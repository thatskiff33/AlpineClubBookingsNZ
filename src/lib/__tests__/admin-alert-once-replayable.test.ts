import { readdirSync, rmSync } from "node:fs";

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
  // This file's own spool directory (`vitest.setup.ts`), emptied per test.
  rmSync(process.env.ADMIN_ALERT_SPOOL_DIR!, { recursive: true, force: true });
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

  // #5297 (`INV-INT-044`): an alert raised while the database refuses every
  // read and write is kept on disk, and sent once, by the sweep, when it answers.
  it("keeps the alert on disk while every database call fails, and the sweep sends it once when the database answers", async () => {
    const outage = (["create", "updateMany", "deleteMany", "findMany", "findUnique"] as const).map((op) =>
      vi.spyOn(db.fake.delegate, op).mockRejectedValue(new Error("Can't reach database server")),
    );
    await expect(raise()).resolves.toBe(false);
    expect(senders.payment, "no claim, so no send").not.toHaveBeenCalled();
    expect(db.fake.rows.size).toBe(0);
    expect(readdirSync(process.env.ADMIN_ALERT_SPOOL_DIR!)).toHaveLength(1);
    await expect(sweepOnceEverAlerts(new Date(Date.now() + 60_000)), "still down").resolves.toMatchObject({ spooled: 0, resent: 0 });

    for (const spy of outage) spy.mockRestore();
    await expect(sweepOnceEverAlerts(new Date(Date.now() + 120_000))).resolves.toMatchObject({ spooled: 1, resent: 1, failed: 0 });
    await sweepOnceEverAlerts(new Date(Date.now() + 180_000));
    await expect(raise(), "the caller raising it again").resolves.toBe(false);
    expect(senders.payment).toHaveBeenCalledTimes(1);
    expect(readdirSync(process.env.ADMIN_ALERT_SPOOL_DIR!)).toEqual([]);
    expect(db.fake.rows.has(OWED)).toBe(false);
  });

  it("sends once when only the stored copy's write failed, and the sweep settles the file it left without a second send", async () => {
    db.fake.intercept("create", async () => {
      throw new Error("connection lost");
    });
    await expect(raise()).resolves.toBe(true);
    expect(readdirSync(process.env.ADMIN_ALERT_SPOOL_DIR!)).toHaveLength(1);

    await expect(sweepOnceEverAlerts(new Date(Date.now() + 60_000))).resolves.toMatchObject({ spooled: 1, settled: 1, resent: 0 });
    expect(senders.payment).toHaveBeenCalledTimes(1);
    expect(db.fake.rows.has(OWED)).toBe(false);
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
