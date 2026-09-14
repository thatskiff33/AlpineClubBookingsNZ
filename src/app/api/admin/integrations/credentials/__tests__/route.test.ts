import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  setIntegrationCredential: vi.fn(),
  createAuditLog: vi.fn(),
  deleteXeroTokens: vi.fn(),
  clearStripeWebhookVerified: vi.fn(),
  loggerError: vi.fn(),
  findMany: vi.fn(),
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
  setIntegrationCredential: mocks.setIntegrationCredential,
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
vi.mock("@/lib/xero-token-store", () => ({ deleteXeroTokens: mocks.deleteXeroTokens }));
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

  it("applies verify-reset (drops Xero tokens) on a client-credential write", async () => {
    asFullAdmin();
    await POST(makeRequest({ provider: "xero", key: "client_secret", value: SECRET_VALUE }));
    expect(mocks.deleteXeroTokens).toHaveBeenCalledTimes(1);
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
    expect(mocks.deleteXeroTokens).not.toHaveBeenCalled();
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
    expect(mocks.deleteXeroTokens).not.toHaveBeenCalled();
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
    expect(mocks.deleteXeroTokens).not.toHaveBeenCalled();
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
