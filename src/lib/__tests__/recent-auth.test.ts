/**
 * #4616 (INV-AUTH-008): `requireRecentAuth`, the one recent-authentication
 * check, and `markSessionReauthenticated`, the step-up route's only way to
 * move the stamp. The session they read is mocked here; that the stamp is
 * written only by sign-in and a consumed challenge is proved end to end in
 * `auth-recent-auth-claim.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  updateSession: vi.fn(),
  createSessionReauthChallenge: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
  updateSession: mocks.updateSession,
}));

vi.mock("@/lib/prisma", () => ({ prisma: { member: { findUnique: vi.fn() } } }));

vi.mock("@/lib/session-reauth-challenge", () => ({
  createSessionReauthChallenge: mocks.createSessionReauthChallenge,
}));

import { markSessionReauthenticated, requireRecentAuth } from "@/lib/recent-auth";
import {
  RECENT_AUTH_REQUIRED_CODE,
  RECENT_AUTH_WINDOW_MS,
  isRecentAuthRefusal,
} from "@/lib/recent-auth-policy";

const SECOND_MS = 1000;

function sessionAuthenticatedAt(lastAuthenticatedAt: number | undefined) {
  return {
    user: {
      id: "officer-1",
      ...(lastAuthenticatedAt === undefined ? {} : { lastAuthenticatedAt }),
    },
  };
}

describe("requireRecentAuth (#4616)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits a session that proved itself just now, and at exactly five minutes", async () => {
    mocks.auth.mockResolvedValue(sessionAuthenticatedAt(Date.now()));
    expect(await requireRecentAuth()).toEqual({ ok: true });

    mocks.auth.mockResolvedValue(sessionAuthenticatedAt(Date.now() - RECENT_AUTH_WINDOW_MS));
    expect(await requireRecentAuth()).toEqual({ ok: true });
  });

  it("refuses a proof five minutes and one second old with the typed refusal the dialog recognises", async () => {
    mocks.auth.mockResolvedValue(
      sessionAuthenticatedAt(Date.now() - RECENT_AUTH_WINDOW_MS - SECOND_MS),
    );
    const result = await requireRecentAuth();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(await isRecentAuthRefusal(result.response)).toBe(true);
    expect(await result.response.json()).toMatchObject({ code: RECENT_AUTH_REQUIRED_CODE });
  });

  it("refuses a session that carries no stamp at all (a token from before #4616)", async () => {
    mocks.auth.mockResolvedValue(sessionAuthenticatedAt(undefined));
    const result = await requireRecentAuth();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(await isRecentAuthRefusal(result.response)).toBe(true);
  });

  it("answers 401, not the step-up refusal, when there is no session", async () => {
    mocks.auth.mockResolvedValue(null);
    const result = await requireRecentAuth();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(await isRecentAuthRefusal(result.response)).toBe(false);
  });
});

describe("markSessionReauthenticated (#4616)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSessionReauthChallenge.mockResolvedValue("minted-reauth-token");
  });

  it("mints a challenge and passes only its token through the session update", async () => {
    mocks.updateSession.mockResolvedValue(sessionAuthenticatedAt(Date.now()));

    expect(await markSessionReauthenticated("officer-1")).toBe(true);
    expect(mocks.createSessionReauthChallenge).toHaveBeenCalledWith("officer-1");
    // No stamp of its own: the jwt callback decides, on consuming the token.
    expect(mocks.updateSession).toHaveBeenCalledWith({
      user: { reauthChallengeToken: "minted-reauth-token" },
    });
  });

  it.each([
    ["no session came back", null],
    ["the stamp did not move", sessionAuthenticatedAt(Date.now() - RECENT_AUTH_WINDOW_MS - 1)],
    ["it carries no stamp", sessionAuthenticatedAt(undefined)],
    ["it is another member's", { user: { id: "officer-2", lastAuthenticatedAt: Date.now() } }],
    [
      "it was invalidated",
      { user: { id: "officer-1", lastAuthenticatedAt: Date.now(), sessionInvalidated: true } },
    ],
  ])("reports failure when %s", async (_label, returned) => {
    mocks.updateSession.mockResolvedValue(returned);
    expect(await markSessionReauthenticated("officer-1")).toBe(false);
  });
});
