import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The central server's availability question (#62).
 *
 * Unauthenticated, so the signature is most of the story; then the shape of
 * the stay, then which lodge — and every "which lodge" refusal must look the
 * same, so probing reveals nothing. The answer is counts only (the free beds
 * per night and their minimum, #79), and the body is pinned to exactly five keys.
 */

const mocks = vi.hoisted(() => ({
  getIntegrationCredentialValue: vi.fn(),
  loadServerNzSettings: vi.fn(),
  resolveLocalLodgeForCentralId: vi.fn(),
  freeBedsForStay: vi.fn(),
  applyRateLimit: vi.fn(),
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
}));
vi.mock("@/lib/club-post-mirror", () => ({ SERVERNZ_PUSH_SECRET_KEY: "push_secret" }));
vi.mock("@/lib/servernz-settings", () => ({ loadServerNzSettings: mocks.loadServerNzSettings }));
vi.mock("@/lib/central-lodge-link", () => ({
  resolveLocalLodgeForCentralId: mocks.resolveLocalLodgeForCentralId,
}));
vi.mock("@/lib/central-availability", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  freeBedsForStay: mocks.freeBedsForStay,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  applyRateLimit: mocks.applyRateLimit,
}));
// The frozen test clock's day (TESTING.md), as the club-time kernel would say it.
vi.mock("@/lib/club-time/server", async () => {
  const { parseDateOnly } = await import("@/lib/date-only");
  return { clubTodayDateOnlyInstant: async () => parseDateOnly("2026-07-01") };
});

import { GET } from "@/app/api/webhooks/servernz-availability/route";

const SECRET = "s".repeat(64);
const OWNED = [{ id: "ol_a", name: "Aorangi Ski Club" }];

type Query = { lodgeId: string; from: string; to: string };
const STAY: Query = { lodgeId: "ol_a", from: "2026-07-10", to: "2026-07-13" };

function sign(text: string, timestamp: string, secret = SECRET) {
  return createHmac("sha256", secret).update(`${timestamp}.${text}`).digest("hex");
}

function request(
  query: Partial<Query> = STAY,
  options: { signedText?: string; secret?: string; timestamp?: string; omitSignature?: boolean } = {},
) {
  const q = { ...STAY, ...query };
  const timestamp = options.timestamp ?? String(Date.now());
  const text = options.signedText ?? `availability\n${q.lodgeId}\n${q.from}\n${q.to}`;
  const headers: Record<string, string> = { "x-acs-timestamp": timestamp };
  if (!options.omitSignature) headers["x-acs-signature"] = sign(text, timestamp, options.secret);
  const url = new URL("https://club.test/api/webhooks/servernz-availability");
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  return new NextRequest(url, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.getIntegrationCredentialValue.mockResolvedValue(SECRET);
  mocks.loadServerNzSettings.mockResolvedValue({
    otherLodgesEnabled: true,
    otherLodgesOwnedLodges: OWNED,
  });
  mocks.resolveLocalLodgeForCentralId.mockResolvedValue("lodge_local");
  mocks.freeBedsForStay.mockResolvedValue({
    freeBeds: 7,
    nights: [
      { date: "2026-07-10", freeBeds: 9 },
      { date: "2026-07-11", freeBeds: 7 },
      { date: "2026-07-12", freeBeds: 12 },
    ],
  });
});

describe("GET /api/webhooks/servernz-availability (#62)", () => {
  it("answers the free beds for a signed question, night by night (#79), with exactly these keys and no caching", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      lodgeId: "ol_a",
      from: "2026-07-10",
      to: "2026-07-13",
      freeBeds: 7,
      nights: [
        { date: "2026-07-10", freeBeds: 9 },
        { date: "2026-07-11", freeBeds: 7 },
        { date: "2026-07-12", freeBeds: 12 },
      ],
    });
    expect(mocks.resolveLocalLodgeForCentralId).toHaveBeenCalledWith("ol_a", OWNED);
    const [lodgeId, from, to] = mocks.freeBedsForStay.mock.calls[0];
    expect(lodgeId).toBe("lodge_local");
    expect((from as Date).toISOString().slice(0, 10)).toBe("2026-07-10");
    expect((to as Date).toISOString().slice(0, 10)).toBe("2026-07-13");
  });

  it("accepts a stay that starts today and one of exactly 30 nights", async () => {
    expect((await GET(request({ from: "2026-07-01", to: "2026-07-02" }))).status).toBe(200);
    expect((await GET(request({ from: "2026-07-01", to: "2026-07-31" }))).status).toBe(200);
  });

  describe("the signature", () => {
    it.each([
      ["no secret is stored (never registered)", () => mocks.getIntegrationCredentialValue.mockResolvedValue(null), {}],
      ["the signature is missing", () => undefined, { omitSignature: true }],
      ["it was signed with another secret", () => undefined, { secret: "t".repeat(64) }],
      ["the timestamp is too old", () => undefined, { timestamp: String(Date.now() - 6 * 60 * 1000) }],
      ["the timestamp is too far ahead", () => undefined, { timestamp: String(Date.now() + 6 * 60 * 1000) }],
      ["the timestamp is not a number", () => undefined, { timestamp: "soon" }],
      ["the signed lodge differs from the asked lodge", () => undefined, { signedText: "availability\nol_b\n2026-07-10\n2026-07-13" }],
      ["the signed dates differ from the asked dates", () => undefined, { signedText: "availability\nol_a\n2026-07-10\n2026-07-20" }],
    ])("is 401 when %s, and nothing is read", async (_label, arrange, options) => {
      arrange();
      const res = await GET(request(STAY, options));
      expect(res.status).toBe(401);
      expect(mocks.loadServerNzSettings).not.toHaveBeenCalled();
      expect(mocks.freeBedsForStay).not.toHaveBeenCalled();
    });

    it("refuses a valid PUSH signature replayed here (the texts can never be equal)", async () => {
      // A body the doorbell would accept, signed exactly as the doorbell's is.
      const pushBody = JSON.stringify({ event: "post.shared", postId: "srv-1" });
      const res = await GET(request(STAY, { signedText: pushBody }));
      expect(res.status).toBe(401);
    });

    it("verifies the same signed question however a proxy encoded the address (D1)", async () => {
      const timestamp = String(Date.now());
      const lodgeId = "ol a&b";
      const signature = sign(`availability\n${lodgeId}\n2026-07-10\n2026-07-13`, timestamp);
      mocks.loadServerNzSettings.mockResolvedValue({
        otherLodgesEnabled: true,
        otherLodgesOwnedLodges: [{ id: lodgeId, name: "Odd id" }],
      });
      for (const encoded of ["ol%20a%26b", "ol+a%26b"]) {
        const res = await GET(
          new NextRequest(
            `https://club.test/api/webhooks/servernz-availability?lodgeId=${encoded}&from=2026-07-10&to=2026-07-13`,
            { headers: { "x-acs-timestamp": timestamp, "x-acs-signature": signature } },
          ),
        );
        expect(res.status, encoded).toBe(200);
      }
    });

    it("judges the signature before the query, so an unsigned caller cannot tell a bad query apart", async () => {
      const res = await GET(request({ from: "not-a-date" }, { omitSignature: true }));
      expect(res.status).toBe(401);
    });
  });

  describe("the stay", () => {
    it.each([
      ["a date that is not a real day", { from: "2026-02-30" }],
      ["check-out on the check-in day", { from: "2026-07-10", to: "2026-07-10" }],
      ["check-out before check-in", { from: "2026-07-10", to: "2026-07-09" }],
      ["31 nights", { from: "2026-07-01", to: "2026-08-01" }],
      ["a check-out thousands of years away", { from: "2026-07-01", to: "9999-12-31" }],
      ["a check-in in the past", { from: "2026-06-30", to: "2026-07-02" }],
      ["a check-in more than 730 days ahead", { from: "2028-07-01", to: "2028-07-02" }],
    ])("is 400 for %s (signed correctly)", async (_label, query) => {
      const res = await GET(request(query));
      expect(res.status).toBe(400);
      expect(mocks.freeBedsForStay).not.toHaveBeenCalled();
    });
  });

  describe("which lodge: every refusal is the same 404", () => {
    it("when Other lodges sharing is off", async () => {
      mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesEnabled: false, otherLodgesOwnedLodges: OWNED });
      const res = await GET(request());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Lodge not available" });
      expect(mocks.resolveLocalLodgeForCentralId).not.toHaveBeenCalled();
    });

    it("when the lodge is unknown, unowned, unlinked or inactive (one resolver answer)", async () => {
      mocks.resolveLocalLodgeForCentralId.mockResolvedValue(null);
      const res = await GET(request({ lodgeId: "ol_somebody_else" }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Lodge not available" });
      expect(mocks.freeBedsForStay).not.toHaveBeenCalled();
    });
  });

  it("is rate-limited before anything else is read", async () => {
    mocks.applyRateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const res = await GET(request());
    expect(res.status).toBe(429);
    expect(mocks.getIntegrationCredentialValue).not.toHaveBeenCalled();
  });
});
