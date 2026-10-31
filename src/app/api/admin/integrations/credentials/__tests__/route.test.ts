import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  setIntegrationCredential: vi.fn(),
  deleteIntegrationCredential: vi.fn(),
  createAuditLog: vi.fn(),
  // #3454: the Xero verify-reset runs the credential write and the token
  // destruction in ONE transaction; this double runs the write it is handed.
  withXeroVerifyReset: vi.fn(
    async (_params: unknown, work: (tx: unknown) => Promise<unknown>) =>
      work({ transaction: "xero-verify-reset" }),
  ),
  clearStripeWebhookVerified: vi.fn(),
  loggerError: vi.fn(),
  findMany: vi.fn(),
  forgetServerConnectionAnswers: vi.fn(),
  lockServerNzSettings: vi.fn(),
  tx: { serverNzSettings: { createMany: vi.fn(), findUnique: vi.fn() } },
}));

const SHOWN_URL = "https://central.example.invalid";

vi.mock("@/lib/servernz-settings", () => ({
  forgetServerConnectionAnswers: mocks.forgetServerConnectionAnswers,
  lockServerNzSettings: mocks.lockServerNzSettings,
  SERVERNZ_SETTINGS_ID: "default",
  SERVERNZ_TRANSACTION_OPTIONS: { timeout: 150_000, maxWait: 10_000 },
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findMany: mocks.findMany } },
}));
// PARTIAL, deliberately. This route reads `INTEGRATION_CREDENTIAL_VALUE_MAX_LENGTH`
// from this module at IMPORT time — it bounds the zod schema — so a factory that
// returns only the writer kills the whole file before a test runs. Spelling the
// number here instead would put a second copy of the cap in the tree, which is the
// duplication #2940 removed; `importOriginal` keeps the one home and mocks only the
// call that must not reach the database.
// The cast sits OUTSIDE the call on purpose (#3318): an `import()` type inside a
// type argument makes Semgrep skip the rest of this file while still exiting 0.
vi.mock("@/lib/integration-credentials", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/integration-credentials")),
  withCredentialTransaction: async (_providers: unknown, work: (tx: unknown) => Promise<unknown>) => work(mocks.tx),
  setIntegrationCredential: mocks.setIntegrationCredential,
  // The in-transaction write is the same writer with the caller's `tx`, so the
  // same double serves both and every assertion below reads either.
  setIntegrationCredentialInTransaction: mocks.setIntegrationCredential,
  // #4470: a ServerNZ key replacement removes the push secret in its fence.
  deleteIntegrationCredentialInTransaction: mocks.deleteIntegrationCredential,
}));
vi.mock("@/lib/stripe-config", () => ({
  STRIPE_PROVIDER: "stripe",
  STRIPE_WRITABLE_CREDENTIAL_KEYS: [
    "secret_key",
    "publishable_key",
    "webhook_secret",
  ],
  clearStripeWebhookVerified: mocks.clearStripeWebhookVerified,
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: () => ({ id: null, ipAddress: "1.2.3.4", userAgent: "test" }),
}));
// PARTIAL: which keys reset the tokens is the token store's rule, so the real
// predicate decides; only the database-touching reset is replaced.
vi.mock("@/lib/xero-verify-reset", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-verify-reset")),
  withXeroVerifyReset: mocks.withXeroVerifyReset,
}));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { WeakAuthSecretError } from "@/lib/integration-crypto";
import { GET, POST } from "../route";

const SECRET_VALUE = "super-secret-xero-client-secret-value";

function makeRequest(body: unknown) {
  return new Request("https://club.example.com/api/admin/integrations/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(provider: string) {
  return new Request(
    `https://club.example.com/api/admin/integrations/credentials?provider=${provider}`,
    { method: "GET" },
  );
}

function asAdmin(accessRoles: string[], fullAdmin: boolean) {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles } },
  });
  mocks.isFullAdmin.mockReturnValue(fullAdmin);
}

function asFullAdmin() {
  asAdmin(["ADMIN"], true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.serverNzSettings.findUnique.mockResolvedValue({ baseUrl: SHOWN_URL });
  mocks.setIntegrationCredential.mockResolvedValue({
    provider: "xero",
    key: "client_secret",
    secretSource: "AUTH_SECRET",
    labelVersion: "integration-credential:v1",
    updatedAt: new Date("2026-07-21T10:00:00.000Z"),
  });
});

describe("POST /api/admin/integrations/credentials", () => {
  it("rejects a non-Full-Admin with 403 and writes nothing", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "area-admin", accessRoles: ["FINANCE_ADMIN"] } },
    });
    mocks.isFullAdmin.mockReturnValue(false);

    const res = await POST(
      makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }),
    );
    expect(res.status).toBe(403);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("stores a credential, returns metadata only (no value), and audits metadata only", async () => {
    asFullAdmin();
    const res = await POST(
      makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }),
    );
    expect(res.status).toBe(200);

    const json = await res.json();
    // Exposure: the value never appears in the response.
    expect(JSON.stringify(json)).not.toContain(SECRET_VALUE);
    expect(json).toMatchObject({ ok: true, provider: "xero", key: "client_secret" });
    expect(json.setAt).toBe("2026-07-21T10:00:00.000Z");

    // The audit row is no longer this route's to write (#2723): the store
    // writes it inside the transaction that writes the secret, so a crash
    // between the two cannot leave a rewritten credential with no evidence.
    // What the route still owns is naming the actor and handing the store the
    // request context, and `credential-write-contract.test.ts` is where the row
    // itself — and its freedom from the plaintext — is asserted.
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    const write = mocks.setIntegrationCredential.mock.calls[0][0];
    expect(JSON.stringify({ ...write, value: undefined })).not.toContain(
      SECRET_VALUE,
    );
    expect(write).toMatchObject({
      provider: "xero",
      key: "client_secret",
      actor: { kind: "admin", memberId: "admin-1" },
      expect: { expect: "any" },
    });
    expect(write.request).toBeDefined();
  });

  it("applies verify-reset (drops Xero tokens) on a client-credential write, in the write's transaction", async () => {
    asFullAdmin();
    await POST(makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }));
    expect(mocks.withXeroVerifyReset).toHaveBeenCalledTimes(1);
    expect(mocks.withXeroVerifyReset.mock.calls[0][0]).toMatchObject({
      actor: { kind: "admin", memberId: "admin-1" },
      causedByCredential: "xero:client_secret",
    });
    // The credential write ran INSIDE the reset's transaction (#3454): it was
    // handed the transaction client the reset opened.
    expect(mocks.setIntegrationCredential).toHaveBeenCalledTimes(1);
    expect(mocks.setIntegrationCredential.mock.calls[0][0].tx).toEqual({
      transaction: "xero-verify-reset",
    });
  });

  it("does NOT drop Xero tokens when only the webhook key changes", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockResolvedValue({
      provider: "xero",
      key: "webhook_key",
      secretSource: "AUTH_SECRET",
      labelVersion: "integration-credential:v1",
      updatedAt: new Date(),
    });
    await POST(makeRequest({ provider: "xero", key: "webhook_key", value: "hook" }));
    expect(mocks.withXeroVerifyReset).not.toHaveBeenCalled();
  });

  it("applies Stripe verify-reset (drops the webhook-verified marker) on any Stripe write", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockResolvedValue({
      provider: "stripe",
      key: "webhook_secret",
      secretSource: "AUTH_SECRET",
      labelVersion: "integration-credential:v1",
      updatedAt: new Date("2026-07-21T10:00:00.000Z"),
    });
    const res = await POST(
      makeRequest({ provider: "stripe", key: "webhook_secret", value: "whsec_x" }),
    );
    expect(res.status).toBe(200);
    expect(mocks.clearStripeWebhookVerified).toHaveBeenCalledTimes(1);
    // ONE administrator, ONE actor, ONE request (#2723 review). The reset used
    // to hard-code a `stripe-verify-reset` system actor, so a single Save wrote
    // one row naming the person and one naming a job with a null member.
    const [resetActor, resetRequest] =
      mocks.clearStripeWebhookVerified.mock.calls[0];
    expect(resetActor).toEqual({ kind: "admin", memberId: "admin-1" });
    expect(resetRequest).toBe(
      mocks.setIntegrationCredential.mock.calls[0][0].request,
    );
    // Cross-provider isolation: a Stripe write never touches Xero tokens.
    expect(mocks.withXeroVerifyReset).not.toHaveBeenCalled();
  });

  it("forgets the owned-lodge list when the Alpine Central Server key is replaced (#52)", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockResolvedValue({
      provider: "servernz",
      key: "api_key",
      secretSource: "AUTH_SECRET",
      labelVersion: "integration-credential:v1",
      updatedAt: new Date(),
    });
    const res = await POST(makeRequest({ provider: "servernz", key: "api_key", value: "acs_replacement", expectedBaseUrl: SHOWN_URL }));
    expect(res.status).toBe(200);
    // #49: and the server's last reported version with it, in one write.
    expect(mocks.forgetServerConnectionAnswers).toHaveBeenCalledTimes(1);
    expect(mocks.forgetServerConnectionAnswers).toHaveBeenCalledWith(mocks.tx);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledWith(expect.objectContaining({ tx: mocks.tx }));
    expect(mocks.lockServerNzSettings).toHaveBeenCalledWith(mocks.tx);
    expect(mocks.lockServerNzSettings.mock.invocationCallOrder[0]).toBeLessThan(mocks.setIntegrationCredential.mock.invocationCallOrder[0]);
    expect(mocks.setIntegrationCredential.mock.invocationCallOrder[0]).toBeLessThan(mocks.forgetServerConnectionAnswers.mock.invocationCallOrder[0]);
    // #4470: the old key's push registration goes with it, by the same admin.
    expect(mocks.deleteIntegrationCredential).toHaveBeenCalledWith(expect.objectContaining({
      tx: mocks.tx, provider: "servernz", key: "push_secret", actor: { kind: "admin", memberId: "admin-1" },
    }));
  });

  it("does not report success when the connection-answer reset fails", async () => {
    asFullAdmin();
    mocks.forgetServerConnectionAnswers.mockRejectedValueOnce(new Error("reset failed"));
    const res = await POST(makeRequest({ provider: "servernz", key: "api_key", value: "replacement", expectedBaseUrl: SHOWN_URL }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("replacement");
  });

  describe("the ServerNZ key names the address the page showed (#4470)", () => {
    it("answers 409 with the reload message and writes nothing when the address moved", async () => {
      asFullAdmin();
      mocks.tx.serverNzSettings.findUnique.mockResolvedValue({ baseUrl: "https://moved.example.invalid" });
      const res = await POST(makeRequest({
        provider: "servernz", key: "api_key", value: "acs_old_server_key", expectedBaseUrl: SHOWN_URL,
      }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("address-changed");
      expect(body.error).toMatch(/Reload the page/);
      expect(JSON.stringify(body)).not.toContain("acs_old_server_key");
      expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
      expect(mocks.forgetServerConnectionAnswers).not.toHaveBeenCalled();
      expect(mocks.loggerError).not.toHaveBeenCalled();
    });

    it("saves a first key when the page showed no address and none is stored", async () => {
      asFullAdmin();
      mocks.tx.serverNzSettings.findUnique.mockResolvedValue({ baseUrl: null });
      const res = await POST(makeRequest({ provider: "servernz", key: "api_key", value: "acs_first", expectedBaseUrl: null }));
      expect(res.status).toBe(200);
      expect(mocks.setIntegrationCredential).toHaveBeenCalledTimes(1);
    });

    it("refuses a Save that does not say which address it was for, before any transaction", async () => {
      asFullAdmin();
      const res = await POST(makeRequest({ provider: "servernz", key: "api_key", value: "acs_unanchored" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Reload the page/);
      expect(mocks.lockServerNzSettings).not.toHaveBeenCalled();
      expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
    });

    it("refuses the address on every other credential, which it does not describe", async () => {
      asFullAdmin();
      const res = await POST(makeRequest({
        provider: "xero", key: "client_secret", value: SECRET_VALUE, expectedBaseUrl: SHOWN_URL,
      }));
      expect(res.status).toBe(400);
      expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
    });
  });

  it("does NOT forget the owned-lodge list on another provider's write", async () => {
    asFullAdmin();
    await POST(makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }));
    expect(mocks.forgetServerConnectionAnswers).not.toHaveBeenCalled();
  });

  it("fences the ServerNZ API key by key, not by provider alone (#4436)", async () => {
    // Only the API key pairs with the server address, so the branch names it.
    // The allowlist holds that key alone today (its type says so); widen it
    // here to prove another ServerNZ key would not borrow the key's fence.
    asFullAdmin();
    vi.resetModules();
    vi.doMock("@/lib/servernz-config", async (importOriginal) => ({
      ...((await importOriginal()) as typeof import("@/lib/servernz-config")),
      SERVERNZ_WRITABLE_CREDENTIAL_KEYS: ["api_key", "future_key"],
    }));
    try {
      const { POST: widenedPost } = await import("../route");
      const res = await widenedPost(makeRequest({ provider: "servernz", key: "future_key", value: "not-the-api-key" }));
      expect(res.status).toBe(200);
      expect(mocks.lockServerNzSettings).not.toHaveBeenCalled();
      expect(mocks.forgetServerConnectionAnswers).not.toHaveBeenCalled();
      expect(mocks.setIntegrationCredential).toHaveBeenCalledTimes(1);
      expect(mocks.setIntegrationCredential.mock.calls[0]![0]).toMatchObject({ provider: "servernz", key: "future_key" });
      expect(mocks.setIntegrationCredential.mock.calls[0]![0]).not.toHaveProperty("tx");
    } finally {
      vi.doUnmock("@/lib/servernz-config");
      vi.resetModules();
    }
  });

  it("accepts the Stripe secret key via the extended allowlist", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockResolvedValue({
      provider: "stripe",
      key: "secret_key",
      secretSource: "AUTH_SECRET",
      labelVersion: "integration-credential:v1",
      updatedAt: new Date("2026-07-21T10:00:00.000Z"),
    });
    const res = await POST(
      makeRequest({ provider: "stripe", key: "secret_key", value: "sk_test_x" }),
    );
    expect(res.status).toBe(200);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledTimes(1);
  });

  it("accepts the Anthropic api_key via the extended allowlist (#2211)", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockResolvedValue({
      provider: "anthropic",
      key: "api_key",
      secretSource: "AUTH_SECRET",
      labelVersion: "integration-credential:v1",
      updatedAt: new Date("2026-07-23T10:00:00.000Z"),
    });
    const res = await POST(
      makeRequest({ provider: "anthropic", key: "api_key", value: "sk-ant-xxx" }),
    );
    expect(res.status).toBe(200);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledTimes(1);
    // No verify-reset side-effect for anthropic (no verified marker exists).
    expect(mocks.withXeroVerifyReset).not.toHaveBeenCalled();
    expect(mocks.clearStripeWebhookVerified).not.toHaveBeenCalled();
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("sk-ant-xxx");
  });

  it("rejects an unknown anthropic key (only api_key is writable)", async () => {
    asFullAdmin();
    const res = await POST(
      makeRequest({ provider: "anthropic", key: "not_a_key", value: "x" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("rejects the internal webhook_verified marker key (not writable via the API)", async () => {
    asFullAdmin();
    const res = await POST(
      makeRequest({ provider: "stripe", key: "webhook_verified", value: "x" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("rejects a non-postgres restore-validation DSN with 400 and writes nothing (#2095 MAJOR-2)", async () => {
    asFullAdmin();
    // libpq keyword-form conninfo is not a parseable postgres:// URI.
    const res = await POST(
      makeRequest({
        provider: "backup",
        key: "restore_validation_url",
        value: "host=shadow password=s3cr3t dbname=x",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/postgres/i);
    expect(JSON.stringify(json)).not.toContain("s3cr3t");
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("accepts a valid postgres:// restore-validation DSN (#2095 MAJOR-2)", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockResolvedValue({
      provider: "backup",
      key: "restore_validation_url",
      secretSource: "AUTH_SECRET",
      labelVersion: "integration-credential:v1",
      updatedAt: new Date("2026-07-21T10:00:00.000Z"),
    });
    const res = await POST(
      makeRequest({
        provider: "backup",
        key: "restore_validation_url",
        value: "postgresql://tac:s3cr3t@shadow:5432/shadow_db",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledTimes(1);
    // Exposure: the value never appears in the response.
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("s3cr3t");
  });

  it("rejects an unknown provider/key with 400", async () => {
    asFullAdmin();
    const res = await POST(
      makeRequest({ provider: "xero", key: "not_a_real_key", value: "x" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("surfaces the weak-auth-secret gate as a plain-English 400", async () => {
    asFullAdmin();
    mocks.setIntegrationCredential.mockRejectedValue(
      new WeakAuthSecretError("The auth secret is still the .env.example placeholder."),
    );
    const res = await POST(
      makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/placeholder/i);
    expect(JSON.stringify(json)).not.toContain(SECRET_VALUE);
  });
});

describe("GET /api/admin/integrations/credentials (metadata-only)", () => {
  it("returns set/not-set + setAt + secretSource, and NEVER a value or ciphertext", async () => {
    // Any admin may read status (area admins keep visibility, epic decision 4).
    asAdmin(["FINANCE_ADMIN"], false);
    mocks.findMany.mockResolvedValue([
      {
        key: "client_id",
        secretSource: "AUTH_SECRET",
        updatedAt: new Date("2026-07-21T10:00:00.000Z"),
      },
    ]);

    const res = await GET(makeGetRequest("xero"));
    expect(res.status).toBe(200);
    const json = await res.json();

    // client_id is set with its metadata; the other keys are simply absent.
    expect(json).toMatchObject({
      provider: "xero",
      credentials: {
        client_id: {
          set: true,
          setAt: "2026-07-21T10:00:00.000Z",
          secretSource: "AUTH_SECRET",
        },
      },
    });
    expect(json.credentials.client_secret).toBeUndefined();

    // Exposure contract: no value/ciphertext/iv/authTag anywhere in the body,
    // and the DB query itself selects only metadata columns.
    const serialized = JSON.stringify(json);
    for (const forbidden of ["ciphertext", "iv", "authTag", "value"]) {
      expect(serialized).not.toContain(forbidden);
    }
    const selectArg = mocks.findMany.mock.calls[0][0].select;
    expect(selectArg).toEqual({ key: true, secretSource: true, updatedAt: true });
  });

  it("rejects an unknown provider with 400", async () => {
    asAdmin(["ADMIN"], true);
    const res = await GET(makeGetRequest("not_a_provider"));
    expect(res.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller via the admin guard", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const res = await GET(makeGetRequest("xero"));
    expect(res.status).toBe(401);
  });
});
