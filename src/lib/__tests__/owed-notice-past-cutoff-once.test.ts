import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertCooldownStore } from "./support/alert-cooldown-store";

/*
 * #5433 review: a kind's past-cut-off officer alert, at most once per marker
 * (owner decision D1). Real: `alertOfficersOncePastCutoff`, the once-ever
 * claim (`admin-alert-once.ts`) and the cooldown helpers. Doubled: the
 * `AlertCooldown` table (in memory) and the logger.
 */

const mocks = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const cooldown = createAlertCooldownStore();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get alertCooldown() {
      return cooldown.delegate;
    },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { ALERT_NOBODY_ELIGIBLE_RETRY_MS } from "@/lib/alert-cooldown";
import type { AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import { alertOfficersOncePastCutoff, pastCutoffAlertKey } from "@/lib/owed-notice/past-cutoff-once";
import { owedNoticeMarker } from "@/lib/owed-notice/store";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const marker = owedNoticeMarker({ kind: "booking-bump-member", subjectId: "b1", eventAt: new Date("2026-06-01T00:00:00.000Z") });

const result = (sent: number, notDelivered = 0): AdminAlertSendResult => ({
  deliveryAllowed: true,
  recipients: sent + notDelivered,
  sent,
  queuedForRetry: 0,
  notDelivered,
});

const send = vi.fn<() => Promise<AdminAlertSendResult>>();
/** The calling kind's wait: a claim younger than this may still be in flight (#5433 review E). */
const IN_FLIGHT_MS = 30 * 60 * 1000;
const alertAt = (now: Date, target = marker) =>
  alertOfficersOncePastCutoff(target, { label: "test past-cut-off alert", send, inFlightMs: IN_FLIGHT_MS, now });
const later = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  vi.clearAllMocks();
  cooldown.rows.clear();
  vi.setSystemTime(NOW);
});

describe("alertOfficersOncePastCutoff", () => {
  it("sends once and settles; a rerun for the same marker sends nothing, retrying while the claim may be in flight and settling once it is kept", async () => {
    send.mockResolvedValue(result(1));

    await expect(alertAt(NOW)).resolves.toBe("settled");
    await expect(alertAt(later(60_000))).resolves.toBe("threw");
    await expect(alertAt(later(IN_FLIGHT_MS + 1))).resolves.toBe("settled");

    expect(send).toHaveBeenCalledTimes(1);
    expect(cooldown.rows.has(pastCutoffAlertKey(marker))).toBe(true);
  });

  it("keys the claim on the marker, so another marker's alert still goes", async () => {
    send.mockResolvedValue(result(1));
    const other = owedNoticeMarker({ kind: "booking-bump-member", subjectId: "b2", eventAt: marker.eventAt });

    await alertAt(NOW);
    await expect(alertAt(NOW, other)).resolves.toBe("settled");

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("answers unreached when nobody received it, sends nothing again for a day, then tries again", async () => {
    send.mockResolvedValue(result(0, 1));

    await expect(alertAt(NOW)).resolves.toBe("unreached");
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await expect(alertAt(new Date(NOW.getTime() + 60_000))).resolves.toBe("unreached");
    expect(send).toHaveBeenCalledTimes(1);

    send.mockResolvedValue(result(1));
    const dayLater = new Date(NOW.getTime() + ALERT_NOBODY_ELIGIBLE_RETRY_MS + 1);
    vi.setSystemTime(dayLater);
    await expect(alertAt(dayLater)).resolves.toBe("settled");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gives the claim back when the send throws, so the next attempt sends", async () => {
    send.mockRejectedValueOnce(new Error("SMTP down")).mockResolvedValue(result(1));

    await expect(alertAt(NOW)).resolves.toBe("unreached");
    expect(cooldown.rows.size).toBe(0);
    await expect(alertAt(later(60_000))).resolves.toBe("settled");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("answers threw, sending nothing, when the claim cannot be written", async () => {
    cooldown.delegate.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(alertAt(NOW)).resolves.toBe("threw");
    expect(send).not.toHaveBeenCalled();
  });

  describe("a claim another attempt holds (#5433 review E: two markers share one claim)", () => {
    it("retries, sending nothing, while the holder's claim is younger than its wait, and settles once the claim is kept", async () => {
      send.mockResolvedValue(result(1));
      await expect(alertAt(NOW)).resolves.toBe("settled");

      vi.setSystemTime(later(5 * 60_000));
      await expect(alertAt(later(5 * 60_000))).resolves.toBe("threw");
      vi.setSystemTime(later(IN_FLIGHT_MS + 1));
      await expect(alertAt(later(IN_FLIGHT_MS + 1))).resolves.toBe("settled");
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does not settle on a holder whose send then reached nobody: the loser waits for it and tries again", async () => {
      // The holder claims; while its send runs, the loser reads the claim.
      let loser: Promise<unknown> | undefined;
      send.mockImplementationOnce(async () => {
        loser = alertAt(later(1_000));
        await loser;
        return result(0, 1);
      });
      await expect(alertAt(NOW)).resolves.toBe("unreached");
      await expect(loser).resolves.toBe("threw");

      // A wait later the holder's claim is the day-long hold nobody received: still not settled.
      vi.setSystemTime(later(IN_FLIGHT_MS + 1));
      await expect(alertAt(later(IN_FLIGHT_MS + 1))).resolves.toBe("unreached");
      // A day on, the claim is free again and the alert goes.
      send.mockResolvedValue(result(1));
      const dayLater = later(ALERT_NOBODY_ELIGIBLE_RETRY_MS + 1);
      vi.setSystemTime(dayLater);
      await expect(alertAt(dayLater)).resolves.toBe("settled");
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
