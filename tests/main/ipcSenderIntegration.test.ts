import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ctx from "../../ipc/context";
import { makeEvent, makeWindowStub } from "./senderGuardHelpers";

async function resetWorldStateIpc() {
  const worldStateIpc = await import("../../ipc/worldStateIpc");
  worldStateIpc.__test__.reset();
}

class MockNotification {
  static isSupported() {
    return false;
  }

  show() {}
}

describe("IPC sender guard integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await resetWorldStateIpc();
    ctx.mainWindow = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers world-state IPC once until reset", async () => {
    const worldStateIpc = await import("../../ipc/worldStateIpc");
    const handle = vi.fn();

    worldStateIpc.register({
      ipcMain: { handle },
      Notification: MockNotification,
    });
    worldStateIpc.register({
      ipcMain: { handle },
      Notification: MockNotification,
    });

    // register() guards against double-registration; only __test__.reset() re-arms it.
    const firstPass = handle.mock.calls.map((call) => call[0]);
    expect(firstPass).toContain("get-world-state");
    expect(new Set(firstPass).size).toBe(firstPass.length);

    worldStateIpc.__test__.reset();
    worldStateIpc.register({
      ipcMain: { handle },
      Notification: MockNotification,
    });

    expect(handle).toHaveBeenCalledTimes(firstPass.length * 2);
  });

  it("blocks unauthorized sender through registered world-state handler", async () => {
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>();

    const worldStateIpc = await import("../../ipc/worldStateIpc");
    worldStateIpc.register({
      ipcMain: {
        handle: (channel: string, handler: (event: unknown) => Promise<unknown>) => {
          handlers.set(channel, handler);
        },
      },
      Notification: MockNotification,
    });

    ctx.mainWindow = makeWindowStub(44);

    const handler = handlers.get("get-world-state");
    expect(handler).toBeTypeOf("function");

    const badEvent = makeEvent(99, "file:///D:/app/renderer/dist/index.html");
    await expect(handler?.(badEvent)).rejects.toThrow("Unauthorized IPC sender");
  });
});
