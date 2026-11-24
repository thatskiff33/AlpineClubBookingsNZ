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
const senders = vi.hoisted(() => ({ xero: vi.fn(), payment: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: senders.xero }));
vi.mock("@/lib/payment-recovery-alert", () => ({
  alertPaymentRecoveryOfficers: senders.payment,
  NOBODY_ALERTED: { deliveryAllowed: true, recipients: 0, sent: 0, queuedForRetry: 0, notDelivered: 0 },
}));
vi.mock("@/lib/club-format-server", async () => ({ clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST }));

import { readOnceEverClaimState } from "@/lib/admin-alert-once";
import { onceEverOwedKey, type StoredReplayableAlert } from "@/lib/admin-alert-once-replayable";
import { ONCE_EVER_OWED_GIVE_UP_MS, ONCE_EVER_UNSENT_GRACE_MS, sweepOnceEverAlerts } from "@/lib/admin-alert-once-sweep";
import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  ALERT_ONCE_EVER_WINDOW_MS,
  claimAlertCooldown,
  confirmAlertCooldownSend,
  deferAlertCooldown,
} from "@/lib/alert-cooldown";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #5255 (`INV-INT-042`): the payments cron's sweep. It gives back a once-ever
 * claim still marked as having no email 15 minutes on, and re-sends a
 * raised-once alert's stored copy while no claim holds it - never one already
 * sent, never twice. Driven over the in-memory `AlertCooldown` table.
 */
const T0 = new Date("2026-07-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;
const KEY = "xero-success-after-resolution:op-1";
const STORED: StoredReplayableAlert = {
  label: "Xero success-after-resolution alert",
  alert: { kind: "xero-sync-error", errorType: "XERO_SUCCESS_AFTER_RESOLUTION", operation: "CREATE PAYMENT", errorMessage: "Check Xero", timestamp: T0.toISOString() },
};
const claim = (key: string, now: Date) =>
  claimAlertCooldown({ key, windowMs: ALERT_ONCE_EVER_WINDOW_MS, now, awaitingSend: true });
const owe = (key: string, stored: unknown = STORED, since = T0) =>
  db.fake.delegate.create({ data: { key: onceEverOwedKey(key), lastAlertedAt: since, replayAlert: stored } });

beforeEach(() => {
  vi.clearAllMocks();
  db.fake.reset();
  senders.xero.mockResolvedValue(UNMUTEABLE_ALERT_SENT);
  senders.payment.mockResolvedValue(UNMUTEABLE_ALERT_SENT);
});

describe("the sweep gives back a claim with no email behind it", () => {
  it("only once the grace has passed, and reports it", async () => {
    await claim("once:a", T0);

    await expect(sweepOnceEverAlerts(at(ONCE_EVER_UNSENT_GRACE_MS))).resolves.toMatchObject({ released: 0 });
    expect(db.fake.rows.has("once:a")).toBe(true);
    await expect(sweepOnceEverAlerts(at(ONCE_EVER_UNSENT_GRACE_MS + 1))).resolves.toMatchObject({ released: 1, failed: 0 });
    expect(db.fake.rows.has("once:a")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ key: "once:a" }), expect.stringContaining("no email behind it"));
  });

  it("never a claim its email row confirmed, or one deferred for the day", async () => {
    await claim("once:sent", T0);
    await confirmAlertCooldownSend({ key: "once:sent", claimedAt: T0 });
    await claim("once:nobody", T0);
    await deferAlertCooldown({ key: "once:nobody", claimedAt: T0, windowMs: ALERT_ONCE_EVER_WINDOW_MS, retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS });

    await expect(sweepOnceEverAlerts(at(60 * MINUTE))).resolves.toMatchObject({ released: 0 });
    expect([...db.fake.rows.keys()].sort()).toEqual(["once:nobody", "once:sent"]);
  });

  it("never a claim taken before #5255, which carries no mark", async () => {
    await claimAlertCooldown({ key: "once:old", windowMs: ALERT_ONCE_EVER_WINDOW_MS, now: T0 });
    await sweepOnceEverAlerts(at(60 * MINUTE));
    expect(db.fake.rows.has("once:old")).toBe(true);
  });

  it("never throws: a failing read or give-back is counted for the run's warning", async () => {
    await claim("once:a", T0);
    db.fake.intercept("deleteMany", async () => {
      throw new Error("connection lost");
    });
    await expect(sweepOnceEverAlerts(at(60 * MINUTE))).resolves.toMatchObject({ released: 0, failed: 1 });

    db.fake.intercept("findMany", async () => {
      throw new Error("connection lost");
    });
    await expect(sweepOnceEverAlerts(at(60 * MINUTE))).resolves.toMatchObject({ released: 0, failed: 1 });
    await expect(sweepOnceEverAlerts(at(60 * MINUTE)), "the next run catches up").resolves.toMatchObject({ released: 1, failed: 0 });
  });
});

describe("the sweep re-sends a raised-once alert's stored copy", () => {
  it("while no claim holds it, then settles it, and a second sweep sends nothing", async () => {
    await owe(KEY);

    await expect(sweepOnceEverAlerts(at(MINUTE))).resolves.toMatchObject({ resent: 1 });
    expect(senders.xero).toHaveBeenCalledWith({
      errorType: "XERO_SUCCESS_AFTER_RESOLUTION",
      operation: "CREATE PAYMENT",
      errorMessage: "Check Xero",
      timestamp: T0,
    });
    expect(db.fake.rows.has(onceEverOwedKey(KEY))).toBe(false);
    expect(db.fake.rows.get(KEY)?.awaitingSendSince, "the kept claim is confirmed").toBeNull();

    await sweepOnceEverAlerts(at(60 * MINUTE));
    expect(senders.xero).toHaveBeenCalledTimes(1);
  });

  it("sends once when two sweeps run at the same time: the claim decides", async () => {
    await owe(KEY);
    const results = await Promise.all([sweepOnceEverAlerts(at(MINUTE)), sweepOnceEverAlerts(at(MINUTE))]);
    expect(senders.xero).toHaveBeenCalledTimes(1);
    expect(results.reduce((sum, run) => sum + run.resent, 0)).toBe(1);
  });

  it("rebuilds a payment alert with the club's format read afresh", async () => {
    await owe(KEY, {
      label: "lost close alert",
      alert: { kind: "payment-recovery", bookingId: "b1", operationId: "op-1", amountCents: 5000, paymentIntentId: "pi_1", errorMessage: "Check it" },
    });
    await sweepOnceEverAlerts(at(MINUTE));
    expect(senders.payment).toHaveBeenCalledWith(
      { bookingId: "b1", operationId: "op-1", amountCents: 5000, paymentIntentId: "pi_1", errorMessage: "Check it" },
      CLUB_FORMAT_TEST,
    );
  });

  it("settles a stored alert whose claim is already kept, sending nothing", async () => {
    await owe(KEY);
    await claim(KEY, T0);
    await confirmAlertCooldownSend({ key: KEY, claimedAt: T0 });

    await expect(sweepOnceEverAlerts(at(MINUTE))).resolves.toMatchObject({ settled: 1, resent: 0 });
    expect(senders.xero).not.toHaveBeenCalled();
    expect(db.fake.rows.has(onceEverOwedKey(KEY))).toBe(false);
  });

  it("leaves one whose claim is in flight, and sends it once that claim is given back", async () => {
    await owe(KEY);
    await claim(KEY, T0);

    await sweepOnceEverAlerts(at(MINUTE));
    expect(senders.xero).not.toHaveBeenCalled();
    expect(db.fake.rows.has(onceEverOwedKey(KEY))).toBe(true);

    // The claim's send never recorded an email: the next sweep gives it back and re-sends, in one run.
    await expect(sweepOnceEverAlerts(at(ONCE_EVER_UNSENT_GRACE_MS + MINUTE))).resolves.toMatchObject({ released: 1, resent: 1 });
    expect(senders.xero).toHaveBeenCalledTimes(1);
  });

  it("waits out a day's deferral when nobody could receive it, then tries again", async () => {
    senders.xero.mockResolvedValueOnce({ ...UNMUTEABLE_ALERT_SENT, recipients: 0, sent: 0 });
    await owe(KEY);

    await sweepOnceEverAlerts(T0);
    await sweepOnceEverAlerts(at(ALERT_NOBODY_ELIGIBLE_RETRY_MS));
    expect(senders.xero).toHaveBeenCalledTimes(1);

    // The re-send claims at the real clock's now, so it moves on with the sweep.
    vi.setSystemTime(at(ALERT_NOBODY_ELIGIBLE_RETRY_MS + MINUTE));
    try {
      await expect(sweepOnceEverAlerts(at(ALERT_NOBODY_ELIGIBLE_RETRY_MS + MINUTE))).resolves.toMatchObject({ resent: 1 });
    } finally {
      vi.setSystemTime(T0);
    }
    expect(senders.xero).toHaveBeenCalledTimes(2);
  });

  it("re-sends one whose send threw on the next sweep", async () => {
    senders.xero.mockRejectedValueOnce(new Error("mail down"));
    await owe(KEY);

    await expect(sweepOnceEverAlerts(at(MINUTE))).resolves.toMatchObject({ resent: 0 });
    expect(db.fake.rows.has(KEY), "the throw gave the claim back").toBe(false);
    await expect(sweepOnceEverAlerts(at(16 * MINUTE))).resolves.toMatchObject({ resent: 1 });
  });

  it("gives up after 7 days unsent, or on a row it cannot read, logging an error", async () => {
    await owe(KEY);
    await owe("once:garbled", { label: "x", alert: { kind: "unknown" } });

    await expect(sweepOnceEverAlerts(at(ONCE_EVER_OWED_GIVE_UP_MS))).resolves.toMatchObject({ dropped: 2, resent: 0 });
    expect(senders.xero).not.toHaveBeenCalled();
    expect(db.fake.rows.size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ key: KEY }), expect.stringContaining("Gave up"));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ key: "once:garbled" }), expect.stringContaining("cannot read"));
  });
});

describe("the sweep pages past owed rows it skips", () => {
  const deferredOwed = async (key: string) => {
    await owe(key);
    await claim(key, T0);
    await deferAlertCooldown({ key, claimedAt: T0, windowMs: ALERT_ONCE_EVER_WINDOW_MS, retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS });
  };

  it("re-sends a newer alert behind more than a page of older deferred ones, across a page break on the same timestamp", async () => {
    // 60 older rows deferred for the day, all owed at T0; the due one shares
    // T0 and sorts after them by key, so only paging by (time, key) reaches it.
    for (let i = 0; i < 60; i += 1) await deferredOwed(`once:skip-${String(i).padStart(2, "0")}`);
    await owe(KEY);

    await expect(sweepOnceEverAlerts(at(MINUTE))).resolves.toMatchObject({ resent: 1, failed: 0 });
    expect(senders.xero).toHaveBeenCalledTimes(1);
    expect(db.fake.rows.has(onceEverOwedKey(KEY))).toBe(false);
    expect([...db.fake.rows.keys()].filter((key) => key.startsWith("once-ever-owed:"))).toHaveLength(60);
  });

  it("re-sends a newer alert behind more than a page of older rows that keep throwing", async () => {
    // 60 older rows whose claim-state read throws on every sweep; each is
    // counted as failed but skipped, so the newer due row is still reached.
    for (let i = 0; i < 60; i += 1) await owe(`once:bad-${String(i).padStart(2, "0")}`);
    await owe(KEY, STORED, at(1));
    const findUnique = db.fake.delegate.findUnique.bind(db.fake.delegate);
    const spy = vi.spyOn(db.fake.delegate, "findUnique").mockImplementation(async (args) => {
      if (args.where.key.startsWith("once:bad-")) throw new Error("row read failed");
      return findUnique(args);
    });
    try {
      await expect(sweepOnceEverAlerts(at(MINUTE))).resolves.toMatchObject({ resent: 1, failed: 60 });
      expect(senders.xero).toHaveBeenCalledTimes(1);
      expect(db.fake.rows.has(onceEverOwedKey(KEY))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("still acts on at most 50 rows a run, leaving the rest for the next", async () => {
    for (let i = 0; i < 60; i += 1) await owe(`once:due-${String(i).padStart(2, "0")}`);

    await expect(sweepOnceEverAlerts(at(MINUTE))).resolves.toMatchObject({ resent: 50 });
    await expect(sweepOnceEverAlerts(at(2 * MINUTE))).resolves.toMatchObject({ resent: 10 });
    expect(senders.xero).toHaveBeenCalledTimes(60);
  });
});

describe("readOnceEverClaimState", () => {
  it("tells no claim, one awaiting its email, one deferred and one kept apart", async () => {
    await expect(readOnceEverClaimState(KEY, T0)).resolves.toBe("none");
    await claim(KEY, T0);
    await expect(readOnceEverClaimState(KEY, T0)).resolves.toBe("awaiting-send");
    await confirmAlertCooldownSend({ key: KEY, claimedAt: T0 });
    await expect(readOnceEverClaimState(KEY, at(365 * 86_400_000))).resolves.toBe("kept");

    db.fake.reset();
    await claim(KEY, T0);
    await deferAlertCooldown({ key: KEY, claimedAt: T0, windowMs: ALERT_ONCE_EVER_WINDOW_MS, retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS });
    await expect(readOnceEverClaimState(KEY, T0)).resolves.toBe("deferred");
    await expect(readOnceEverClaimState(KEY, at(ALERT_NOBODY_ELIGIBLE_RETRY_MS))).resolves.toBe("deferred");
    await expect(readOnceEverClaimState(KEY, at(ALERT_NOBODY_ELIGIBLE_RETRY_MS + 1))).resolves.toBe("none");
  });
});
