/**
 * #5433 (WL-2): the "offer expired" email's owed notice, against doubles.
 * Real: `waitlist-offer-expired-notice.ts` and the mechanism's delivery and
 * sweep. The revert's wiring (the marker in its transaction, none for an offer
 * never told) is in `waitlist.test.ts`; against PostgreSQL in
 * `waitlist-owed-notices.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  owedNoticeUpdateMany: vi.fn(),
  owedNoticeDeleteMany: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: db.bookingFindUnique },
    owedNotice: { updateMany: db.owedNoticeUpdateMany, deleteMany: db.owedNoticeDeleteMany },
  },
}));
const send = vi.hoisted(() => ({ expired: vi.fn(), unsent: vi.fn(), position: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendWaitlistOfferExpiredEmail: send.expired }));
vi.mock("@/lib/email/admin-alerts-waitlist-notice-unsent", () => ({ sendAdminWaitlistNoticeUnsentAlert: send.unsent }));
vi.mock("@/lib/waitlist-queue", () => ({ getWaitlistPositionOf: send.position }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/owed-notice/past-cutoff-once", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/owed-notice/past-cutoff-once")),
  alertOfficersOncePastCutoff: async (_marker: unknown, { send: sendAlert }: { send: () => Promise<unknown> }) => {
    await sendAlert();
    return "settled";
  },
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sweepOwedNotice } from "@/lib/owed-notice/deliver";
import { owedNoticeMarker, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import {
  deliverWaitlistOfferExpiredNotice,
  recordWaitlistOfferExpiredNoticesOwed,
  WAITLIST_OFFER_EXPIRED_NOTICE_DELIVERER as EXPIRED,
} from "@/lib/waitlist-offer-expired-notice";
import { WAITLIST_NOTICE_SWEEP_AFTER_MS } from "@/lib/waitlist-offer-notices";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-07-01T00:00:00.000Z");
const EXPIRED_AT = new Date(NOW.getTime() - 2 * HOUR);
const marker = owedNoticeMarker({ kind: "waitlist-offer-expired", subjectId: "booking1", eventAt: EXPIRED_AT });

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking1",
    status: "WAITLISTED",
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    lodgeId: "lodge-1",
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    memberId: "m1",
    member: { id: "m1", email: "ada@example.test", firstName: "Ada", lastName: "Proof" },
    organisation: null,
    ...overrides,
  };
}

function ref(target: OwedNoticeMarker) {
  return {
    key: target.id,
    marker: target,
    claim: vi.fn(async (_bound: Date, now: Date) => now),
    settle: vi.fn(async () => {}),
    defer: vi.fn(async () => {}),
  };
}

const sweep = (handle: ReturnType<typeof ref>, now = NOW) =>
  sweepOwedNotice(EXPIRED, handle, new Date(now.getTime() - WAITLIST_NOTICE_SWEEP_AFTER_MS), now, "test-sweep");

beforeEach(() => {
  vi.clearAllMocks();
  db.bookingFindUnique.mockResolvedValue(bookingRow());
  db.owedNoticeUpdateMany.mockResolvedValue({ count: 1 });
  db.owedNoticeDeleteMany.mockResolvedValue({ count: 1 });
  send.expired.mockResolvedValue({ status: "sent", emailLogId: "row", messageId: null });
  send.unsent.mockResolvedValue({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, failedBeforeLogged: 0 });
  send.position.mockResolvedValue(4);
});

describe("the offer-expired notice (#5433 WL-2)", () => {
  it("records one marker per lapse in one insert, keyed and stamped by the lapse's time", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    await recordWaitlistOfferExpiredNoticesOwed({ owedNotice: { createMany } } as never, [
      { bookingId: "a", expiredAt: EXPIRED_AT },
      { bookingId: "b", expiredAt: EXPIRED_AT },
    ]);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]![0].data.map((row: { id: string }) => row.id)).toEqual([
      `waitlist-offer-expired:a:${EXPIRED_AT.getTime()}`,
      `waitlist-offer-expired:b:${EXPIRED_AT.getTime()}`,
    ]);
  });

  it("straight after the revert sends the position the revert worked out, with the lapse's key, and clears the marker", async () => {
    await deliverWaitlistOfferExpiredNotice(
      {
        bookingId: "booking1",
        status: "WAITLISTED",
        checkIn: new Date("2026-09-01T00:00:00.000Z"),
        checkOut: new Date("2026-09-03T00:00:00.000Z"),
        recipientMemberId: "m1",
        email: "ada@example.test",
        firstName: "Ada",
        memberName: "Ada Proof",
        lodgeId: "lodge-1",
        position: 2,
      },
      { bookingId: "booking1", expiredAt: EXPIRED_AT },
    );
    expect(send.expired).toHaveBeenCalledTimes(1);
    expect(send.expired.mock.calls[0]![0]).toEqual({ bookingId: "booking1", recipientMemberId: "m1", idempotencyKey: `booking1:${EXPIRED_AT.getTime()}` });
    expect(send.expired.mock.calls[0]![5]).toBe(2);
    expect(send.position).not.toHaveBeenCalled();
    expect(db.owedNoticeDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("from the sweep sends once, with the queue position as it stands at the send, and clears the marker", async () => {
    const handle = ref(marker);
    await expect(sweep(handle)).resolves.toBe("delivered");
    expect(send.position).toHaveBeenCalledTimes(1);
    expect(send.expired.mock.calls[0]![5]).toBe(4);
    expect(send.expired.mock.calls[0]![0]).toMatchObject({ idempotencyKey: `booking1:${EXPIRED_AT.getTime()}` });
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["re-offered", bookingRow({ status: "WAITLIST_OFFERED" })],
    ["confirmed", bookingRow({ status: "PAYMENT_PENDING" })],
    ["cancelled", bookingRow({ status: "CANCELLED" })],
    ["over: its check-out date has begun at the club", bookingRow({ checkOut: new Date("2026-07-01T00:00:00.000Z") })],
    ["gone", null],
  ])("clears without sending once the booking is %s", async (_case, row) => {
    db.bookingFindUnique.mockResolvedValue(row);
    const handle = ref(marker);
    await expect(sweep(handle)).resolves.toBe("cleared");
    expect(send.expired).not.toHaveBeenCalled();
    expect(send.unsent).not.toHaveBeenCalled();
  });

  it("past its cut-off alerts the officers once instead of sending, and clears the marker", async () => {
    const old = owedNoticeMarker({ kind: "waitlist-offer-expired", subjectId: "booking1", eventAt: new Date(NOW.getTime() - 8 * 24 * HOUR) });
    const handle = ref(old);
    await expect(sweep(handle)).resolves.toBe("expired");
    expect(send.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "offer-expired", bookingId: "booking1" }));
    expect(send.expired).not.toHaveBeenCalled();
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });
});
