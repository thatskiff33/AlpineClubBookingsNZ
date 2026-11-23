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
    // The offer email's row, read by the offer email's past-cut-off step: none (never sent).
    emailLog: { findUnique: async () => null, count: async () => 0 },
    owedNotice: { updateMany: db.owedNoticeUpdateMany, deleteMany: db.owedNoticeDeleteMany },
  },
}));
const send = vi.hoisted(() => ({ expired: vi.fn(), unsent: vi.fn(), position: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendWaitlistOfferExpiredEmail: send.expired }));
vi.mock("@/lib/email/admin-alerts-waitlist-notice-unsent", () => ({ sendAdminWaitlistNoticeUnsentAlert: send.unsent }));
vi.mock("@/lib/waitlist-queue", () => ({ getWaitlistPositionOf: send.position }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
// The once-ever claim as a set of claimed keys: the first caller for a key
// sends and keeps it, a later one finds it held and sends nothing. The real
// claim is proved in owed-notice-past-cutoff-once.test.ts; what this suite
// proves is which key each path claims.
const claimed = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/owed-notice/past-cutoff-once", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/owed-notice/past-cutoff-once");
  return {
    ...real,
    alertOfficersOncePastCutoff: async (marker: { id: string }, { send: sendAlert }: { send: () => Promise<unknown> }) => {
      const key = real.pastCutoffAlertKey(marker);
      if (claimed.has(key)) return "settled";
      claimed.add(key);
      await sendAlert();
      return "settled";
    },
  };
});
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sweepOwedNotice } from "@/lib/owed-notice/deliver";
import { owedNoticeMarker, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import {
  deliverWaitlistLapseNotice,
  recordWaitlistLapseNoticesOwed,
  WAITLIST_LAPSE_NOTICE_DELIVERERS,
} from "@/lib/waitlist-offer-expired-notice";
import { WAITLIST_OFFER_NOTICE_DELIVERERS, waitlistOfferMemberMarker } from "@/lib/waitlist-offer-notices";
import { WAITLIST_NOTICE_SWEEP_AFTER_MS } from "@/lib/waitlist-offer-window";

const [EXPIRED, UNTOLD] = WAITLIST_LAPSE_NOTICE_DELIVERERS as [
  (typeof WAITLIST_LAPSE_NOTICE_DELIVERERS)[number],
  (typeof WAITLIST_LAPSE_NOTICE_DELIVERERS)[number],
];

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

const sweep = (handle: ReturnType<typeof ref>, now = NOW, deliverer = EXPIRED) =>
  sweepOwedNotice(deliverer, handle, new Date(now.getTime() - WAITLIST_NOTICE_SWEEP_AFTER_MS), now, "test-sweep");

beforeEach(() => {
  vi.clearAllMocks();
  claimed.clear();
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
    await recordWaitlistLapseNoticesOwed({ owedNotice: { createMany } } as never, [
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
    await deliverWaitlistLapseNotice(
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

describe("a never-told lapse alerts the officers once (#5433 owner decision D5)", () => {
  const OFFERED_AT = new Date(NOW.getTime() - 60 * HOUR);
  const lapse = { bookingId: "booking1", expiredAt: EXPIRED_AT, untoldOfferedAt: OFFERED_AT };
  const untold = owedNoticeMarker({
    kind: "waitlist-offer-lapsed-untold",
    subjectId: "booking1",
    eventAt: EXPIRED_AT,
    payload: { offeredAtMs: OFFERED_AT.getTime() },
  });
  const notice = {
    bookingId: "booking1",
    status: "WAITLISTED" as const,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    recipientMemberId: "m1",
    email: "ada@example.test",
    firstName: "Ada",
    memberName: "Ada Proof",
    lodgeId: "lodge-1",
    position: 2,
  };
  /** What the offer email's own past-cut-off step does for this offer (its member marker). */
  const offerEmailPastCutoff = () =>
    WAITLIST_OFFER_NOTICE_DELIVERERS[0]!.pastCutoff!(notice as never, waitlistOfferMemberMarker("booking1", OFFERED_AT), {
      job: "test-sweep",
      now: NOW,
    });

  it("records the officers' kind, with the offer's time in its payload, in place of the member's email, in the same insert", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    await recordWaitlistLapseNoticesOwed({ owedNotice: { createMany } } as never, [lapse, { bookingId: "told", expiredAt: EXPIRED_AT }]);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]![0].data).toEqual([
      expect.objectContaining({ id: untold.id, kind: "waitlist-offer-lapsed-untold", payload: { offeredAtMs: OFFERED_AT.getTime() } }),
      expect.objectContaining({ id: `waitlist-offer-expired:told:${EXPIRED_AT.getTime()}`, kind: "waitlist-offer-expired" }),
    ]);
  });

  it("straight after the revert alerts the officers with the lapsed-untold wording, sends the member nothing, and clears the marker", async () => {
    await deliverWaitlistLapseNotice(notice, lapse);
    expect(send.unsent).toHaveBeenCalledTimes(1);
    expect(send.unsent).toHaveBeenCalledWith(
      expect.objectContaining({ notice: "offer-lapsed-untold", bookingId: "booking1", memberName: "Ada Proof" }),
    );
    expect(send.expired).not.toHaveBeenCalled();
    expect(db.owedNoticeDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("from the sweep alerts once, and a second sweep of the same marker sends nothing more", async () => {
    await expect(sweep(ref(untold), NOW, UNTOLD)).resolves.toBe("delivered");
    await expect(sweep(ref(untold), NOW, UNTOLD)).resolves.toBe("delivered");
    expect(send.unsent).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the offer email's past-cut-off step already alerted for this offer", async () => {
    await offerEmailPastCutoff();
    expect(send.unsent).toHaveBeenCalledTimes(1);
    await expect(sweep(ref(untold), NOW, UNTOLD)).resolves.toBe("delivered");
    expect(send.unsent).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing for the offer email's past-cut-off step to send once the lapse alerted", async () => {
    await expect(sweep(ref(untold), NOW, UNTOLD)).resolves.toBe("delivered");
    await offerEmailPastCutoff();
    expect(send.unsent).toHaveBeenCalledTimes(1);
  });

  it("clears without alerting once the member is re-offered, confirmed or cancelled", async () => {
    db.bookingFindUnique.mockResolvedValue(bookingRow({ status: "WAITLIST_OFFERED" }));
    await expect(sweep(ref(untold), NOW, UNTOLD)).resolves.toBe("cleared");
    expect(send.unsent).not.toHaveBeenCalled();
  });

  it("clears, alerting nobody, a marker whose offer time cannot be read", async () => {
    const unreadable = owedNoticeMarker({ kind: "waitlist-offer-lapsed-untold", subjectId: "booking1", eventAt: EXPIRED_AT });
    await expect(sweep(ref(unreadable), NOW, UNTOLD)).resolves.toBe("delivered");
    expect(send.unsent).not.toHaveBeenCalled();
  });
});
