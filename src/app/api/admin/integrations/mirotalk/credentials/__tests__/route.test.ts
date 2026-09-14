import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The MiroTalk secret route (#2940), and the reason it exists separately from
 * the shared credentials route: every write from this screen declares what it
 * expects to find, so a second administrator who saved in between makes this
 * one LOSE rather than silently overwrite them.
 *
 * The assertions that matter most here are the negative ones. No response, no
 * log line and no error may carry the value, and no request may reach the store
 * with `{ expect: "any" }` — which is the expectation that makes a stale write
 * win, and which a client must not be able to ask for.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  setMirotalkSecret: vi.fn(),
  clearMirotalkSecret: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/mirotalk-config", () => ({
  setMirotalkSecret: mocks.setMirotalkSecret,
  clearMirotalkSecret: mocks.clearMirotalkSecret,
}));
vi.mock("@/lib/audit", () => ({
  getAuditRequestContext: () => ({
    id: "req-1",
    ipAddress: "1.2.3.4",
    userAgent: "test",
  }),
}));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { StaleCredentialWriteError } from "@/lib/integration-credential-actor";
import { DELETE, POST } from "../route";

const SECRET = "an-unmistakable-mirotalk-signing-key-value";

function postRequest(body: unknown) {
  return new Request(
    "https://club.example.com/api/admin/integrations/mirotalk/credentials",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function deleteRequest(query: string) {
  return new Request(
    `https://club.example.com/api/admin/integrations/mirotalk/credentials?${query}`,
    { method: "DELETE" },
  );
}

function asAdmin(fullAdmin: boolean) {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles: ["ADMIN"] } },
  });
  mocks.isFullAdmin.mockReturnValue(fullAdmin);
}

beforeEach(() => {
  vi.clearAllMocks();
  asAdmin(true);
  mocks.setMirotalkSecret.mockResolvedValue(undefined);
  mocks.clearMirotalkSecret.mockResolvedValue(undefined);
});

describe("POST", () => {
  it("needs Full Admin", async () => {
    asAdmin(false);
    const res = await POST(
      postRequest({ key: "jwt_key", value: SECRET, version: null }),
    );
    expect(res.status).toBe(403);
    expect(mocks.setMirotalkSecret).not.toHaveBeenCalled();
  });

  it("refuses a key outside the closed set", async () => {
    const res = await POST(
      postRequest({ key: "anything_else", value: SECRET, version: null }),
    );
    expect(res.status).toBe(400);
    expect(mocks.setMirotalkSecret).not.toHaveBeenCalled();
  });

  it("turns 'the screen said nothing was stored' into a create-only write", async () => {
    await POST(postRequest({ key: "jwt_key", value: SECRET, version: null }));
    const call = mocks.setMirotalkSecret.mock.calls[0][0];
    expect(call.expect).toEqual({ expect: "absent" });
    expect(call.actor).toEqual({ kind: "admin", memberId: "admin-1" });
    expect(call.request.id).toBe("req-1");
  });

  it("turns a version the screen was shown into a compare-and-set", async () => {
    await POST(
      postRequest({ key: "meeting_password", value: SECRET, version: "ver-9" }),
    );
    expect(mocks.setMirotalkSecret.mock.calls[0][0].expect).toEqual({
      expect: "version",
      version: "ver-9",
    });
  });

  it("never lets a client ask for an unconditional overwrite", async () => {
    // `{ expect: "any" }` is the one expectation a stale writer can win with,
    // so the wire format cannot express it: the body carries a version or null.
    await POST(
      postRequest({
        key: "jwt_key",
        value: SECRET,
        version: null,
        expect: { expect: "any" },
      }),
    );
    // The body is `.strict()`, so an extra key is a 400 rather than something
    // that reaches the store.
    expect(mocks.setMirotalkSecret).not.toHaveBeenCalled();
  });

  it("reports a lost race as a conflict rather than a success", async () => {
    mocks.setMirotalkSecret.mockRejectedValue(
      new StaleCredentialWriteError({
        provider: "mirotalk",
        key: "jwt_key",
        expectation: { expect: "version", version: "ver-old" },
        observedVersion: "ver-new",
      }),
    );
    const res = await POST(
      postRequest({ key: "jwt_key", value: SECRET, version: "ver-old" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Somebody else changed");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("returns no value, and logs none on failure", async () => {
    const ok = await POST(
      postRequest({ key: "jwt_key", value: SECRET, version: null }),
    );
    expect(JSON.stringify(await ok.json())).not.toContain(SECRET);

    mocks.setMirotalkSecret.mockRejectedValue(new Error("boom"));
    const failed = await POST(
      postRequest({ key: "meeting_password", value: SECRET, version: null }),
    );
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain(SECRET);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(SECRET);
  });

  it("warns about a weak signing key without blocking it or echoing it", async () => {
    const res = await POST(
      postRequest({ key: "jwt_key", value: "mirotalk", version: null }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toContain("shipped example value");
    // Advisory, not a refusal: a club whose links stop working is worse off.
    expect(mocks.setMirotalkSecret).toHaveBeenCalled();
  });

  it("says nothing about a strong key, or about the other two secrets", async () => {
    const strong = await POST(
      postRequest({
        key: "jwt_key",
        value: "Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu2",
        version: null,
      }),
    );
    expect((await strong.json()).warning).toBeNull();

    const username = await POST(
      postRequest({ key: "meeting_username", value: "mirotalk", version: null }),
    );
    expect((await username.json()).warning).toBeNull();
  });
});

describe("DELETE", () => {
  it("needs Full Admin", async () => {
    asAdmin(false);
    const res = await DELETE(deleteRequest("key=jwt_key&version=ver-1"));
    expect(res.status).toBe(403);
    expect(mocks.clearMirotalkSecret).not.toHaveBeenCalled();
  });

  it("refuses a clear with nothing to compare against", async () => {
    // Without a version there is no fence, and an unconditional delete is
    // exactly the lost-race-reported-as-a-win this route exists to prevent.
    const res = await DELETE(deleteRequest("key=jwt_key"));
    expect(res.status).toBe(400);
    expect(mocks.clearMirotalkSecret).not.toHaveBeenCalled();
  });

  it("fences the clear on the version the screen was shown", async () => {
    const res = await DELETE(deleteRequest("key=meeting_password&version=ver-3"));
    expect(res.status).toBe(200);
    expect(mocks.clearMirotalkSecret.mock.calls[0][0].expect).toEqual({
      expect: "version",
      version: "ver-3",
    });
  });

  it("reports a lost race as a conflict", async () => {
    mocks.clearMirotalkSecret.mockRejectedValue(
      new StaleCredentialWriteError({
        provider: "mirotalk",
        key: "meeting_password",
        expectation: { expect: "version", version: "ver-3" },
        observedVersion: "ver-4",
      }),
    );
    const res = await DELETE(deleteRequest("key=meeting_password&version=ver-3"));
    expect(res.status).toBe(409);
  });
});
