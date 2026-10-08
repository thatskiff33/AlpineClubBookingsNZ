import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindMany,
  mockGetValue,
  mockNeedsReentry,
  mockSetCredential,
  mockDeleteCredential,
  mockReadRow,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockGetValue: vi.fn(),
  mockReadRow: vi.fn(),
  mockNeedsReentry: vi.fn(),
  mockSetCredential: vi.fn(),
  mockDeleteCredential: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findMany: (...a: unknown[]) => mockFindMany(...a) },
  },
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: (...a: unknown[]) => mockGetValue(...a),
  providerNeedsReentry: (...a: unknown[]) => mockNeedsReentry(...a),
  setIntegrationCredential: (...a: unknown[]) => mockSetCredential(...a),
  deleteIntegrationCredential: (...a: unknown[]) => mockDeleteCredential(...a),
  readIntegrationCredentialRow: (...a: unknown[]) => mockReadRow(...a),
}));

/** The secret the route verified each event with, in these tests. */
const VERIFIED_WITH = "whsec_verified";

/** `readIntegrationCredentialRow`'s answer for a stored signing secret. */
function storedSecret(value: string) {
  return { status: "configured", value };
}

import {
  STRIPE_PROVIDER,
  STRIPE_WEBHOOK_VERIFIED_KEY,
  clearStripeWebhookVerified,
  getOperationalStripeSecretKey,
  getOperationalStripeWebhookSecret,
  getStripeSetupState,
  recordStripeWebhookVerified,
} from "@/lib/stripe-config";

/** `findMany`'s `select: { key, updatedAt }` projection, from pairs. */
function rows(pairs: [string, Date][]): { key: string; updatedAt: Date }[] {
  return pairs.map(([key, updatedAt]) => ({ key, updatedAt }));
}

describe("stripe-config resolvers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNeedsReentry.mockResolvedValue(false);
  });

  it("resolves the secret key from the encrypted store", async () => {
    mockGetValue.mockResolvedValue("sk_test_123");
    await expect(getOperationalStripeSecretKey()).resolves.toBe("sk_test_123");
    expect(mockGetValue).toHaveBeenCalledWith(STRIPE_PROVIDER, "secret_key");
  });

  it("is fail-closed: the webhook secret is undefined when unconfigured", async () => {
    mockGetValue.mockResolvedValue(null);
    await expect(getOperationalStripeWebhookSecret()).resolves.toBeUndefined();
  });

  it("clearStripeWebhookVerified attributes the delete to ITS CALLER", async () => {
    // As for Google (#2723 review): the one caller is the admin credential
    // write, so the marker deletion is that administrator's action, not a
    // background job's.
    mockDeleteCredential.mockResolvedValue(undefined);
    await clearStripeWebhookVerified(
      { kind: "admin", memberId: "member-7" },
      { id: "req-1", ipAddress: null, userAgent: null },
    );
    expect(mockDeleteCredential).toHaveBeenCalledWith({
      provider: STRIPE_PROVIDER,
      key: STRIPE_WEBHOOK_VERIFIED_KEY,
      actor: { kind: "admin", memberId: "member-7" },
      expect: { expect: "any" },
      request: { id: "req-1", ipAddress: null, userAgent: null },
    });
  });

  it("recordStripeWebhookVerified never throws even when the store errors", async () => {
    mockFindMany.mockResolvedValue(rows([["webhook_secret", new Date()]]));
    mockReadRow.mockResolvedValue(storedSecret(VERIFIED_WITH));
    mockSetCredential.mockRejectedValue(new Error("weak auth secret"));
    await expect(
      recordStripeWebhookVerified(VERIFIED_WITH),
    ).resolves.toBeUndefined();
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
  });
});

/**
 * The webhook route calls this on EVERY signature-verified event (live or test, #3975),
 * before idempotency handling, and since #2723 every credential mutation mints a
 * seven-year `security`/`important` audit row. A row per delivery of a freshness
 * timestamp buries the secret changes an operator came to the log for, so the
 * marker is stamped only when the freshness answer would change.
 */
describe("recordStripeWebhookVerified writes only when it would change the answer (#2723)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNeedsReentry.mockResolvedValue(false);
    mockSetCredential.mockResolvedValue(undefined);
    mockReadRow.mockResolvedValue(storedSecret(VERIFIED_WITH));
  });

  it("does NOT write when the marker is already fresh", async () => {
    mockFindMany.mockResolvedValue(
      rows([
        ["webhook_secret", new Date("2026-06-01T00:00:00.000Z")],
        ["webhook_verified", new Date("2026-06-02T00:00:00.000Z")],
      ]),
    );
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockSetCredential).not.toHaveBeenCalled();
    // The fresh path is the per-delivery path: it never re-reads the secret.
    expect(mockReadRow).not.toHaveBeenCalled();
  });

  it("writes when no marker is stored yet", async () => {
    mockFindMany.mockResolvedValue(
      rows([["webhook_secret", new Date("2026-06-01T00:00:00.000Z")]]),
    );
    await recordStripeWebhookVerified(
      VERIFIED_WITH,
      new Date("2026-06-03T00:00:00.000Z"),
    );
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
    expect(mockSetCredential.mock.calls[0]?.[0]).toMatchObject({
      provider: STRIPE_PROVIDER,
      key: STRIPE_WEBHOOK_VERIFIED_KEY,
      value: "2026-06-03T00:00:00.000Z",
      actor: { kind: "system", actor: "stripe-webhook-verify" },
    });
  });

  it("writes when the marker is STALE — the secret was swapped after it", async () => {
    mockFindMany.mockResolvedValue(
      rows([
        ["webhook_secret", new Date("2026-06-05T00:00:00.000Z")],
        ["webhook_verified", new Date("2026-06-02T00:00:00.000Z")],
      ]),
    );
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
  });

  it("writes when there is a marker but no stored secret — a marker attesting to nothing is not fresh", async () => {
    mockFindMany.mockResolvedValue(
      rows([["webhook_verified", new Date("2026-06-02T00:00:00.000Z")]]),
    );
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
  });
});

/**
 * #3975 review: an event verified under the OLD signing secret can reach the
 * write after an administrator saved a new one and verify-reset cleared the
 * marker. Stamping it then would date the marker after the new secret and turn
 * the badge green for a secret no event has proved.
 */
describe("recordStripeWebhookVerified attests only to the secret it was verified with (#3975)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetCredential.mockResolvedValue(undefined);
    // Verify-reset has cleared the marker: the write path is reached.
    mockFindMany.mockResolvedValue(
      rows([["webhook_secret", new Date("2026-06-05T00:00:00.000Z")]]),
    );
  });

  it("does NOT write when the stored secret changed after the event was verified", async () => {
    mockReadRow.mockResolvedValue(storedSecret("whsec_saved_meanwhile"));
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockSetCredential).not.toHaveBeenCalled();
  });

  it("writes when the stored secret is still the one the event was verified with", async () => {
    mockReadRow.mockResolvedValue(storedSecret(VERIFIED_WITH));
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
  });

  it("re-reads the secret from the database, not the per-process cache", async () => {
    mockReadRow.mockResolvedValue(storedSecret(VERIFIED_WITH));
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockReadRow).toHaveBeenCalledWith(
      expect.anything(),
      STRIPE_PROVIDER,
      "webhook_secret",
    );
    expect(mockGetValue).not.toHaveBeenCalled();
  });

  it("does NOT write when the stored secret is gone or no longer decrypts", async () => {
    mockReadRow.mockResolvedValue({ status: "not_configured" });
    await recordStripeWebhookVerified(VERIFIED_WITH);
    mockReadRow.mockResolvedValue({ status: "needs_reentry", reason: "x" });
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockSetCredential).not.toHaveBeenCalled();
  });

  it("clears the marker it just wrote when the secret was swapped between the write and the re-read", async () => {
    mockDeleteCredential.mockResolvedValue(undefined);
    mockReadRow
      .mockResolvedValueOnce(storedSecret(VERIFIED_WITH))
      .mockResolvedValueOnce(storedSecret("whsec_saved_meanwhile"));
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
    expect(mockDeleteCredential).toHaveBeenCalledTimes(1);
    expect(mockDeleteCredential.mock.calls[0]?.[0]).toMatchObject({
      provider: STRIPE_PROVIDER,
      key: STRIPE_WEBHOOK_VERIFIED_KEY,
      actor: { kind: "system", actor: "stripe-webhook-verify" },
    });
    // The marker write ran before the clear, never after it.
    expect(mockSetCredential.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteCredential.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps the marker when the secret is unchanged after the write", async () => {
    mockReadRow.mockResolvedValue(storedSecret(VERIFIED_WITH));
    await recordStripeWebhookVerified(VERIFIED_WITH);
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
    expect(mockReadRow).toHaveBeenCalledTimes(2);
    expect(mockDeleteCredential).not.toHaveBeenCalled();
  });

  it("swallows a failed clear (best-effort, never breaks the webhook)", async () => {
    mockReadRow
      .mockResolvedValueOnce(storedSecret(VERIFIED_WITH))
      .mockResolvedValueOnce(storedSecret("whsec_saved_meanwhile"));
    mockDeleteCredential.mockRejectedValue(new Error("db down"));
    await expect(
      recordStripeWebhookVerified(VERIFIED_WITH),
    ).resolves.toBeUndefined();
  });

  it("swallows a failed re-read (best-effort, never breaks the webhook)", async () => {
    mockReadRow.mockRejectedValue(new Error("db down"));
    await expect(
      recordStripeWebhookVerified(VERIFIED_WITH),
    ).resolves.toBeUndefined();
    expect(mockSetCredential).not.toHaveBeenCalled();
  });
});

describe("getStripeSetupState webhook-verified freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNeedsReentry.mockResolvedValue(false);
  });

  const secretAt = new Date("2026-07-20T00:00:00.000Z");

  it("is verified only when the marker is at/after the webhook secret", async () => {
    mockFindMany.mockResolvedValue([
      { key: "secret_key", updatedAt: secretAt },
      { key: "publishable_key", updatedAt: secretAt },
      { key: "webhook_secret", updatedAt: secretAt },
      {
        key: STRIPE_WEBHOOK_VERIFIED_KEY,
        updatedAt: new Date("2026-07-20T00:01:00.000Z"),
      },
    ]);
    const state = await getStripeSetupState();
    expect(state.secretKeySet).toBe(true);
    expect(state.publishableKeySet).toBe(true);
    expect(state.webhookSecretSet).toBe(true);
    expect(state.webhookVerified).toBe(true);
  });

  it("is NOT verified when the marker predates the current webhook secret (secret swap)", async () => {
    mockFindMany.mockResolvedValue([
      { key: "webhook_secret", updatedAt: secretAt },
      {
        key: STRIPE_WEBHOOK_VERIFIED_KEY,
        updatedAt: new Date("2026-07-19T00:00:00.000Z"),
      },
    ]);
    const state = await getStripeSetupState();
    expect(state.webhookVerified).toBe(false);
  });

  it("is NOT verified when there is no webhook secret", async () => {
    mockFindMany.mockResolvedValue([
      { key: STRIPE_WEBHOOK_VERIFIED_KEY, updatedAt: secretAt },
    ]);
    const state = await getStripeSetupState();
    expect(state.webhookVerified).toBe(false);
    expect(state.webhookSecretSet).toBe(false);
  });
});
