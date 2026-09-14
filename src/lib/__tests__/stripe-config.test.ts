import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindMany,
  mockGetValue,
  mockNeedsReentry,
  mockSetCredential,
  mockDeleteCredential,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockGetValue: vi.fn(),
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
}));

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
    mockSetCredential.mockRejectedValue(new Error("weak auth secret"));
    await expect(recordStripeWebhookVerified()).resolves.toBeUndefined();
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
  });
});

/**
 * The webhook route calls this on EVERY signature-verified test-mode event,
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
  });

  it("does NOT write when the marker is already fresh", async () => {
    mockFindMany.mockResolvedValue(
      rows([
        ["webhook_secret", new Date("2026-06-01T00:00:00.000Z")],
        ["webhook_verified", new Date("2026-06-02T00:00:00.000Z")],
      ]),
    );
    await recordStripeWebhookVerified();
    expect(mockSetCredential).not.toHaveBeenCalled();
  });

  it("writes when no marker is stored yet", async () => {
    mockFindMany.mockResolvedValue(
      rows([["webhook_secret", new Date("2026-06-01T00:00:00.000Z")]]),
    );
    await recordStripeWebhookVerified(new Date("2026-06-03T00:00:00.000Z"));
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
    await recordStripeWebhookVerified();
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
  });

  it("writes when there is a marker but no stored secret — a marker attesting to nothing is not fresh", async () => {
    mockFindMany.mockResolvedValue(
      rows([["webhook_verified", new Date("2026-06-02T00:00:00.000Z")]]),
    );
    await recordStripeWebhookVerified();
    expect(mockSetCredential).toHaveBeenCalledTimes(1);
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
