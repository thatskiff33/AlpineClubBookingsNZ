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

import { ONCE_EVER_UNSENT_GRACE_MS } from "@/lib/admin-alert-once-sweep";
import { ALERT_NOBODY_ELIGIBLE_RETRY_MS, listStaleUnsentAlertCooldowns, releaseUnsentAlertCooldown } from "@/lib/alert-cooldown";
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
const alertAt = (now: Date) => alertOfficersOncePastCutoff(marker, { label: "test past-cut-off alert", send, now });

beforeEach(() => {
  vi.clearAllMocks();
  cooldown.rows.clear();
  vi.setSystemTime(NOW);
});

describe("alertOfficersOncePastCutoff", () => {
  it("sends once and settles; a rerun for the same marker settles without sending again", async () => {
    send.mockResolvedValue(result(1));

    await expect(alertAt(NOW)).resolves.toBe("settled");
    await expect(alertAt(new Date(NOW.getTime() + 60_000))).resolves.toBe("settled");

    expect(send).toHaveBeenCalledTimes(1);
    expect(cooldown.rows.has(pastCutoffAlertKey(marker))).toBe(true);
  });

  it("keys the claim on the marker, so another marker's alert still goes", async () => {
    send.mockResolvedValue(result(1));
    const other = owedNoticeMarker({ kind: "booking-bump-member", subjectId: "b2", eventAt: marker.eventAt });

    await alertAt(NOW);
    await expect(alertOfficersOncePastCutoff(other, { label: "test", send, now: NOW })).resolves.toBe("settled");

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

  it("#5255: classifies a lost claim at the read, so a claim deferred after the caller's `now` is not read as sent", async () => {
    // A competing attempt claims after this caller took `now` (as a drain
    // passing one `now` for a whole run would), reaches nobody and defers.
    send.mockResolvedValue(result(0, 1));
    await expect(alertAt(NOW)).resolves.toBe("unreached");

    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await expect(alertAt(new Date(NOW.getTime() - 60_000))).resolves.toBe("unreached");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("gives the claim back when the send throws, so the next attempt sends", async () => {
    send.mockRejectedValueOnce(new Error("SMTP down")).mockResolvedValue(result(1));

    await expect(alertAt(NOW)).resolves.toBe("unreached");
    expect(cooldown.rows.size).toBe(0);
    await expect(alertAt(new Date(NOW.getTime() + 60_000))).resolves.toBe("settled");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("#5255: a held claim still awaiting its send answers unreached; once the sweep gives it back the next attempt sends once", async () => {
    // The first attempt claims and its send hangs: the claim stays marked "no email yet".
    let failHungSend!: (err: Error) => void;
    send.mockImplementationOnce(() => new Promise((_, reject) => (failHungSend = reject)));
    const hung = alertAt(NOW);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    // A rerun loses the claim. No email went, so it must not settle (which would
    // clear the marker); `unreached` holds the marker for the kind's longer retry.
    const rerunAt = new Date(NOW.getTime() + 60_000);
    vi.setSystemTime(rerunAt);
    await expect(alertAt(rerunAt)).resolves.toBe("unreached");
    expect(send).toHaveBeenCalledTimes(1);

    // The payments cron's sweep gives back the claim once it is past the grace.
    const sweepAt = new Date(NOW.getTime() + ONCE_EVER_UNSENT_GRACE_MS + 60_000);
    vi.setSystemTime(sweepAt);
    const stale = await listStaleUnsentAlertCooldowns({ markedBefore: new Date(sweepAt.getTime() - ONCE_EVER_UNSENT_GRACE_MS) });
    expect(stale.map((row) => row.key)).toEqual([pastCutoffAlertKey(marker)]);
    await expect(releaseUnsentAlertCooldown({ key: stale[0].key, claimedAt: stale[0].lastAlertedAt })).resolves.toBe(true);

    // The marker's next attempt sends exactly once and settles.
    send.mockResolvedValue(result(1));
    const retryAt = new Date(sweepAt.getTime() + 60_000);
    vi.setSystemTime(retryAt);
    await expect(alertAt(retryAt)).resolves.toBe("settled");
    expect(send).toHaveBeenCalledTimes(2);

    // The hung send now fails: it gives back only its own stamp, so the kept
    // claim stands and a later rerun settles without sending.
    failHungSend(new Error("SMTP timed out"));
    await expect(hung).resolves.toBe("unreached");
    await expect(alertAt(new Date(retryAt.getTime() + 60_000))).resolves.toBe("settled");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("#5255: answers threw, sending nothing, when a held claim's state cannot be read", async () => {
    send.mockResolvedValue(result(1));
    await alertAt(NOW);
    cooldown.delegate.findUnique.mockRejectedValueOnce(new Error("db down"));

    await expect(alertAt(new Date(NOW.getTime() + 60_000))).resolves.toBe("threw");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("answers threw, sending nothing, when the claim cannot be written", async () => {
    cooldown.delegate.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(alertAt(NOW)).resolves.toBe("threw");
    expect(send).not.toHaveBeenCalled();
  });
});
