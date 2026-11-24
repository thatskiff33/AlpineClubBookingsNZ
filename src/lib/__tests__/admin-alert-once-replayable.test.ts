import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertCooldownFake } from "./helpers/alert-cooldown-fake";

const db = vi.hoisted(() => ({ fake: null as unknown as AlertCooldownFake }));
vi.mock("@/lib/prisma", async () => {
  const { createAlertCooldownFake } = await import("./helpers/alert-cooldown-fake");
  db.fake = createAlertCooldownFake();
  return { prisma: { alertCooldown: db.fake.delegate } };
});
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: logger }));
const senders = vi.hoisted(() => ({ xero: vi.fn(), payment: vi.fn(), format: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: senders.xero }));
vi.mock("@/lib/payment-recovery-alert", () => ({
  alertPaymentRecoveryOfficers: senders.payment,
  NOBODY_ALERTED: { deliveryAllowed: true, recipients: 0, sent: 0, queuedForRetry: 0, notDelivered: 0 },
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: senders.format }));

import {
  onceEverOwedKey,
  parseStoredReplayableAlert,
  sendReplayableAdminAlertOnceEver,
  type ReplayableAdminAlert,
} from "@/lib/admin-alert-once-replayable";
import { sweepOnceEverAlerts } from "@/lib/admin-alert-once-sweep";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #5255 (`INV-INT-042`): a raised-once alert is stored for the sweep before it
 * is sent, and settled once its claim is kept. A failure to store it never
 * costs the send itself; an alert already sent or deferred is left alone.
 */
const KEY = "capacity-race-refund-shortfall:b1";
const OWED = onceEverOwedKey(KEY);
const PAYMENT: ReplayableAdminAlert = { kind: "payment-recovery", bookingId: "b1", amountCents: 2000, paymentIntentId: "pi_1", errorMessage: "Refund $20.00 by hand" };
const raise = (format = CLUB_FORMAT_TEST) =>
  sendReplayableAdminAlertOnceEver({ key: KEY, label: "shortfall alert", context: { bookingId: "b1" }, alert: PAYMENT, format });

beforeEach(() => {
  vi.clearAllMocks();
  db.fake.reset();
  senders.payment.mockResolvedValue(UNMUTEABLE_ALERT_SENT);
  senders.format.mockResolvedValue(CLUB_FORMAT_TEST);
});

describe("sendReplayableAdminAlertOnceEver", () => {
  it("stores the alert, sends it once with the caller's format, and settles the stored copy", async () => {
    let storedWhenSent: unknown;
    senders.payment.mockImplementationOnce(async () => {
      storedWhenSent = db.fake.rows.get(OWED)?.replayAlert;
      return UNMUTEABLE_ALERT_SENT;
    });

    await expect(raise()).resolves.toBe(true);
    expect(storedWhenSent, "stored before the send").toEqual({ label: "shortfall alert", alert: PAYMENT });
    expect(senders.payment).toHaveBeenCalledWith(
      { bookingId: "b1", amountCents: 2000, paymentIntentId: "pi_1", errorMessage: "Refund $20.00 by hand" },
      CLUB_FORMAT_TEST,
    );
    expect(senders.format, "the caller's format, not a second read").not.toHaveBeenCalled();
    expect(db.fake.rows.has(OWED)).toBe(false);

    await expect(raise(), "a repeat").resolves.toBe(false);
    expect(senders.payment).toHaveBeenCalledTimes(1);
    expect(db.fake.rows.has(OWED), "nothing stored for an alert already sent").toBe(false);
  });

  it("leaves the stored copy for the sweep when the send throws, and the sweep sends it once", async () => {
    senders.payment.mockRejectedValueOnce(new Error("mail down"));

    await expect(raise()).resolves.toBe(false);
    expect(db.fake.rows.has(OWED)).toBe(true);
    expect(db.fake.rows.has(KEY), "the claim was given back").toBe(false);

    await sweepOnceEverAlerts(new Date(Date.now() + 60_000));
    await sweepOnceEverAlerts(new Date(Date.now() + 120_000));
    expect(senders.payment).toHaveBeenCalledTimes(2);
    expect(db.fake.rows.has(OWED)).toBe(false);
  });

  it("stores nothing and sends nothing while the claim is deferred for the day", async () => {
    senders.payment.mockResolvedValueOnce({ ...UNMUTEABLE_ALERT_SENT, recipients: 0, sent: 0 });
    await raise();
    expect(db.fake.rows.has(OWED), "kept for the sweep after nobody received it").toBe(true);
    db.fake.rows.delete(OWED);

    await expect(raise()).resolves.toBe(false);
    expect(senders.payment).toHaveBeenCalledTimes(1);
    expect(db.fake.rows.has(OWED)).toBe(false);
  });

  it("still sends the alert, once, when the stored copy cannot be written", async () => {
    db.fake.intercept("create", async () => {
      throw new Error("connection lost");
    });

    await expect(raise()).resolves.toBe(true);
    expect(senders.payment).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "b1" }), expect.stringContaining("Failed to store the shortfall alert"));
  });

  it("still sends when the claim state cannot be read first", async () => {
    db.fake.intercept("findUnique", async () => {
      throw new Error("connection lost");
    });
    await expect(raise()).resolves.toBe(true);
    expect(senders.payment).toHaveBeenCalledTimes(1);
  });
});

describe("parseStoredReplayableAlert", () => {
  it("reads both alert kinds back, and refuses anything else", () => {
    const xero = { kind: "xero-sync-error", errorType: "X", operation: "op", errorMessage: "m", timestamp: "2026-07-01T00:00:00.000Z" };
    expect(parseStoredReplayableAlert({ label: "l", alert: PAYMENT })).toEqual({ label: "l", alert: PAYMENT });
    expect(parseStoredReplayableAlert({ label: "l", alert: xero })).toEqual({ label: "l", alert: xero });
    for (const broken of [
      null,
      [],
      { alert: PAYMENT },
      { label: "l", alert: { ...PAYMENT, amountCents: 1.5 } },
      { label: "l", alert: { ...PAYMENT, operationId: 7 } },
      { label: "l", alert: { ...xero, timestamp: undefined } },
      { label: "l", alert: { kind: "other" } },
    ]) {
      expect(parseStoredReplayableAlert(broken as never)).toBeNull();
    }
  });
});
