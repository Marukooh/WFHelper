import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir = "";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../services/wfmWebSocket", () => ({
  setStatusViaWebSocket: vi.fn(async () => ({ statusUntil: null })),
}));

const client = vi.hoisted(() => ({
  request: vi.fn(),
  requestRaw: vi.fn(),
  requestV2: vi.fn(),
  requestRedirectTarget: vi.fn(),
}));

vi.mock("../../services/wfmClient", () => ({
  WfmApiError: class WfmApiError extends Error {
    code?: string;
    status?: number;
    constructor(message: string, code?: string, status?: number) {
      super(message);
      this.name = "WfmApiError";
      this.code = code;
      this.status = status;
    }
  },
  request: client.request,
  requestRaw: client.requestRaw,
  requestV2: client.requestV2,
  requestRedirectTarget: client.requestRedirectTarget,
  setTokenProvider: vi.fn(),
  setTokenRotationHandler: vi.fn(),
  updateCsrfFromToken: vi.fn(),
  clearCsrfToken: vi.fn(),
}));

const API = "https://api.warframe.market/v1";

type Session = typeof import("../../services/wfmSession");
type Contracts = typeof import("../../services/wfmContracts");

function skippable404(): Error {
  return Object.assign(new Error("HTTP 404"), { status: 404 });
}

/** Fresh module state per case: both modules cache the resolved slug for the
 *  life of the session. */
async function signedInAs(userName: string): Promise<{ session: Session; contracts: Contracts }> {
  vi.resetModules();
  client.requestRaw.mockResolvedValue({
    res: {
      headers: { get: (name: string) => (name === "authorization" ? "JWT test-token" : null) },
    },
    body: { payload: { user: { ingame_name: userName, platform: "pc" } } },
  });
  const session = await import("../../services/wfmSession");
  const contracts = await import("../../services/wfmContracts");
  await session.signIn("tester@example.test", "correct-horse");
  return { session, contracts };
}

const v1Paths = (): string[] => client.request.mock.calls.map((call) => String(call[1]));

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-slug-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  client.request.mockReset();
  client.requestRaw.mockReset();
  client.requestV2.mockReset();
  client.requestRedirectTarget.mockReset();
  client.requestRedirectTarget.mockResolvedValue(null);
  client.requestV2.mockResolvedValue({ data: { status: "online" } });
  // The account-implicit auctions route is the first candidate; leaving it dead
  // is what lets the slug-bearing profile route be the one that answers.
  client.request.mockImplementation(async (_method: string, requestPath: string) => {
    if (requestPath.startsWith("/profile/auctions")) throw skippable404();
    return { payload: { auctions: [], current_page: 1, last_page: 1 } };
  });
});

describe("signed-in account profile slug", () => {
  it("sends both self-addressed routes to the slug WFM redirects the name to", async () => {
    client.requestRedirectTarget.mockResolvedValue(`${API}/profile/alt-handle/reviews/`);
    const { session, contracts } = await signedInAs("-Alt-Handle");

    await session.getPublicStatus();
    await contracts.getMyContracts();

    expect(client.requestRedirectTarget).toHaveBeenCalledWith("/profile/-Alt-Handle/reviews/");
    expect(client.requestV2).toHaveBeenCalledWith("GET", "/user/alt-handle");
    expect(v1Paths()).toContain("/profile/alt-handle/auctions?limit=40");
  });

  // Invented names in the shapes WFM mints, down to a numeric suffix that
  // appears nowhere in the name. No local rule produces any of them.
  it.each([
    ["-Alt-Handle", "alt-handle"],
    ["Trade Partner", "trade-partner"],
    [".Courier.", "courier"],
    ["Spare_Parts", "spare-parts"],
    ["Relay Fox", "relay-fox-7"],
  ])("routes %s to %s", async (name, slug) => {
    client.requestRedirectTarget.mockResolvedValue(`${API}/profile/${slug}/reviews/`);
    const { session, contracts } = await signedInAs(name);

    await session.getPublicStatus();
    await contracts.getMyContracts();

    expect(client.requestV2).toHaveBeenCalledWith("GET", `/user/${slug}`);
    expect(v1Paths()).toContain(`/profile/${slug}/auctions?limit=40`);
  });

  it("leaves a plain alphanumeric name on the paths it already used", async () => {
    client.requestRedirectTarget.mockResolvedValue(`${API}/profile/testuser/reviews/`);
    const { session, contracts } = await signedInAs("TestUser");

    await session.getPublicStatus();
    await contracts.getMyContracts();

    expect(client.requestV2).toHaveBeenCalledWith("GET", "/user/testuser");
    expect(v1Paths()).toContain("/profile/testuser/auctions?limit=40");
  });

  it("skips the probe entirely when the account-implicit route answers", async () => {
    client.request.mockImplementation(async () => ({ payload: { auctions: [] } }));
    const { contracts } = await signedInAs("Trade Partner");

    await contracts.getMyContracts();

    expect(v1Paths()).toEqual(["/profile/auctions?limit=40"]);
    expect(client.requestRedirectTarget).not.toHaveBeenCalled();
  });

  it("probes once for the session and reuses the answer", async () => {
    client.requestRedirectTarget.mockResolvedValue(`${API}/profile/trade-partner/reviews/`);
    const { session, contracts } = await signedInAs("Trade Partner");

    await session.getPublicStatus();
    await contracts.getMyContracts();
    await contracts.getMyContracts({ page: 2 });

    expect(client.requestRedirectTarget).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    let release: (value: string | null) => void = () => {};
    client.requestRedirectTarget.mockReturnValue(
      new Promise<string | null>((resolve) => {
        release = resolve;
      }),
    );
    const { session } = await signedInAs("Trade Partner");

    const both = Promise.all([session.getProfileSlug(), session.getProfileSlug()]);
    release(`${API}/profile/trade-partner/reviews/`);

    expect(await both).toEqual(["trade-partner", "trade-partner"]);
    expect(client.requestRedirectTarget).toHaveBeenCalledTimes(1);
  });

  it("falls back to folding the name when WFM offers no redirect", async () => {
    const { session, contracts } = await signedInAs("Trade Partner");

    await session.getPublicStatus();
    await contracts.getMyContracts();

    expect(client.requestV2).toHaveBeenCalledWith("GET", "/user/trade_partner");
    expect(v1Paths()).toContain("/profile/trade_partner/auctions?limit=40");
  });

  it("keeps a name that is already slug shaped instead of folding it", async () => {
    const { session } = await signedInAs("alt-handle");

    await expect(session.getProfileSlug()).resolves.toBe("alt-handle");
  });

  it("ignores a redirect target that is not a profile slug", async () => {
    client.requestRedirectTarget.mockResolvedValue(`${API}/profile/..%2Fadmin/reviews/`);
    const { session } = await signedInAs("Trade Partner");

    await expect(session.getProfileSlug()).resolves.toBe("trade_partner");
  });

  it("does not latch a probe that failed in transport", async () => {
    const { session } = await signedInAs("Trade Partner");
    client.requestRedirectTarget.mockRejectedValueOnce(new Error("WFM request queue full"));

    await expect(session.getProfileSlug()).resolves.toBe("trade_partner");

    client.requestRedirectTarget.mockResolvedValueOnce(`${API}/profile/trade-partner/reviews/`);
    await expect(session.getProfileSlug()).resolves.toBe("trade-partner");
  });

  it("drops the cached slug on sign-out", async () => {
    client.requestRedirectTarget.mockResolvedValue(`${API}/profile/trade-partner/reviews/`);
    const { session } = await signedInAs("Trade Partner");

    await expect(session.getProfileSlug()).resolves.toBe("trade-partner");
    session.signOut();

    await expect(session.getProfileSlug()).resolves.toBeNull();
    expect(client.requestRedirectTarget).toHaveBeenCalledTimes(1);
  });
});
