import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared-post push webhook (epic #2992).
 *
 * An unauthenticated endpoint whose whole security story is the signature
 * check, so that check is what gets tested: wrong secret, missing headers,
 * stale timestamp, and — because the compare is over what WE compute — a body
 * that was tampered with after signing. The happy path matters only in that a
 * valid push triggers a sync.
 */

const mocks = vi.hoisted(() => ({
  runMirrorSync: vi.fn(),
  getIntegrationCredentialValue: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  after: vi.fn(),
}));

vi.mock("@/lib/club-post-mirror", () => ({
  runMirrorSync: mocks.runMirrorSync,
  SERVERNZ_PUSH_SECRET_KEY: "push_secret",
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

// `after` needs a request context in tests; run the task inline instead so the
// assertion can await its effect.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => Promise<void>) => {
      mocks.after(task);
      void task();
    },
  };
});

import { POST } from "@/app/api/webhooks/servernz-posts/route";

const SECRET = "s".repeat(64);

function signedRequest(options: {
  body?: string;
  secret?: string;
  timestamp?: string;
  tamper?: boolean;
  omitSignature?: boolean;
} = {}): NextRequest {
  const body =
    options.body ?? JSON.stringify({ event: "post.shared", postId: "srv-1" });
  const timestamp = options.timestamp ?? String(Date.now());
  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-acs-timestamp": timestamp,
  };
  if (!options.omitSignature) headers["x-acs-signature"] = signature;

  return new NextRequest("https://club.example.nz/api/webhooks/servernz-posts", {
    method: "POST",
    headers,
    body: options.tamper ? body.replace("srv-1", "srv-2") : body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadEffectiveModuleFlags.mockResolvedValue({ commsPortal: true });
  mocks.getIntegrationCredentialValue.mockResolvedValue(SECRET);
  mocks.runMirrorSync.mockResolvedValue({ upserted: 0, removed: 0, pages: 1 });
});

describe("POST /api/webhooks/servernz-posts", () => {
  it("accepts a correctly signed push and triggers a sync", async () => {
    const res = await POST(signedRequest());
    expect(res.status).toBe(200);
    expect(mocks.runMirrorSync).toHaveBeenCalled();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const res = await POST(signedRequest({ secret: "w".repeat(64) }));
    expect(res.status).toBe(401);
    expect(mocks.runMirrorSync).not.toHaveBeenCalled();
  });

  it("rejects a body tampered with after signing", async () => {
    const res = await POST(signedRequest({ tamper: true }));
    expect(res.status).toBe(401);
    expect(mocks.runMirrorSync).not.toHaveBeenCalled();
  });

  it("rejects a missing signature", async () => {
    const res = await POST(signedRequest({ omitSignature: true }));
    expect(res.status).toBe(401);
  });

  it("rejects a replayed request from outside the tolerance window", async () => {
    // Correctly signed — the attacker captured a real delivery — but ten
    // minutes old. The signature covers the timestamp, so it cannot be
    // refreshed without the secret.
    const stale = String(Date.now() - 10 * 60 * 1000);
    const res = await POST(signedRequest({ timestamp: stale }));
    expect(res.status).toBe(401);
    expect(mocks.runMirrorSync).not.toHaveBeenCalled();
  });

  it("rejects a garbage timestamp", async () => {
    const res = await POST(signedRequest({ timestamp: "yesterday" }));
    expect(res.status).toBe(401);
  });

  it("answers 401 when no secret is stored, so the server sees its pushes failing", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    const res = await POST(signedRequest());
    expect(res.status).toBe(401);
  });

  it("answers 200-ignored with the module off, so the server stops retrying", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ commsPortal: false });
    const res = await POST(signedRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "module-off" });
    expect(mocks.runMirrorSync).not.toHaveBeenCalled();
  });

  it("keeps answering 200 when the triggered sync fails, because polling covers it", async () => {
    mocks.runMirrorSync.mockRejectedValue(new Error("server down"));
    const res = await POST(signedRequest());
    expect(res.status).toBe(200);
  });
});
