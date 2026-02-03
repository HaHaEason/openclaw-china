/**
 * 钉钉 Stream 连接管理
 * 
 * 使用 dingtalk-stream SDK 建立持久连接接收消息
 * 
 */

import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDingtalkClientFromConfig } from "./client.js";
import { handleDingtalkMessage } from "./bot.js";
import type { DingtalkConfig } from "./config.js";
import type { DingtalkRawMessage } from "./types.js";
import { createLogger, type Logger } from "./logger.js";

/**
 * Monitor 配置选项
 */
export interface MonitorDingtalkOpts {
  /** 钉钉渠道配置 */
  config?: {
    channels?: {
      dingtalk?: DingtalkConfig;
    };
  };
  /** 运行时环境 */
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  /** 中断信号，用于优雅关闭 */
  abortSignal?: AbortSignal;
  /** 账户 ID */
  accountId?: string;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

async function ensureGatewayHttpEnabled(params: {
  dingtalkCfg?: DingtalkConfig;
  logger: Logger;
}): Promise<void> {
  const { dingtalkCfg, logger } = params;
  if (!dingtalkCfg?.enableAICard) return;

  const home = os.homedir();
  const candidates = [
    path.join(home, ".openclaw", "openclaw.json"),
    path.join(home, ".openclaw", "config.json"),
  ];

  for (const filePath of candidates) {
    try {
      await fs.access(filePath);
    } catch {
      continue;
    }

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const cleaned = raw.replace(/^\uFEFF/, "").trim();
      if (!cleaned) continue;

      const cfg = JSON.parse(cleaned) as Record<string, unknown>;
      const gateway = toRecord(cfg.gateway);
      const http = toRecord(gateway.http);
      const endpoints = toRecord(http.endpoints);
      const chatCompletions = toRecord(endpoints.chatCompletions);

      if (chatCompletions.enabled === true) {
      logger.debug(`[gateway] chatCompletions already enabled in ${filePath}`);
      return;
      }

      chatCompletions.enabled = true;
      endpoints.chatCompletions = chatCompletions;
      http.endpoints = endpoints;
      gateway.http = http;
      cfg.gateway = gateway;

      const output = JSON.stringify(cfg, null, 2);
      await fs.writeFile(filePath, `${output}\n`, "utf8");
      logger.info(`[gateway] enabled http.endpoints.chatCompletions in ${filePath}`);
      logger.info("[gateway] restart OpenClaw gateway to apply HTTP endpoint change");
      return;
    } catch (err) {
      logger.warn(`[gateway] failed to update ${filePath}: ${String(err)}`);
    }
  }

  logger.warn("[gateway] openclaw config not found; cannot auto-enable http endpoint");
}

/** 当前活跃的 Stream 客户端 */
let currentClient: DWClient | null = null;

/** 当前活跃连接的账户 ID */
let currentAccountId: string | null = null;

/** 当前 Monitor Promise */
let currentPromise: Promise<void> | null = null;

/** 停止当前 Monitor */
let currentStop: (() => void) | null = null;

/** 消息去重缓存：streamMessageId -> 处理时间戳 */
const processedMessages = new Map<string, number>();

/** 去重缓存过期时间（毫秒） */
const MESSAGE_DEDUP_TTL_MS = 60000;

/** 重连与健康检查相关参数 */
const WATCHDOG_INTERVAL_MS = 10000;
const CONNECT_TIMEOUT_MS = 30000;
const REGISTER_TIMEOUT_MS = 30000;
const DISCONNECT_GRACE_MS = 15000;
const MIN_RECONNECT_INTERVAL_MS = 10000;

type DingtalkSocketLike = {
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  terminate?: () => void;
};

type DingtalkClientState = {
  connected?: boolean;
  registered?: boolean;
  socket?: DingtalkSocketLike;
};

function getClientState(client: DWClient): DingtalkClientState {
  return client as unknown as DingtalkClientState;
}

/**
 * 启动钉钉 Stream 连接监控
 * 
 * 使用 DWClient 建立 Stream 连接，注册 TOPIC_ROBOT 回调处理消息。
 * 支持 abortSignal 进行优雅关闭。
 * 
 * @param opts 监控配置选项
 * @returns Promise<void> 连接关闭时 resolve
 * @throws Error 如果凭证未配置
 */
export async function monitorDingtalkProvider(opts: MonitorDingtalkOpts = {}): Promise<void> {
  const { config, runtime, abortSignal, accountId = "default" } = opts;
  
  const logger: Logger = createLogger("dingtalk", {
    log: runtime?.log,
    error: runtime?.error,
  });
  
  // Single-account: only one active connection allowed.
  if (currentClient) {
    if (currentAccountId && currentAccountId !== accountId) {
      throw new Error(`DingTalk already running for account ${currentAccountId}`);
    }
    logger.debug(`existing connection for account ${accountId} is active, reusing monitor`);
    if (currentPromise) {
      return currentPromise;
    }
    throw new Error("DingTalk monitor state invalid: active client without promise");
  }

  // Get DingTalk config.
  const dingtalkCfg = config?.channels?.dingtalk;
  if (!dingtalkCfg) {
    throw new Error("DingTalk configuration not found");
  }

  await ensureGatewayHttpEnabled({ dingtalkCfg, logger });

  // Create Stream client.
  let client: DWClient;
  try {
    client = createDingtalkClientFromConfig(dingtalkCfg);
  } catch (err) {
    logger.error(`failed to create client: ${String(err)}`);
    throw err;
  }

  currentClient = client;
  currentAccountId = accountId;

  logger.info(`starting Stream connection for account ${accountId}...`);

  currentPromise = new Promise<void>((resolve, reject) => {
    let stopped = false;
    let watchdogId: ReturnType<typeof setInterval> | null = null;
    let lastSocket: DingtalkSocketLike | null = null;
    let connectStartedAt = Date.now();
    let lastConnectedAt: number | null = null;
    let lastReconnectAt = 0;

    const attachSocketListeners = () => {
      const { socket } = getClientState(client);
      if (!socket || socket === lastSocket) return;
      lastSocket = socket;
      socket.once("open", () => {
        const now = Date.now();
        connectStartedAt = now;
        lastConnectedAt = now;
        logger.info("Stream socket opened");
      });
      socket.once("close", () => {
        logger.warn("Stream socket closed");
      });
      socket.once("error", (err) => {
        logger.warn(`Stream socket error: ${String(err)}`);
      });
    };

    const forceReconnect = (reason: string) => {
      const now = Date.now();
      if (now - lastReconnectAt < MIN_RECONNECT_INTERVAL_MS) {
        return;
      }
      lastReconnectAt = now;
      logger.warn(`[reconnect] forcing reconnect: ${reason}`);
      try {
        const { socket } = getClientState(client);
        socket?.terminate?.();
      } catch (err) {
        logger.error(`failed to terminate socket: ${String(err)}`);
      }
    };

    // Cleanup state and disconnect the client.
    const cleanup = () => {
      if (watchdogId) {
        clearInterval(watchdogId);
        watchdogId = null;
      }
      if (currentClient === client) {
        currentClient = null;
        currentAccountId = null;
        currentStop = null;
        currentPromise = null;
      }
      try {
        client.disconnect();
      } catch (err) {
        logger.error(`failed to disconnect client: ${String(err)}`);
      }
    };

    const finalizeResolve = () => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", handleAbort);
      cleanup();
      resolve();
    };

    const finalizeReject = (err: unknown) => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", handleAbort);
      cleanup();
      reject(err);
    };

    // Handle abort signal.
    const handleAbort = () => {
      logger.info("abort signal received, stopping Stream client");
      finalizeResolve();
    };

    // Expose a stop hook for manual shutdown.
    currentStop = () => {
      logger.info("stop requested, stopping Stream client");
      finalizeResolve();
    };

    // If already aborted, resolve immediately.
    if (abortSignal?.aborted) {
      finalizeResolve();
      return;
    }

    // Register abort handler.
    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      // Register TOPIC_ROBOT callback.
      client.registerCallbackListener(TOPIC_ROBOT, (res) => {
        const streamMessageId = res?.headers?.messageId;

        // 立即显式 ACK，防止钉钉重发消息
        if (streamMessageId) {
          try {
            client.socketCallBackResponse(streamMessageId, { success: true });
          } catch (ackErr) {
            logger.error(`failed to ACK message ${streamMessageId}: ${String(ackErr)}`);
          }
        }

        // 消息去重检查
        if (streamMessageId) {
          const now = Date.now();
          const lastProcessed = processedMessages.get(streamMessageId);
          if (lastProcessed && now - lastProcessed < MESSAGE_DEDUP_TTL_MS) {
            logger.debug(`duplicate message ignored: ${streamMessageId}`);
            return;
          }
          processedMessages.set(streamMessageId, now);

          // 清理过期条目（每次处理时清理，避免内存泄漏）
          for (const [id, time] of processedMessages) {
            if (now - time > MESSAGE_DEDUP_TTL_MS) {
              processedMessages.delete(id);
            }
          }
        }

        try {
          // Parse message payload.
          const rawMessage = JSON.parse(res.data) as DingtalkRawMessage;
          if (streamMessageId) {
            rawMessage.streamMessageId = streamMessageId;
          }

          // 关键业务日志：收到消息
          // content 可能是字符串或对象，需要处理
          let contentText = "";
          if (rawMessage.msgtype === "text" && rawMessage.text?.content) {
            contentText = rawMessage.text.content;
          } else if (rawMessage.content) {
            const contentObj = typeof rawMessage.content === "string"
              ? (() => { try { return JSON.parse(rawMessage.content); } catch { return null; } })()
              : rawMessage.content;
            if (contentObj && typeof contentObj === "object" && "recognition" in contentObj && typeof contentObj.recognition === "string") {
              contentText = contentObj.recognition;
            }
          }
          const contentTrimmed = contentText.trim();
          const senderName = rawMessage.senderNick ?? rawMessage.senderId;
          const textPreview = contentTrimmed.slice(0, 50);
          logger.info(`Inbound: from=${senderName} text="${textPreview}${contentTrimmed.length > 50 ? "..." : ""}"`);
          logger.debug(`streamId=${streamMessageId ?? "none"} convo=${rawMessage.conversationId}`);

          // 异步处理消息（ACK 已在前面发送）
          void handleDingtalkMessage({
            cfg: config,
            raw: rawMessage,
            accountId,
            log: (msg: string) => logger.info(msg.replace(/^\[dingtalk\]\s*/, "")),
            error: (msg: string) => logger.error(msg.replace(/^\[dingtalk\]\s*/, "")),
            enableAICard: dingtalkCfg?.enableAICard ?? true,
          }).catch((err) => {
            logger.error(`error handling message: ${String(err)}`);
          });
        } catch (err) {
          logger.error(`error parsing message: ${String(err)}`);
        }
      });

      // Start watchdog to detect stale connections.
      watchdogId = setInterval(() => {
        if (stopped) return;
        attachSocketListeners();

        const now = Date.now();
        const state = getClientState(client);
        const connected = state.connected === true;
        const registered = state.registered === true;

        if (connected) {
          lastConnectedAt = now;
        }
        // Connection never established or got stuck before register.
        if (!connected && now - connectStartedAt > CONNECT_TIMEOUT_MS) {
          forceReconnect("connect timeout");
          connectStartedAt = now;
          lastConnectedAt = null;
          return;
        }

        if (connected && !registered && now - connectStartedAt > REGISTER_TIMEOUT_MS) {
          forceReconnect("register timeout");
          connectStartedAt = now;
          lastConnectedAt = null;
          return;
        }

        // Server signaled disconnect but socket stayed open.
        if (!connected) {
          const lastSeen = lastConnectedAt ?? connectStartedAt;
          if (now - lastSeen > DISCONNECT_GRACE_MS) {
            forceReconnect("client marked disconnected");
            connectStartedAt = now;
            lastConnectedAt = null;
          }
        }
      }, WATCHDOG_INTERVAL_MS);

      // Start Stream connection.
      connectStartedAt = Date.now();
      lastConnectedAt = null;
      attachSocketListeners();
      client.connect();

      logger.info("Stream client connect invoked");
    } catch (err) {
      logger.error(`failed to start Stream connection: ${String(err)}`);
      finalizeReject(err);
    }
  });

  return currentPromise;
}

/**
 * 停止钉钉 Monitor
 */
export function stopDingtalkMonitor(): void {
  if (currentStop) {
    currentStop();
    return;
  }
  if (currentClient) {
    try {
      currentClient.disconnect();
    } catch (err) {
      console.error(`[dingtalk] failed to disconnect client: ${String(err)}`);
    } finally {
      currentClient = null;
      currentAccountId = null;
      currentPromise = null;
      currentStop = null;
    }
  }
}

/**
 * 获取当前 Stream 客户端状态
 */
export function isMonitorActive(): boolean {
  return currentClient !== null;
}

/**
 * 获取当前活跃连接的账户 ID
 */
export function getCurrentAccountId(): string | null {
  return currentAccountId;
}
