import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertCooldownStore } from "./support/alert-cooldown-store";

/*
 * #5433 review: a kind's past-cut-off officer alert, at most once per claim
 * key (owner decision D1; the waitlist offer's email and its never-told lapse
 * share one key, D5). Through the once-ever takeover sequence
 * (`sendAdminAlertOnceEverWithTakeover`, round 2 item 5e) with a sent stamp as
 * its `isSent`. Real: `alertOfficersOncePastCutoff`, the once-ever claim, the
 * takeover and the cooldown helpers. Doubled: the `AlertCooldown` table (in
 * memory) and the logger.
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
import { alertOfficersOncePastCutoff, pastCutoffAlertKey, pastCutoffSentKey } from "@/lib/owed-notice/past-cutoff-once";
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
/** The calling kind's wait: another holder's claim younger than this may still be sending. */
const IN_FLIGHT_MS = 30 * 60 * 1000;
const alert = (target = marker) => alertOfficersOncePastCutoff(target, { label: "test past-cut-off alert", send, inFlightMs: IN_FLIGHT_MS });
const at = (ms: number) => {
  vi.setSystemTime(new Date(NOW.getTime() + ms));
};

beforeEach(() => {
  vi.clearAllMocks();
  cooldown.rows.clear();
  vi.setSystemTime(NOW);
});

describe("alertOfficersOncePastCutoff", () => {
  it("sends once, stamps it sent and settles; a rerun for the same key settles at once without sending again", async () => {
    send.mockResolvedValue(result(1));

    await expect(alert()).resolves.toBe("settled");
    expect(cooldown.rows.has(pastCutoffAlertKey(marker))).toBe(true);
    expect(cooldown.rows.has(pastCutoffSentKey(marker))).toBe(true);
    at(60_000);
    await expect(alert()).resolves.toBe("settled");

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keys the claim on the marker, so another marker's alert still goes", async () => {
    send.mockResolvedValue(result(1));
    const other = owedNoticeMarker({ kind: "booking-bump-member", subjectId: "b2", eventAt: marker.eventAt });

    await alert();
    await expect(alert(other)).resolves.toBe("settled");

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("answers unreached when nobody received it; the kind's day-later retry sends it again", async () => {
    send.mockResolvedValue(result(0, 1));
    await expect(alert()).resolves.toBe("unreached");
    expect(cooldown.rows.has(pastCutoffSentKey(marker))).toBe(false);

    send.mockResolvedValue(result(1));
    at(ALERT_NOBODY_ELIGIBLE_RETRY_MS + 1);
    await expect(alert()).resolves.toBe("settled");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gives the claim back when the send throws, so the next attempt sends", async () => {
    send.mockRejectedValueOnce(new Error("SMTP down")).mockResolvedValue(result(1));

    await expect(alert()).resolves.toBe("unreached");
    expect(cooldown.rows.has(pastCutoffAlertKey(marker))).toBe(false);
    await expect(alert()).resolves.toBe("settled");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("writes the sent stamp a second time when the first write throws (round 3, item 6)", async () => {
    send.mockResolvedValue(result(1));
    const sentKey = pastCutoffSentKey(marker);
    const realUpdateMany = cooldown.delegate.updateMany.getMockImplementation()!;
    let failed = false;
    cooldown.delegate.updateMany.mockImplementation(async (args: Parameters<typeof realUpdateMany>[0]) => {
      if (args.where.key === sentKey && !failed) {
        failed = true;
        throw new Error("db blip");
      }
      return realUpdateMany(args);
    });
    try {
      await expect(alert()).resolves.toBe("settled");
      expect(cooldown.rows.has(sentKey)).toBe(true);
    } finally {
      cooldown.delegate.updateMany.mockImplementation(realUpdateMany);
    }
  });

  it("gives up after two failed stamp writes, saying a later attempt may send again (the stated limit)", async () => {
    send.mockResolvedValue(result(1));
    const sentKey = pastCutoffSentKey(marker);
    const realUpdateMany = cooldown.delegate.updateMany.getMockImplementation()!;
    cooldown.delegate.updateMany.mockImplementation(async (args: Parameters<typeof realUpdateMany>[0]) => {
      if (args.where.key === sentKey) throw new Error("db down");
      return realUpdateMany(args);
    });
    try {
      await expect(alert()).resolves.toBe("settled");
      expect(cooldown.rows.has(sentKey)).toBe(false);
      expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2 }), expect.stringContaining("may send it again"));
    } finally {
      cooldown.delegate.updateMany.mockImplementation(realUpdateMany);
    }
  });

  it("sends nothing when the claim cannot be written", async () => {
    cooldown.delegate.updateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(alert()).resolves.not.toBe("settled");
    expect(send).not.toHaveBeenCalled();
  });

  describe("a claim another attempt holds (#5433 round 2, item 5e)", () => {
    /** Another attempt's claim on the key, taken `ago` before now, with or without its sent stamp. */
    const heldByAnother = (ago: number, sent: boolean) => {
      cooldown.rows.set(pastCutoffAlertKey(marker), new Date(Date.now() - ago));
      if (sent) cooldown.rows.set(pastCutoffSentKey(marker), new Date(Date.now() - ago));
    };

    it("settles, sending nothing, when the holder's alert went (its sent stamp), however recent", async () => {
      heldByAnother(1_000, true);
      await expect(alert()).resolves.toBe("settled");
      expect(send).not.toHaveBeenCalled();
    });

    it("retries later, sending nothing, while the holder may still be sending (younger than the wait, no sent stamp)", async () => {
      heldByAnother(5 * 60_000, false);
      await expect(alert()).resolves.toBe("threw");
      expect(send).not.toHaveBeenCalled();
    });

    it("takes over a holder that died after claiming (older than the wait, no sent stamp) and sends the alert, so it is not lost", async () => {
      send.mockResolvedValue(result(1));
      heldByAnother(IN_FLIGHT_MS + 1, false);
      await expect(alert()).resolves.toBe("settled");
      expect(send).toHaveBeenCalledTimes(1);
      expect(cooldown.rows.has(pastCutoffSentKey(marker))).toBe(true);
    });
  });
});
