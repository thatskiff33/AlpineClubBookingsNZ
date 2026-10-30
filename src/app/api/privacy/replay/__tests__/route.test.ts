import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRIVACY_RETENTION_SETTINGS } from "@/lib/privacy-retention-shared";

const mocks = vi.hoisted(() => ({
  applyRateLimit: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    privacyRetentionSettings: { findUnique: mocks.findUnique },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      privacyRetentionSettings: { upsert: mocks.upsert },
    }),
  },
}));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: mocks.applyRateLimit, rateLimiters: { api: { id: "api" } } }));

const request = () => new Request("https://club.example/api/privacy/replay");
let GET: typeof import("../route").GET;
let elapsed: number;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.findUnique.mockResolvedValue({ ...DEFAULT_PRIVACY_RETENTION_SETTINGS, sentryReplayEnabled: true });
  ({ GET } = await import("../route"));
});

describe("public Replay policy", () => {
  it("rate limits before reading policy, including cache hits", async () => {
    await GET(request());
    mocks.findUnique.mockClear();
    const blocked = new Response(null, { status: 429 });
    mocks.applyRateLimit.mockResolvedValue(blocked);
    expect(await GET(request())).toBe(blocked);
    expect(mocks.applyRateLimit).toHaveBeenCalledWith({ id: "api" }, expect.any(Request));
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
  it("coalesces concurrent reads and refreshes after 60 seconds", async () => {
    const responses = await Promise.all([GET(request()), GET(request())]);
    expect(mocks.findUnique).toHaveBeenCalledOnce();
    for (const response of responses) {
      expect(await response.json()).toEqual({ enabled: true });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    mocks.findUnique.mockResolvedValue(DEFAULT_PRIVACY_RETENTION_SETTINGS);
    elapsed = 59_999;
    expect(await (await GET(request())).json()).toEqual({ enabled: true });
    elapsed = 60_000;
    expect(await (await GET(request())).json()).toEqual({ enabled: false });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });
  it("fails closed on a failed policy refresh and caches OFF", async () => {
    await GET(request());
    mocks.findUnique.mockRejectedValue(new Error("settings unavailable"));
    elapsed = 60_000;
    expect(await (await GET(request())).json()).toEqual({ enabled: false });
    expect(await (await GET(request())).json()).toEqual({ enabled: false });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
    mocks.findUnique.mockResolvedValue({ ...DEFAULT_PRIVACY_RETENTION_SETTINGS, sentryReplayEnabled: true });
    elapsed = 120_000;
    expect(await (await GET(request())).json()).toEqual({ enabled: true });
  });
  it("invalidates the local policy cache after a successful settings save", async () => {
    await GET(request());
    const { savePrivacyRetentionSettings } = await import("@/lib/privacy-retention-settings");
    await savePrivacyRetentionSettings(DEFAULT_PRIVACY_RETENTION_SETTINGS, "admin-1");
    mocks.findUnique.mockResolvedValue(DEFAULT_PRIVACY_RETENTION_SETTINGS);
    expect(await (await GET(request())).json()).toEqual({ enabled: false });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });
});
