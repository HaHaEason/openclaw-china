/**
 * Gateway WebSocket 客户端
 *
 * 通过 WebSocket 长连接与 OpenClaw Gateway 通信，实现流式聊天响应。
 *
 * 优势:
 * - 长连接复用，减少连接开销
 * - 主动 abort 能力 (chat.abort)
 * - 自动重连机制
 *
 * 协议参考: doc/reference-projects/openclaw/src/gateway/protocol/schema/frames.ts
 */

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { Logger } from "@openclaw-china/shared";

export interface GatewayWsConfig {
  /** WebSocket URL，默认 ws://127.0.0.1:18789 */
  url?: string;
  /** Gateway auth token */
  token?: string;
  /** Gateway auth password */
  password?: string;
}

export interface ChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  errorMessage?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/** 会话进度缓存，用于断开重连后恢复 */
interface SessionProgress {
  runId: string;
  sessionKey: string;
  accumulated: string;
  lastSeq: number;
  updatedAt: number;
}

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private chatListeners = new Map<string, (evt: ChatEvent) => void>();
  private connected = false;
  private closed = false;
  private disconnected = false; // 标记连接断开，用于通知 chatStream
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private connectPromise: Promise<void> | null = null;

  // seq 追踪
  private lastSeq: number | null = null;

  // 会话进度缓存，key 为 sessionKey
  private sessionProgress = new Map<string, SessionProgress>();

  // 进度缓存过期时间 (5分钟)
  private static readonly PROGRESS_TTL_MS = 5 * 60 * 1000;

  constructor(
    private config: GatewayWsConfig,
    private logger: Logger,
  ) {}

  /**
   * 连接到 Gateway WebSocket
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.closed) throw new Error("client is closed");

    // 避免并发连接
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private doConnect(): Promise<void> {
    const url = this.config.url ?? "ws://127.0.0.1:18789";
    this.logger.debug(`[gateway-ws] connecting to ${url}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
      this.disconnected = false;

      const onOpen = async () => {
        try {
          await this.sendConnect();
          this.connected = true;
          this.backoffMs = 1000;
          this.logger.debug("[gateway-ws] connected");
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      const onError = (err: Error) => {
        this.logger.error(`[gateway-ws] error: ${String(err)}`);
        if (!this.connected) reject(err);
      };

      this.ws.once("open", onOpen);
      this.ws.on("error", onError); // 持久错误监听，避免未处理错误崩溃
      this.ws.on("message", (data) => this.handleMessage(data.toString()));
      this.ws.on("close", () => this.handleClose());
    });
  }

  private async sendConnect(): Promise<void> {
    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        version: "moltbot-china",
        platform: process.platform,
        mode: "backend",
        displayName: "DingTalk Plugin",
      },
      role: "operator",
      scopes: ["operator.admin"],
    };

    // 添加认证信息
    if (this.config.token || this.config.password) {
      params.auth = {
        token: this.config.token,
        password: this.config.password,
      };
    }

    await this.request("connect", params);
  }

  private handleMessage(raw: string): void {
    try {
      const frame = JSON.parse(raw) as Record<string, unknown>;

      // 处理响应
      if (frame.type === "res") {
        const pending = this.pending.get(frame.id as string);
        if (pending) {
          this.pending.delete(frame.id as string);
          if (frame.ok) {
            pending.resolve(frame.payload);
          } else {
            const error = frame.error as Record<string, unknown> | undefined;
            pending.reject(new Error((error?.message as string) ?? "unknown error"));
          }
        }
        return;
      }

      // 处理事件
      if (frame.type === "event") {
        // seq 追踪和间隙检测
        const seq = typeof frame.seq === "number" ? frame.seq : null;
        if (seq !== null) {
          if (this.lastSeq !== null && seq > this.lastSeq + 1) {
            const gap = seq - this.lastSeq - 1;
            this.logger.warn(
              `[gateway-ws] event gap detected: expected seq=${this.lastSeq + 1}, received seq=${seq}, missed ${gap} events`
            );
          }
          this.lastSeq = seq;
        }

        // 处理 chat 事件
        if (frame.event === "chat") {
          const payload = frame.payload as ChatEvent;
          const listener = this.chatListeners.get(payload.runId);
          listener?.(payload);
        }
      }
    } catch (err) {
      this.logger.debug(`[gateway-ws] parse error: ${String(err)}`);
    }
  }

  private handleClose(): void {
    this.connected = false;
    this.disconnected = true;
    this.ws = null;
    this.flushPending(new Error("connection closed"));

    // 通知所有 chatStream 监听器连接已断开
    // 改进：使用 error 状态让 chatStream 决定是否优雅降级
    for (const [runId, listener] of this.chatListeners) {
      this.logger.debug(`[gateway-ws] notifying listener ${runId} of connection close`);
      listener({
        runId,
        sessionKey: "",
        seq: -1,
        state: "error",
        errorMessage: "WebSocket connection closed unexpectedly",
      });
    }

    if (!this.closed) {
      this.logger.info("[gateway-ws] connection closed, scheduling reconnect");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.logger.error(`[gateway-ws] reconnect failed: ${String(err)}`);
      });
    }, this.backoffMs);

    // 指数退避，最大 30 秒
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }

    const id = randomUUID();
    const frame = { type: "req", id, method, params };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeoutId);
          resolve(v as T);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  /**
   * 清理过期的会话进度缓存
   */
  private cleanupExpiredProgress(): void {
    const now = Date.now();
    for (const [key, progress] of this.sessionProgress) {
      if (now - progress.updatedAt > GatewayWsClient.PROGRESS_TTL_MS) {
        this.logger.debug(`[gateway-ws] cleaning up expired progress for session ${key}`);
        this.sessionProgress.delete(key);
      }
    }
  }

  /**
   * 保存会话进度
   */
  private saveProgress(sessionKey: string, runId: string, accumulated: string, seq: number): void {
    this.sessionProgress.set(sessionKey, {
      runId,
      sessionKey,
      accumulated,
      lastSeq: seq,
      updatedAt: Date.now(),
    });
    this.logger.debug(
      `[gateway-ws] saved progress for session ${sessionKey}: ${accumulated.length} chars, seq=${seq}`
    );
  }

  /**
   * 获取会话进度
   */
  private getProgress(sessionKey: string): SessionProgress | undefined {
    this.cleanupExpiredProgress();
    return this.sessionProgress.get(sessionKey);
  }

  /**
   * 清除会话进度
   */
  private clearProgress(sessionKey: string): void {
    this.sessionProgress.delete(sessionKey);
  }

  /**
   * 发送聊天消息并返回流式响应
   *
   * 改进：
   * - 连接断开时优雅降级，返回已累积的数据而不是抛出错误
   * - 断开时保存进度，重连后可以恢复
   * - 追踪 seq 用于检测事件间隙
   */
  async *chatStream(params: {
    sessionKey: string;
    message: string;
    timeoutMs?: number;
  }): AsyncGenerator<string, void, unknown> {
    const runId = randomUUID();
    let accumulated = "";
    let done = false;
    let error: Error | null = null;
    let disconnectedWithData = false; // 标记：连接断开但有数据
    const resolvers: Array<() => void> = [];
    let lastState: ChatEvent["state"] | null = null;
    let lastEventSeq = 0; // 追踪当前会话的最后 seq

    // 检查是否有之前断开时保存的进度
    const savedProgress = this.getProgress(params.sessionKey);
    if (savedProgress) {
      this.logger.info(
        `[gateway-ws] found saved progress for session ${params.sessionKey}: ${savedProgress.accumulated.length} chars, lastSeq=${savedProgress.lastSeq}`
      );
      // 注意：这里不直接恢复 accumulated，因为新请求会从头开始
      // 但我们记录日志以便调试
    }

    // 注册 chat 事件监听
    this.chatListeners.set(runId, (evt) => {
      lastState = evt.state;

      // 追踪事件 seq
      if (typeof evt.seq === "number") {
        lastEventSeq = evt.seq;
      }

      if (evt.state === "delta" || evt.state === "final") {
        const text =
          evt.message?.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("") ?? "";
        accumulated = text;

        // 每次收到数据都保存进度（用于断开时恢复）
        if (accumulated.length > 0) {
          this.saveProgress(params.sessionKey, runId, accumulated, lastEventSeq);
        }
      }

      if (evt.state === "final" || evt.state === "aborted") {
        done = true;
        // 正常完成，清除进度缓存
        this.clearProgress(params.sessionKey);
      }

      if (evt.state === "error") {
        // 改进：如果已有累积数据，不抛出错误，而是标记完成
        if (accumulated.length > 0) {
          this.logger.warn(
            `[gateway-ws] connection error with ${accumulated.length} chars accumulated (seq=${lastEventSeq}), graceful finish`
          );
          disconnectedWithData = true;
          done = true;
          // 保留进度缓存，不清除（可能需要恢复）
        } else {
          error = new Error(evt.errorMessage ?? "chat error");
          done = true;
        }
      }

      // 唤醒等待的 yield
      resolvers.shift()?.();
    });

    try {
      // 发送 chat.send 请求
      await this.request("chat.send", {
        sessionKey: params.sessionKey,
        message: params.message,
        deliver: false,
        idempotencyKey: runId,
        timeoutMs: params.timeoutMs ?? 120000,
      });

      while (!done) {
        // wait for new data
        await new Promise<void>((resolve) => {
          if (done) {
            resolve();
          } else {
            resolvers.push(resolve);
          }
        });

        // only throw when there is no accumulated data
        if (error && accumulated.length === 0) throw error;
      }

      // only allow final output
      if (lastState === "final" && accumulated) {
        yield accumulated;
      }

      // 如果连接断开但有数据，也输出
      if (disconnectedWithData && accumulated) {
        this.logger.info(
          `[gateway-ws] yielding ${accumulated.length} chars from interrupted stream (lastSeq=${lastEventSeq})`
        );
        yield accumulated;
      }

      if (disconnectedWithData) {
        this.logger.info(`[gateway-ws] stream completed with ${accumulated.length} chars (connection was interrupted)`);
      }
    } finally {
      this.chatListeners.delete(runId);
    }
  }

  /**
   * 中止正在进行的聊天
   */
  async abortChat(sessionKey: string, runId?: string): Promise<void> {
    await this.request("chat.abort", { sessionKey, runId });
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 关闭客户端
   */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("client closed"));
  }
}

// 全局单例实例
let globalClient: GatewayWsClient | null = null;
let globalClientConfig: string | null = null; // 用于检测配置变化

/**
 * 获取或创建全局 Gateway WebSocket 客户端
 * 如果配置变化，会关闭旧连接并创建新连接
 */
export function getGatewayWsClient(
  config: GatewayWsConfig,
  logger: Logger
): GatewayWsClient {
  const configKey = JSON.stringify({
    url: config.url,
    token: config.token,
    password: config.password,
  });

  // 配置变化时重建客户端
  if (globalClient && globalClientConfig !== configKey) {
    logger.debug("[gateway-ws] config changed, recreating client");
    globalClient.close();
    globalClient = null;
  }

  if (!globalClient) {
    globalClient = new GatewayWsClient(config, logger);
    globalClientConfig = configKey;
  }
  return globalClient;
}

/**
 * 关闭全局客户端
 */
export function closeGatewayWsClient(): void {
  globalClient?.close();
  globalClient = null;
}
