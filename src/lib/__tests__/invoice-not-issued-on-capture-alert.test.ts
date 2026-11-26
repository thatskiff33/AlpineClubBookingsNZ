import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5312: the officer's email for an invoice a capture did not issue reports
 * what its send did, so the repair tool never says an officer was emailed
 * when nobody was. It still never throws.
 */
const mocks = vi.hoisted(() => ({ sendAdminXeroSyncErrorAlert: vi.fn() }));

vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: mocks.sendAdminXeroSyncErrorAlert }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { alertInvoiceNotIssuedOnCapture } from "@/lib/xero-supplementary-invoice-late-capture";

const alert = {
  operationId: "op_retired",
  localModel: "BookingModification",
  localId: "mod_change",
  paymentIntentId: "pi_late",
  reason: "short-of-ask" as const,
  wasRetired: true,
};

const result = (overrides: Partial<{ deliveryAllowed: boolean; recipients: number; sent: number; queuedForRetry: number; notDelivered: number }>) => ({
  deliveryAllowed: true,
  recipients: 1,
  sent: 0,
  queuedForRetry: 0,
  notDelivered: 0,
  failedBeforeLogged: 0,
  ...overrides,
});

describe("alertInvoiceNotIssuedOnCapture's outcome (#5312)", () => {
  beforeEach(() => {
    mocks.sendAdminXeroSyncErrorAlert.mockReset();
  });

  it("is sent only when a copy went out", async () => {
    mocks.sendAdminXeroSyncErrorAlert.mockResolvedValue(result({ sent: 1 }));
    await expect(alertInvoiceNotIssuedOnCapture(alert)).resolves.toBe("sent");
  });

  it("says when nobody received it", async () => {
    mocks.sendAdminXeroSyncErrorAlert.mockResolvedValue(result({ notDelivered: 1 }));
    await expect(alertInvoiceNotIssuedOnCapture(alert)).resolves.toBe("undelivered");
    mocks.sendAdminXeroSyncErrorAlert.mockResolvedValue(result({ queuedForRetry: 1 }));
    await expect(alertInvoiceNotIssuedOnCapture(alert)).resolves.toBe("queued-for-retry");
    mocks.sendAdminXeroSyncErrorAlert.mockResolvedValue(result({ recipients: 0 }));
    await expect(alertInvoiceNotIssuedOnCapture(alert)).resolves.toBe("no-recipients");
  });

  it("a send that throws is undelivered, never thrown on", async () => {
    mocks.sendAdminXeroSyncErrorAlert.mockRejectedValue(new Error("SES down"));
    await expect(alertInvoiceNotIssuedOnCapture(alert)).resolves.toBe("undelivered");
  });
});
