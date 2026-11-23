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

  it("gives the claim back when the send throws, so the next attempt sends", async () => {
    send.mockRejectedValueOnce(new Error("SMTP down")).mockResolvedValue(result(1));

    await expect(alertAt(NOW)).resolves.toBe("unreached");
    expect(cooldown.rows.size).toBe(0);
    await expect(alertAt(new Date(NOW.getTime() + 60_000))).resolves.toBe("settled");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("answers threw, sending nothing, when the claim cannot be written", async () => {
    cooldown.delegate.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(alertAt(NOW)).resolves.toBe("threw");
    expect(send).not.toHaveBeenCalled();
  });
});
