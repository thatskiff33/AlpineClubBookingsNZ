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

  it("clearStripeWebhookVerified deletes the marker row", async () => {
    mockDeleteCredential.mockResolvedValue(undefined);
    await clearStripeWebhookVerified();
    expect(mockDeleteCredential).toHaveBeenCalledWith({
      provider: STRIPE_PROVIDER,
      key: STRIPE_WEBHOOK_VERIFIED_KEY,
      // Verify-reset is a NAMED background writer (#2723), distinguishable in
      // the audit log from the admin whose credential write triggered it.
      actor: { kind: "system", actor: "stripe-verify-reset" },
      expect: { expect: "any" },
    });
  });

  it("recordStripeWebhookVerified never throws even when the store errors", async () => {
    mockSetCredential.mockRejectedValue(new Error("weak auth secret"));
    await expect(recordStripeWebhookVerified()).resolves.toBeUndefined();
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
