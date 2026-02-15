import { describe, expect, it } from "vitest";

import { wecomPlugin } from "./channel.js";

describe("wecom target resolution", () => {
  it("accepts explicit user target", () => {
    expect(wecomPlugin.directory.canResolve({ target: "user:zhangchongwen" })).toBe(true);
    expect(
      wecomPlugin.directory.resolveTarget({
        cfg: {},
        target: "user:zhangchongwen",
      })
    ).toEqual({
      channel: "wecom",
      to: "zhangchongwen",
      accountId: undefined,
    });
  });

  it("accepts explicit group target", () => {
    expect(wecomPlugin.directory.canResolve({ target: "group:chat-001" })).toBe(true);
    expect(
      wecomPlugin.directory.resolveTarget({
        cfg: {},
        target: "group:chat-001",
      })
    ).toEqual({
      channel: "wecom",
      to: "chat-001",
      accountId: undefined,
    });
  });

  it("rejects bare display-name-like target but allows bare lowercase userId", () => {
    expect(
      wecomPlugin.directory.resolveTarget({
        cfg: {},
        target: "zhangchongwen",
      })
    ).toEqual({
      channel: "wecom",
      to: "zhangchongwen",
      accountId: undefined,
    });

    expect(wecomPlugin.directory.canResolve({ target: "ZhangChongWen" })).toBe(false);
    expect(
      wecomPlugin.directory.resolveTarget({
        cfg: {},
        target: "ZhangChongWen",
      })
    ).toBeNull();
  });
});

