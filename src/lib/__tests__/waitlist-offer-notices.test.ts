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
  emailLogUpdateMany: vi.fn(),
  owedNoticeUpdateMany: vi.fn(),
  owedNoticeDeleteMany: vi.fn(),
  owedNoticeFindUnique: vi.fn(),
  suppression: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: db.bookingFindUnique },
    // The retirement reads its rows by id list; one offer here, so it is the one row `findUnique` gives.
    emailLog: {
      findUnique: db.emailLogFindUnique,
      findMany: async (args: { where: { id: { in: string[] } } }) => {
        const found = await db.emailLogFindUnique({ where: { id: args.where.id.in[0] } });
        return found ? [{ id: args.where.id.in[0], ...found }] : [];
      },
      updateMany: db.emailLogUpdateMany,
    },
    bookingGuest: { findMany: async () => [] },
    owedNotice: { updateMany: db.owedNoticeUpdateMany, deleteMany: db.owedNoticeDeleteMany, findUnique: db.owedNoticeFindUnique },
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
vi.mock("@/lib/email-suppression", () => ({ getActiveEmailSuppression: db.suppression }));
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
const audit = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: audit.log }));

import { requireClubTimeZone } from "@/lib/club-time";
import { sweepOwedNotice, type OwedNoticeRef } from "@/lib/owed-notice/deliver";
import { owedNoticeMarker, type OwedNoticeMarker } from "@/lib/owed-notice/store";
import {
  deliverWaitlistOfferNotices,
  findNeverToldWaitlistOffers,
  recordWaitlistOfferNoticesOwed,
  WAITLIST_OFFER_NOTICE_DELIVERERS,
  type WaitlistOfferNotice,
} from "@/lib/waitlist-offer-notices";
import { waitlistOfferEmailKey } from "@/lib/waitlist-offer-email-state";
import { WAITLIST_NOTICE_SWEEP_AFTER_MS } from "@/lib/waitlist-offer-window";
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

/** An offer email row as `readOfferEmailState` reads it; `replayable` keeps a body the retry cron can replay. */
function row(status: string, attempts = 1, replayable = true, lastAttemptAt = NOW) {
  return { status, attempts, lastAttemptAt, htmlBody: null, bookingRetryHtmlBody: replayable ? "<p>the offer</p>" : null };
}

/** The offer email's row, fixed whatever is sent. */
function emailRow(status: string | null, attempts = 1, replayable = true) {
  db.emailLogFindUnique.mockResolvedValue(status === null ? null : row(status, attempts, replayable));
}

/** No row until the member's send runs, then `after` (a SENT row by default). */
function rowAfterSend(after: ReturnType<typeof row> | null = row("SENT")) {
  db.emailLogFindUnique.mockImplementation(async () => (send.offer.mock.calls.length > 0 ? after : null));
}

beforeEach(() => {
  vi.clearAllMocks();
  db.bookingFindUnique.mockResolvedValue(bookingRow());
  rowAfterSend();
  db.emailLogUpdateMany.mockResolvedValue({ count: 1 });
  db.owedNoticeFindUnique.mockResolvedValue(null);
  db.suppression.mockResolvedValue(null);
  db.owedNoticeUpdateMany.mockResolvedValue({ count: 1 });
  db.owedNoticeDeleteMany.mockResolvedValue({ count: 1 });
  send.offer.mockResolvedValue({ status: "sent", emailLogId: "row", messageId: null });
  send.officers.mockResolvedValue(SENT);
  send.unsent.mockResolvedValue(SENT);
  send.restart.mockResolvedValue({ kind: "in-force", expiresAt: RESTARTED_TO, restarted: true, previousExpiresAt: EXPIRES_AT });
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
  it("sends the offer email with the offer's own window and its event key, never restarts it, alerts the officers once it went, and clears both markers", async () => {
    await deliverWaitlistOfferNotices(notice(), owed);

    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).toHaveBeenCalledTimes(1);
    expect(send.offer.mock.calls[0]![0]).toEqual({ bookingId: "booking1", recipientMemberId: "m1", idempotencyKey: `booking1:${OFFERED_AT.getTime()}` });
    expect(send.offer.mock.calls[0]![6]).toBe(EXPIRES_AT);
    expect(send.officers).toHaveBeenCalledWith(
      expect.objectContaining({ memberName: "Ada Proof", position: 3, expiresAt: EXPIRES_AT, offerEmail: "sent" }),
    );
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

  it("keeps both markers when the member's send throws before its row: the officers' alert waits for the email (review L)", async () => {
    send.offer.mockRejectedValue(new Error("render failed"));
    // A send that throws writes no row, and the member's marker still stands,
    // so the officers' alert waits for it.
    emailRow(null);
    db.owedNoticeFindUnique.mockResolvedValue({ id: memberMarker.id });
    await deliverWaitlistOfferNotices(notice(), owed);
    expect(send.officers).not.toHaveBeenCalled();
    expect(db.owedNoticeDeleteMany).not.toHaveBeenCalled();
  });

  describe("a send that returns without reaching the member (round 2, item 2)", () => {
    it.each([
      ["a suppressed address (BOUNCED)", row("BOUNCED")],
      ["a FAILED row with nothing left to replay (its body gone)", row("FAILED", 1, false)],
      ["an empty or placeholder address (no row at all)", null],
    ])("alerts the officers once and clears the member's marker for %s; the routine offer alert still goes, saying the email was not delivered", async (_case, after) => {
      rowAfterSend(after);
      send.offer.mockResolvedValue(after ? { status: "suppressed", emailLogId: "row" } : { status: "skipped_no_recipient", emailLogId: null });
      await deliverWaitlistOfferNotices(notice(), owed);
      expect(send.unsent).toHaveBeenCalledTimes(1);
      expect(send.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "offer", bookingId: "booking1" }));
      // As before #5433, the officers' routine alert goes for every offer; it now says what became of the email.
      expect(send.officers).toHaveBeenCalledTimes(1);
      expect(send.officers).toHaveBeenCalledWith(expect.objectContaining({ offerEmail: "not-delivered", expiresAt: EXPIRES_AT }));
      expect(db.owedNoticeDeleteMany).toHaveBeenCalledTimes(2);
    });

    it("keeps the member's marker, alerting nobody, when the retry cron holds the email (FAILED, replayable)", async () => {
      rowAfterSend(row("FAILED", 1, true));
      db.owedNoticeFindUnique.mockResolvedValue({ id: memberMarker.id });
      await deliverWaitlistOfferNotices(notice(), owed);
      expect(send.unsent).not.toHaveBeenCalled();
      expect(send.officers).not.toHaveBeenCalled();
      expect(db.owedNoticeDeleteMany).not.toHaveBeenCalled();
    });

    it("words the routine officers' alert as withheld when the offer email was withheld by design", async () => {
      rowAfterSend(row("SKIPPED_NO_EMAILS"));
      await deliverWaitlistOfferNotices(notice(), owed);
      expect(send.unsent).not.toHaveBeenCalled();
      expect(send.officers).toHaveBeenCalledWith(expect.objectContaining({ offerEmail: "withheld" }));
    });
  });
});

describe("the sweep's offer email (owner decision D2; the told rule, review B)", () => {
  it("restarts the window on the sweep's clock first, audits it, then sends once with the deadline in force, and clears the marker", async () => {
    const handle = ref(memberMarker);
    // The sweep's own instant, not the process clock (frozen at NOW in tests).
    const sweepAt = new Date(NOW.getTime() + 5 * 60 * 1000);
    await expect(sweep(MEMBER, handle, sweepAt)).resolves.toBe("delivered");

    expect(send.restart).toHaveBeenCalledWith({ bookingId: "booking1", offeredAt: OFFERED_AT, zone: "Pacific/Auckland", now: sweepAt });
    expect(send.offer).toHaveBeenCalledTimes(1);
    expect(send.offer.mock.calls[0]![6]).toBe(RESTARTED_TO);
    expect(send.offer.mock.calls[0]![0]).toMatchObject({ idempotencyKey: waitlistOfferEmailKey("booking1", OFFERED_AT) });
    expect(send.restart.mock.invocationCallOrder[0]).toBeLessThan(send.offer.mock.invocationCallOrder[0]!);
    expect(handle.settle).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "waitlist.offer_window_restarted",
        category: "booking",
        targetId: "booking1",
        metadata: { previousExpiresAt: EXPIRES_AT.toISOString(), expiresAt: RESTARTED_TO.toISOString() },
      }),
    );
  });

  it("writes no audit row when the deadline in force was not moved", async () => {
    send.restart.mockResolvedValue({ kind: "in-force", expiresAt: EXPIRES_AT, restarted: false });
    await expect(sweep(MEMBER, ref(memberMarker))).resolves.toBe("delivered");
    expect(send.offer.mock.calls[0]![6]).toBe(EXPIRES_AT);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([["SENT"], ["QUEUED"], ["SKIPPED_NO_EMAILS"], ["SKIPPED_NON_PRODUCTION"]])(
    "clears without restarting or sending when the offer email's row is %s on its first attempt (told)",
    async (status) => {
      emailRow(status);
      const handle = ref(memberMarker);
      await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
      expect(db.emailLogFindUnique).toHaveBeenCalledWith({
        where: { id: `email:waitlist-offer:booking1:${OFFERED_AT.getTime()}` },
        select: { status: true, attempts: true, lastAttemptAt: true, htmlBody: true, bookingRetryHtmlBody: true },
      });
      expect(send.restart).not.toHaveBeenCalled();
      expect(send.offer).not.toHaveBeenCalled();
      expect(send.unsent).not.toHaveBeenCalled();
      expect(handle.settle).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["a FAILED row it can still replay", "FAILED"],
    ["a QUEUED row past its first attempt (the cron is replaying it, round 2 item 3)", "QUEUED"],
  ])("waits, restarting and sending nothing, while the email retry cron holds %s", async (_case, status) => {
    emailRow(status, status === "QUEUED" ? 2 : 1, true);
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("kept");
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.unsent).not.toHaveBeenCalled();
    expect(handle.settle).not.toHaveBeenCalled();
  });

  it.each([
    ["an exhausted FAILED row", "FAILED", 3, true],
    ["a FAILED row with no body to replay", "FAILED", 1, false],
    ["a BOUNCED row", "BOUNCED", 1, true],
  ])("alerts the officers once, sending and restarting nothing, for %s, and clears the marker", async (_case, status, attempts, replayable) => {
    emailRow(status, attempts, replayable);
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
    expect(send.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "offer", bookingId: "booking1" }));
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the restart's claim is lost (the offer moved on under the lock), and clears the marker", async () => {
    send.restart.mockResolvedValue({ kind: "moved-on", why: "the booking is WAITLISTED" });
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.unsent).not.toHaveBeenCalled();
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("retires a replayable offer email when the restart finds the offer moved on (round 2, item 4)", async () => {
    send.restart.mockResolvedValue({ kind: "moved-on", why: "the booking is WAITLISTED" });
    // No row when the sweep read it; a replayable one (another attempt's failed send) by the time the restart lost.
    db.emailLogFindUnique.mockResolvedValueOnce(null).mockResolvedValue(row("FAILED", 1, true));
    await expect(sweep(MEMBER, ref(memberMarker))).resolves.toBe("delivered");
    expect(db.emailLogUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "FAILED", attempts: 1 }) }),
    );
  });

  it("keeps the notice, restarting, sending and alerting nothing, when the suppression list cannot be read (round 3, item 4)", async () => {
    db.suppression.mockRejectedValue(new Error("db down"));
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("kept");
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.unsent).not.toHaveBeenCalled();
    expect(handle.settle).not.toHaveBeenCalled();
  });

  it("alerts the officers instead, restarting and sending nothing, for a placeholder address (round 2, item 6)", async () => {
    db.bookingFindUnique.mockResolvedValue(bookingRow({ member: { id: "m1", email: "walk-in@no-email.invalid", firstName: "Ada", lastName: "Proof" } }));
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "offer" }));
  });

  it("alerts the officers instead, restarting and sending nothing, for an address on the SES suppression list (round 2, item 6)", async () => {
    db.suppression.mockResolvedValue({ email: "ada@example.test" });
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "offer" }));
  });

  it("alerts the officers after a sweep send that the core recorded as BOUNCED", async () => {
    rowAfterSend(row("BOUNCED"));
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
    expect(send.offer).toHaveBeenCalledTimes(1);
    expect(send.unsent).toHaveBeenCalledTimes(1);
  });

  it("sends no offer email and alerts the officers instead when too little window is left (review D)", async () => {
    send.restart.mockResolvedValue({ kind: "no-window" });
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("delivered");
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "offer" }));
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("restarts once, then on a send that fails again sends a later sweep with the deadline in force (review C)", async () => {
    // The first send throws before its row; the second writes a SENT row.
    let sent = false;
    send.offer.mockRejectedValueOnce(new Error("render failed")).mockImplementation(async () => {
      sent = true;
      return { status: "sent", emailLogId: "row", messageId: null };
    });
    db.emailLogFindUnique.mockImplementation(async () => (sent ? row("SENT") : null));
    const handle = ref(memberMarker);
    await expect(sweep(MEMBER, handle)).resolves.toBe("kept");
    // The real restart answers the restarted deadline unmoved on the second sweep.
    send.restart.mockResolvedValue({ kind: "in-force", expiresAt: RESTARTED_TO, restarted: false });
    await expect(sweep(MEMBER, ref(memberMarker), new Date(NOW.getTime() + HOUR))).resolves.toBe("delivered");
    expect(send.offer).toHaveBeenCalledTimes(2);
    expect(send.offer.mock.calls[1]![6]).toBe(RESTARTED_TO);
    expect(audit.log).toHaveBeenCalledTimes(1);
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
  ])("clears a %s offer without restarting or sending", async (_case, booking) => {
    db.bookingFindUnique.mockResolvedValue(booking);
    for (const deliverer of [MEMBER, OFFICERS]) {
      const handle = ref(deliverer === MEMBER ? memberMarker : officersMarker);
      await expect(sweep(deliverer, handle)).resolves.toBe("cleared");
      expect(handle.settle).toHaveBeenCalledTimes(1);
    }
    expect(send.restart).not.toHaveBeenCalled();
    expect(send.offer).not.toHaveBeenCalled();
    expect(send.officers).not.toHaveBeenCalled();
  });

  it("retires a replayable offer email when the offer has moved on, guarded on the row as read (round 2, item 4)", async () => {
    db.bookingFindUnique.mockResolvedValue(bookingRow({ status: "WAITLISTED", waitlistOfferedAt: null, waitlistOfferExpiresAt: null }));
    emailRow("FAILED", 1, true);
    await expect(sweep(MEMBER, ref(memberMarker))).resolves.toBe("cleared");
    expect(db.emailLogUpdateMany).toHaveBeenCalledWith({
      where: {
        id: `email:waitlist-offer:booking1:${OFFERED_AT.getTime()}`,
        status: "FAILED",
        attempts: 1,
        htmlBody: null,
        bookingRetryHtmlBody: "<p>the offer</p>",
      },
      data: expect.objectContaining({ attempts: 3, htmlBody: null, bookingRetryHtmlBody: null }),
    });
  });

  it("retires nothing when the moved-on offer's email row is not replayable", async () => {
    db.bookingFindUnique.mockResolvedValue(bookingRow({ status: "WAITLISTED", waitlistOfferedAt: null, waitlistOfferExpiresAt: null }));
    emailRow("SENT");
    await expect(sweep(MEMBER, ref(memberMarker))).resolves.toBe("cleared");
    expect(db.emailLogUpdateMany).not.toHaveBeenCalled();
  });

  describe("past its cut-off (the check-in date and the offer's deadline both passed)", () => {
    const later = new Date("2026-09-02T00:00:00.000Z");
    const offeredAt = new Date("2026-08-30T00:00:00.000Z");
    const marker = owedNoticeMarker({ kind: "waitlist-offer-member", subjectId: "booking1", eventAt: offeredAt });
    beforeEach(() => {
      db.bookingFindUnique.mockResolvedValue(bookingRow({ waitlistOfferedAt: offeredAt, waitlistOfferExpiresAt: new Date("2026-08-31T00:00:00.000Z") }));
    });

    it("alerts the officers once instead, and clears the marker", async () => {
      const handle = ref(marker);
      await expect(sweep(MEMBER, handle, later)).resolves.toBe("expired");
      expect(send.unsent).toHaveBeenCalledWith(expect.objectContaining({ notice: "offer", bookingId: "booking1", memberName: "Ada Proof" }));
      expect(send.restart).not.toHaveBeenCalled();
      expect(send.offer).not.toHaveBeenCalled();
      expect(handle.settle).toHaveBeenCalledTimes(1);
    });

    it("alerts nobody when the offer email did reach the member after all (review G)", async () => {
      emailRow("SENT");
      const handle = ref(marker);
      await expect(sweep(MEMBER, handle, later)).resolves.toBe("expired");
      expect(send.unsent).not.toHaveBeenCalled();
      expect(handle.settle).toHaveBeenCalledTimes(1);
    });

    it("still alerts when the email's row is FAILED at the cut-off, even one the cron could replay", async () => {
      emailRow("FAILED", 1, true);
      await expect(sweep(MEMBER, ref(marker), later)).resolves.toBe("expired");
      expect(send.unsent).toHaveBeenCalledTimes(1);
    });
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

describe("the sweep's officers' alert (it says the offer email has been sent: review L)", () => {
  it("quotes the position the offer's transaction worked out, once the offer email is told", async () => {
    emailRow("SENT");
    await expect(sweep(OFFICERS, ref(officersMarker))).resolves.toBe("delivered");
    expect(send.officers).toHaveBeenCalledWith(expect.objectContaining({ position: 3, guestCount: 2 }));
  });

  it.each([["never sent, its notice still owed", null], ["the retry cron's", "FAILED"]])(
    "waits, sending nothing, while the offer email is %s",
    async (_case, status) => {
      emailRow(status, 1, true);
      db.owedNoticeFindUnique.mockResolvedValue({ id: memberMarker.id });
      const handle = ref(officersMarker);
      await expect(sweep(OFFICERS, handle)).resolves.toBe("kept");
      expect(send.officers).not.toHaveBeenCalled();
      expect(handle.settle).not.toHaveBeenCalled();
    },
  );

  it("goes, saying the email was not delivered, when the offer email has no row and its notice has ended (an owner with no address): it does not wait every half hour", async () => {
    emailRow(null);
    db.owedNoticeFindUnique.mockResolvedValue(null);
    const handle = ref(officersMarker);
    await expect(sweep(OFFICERS, handle)).resolves.toBe("delivered");
    expect(send.officers).toHaveBeenCalledWith(expect.objectContaining({ offerEmail: "not-delivered" }));
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("goes, saying the email was not delivered, when the offer email is undeliverable: officers got this alert for every offer before #5433", async () => {
    emailRow("BOUNCED");
    const handle = ref(officersMarker);
    await expect(sweep(OFFICERS, handle)).resolves.toBe("delivered");
    expect(send.officers).toHaveBeenCalledWith(expect.objectContaining({ offerEmail: "not-delivered" }));
    expect(handle.settle).toHaveBeenCalledTimes(1);
  });

  it("holds the marker a day when nobody received the alert and nothing will replay it", async () => {
    emailRow("SENT");
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

describe("findNeverToldWaitlistOffers (D2: no offer-expired email for an offer never told; review B)", () => {
  const offers = [
    { bookingId: "owed", offeredAt: OFFERED_AT },
    { bookingId: "sent", offeredAt: OFFERED_AT },
    { bookingId: "crashed-after-send", offeredAt: OFFERED_AT },
    { bookingId: "failed", offeredAt: OFFERED_AT },
    { bookingId: "bounced", offeredAt: OFFERED_AT },
    { bookingId: "withheld", offeredAt: OFFERED_AT },
    { bookingId: "replaying", offeredAt: OFFERED_AT },
    { bookingId: "stale-replay", offeredAt: OFFERED_AT },
    { bookingId: "past-cutoff", offeredAt: OFFERED_AT },
    { bookingId: "legacy", offeredAt: OFFERED_AT },
    { bookingId: "no-offer-time", offeredAt: null },
  ];
  const memberId = (bookingId: string) => `waitlist-offer-member:${bookingId}:${OFFERED_AT.getTime()}`;
  const emailId = (bookingId: string) => `email:waitlist-offer:${bookingId}:${OFFERED_AT.getTime()}`;

  it("counts as never told an offer whose email row is not told whatever else remains, and one with no row only when its notice is still owed or passed its cut-off unsent", async () => {
    const tx = {
      owedNotice: {
        findMany: vi.fn().mockResolvedValue(
          ["owed", "crashed-after-send", "withheld"].map((id) => ({ id: memberId(id) })),
        ),
      },
      emailLog: {
        findMany: vi.fn().mockResolvedValue([
          { id: emailId("sent"), status: "SENT", attempts: 1, lastAttemptAt: NOW },
          { id: emailId("crashed-after-send"), status: "QUEUED", attempts: 1, lastAttemptAt: NOW },
          // No marker or claim remains for these: the row alone decides.
          { id: emailId("failed"), status: "FAILED", attempts: 1, lastAttemptAt: NOW },
          { id: emailId("bounced"), status: "BOUNCED", attempts: 1, lastAttemptAt: NOW },
          { id: emailId("replaying"), status: "QUEUED", attempts: 2, lastAttemptAt: NOW },
          // Round 3, item 1: a replay left QUEUED long ago reads as sent (the provider may have it).
          { id: emailId("stale-replay"), status: "QUEUED", attempts: 2, lastAttemptAt: new Date(NOW.getTime() - HOUR) },
          { id: emailId("withheld"), status: "SKIPPED_NO_EMAILS", attempts: 1, lastAttemptAt: NOW },
        ]),
      },
      alertCooldown: { findMany: vi.fn().mockResolvedValue([{ key: `owed-notice-past-cutoff:${memberId("past-cutoff")}` }]) },
    };
    const neverTold = await findNeverToldWaitlistOffers(tx as never, offers);
    expect([...neverTold].sort()).toEqual(["bounced", "failed", "owed", "past-cutoff", "replaying"]);
    // The read carries the last attempt, which tells a live replay from a stale one (round 3, item 1).
    expect(tx.emailLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ lastAttemptAt: true }) }));
  });

  it("reads nothing when no lapsed offer has an offer time", async () => {
    const tx = { owedNotice: { findMany: vi.fn() }, emailLog: { findMany: vi.fn() }, alertCooldown: { findMany: vi.fn() } };
    await expect(findNeverToldWaitlistOffers(tx as never, [{ bookingId: "x", offeredAt: null }])).resolves.toEqual(new Set());
    expect(tx.owedNotice.findMany).not.toHaveBeenCalled();
  });
});
