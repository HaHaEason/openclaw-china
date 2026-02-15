/**
 * 企业微信 ChannelPlugin 实现
 */

import type { ResolvedWecomAccount, WecomConfig } from "./types.js";
import {
  DEFAULT_ACCOUNT_ID,
  listWecomAccountIds,
  resolveDefaultWecomAccountId,
  resolveWecomAccount,
  resolveAllowFrom,
  resolveGroupAllowFrom,
  resolveRequireMention,
  WecomConfigJsonSchema,
  type PluginConfig,
} from "./config.js";
import { registerWecomWebhookTarget } from "./monitor.js";
import { setWecomRuntime } from "./runtime.js";

type ParsedDirectTarget = {
  accountId?: string;
  kind: "user" | "group";
  id: string;
};

// 裸目标默认按 userId 处理；仅接受“机器可投递 ID”风格，避免显示名歧义。
const BARE_USER_ID_RE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
const EXPLICIT_USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

function parseDirectTarget(rawTarget: string): ParsedDirectTarget | null {
  let raw = String(rawTarget ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("wecom:")) {
    raw = raw.slice("wecom:".length);
  }

  let accountId: string | undefined;
  if (!looksLikeEmail(raw)) {
    const atIdx = raw.lastIndexOf("@");
    if (atIdx > 0 && atIdx < raw.length - 1) {
      const candidate = raw.slice(atIdx + 1);
      if (!/[:/]/.test(candidate)) {
        accountId = candidate;
        raw = raw.slice(0, atIdx);
      }
    }
  }

  if (raw.startsWith("chat:")) {
    raw = `group:${raw.slice(5)}`;
  }

  if (raw.startsWith("group:")) {
    const id = raw.slice(6).trim();
    if (!id || /\s/.test(id) || !GROUP_ID_RE.test(id)) return null;
    return { accountId, kind: "group", id };
  }

  const explicitUserPrefix = raw.startsWith("user:");
  if (explicitUserPrefix) raw = raw.slice(5);
  const id = raw.trim();
  if (!id || /\s/.test(id)) return null;
  if (!explicitUserPrefix && !BARE_USER_ID_RE.test(id)) return null;
  if (explicitUserPrefix && !EXPLICIT_USER_ID_RE.test(id)) return null;
  return { accountId, kind: "user", id };
}

const meta = {
  id: "wecom",
  label: "WeCom",
  selectionLabel: "WeCom (企业微信)",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "企业微信智能机器人回调",
  aliases: ["wechatwork", "wework", "qywx", "企微", "企业微信"],
  order: 85,
} as const;

const unregisterHooks = new Map<string, () => void>();

export const wecomPlugin = {
  id: "wecom",

  meta: {
    ...meta,
  },

  capabilities: {
    chatTypes: ["direct", "group"] as const,
    media: false,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
  },

  messaging: {
    normalizeTarget: (raw: string): string | undefined => {
      const parsed = parseDirectTarget(raw);
      if (!parsed) return undefined;
      return `${parsed.kind}:${parsed.id}${parsed.accountId ? `@${parsed.accountId}` : ""}`;
    },
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string) => {
        const candidate = (normalized ?? raw).trim();
        return Boolean(parseDirectTarget(candidate));
      },
      hint: "Use WeCom ids only: user:<userid> for DM, group:<chatid> for groups (optional @accountId).",
    },
    formatTargetDisplay: (params: { target: string; display?: string }) => {
      const parsed = parseDirectTarget(params.target);
      if (!parsed) return params.display?.trim() || params.target;
      return `${parsed.kind}:${parsed.id}`;
    },
  },

  configSchema: WecomConfigJsonSchema,

  reload: { configPrefixes: ["channels.wecom"] },

  config: {
    listAccountIds: (cfg: PluginConfig): string[] => listWecomAccountIds(cfg),

    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedWecomAccount =>
      resolveWecomAccount({ cfg, accountId }),

    defaultAccountId: (cfg: PluginConfig): string => resolveDefaultWecomAccountId(cfg),

    setAccountEnabled: (params: { cfg: PluginConfig; accountId?: string; enabled: boolean }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccount = Boolean(params.cfg.channels?.wecom?.accounts?.[accountId]);
      if (!useAccount) {
        return {
          ...params.cfg,
          channels: {
            ...params.cfg.channels,
            wecom: {
              ...(params.cfg.channels?.wecom ?? {}),
              enabled: params.enabled,
            } as WecomConfig,
          },
        };
      }

      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          wecom: {
            ...(params.cfg.channels?.wecom ?? {}),
            accounts: {
              ...(params.cfg.channels?.wecom?.accounts ?? {}),
              [accountId]: {
                ...(params.cfg.channels?.wecom?.accounts?.[accountId] ?? {}),
                enabled: params.enabled,
              },
            },
          } as WecomConfig,
        },
      };
    },

    deleteAccount: (params: { cfg: PluginConfig; accountId?: string }): PluginConfig => {
      const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
      const next = { ...params.cfg };
      const current = next.channels?.wecom;
      if (!current) return next;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { accounts: _ignored, defaultAccount: _ignored2, ...rest } = current as WecomConfig;
        next.channels = {
          ...next.channels,
          wecom: { ...(rest as WecomConfig), enabled: false },
        };
        return next;
      }

      const accounts = { ...(current.accounts ?? {}) };
      delete accounts[accountId];

      next.channels = {
        ...next.channels,
        wecom: {
          ...(current as WecomConfig),
          accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
        },
      };

      return next;
    },

    isConfigured: (account: ResolvedWecomAccount): boolean => account.configured,

    describeAccount: (account: ResolvedWecomAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      webhookPath: account.config.webhookPath ?? "/wecom",
    }),

    resolveAllowFrom: (params: { cfg: PluginConfig; accountId?: string }): string[] => {
      const account = resolveWecomAccount({ cfg: params.cfg, accountId: params.accountId });
      return resolveAllowFrom(account.config);
    },

    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  groups: {
    resolveRequireMention: (params: { cfg: PluginConfig; accountId?: string; account?: ResolvedWecomAccount }): boolean => {
      const account = params.account ?? resolveWecomAccount({ cfg: params.cfg ?? {}, accountId: params.accountId });
      return resolveRequireMention(account.config);
    },
  },

  directory: {
    canResolve: (params: { target: string }): boolean => Boolean(parseDirectTarget(params.target)),
    resolveTarget: (params: {
      cfg: PluginConfig;
      target: string;
    }): {
      channel: string;
      accountId?: string;
      to: string;
    } | null => {
      const parsed = parseDirectTarget(params.target);
      if (!parsed) return null;
      return { channel: "wecom", accountId: parsed.accountId, to: parsed.id };
    },
    resolveTargets: (params: {
      cfg: PluginConfig;
      targets: string[];
    }): Array<{
      channel: string;
      accountId?: string;
      to: string;
    }> => {
      const results: Array<{
        channel: string;
        accountId?: string;
        to: string;
      }> = [];
      for (const target of params.targets) {
        const resolved = wecomPlugin.directory.resolveTarget({ cfg: params.cfg, target });
        if (resolved) results.push(resolved);
      }
      return results;
    },
    getTargetFormats: (): string[] => [
      "wecom:user:<userId>",
      "user:<userId>",
      "group:<chatId>",
      "<userid-lowercase>",
    ],
  },

  outbound: {
    deliveryMode: "direct",
    sendText: async () => {
      return {
        channel: "wecom",
        ok: false,
        messageId: "",
        error: new Error("WeCom intelligent bot only supports replying within callbacks (no standalone sendText)."),
      };
    },
  },

  gateway: {
    startAccount: async (ctx: {
      cfg: PluginConfig;
      runtime?: unknown;
      abortSignal?: AbortSignal;
      accountId: string;
      setStatus?: (status: Record<string, unknown>) => void;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }): Promise<void> => {
      ctx.setStatus?.({ accountId: ctx.accountId });

      if (ctx.runtime) {
        const candidate = ctx.runtime as {
          channel?: {
            routing?: { resolveAgentRoute?: unknown };
            reply?: { dispatchReplyFromConfig?: unknown };
          };
        };
        if (candidate.channel?.routing?.resolveAgentRoute && candidate.channel?.reply?.dispatchReplyFromConfig) {
          setWecomRuntime(ctx.runtime as Record<string, unknown>);
        }
      }

      const account = resolveWecomAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      if (!account.configured) {
        ctx.log?.info(`[wecom] account ${ctx.accountId} not configured; webhook not registered`);
        ctx.setStatus?.({ accountId: ctx.accountId, running: false, configured: false });
        return;
      }

      const path = (account.config.webhookPath ?? "/wecom").trim();
      const unregister = registerWecomWebhookTarget({
        account,
        config: (ctx.cfg ?? {}) as PluginConfig,
        runtime: {
          log: ctx.log?.info ?? console.log,
          error: ctx.log?.error ?? console.error,
        },
        path,
        statusSink: (patch) => ctx.setStatus?.({ accountId: ctx.accountId, ...patch }),
      });

      const existing = unregisterHooks.get(ctx.accountId);
      if (existing) existing();
      unregisterHooks.set(ctx.accountId, unregister);

      ctx.log?.info(`[wecom] webhook registered at ${path} for account ${ctx.accountId}`);
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: true,
        configured: true,
        webhookPath: path,
        lastStartAt: Date.now(),
      });
    },

    stopAccount: async (ctx: { accountId: string; setStatus?: (status: Record<string, unknown>) => void }): Promise<void> => {
      const unregister = unregisterHooks.get(ctx.accountId);
      if (unregister) {
        unregister();
        unregisterHooks.delete(ctx.accountId);
      }
      ctx.setStatus?.({ accountId: ctx.accountId, running: false, lastStopAt: Date.now() });
    },
  },
};

export { DEFAULT_ACCOUNT_ID } from "./config.js";
