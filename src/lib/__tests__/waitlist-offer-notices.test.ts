/**
 * #5433 (WL-1): the waitlist offer's owed notices, their deliverers and owner
 * decision D2, against doubles. Real: `waitlist-offer-notices.ts`, the
 * mechanism's delivery and sweep (`owed-notice/deliver.ts`, `store.ts`).
 * Doubles: the database, the senders, the restart's transaction (proved on its
 * own in `waitlist-offer-window-restart.test.ts` and against PostgreSQL in
 * `waitlist-owed-notices.realdb.test.ts`) and the once-ever claim (proved in
 * `owed-notice-past-cutoff-once.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  emailLogFindUnique: vi.fn(),
  owedNoticeUpdateMany: vi.fn(),
  owedNoticeDeleteMany: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: db.bookingFindUnique },
    emailLog: { findUnique: db.emailLogFindUnique },
    bookingGuest: { findMany: async () => [] },
    owedNotice: { updateMany: db.owedNoticeUpdateMany, deleteMany: db.owedNoticeDeleteMany },
  },
}));
const send = vi.hoisted(() => ({
  offer: vi.fn(),
  officers: vi.fn(),
  unsent: vi.fn(),
  restart: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendWaitlistOfferEmail: send.offer,
  sendAdminWaitlistOfferAlert: send.officers,
}));
vi.mock("@/lib/email/admin-alerts-waitlist-notice-unsent", () => ({ sendAdminWaitlistNoticeUnsentAlert: send.unsent }));
vi.mock("@/lib/waitlist-offer-window-restart", () => ({ restartWaitlistOfferWindow: send.restart }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({ resolveSubscriptionLockoutMode: async () => "NO_BLOCK" }));
vi.mock("@/lib/subscription-lockout-enforcement", () => ({
  evaluateNonMemberPricingRequirements: async () => null,
  toSubscriptionLockoutParticipants: () => [],
}));
// The once-ever claim is proved where it lives; here it sends and is kept.
vi.mock("@/lib/owed-notice/past-cutoff-once", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/owed-notice/past-cutoff-once")),
  alertOfficersOncePastCutoff: async (_marker: unknown, { send: sendAlert }: { send: () => Promise<unknown> }) => {
    await sendAlert();
    return "settled";
  },
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { requireClubTimeZone } from "@/lib/club-time";
import { sweepOwedNotice, type OwedNoticeRef } from "@/lib/owed-notice/deliver";
import { owedNoticeMarker, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import {
  deliverWaitlistOfferNotices,
  findNeverToldWaitlistOffers,
  recordWaitlistOfferNoticesOwed,
  WAITLIST_NOTICE_SWEEP_AFTER_MS,
  WAITLIST_OFFER_NOTICE_DELIVERERS,
  waitlistOfferEmailKey,
  type WaitlistOfferNotice,
} from "@/lib/waitlist-offer-notices";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const [MEMBER, OFFICERS] = WAITLIST_OFFER_NOTICE_DELIVERERS;
const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-07-01T00:00:00.000Z");
const OFFERED_AT = new Date(NOW.getTime() - 3 * HOUR);
const EXPIRES_AT = new Date(OFFERED_AT.getTime() + 48 * HOUR);
const RESTARTED_TO = new Date(NOW.getTime() + 48 * HOUR);
const zone = requireClubTimeZone("Pacific/Auckland");
const SENT = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, failedBeforeLogged: 0 };
const NOBODY = { deliveryAllowed: true, recipients: 1, sent: 0, queuedForRetry: 0, notDelivered: 1, failedBeforeLogged: 1 };

const owed = { bookingId: "booking1", offeredAt: OFFERED_AT, position: 3 };
const memberMarker = owedNoticeMarker({ kind: "waitlist-offer-member", subjectId: "booking1", eventAt: OFFERED_AT });
const officersMarker = owedNoticeMarker({ kind: "waitlist-offer-officers", subjectId: "booking1", eventAt: OFFERED_AT, payload: { position: 3 } });

function notice(overrides: Partial<WaitlistOfferNotice> = {}): WaitlistOfferNotice {
  return {
    bookingId: "booking1",
    status: "WAITLIST_OFFERED",
    offeredAt: OFFERED_AT,
    expiresAt: EXPIRES_AT,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    guestCount: 2,
    recipientMemberId: "m1",
    email: "ada@example.test",
    firstName: "Ada",
    memberName: "Ada Proof",
    priceCents: 24_000,
    lodgeId: "lodge-1",
    offeredLodgeId: null,
    offeredLodgeName: null,
    zone,
    format: CLUB_FORMAT_TEST,
    lockoutMode: "NO_BLOCK",
    ...overrides,
  };
}

/** The booking row a sweep reads back, as `OFFER_NOTICE_SELECT` shapes it. */
function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking1",
    status: "WAITLIST_OFFERED",
    waitlistOfferedAt: OFFERED_AT,
    waitlistOfferExpiresAt: EXPIRES_AT,
    waitlistOfferedLodgeId: null,
    waitlistOfferedPriceCents: null,
    waitlistOfferedLodge: null,
    finalPriceCents: 24_000,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    lodgeId: "lodge-1",
    memberId: "m1",
    member: { id: "m1", email: "ada@example.test", firstName: "Ada", lastName: "Proof" },
    organisation: null,
    _count: { guests: 2 },
    ...overrides,
  };
}

/** A sweep's handle on one marker: a won claim unless told otherwise, and spies for the clear and the defer. */
function ref(marker: OwedNoticeMarker, claimed: boolean = true) {
  const handle = {
    key: marker.id,
    marker,
    claim: vi.fn(async (_bound: Date, now: Date) => (claimed ? now : null)),
    settle: vi.fn(async () => {}),
    defer: vi.fn(async () => {}),
  };
  return handle satisfies OwedNoticeRef;
}

const sweep = (deliverer: typeof MEMBER, handle: OwedNoticeRef, now = NOW) =>
  sweepOwedNotice(deliverer, handle, new Date(now.getTime() - WAITLIST_NOTICE_SWEEP_AFTER_MS), now, "test-sweep");

beforeEach(() => {
  vi.clearAllMocks();
  db.bookingFindUnique.mockResolvedValue(bookingRow());
  db.emailLogFindUnique.mockResolvedValue(null);
  db.owedNoticeUpdateMany.mockResolvedValue({ count: 1 });
  db.owedNoticeDeleteMany.mockResolvedValue({ count: 1 });
  send.offer.mockResolvedValue({ status: "sent", emailLogId: "row", messageId: null });
  send.officers.mockResolvedValue(SENT);
  send.unsent.mockResolvedValue(SENT);
  send.restart.mockResolvedValue({ kind: "in-force", expiresAt: RESTARTED_TO, restarted: true });
});

describe("recording the offer's notices (#5433 WL-1)", () => {
  it("writes the member's and the officers' markers in one insert, keyed and stamped by the offer's time, the position in the officers' payload", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    await expect(recordWaitlistOfferNoticesOwed({ owedNotice: { createMany } } as never, owed)).resolves.toBe(owed);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]![0]).toEqual({
      data: [
        expect.objectContaining({ id: `waitlist-offer-member:booking1:${OFFERED_AT.getTime()}`, stampedAt: OFFERED_AT, payload: undefined }),
        expect.objectContaining({ id: `waitlist-offer-officers:booking1:${OFFERED_AT.getTime()}`, stampedAt: OFFERED_AT, payload: { position: 3 } }),
      ],
      skipDuplicates: true,
    });
  });
});

describe("the first attempt, straight after the offer commits", () => {
  it("sends the offer email with the offer's own window and its event key, never restarts it, alerts the officers, and clears both markers", async () => {
    await deliverWaitlistOfferNotices(notice(), owed);

    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).toHaveBeenCalledTimes(1);
    expect(send.offer.mock.calls[0]![0]).toEqual({ bookingId: "booking1", recipientMemberId: "m1", idempotencyKey: `booking1:${OFFERED_AT.getTime()}` });
    expect(send.offer.mock.calls[0]![6]).toBe(EXPIRES_AT);
    expect(send.officers).toHaveBeenCalledWith(expect.objectContaining({ memberName: "Ada Proof", position: 3 }));
    // Both claims taken on the stamp the transaction wrote, both cleared under them.
    expect(db.owedNoticeUpdateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: memberMarker.id, stampedAt: { lte: OFFERED_AT } },
      { id: officersMarker.id, stampedAt: { lte: OFFERED_AT } },
    ]);
    expect(db.owedNoticeDeleteMany).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when a sweep already holds the markers", async () => {
    db.owedNoticeUpdateMany.mockResolvedValue({ count: 0 });
    await deliverWaitlistOfferNotices(notice(), owed);
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.officers).not.toHaveBeenCalled();
    expect(db.owedNoticeDeleteMany).not.toHaveBeenCalled();
  });

  it("keeps the member's marker for the sweep when the send throws", async () => {
    send.offer.mockRejectedValue(new Error("render failed"));
    await deliverWaitlistOfferNotices(notice(), owed);
    // Only the officers' marker is cleared.
    expect(db.owedNoticeDeleteMany.mock.calls.map(([args]) => args.where.id)).toEqual([officersMarker.id]);
  });
});

describe("the sweep's offer email (owner decision D2)", () => {
  it("restarts the window first, then sends once with the deadline the restart left in force, and clears the marker", async () => {
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");

    expect(send.restart).toHaveBeenCalledWith({ bookingId: "booking1", offeredAt: OFFERED_AT, zone: "Pacific/Auckland" });
    expect(send.offer).toHaveBeenCalledTimes(1);
    expect(send.offer.mock.calls[0]![6]).toBe(RESTARTED_TO);
    expect(send.offer.mock.calls[0]![0]).toMatchObject({ idempotencyKey: waitlistOfferEmailKey("booking1", OFFERED_AT) });
    expect(send.restart.mock.invocationCallOrder[0]).toBeLessThan(send.offer.mock.invocationCallOrder[0]!);
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("neither restarts nor sends when the offer email's row is already recorded (a stop after the send), and clears the marker", async () => {
    db.emailLogFindUnique.mockResolvedValue({ id: "email:waitlist-offer:x" });
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
    expect(db.emailLogFindUnique).toHaveBeenCalledWith({
      where: { id: `email:waitlist-offer:booking1:${OFFERED_AT.getTime()}` },
      select: { id: true },
    });
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the restart's claim is lost (the offer moved on under the lock), and clears the marker", async () => {
    send.restart.mockResolvedValue({ kind: "moved-on", why: "the booking is WAITLISTED" });
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
    expect(send.offer).not.toHaveBeenCalled();
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("sends nothing and keeps the marker when no window is left to give", async () => {
    send.restart.mockResolvedValue({ kind: "no-window" });
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("kept");
    expect(send.offer).not.toHaveBeenCalled();
    expect(handle.settle).not.toHaveBeenCalled();
  });

  it("keeps the marker when the restart throws (contention), sending nothing", async () => {
    send.restart.mockRejectedValue(new Error("P2028"));
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("kept");
    expect(send.offer).not.toHaveBeenCalled();
  });

  it.each([
    ["confirmed", bookingRow({ status: "PAYMENT_PENDING", waitlistOfferedAt: null, waitlistOfferExpiresAt: null })],
    ["expired", bookingRow({ status: "WAITLISTED", waitlistOfferedAt: null, waitlistOfferExpiresAt: null })],
    ["re-offered", bookingRow({ waitlistOfferedAt: new Date(NOW.getTime() - HOUR) })],
    // A cancel that leaves the offer's fields as they were: only the status says it moved on.
    ["cancelled", bookingRow({ status: "CANCELLED" })],
    ["gone", null],
  ])("clears a %s offer without restarting or sending", async (_case, row) => {
    db.bookingFindUnique.mockResolvedValue(row);
    for (const deliverer of [MEMBER, OFFICERS]) {
      const handle = ref(deliverer === MEMBER ? memberMarker : officersMarker);
      await expect(sweep(deliverer, handle)).resolves.toBe("cleared");
      expect(handle.settle).toHaveBeenCalledTimes(1);
    }
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.officers).not.toHaveBeenCalled();
  });

  it("past its cut-off (the check-in date and the offer's deadline both passed) alerts the officers once instead, and clears the marker", async () => {
    const later = new Date("2026-09-02T00:00:00.000Z");
    const offeredAt = new Date("2026-08-30T00:00:00.000Z");
    db.bookingFindUnique.mockResolvedValue(bookingRow({ waitlistOfferedAt: offeredAt, waitlistOfferExpiresAt: new Date("2026-08-31T00:00:00.000Z") }));
    const marker = owedNoticeMarker({ kind: "waitlist-offer-member", subjectId: "booking1", eventAt: offeredAt });
    const handle = ref(marker);
    await expect(sweep(MEMBER, handle, later)).resolves.toBe("expired");
    expect(send.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "offer", bookingId: "booking1", memberName: "Ada Proof" }));
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("still sends while the offer's own deadline stands even after the check-in date began (an offer made close to it)", async () => {
    const later = new Date("2026-09-01T06:00:00.000Z");
    const offeredAt = new Date("2026-08-31T00:00:00.000Z");
    db.bookingFindUnique.mockResolvedValue(bookingRow({ waitlistOfferedAt: offeredAt, waitlistOfferExpiresAt: new Date("2026-09-02T00:00:00.000Z") }));
    const marker = owedNoticeMarker({ kind: "waitlist-offer-member", subjectId: "booking1", eventAt: offeredAt });
    await expect(sweep(MEMBER, ref(marker), later)).resolves.toBe("delivered");
    expect(send.unsent).not.toHaveBeenCalled();
    expect(send.restart).toHaveBeenCalledTimes(1);
  });
});

describe("the sweep's officers' alert", () => {
  it("quotes the position the offer's transaction worked out", async () => {
    await expect(sweep(OFFICERS, ref(officersMarker))).resolves.toBe("delivered");
    expect(send.officers).toHaveBeenCalledWith(expect.objectContaining({ position: 3, guestCount: 2 }));
  });

  it("holds the marker a day when nobody received the alert and nothing will replay it", async () => {
    send.officers.mockResolvedValue(NOBODY);
    const handle = ref(officersMarker);
    await expect(sweep(OFFICERS, handle)).resolves.toBe("kept");
    expect(handle.defer).toHaveBeenCalledTimes(1);
    expect(handle.settle).not.toHaveBeenCalled();
  });

  it("clears, sending nothing, a marker whose position cannot be read", async () => {
    const handle = ref(owedNoticeMarker({ kind: "waitlist-offer-officers", subjectId: "booking1", eventAt: OFFERED_AT }));
    await expect(sweep(OFFICERS, handle)).resolves.toBe("delivered");
    expect(send.officers).not.toHaveBeenCalled();
  });
});

describe("findNeverToldWaitlistOffers (D2: no offer-expired email for an offer never told)", () => {
  const offers = [
    { bookingId: "owed", offeredAt: OFFERED_AT },
    { bookingId: "sent", offeredAt: OFFERED_AT },
    { bookingId: "crashed-after-send", offeredAt: OFFERED_AT },
    { bookingId: "past-cutoff", offeredAt: OFFERED_AT },
    { bookingId: "legacy", offeredAt: OFFERED_AT },
    { bookingId: "no-offer-time", offeredAt: null },
  ];
  const memberId = (bookingId: string) => `waitlist-offer-member:${bookingId}:${OFFERED_AT.getTime()}`;
  const emailId = (bookingId: string) => `email:waitlist-offer:${bookingId}:${OFFERED_AT.getTime()}`;

  it("counts as never told an offer with no email row whose notice is still owed or passed its cut-off unsent, and as told every other", async () => {
    const tx = {
      owedNotice: { findMany: vi.fn().mockResolvedValue([{ id: memberId("owed") }, { id: memberId("crashed-after-send") }]) },
      emailLog: { findMany: vi.fn().mockResolvedValue([{ id: emailId("sent") }, { id: emailId("crashed-after-send") }]) },
      alertCooldown: { findMany: vi.fn().mockResolvedValue([{ key: `owed-notice-past-cutoff:${memberId("past-cutoff")}` }]) },
    };
    const neverTold = await findNeverToldWaitlistOffers(tx as never, offers);
    expect([...neverTold].sort()).toEqual(["owed", "past-cutoff"]);
  });

  it("reads nothing when no lapsed offer has an offer time", async () => {
    const tx = { owedNotice: { findMany: vi.fn() }, emailLog: { findMany: vi.fn() }, alertCooldown: { findMany: vi.fn() } };
    await expect(findNeverToldWaitlistOffers(tx as never, [{ bookingId: "x", offeredAt: null }])).resolves.toEqual(new Set());
    expect(tx.owedNotice.findMany).not.toHaveBeenCalled();
  });
});
