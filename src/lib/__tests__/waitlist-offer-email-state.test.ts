/**
 * #5433 review (round 2, items 2, 3, 4, 5b): the one definition of whether a
 * member was told of a waitlist offer, from its email's row; and the
 * retirement of a replayable row once the offer is over.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), bookingFindUnique: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { emailLog: { findMany: db.findMany, updateMany: db.updateMany }, booking: { findUnique: db.bookingFindUnique } },
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { EmailLogStatus } from "@prisma/client";

import { replayInFlightWindowMs } from "@/lib/email/replay-in-flight";
import { EMAIL_RETRY_MAX_ATTEMPTS } from "@/lib/email/retry-selection";
import {
  isOfferEmailRowTold,
  offerEmailLogId,
  offerEmailRowState,
  retireOfferEmailIfReplayable,
  offerEmailLookupStart,
  offerTimeOfEmailLogId,
  retireReplayableOfferEmails,
  WAITLIST_EMAIL_LOOKBACK_MS,
  waitlistOfferEmailStillWanted,
  waitlistOfferMovedOn,
} from "@/lib/waitlist-offer-email-state";

const NOW = new Date("2026-07-01T00:00:00.000Z");
// Exactly the replay window ago: no longer in flight (round 4, item 6).
const STALE = new Date(NOW.getTime() - replayInFlightWindowMs());
/** A row's bodies, and a last attempt just now unless a case says otherwise. */
const body = (replayable: boolean, lastAttemptAt: Date = NOW) => ({
  lastAttemptAt,
  htmlBody: null,
  bookingRetryHtmlBody: replayable ? "<p>the offer</p>" : null,
});
const offeredAt = new Date("2026-06-28T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  db.updateMany.mockResolvedValue({ count: 1 });
});

describe("offerEmailRowState", () => {
  it.each([
    ["no row", null, "not-sent", false],
    ["SENT", { status: EmailLogStatus.SENT, attempts: 1, ...body(true) }, "sent", true],
    ["QUEUED on its first attempt (the crash-during-the-provider-call limit)", { status: EmailLogStatus.QUEUED, attempts: 1, ...body(true) }, "sent", true],
    ["QUEUED past its first attempt, claimed within the replay window (the retry cron is replaying it)", { status: EmailLogStatus.QUEUED, attempts: 2, ...body(true) }, "retrying", false],
    ["QUEUED past its first attempt and older than the replay window (a replay whose SENT write failed, or that died: round 3, item 1)", { status: EmailLogStatus.QUEUED, attempts: 2, ...body(true, STALE) }, "sent", true],
    ["withheld by No emails", { status: EmailLogStatus.SKIPPED_NO_EMAILS, attempts: 1, ...body(false) }, "withheld", true],
    ["withheld by a non-production copy", { status: EmailLogStatus.SKIPPED_NON_PRODUCTION, attempts: 1, ...body(false) }, "withheld", true],
    ["FAILED, replayable", { status: EmailLogStatus.FAILED, attempts: 1, ...body(true) }, "retrying", false],
    ["FAILED at the ceiling", { status: EmailLogStatus.FAILED, attempts: EMAIL_RETRY_MAX_ATTEMPTS, ...body(true) }, "undeliverable", false],
    ["FAILED with no body (an environment fault's copy of a sensitive template)", { status: EmailLogStatus.FAILED, attempts: 1, ...body(false) }, "undeliverable", false],
    ["FAILED with its body after a fail-closed No-emails read (the retry cron's)", { status: EmailLogStatus.FAILED, attempts: 1, ...body(true) }, "retrying", false],
    ["BOUNCED (a suppressed address, or a bounce after SENT)", { status: EmailLogStatus.BOUNCED, attempts: 1, ...body(true) }, "undeliverable", false],
  ])("reads %s", (_case, row, state, told) => {
    expect(offerEmailRowState(row, NOW)).toBe(state);
    if (row) expect(isOfferEmailRowTold(row, NOW)).toBe(told);
  });

  it("classifies every status the schema has", () => {
    for (const status of Object.values(EmailLogStatus)) {
      expect(() => offerEmailRowState({ status, attempts: 1, ...body(true) }, NOW)).not.toThrow();
      expect(offerEmailRowState({ status, attempts: 1, ...body(true) }, NOW)).not.toBe(undefined);
    }
  });
});

describe("retireOfferEmailIfReplayable (round 2, item 4)", () => {
  it("retires a replayable row with an update guarded on the row as read, so the retry cron's claim and this cannot both win", async () => {
    db.findMany.mockResolvedValue([{ id: offerEmailLogId("booking1", offeredAt), status: EmailLogStatus.FAILED, attempts: 2, ...body(true) }]);
    await retireOfferEmailIfReplayable("booking1", offeredAt, "the offer lapsed");
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: offerEmailLogId("booking1", offeredAt), status: "FAILED", attempts: 2, htmlBody: null, bookingRetryHtmlBody: "<p>the offer</p>" },
      data: expect.objectContaining({
        attempts: EMAIL_RETRY_MAX_ATTEMPTS,
        htmlBody: null,
        bookingRetryHtmlBody: null,
        errorMessage: expect.stringContaining("the offer lapsed"),
      }),
    });
  });

  it.each([
    ["no row", null],
    ["a SENT row", { status: EmailLogStatus.SENT, attempts: 1, ...body(true) }],
    ["a row the cron already claimed (QUEUED)", { status: EmailLogStatus.QUEUED, attempts: 2, ...body(true) }],
    ["an exhausted row", { status: EmailLogStatus.FAILED, attempts: EMAIL_RETRY_MAX_ATTEMPTS, ...body(true) }],
  ])("writes nothing for %s", async (_case, row) => {
    db.findMany.mockResolvedValue(row ? [{ id: offerEmailLogId("booking1", offeredAt), ...row }] : []);
    await retireOfferEmailIfReplayable("booking1", offeredAt, "the offer lapsed");
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    db.findMany.mockRejectedValue(new Error("db down"));
    await expect(retireOfferEmailIfReplayable("booking1", offeredAt, "the offer lapsed")).resolves.toBeUndefined();
  });
});

describe("retireReplayableOfferEmails, the lapse's retirement inside its transaction (round 3, item 2)", () => {
  it("reads every lapsed offer's row through the transaction's client and retires only the replayable ones", async () => {
    const tx = {
      emailLog: {
        findMany: vi.fn().mockResolvedValue([
          { id: offerEmailLogId("a", offeredAt), status: EmailLogStatus.FAILED, attempts: 1, ...body(true) },
          { id: offerEmailLogId("b", offeredAt), status: EmailLogStatus.SENT, attempts: 1, ...body(true) },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const retired = await retireReplayableOfferEmails(tx as never, [
      { bookingId: "a", offeredAt },
      { bookingId: "b", offeredAt },
      { bookingId: "c", offeredAt: null },
    ], "the offer lapsed");
    expect(tx.emailLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [offerEmailLogId("a", offeredAt), offerEmailLogId("b", offeredAt)] } } }));
    expect(tx.emailLog.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.emailLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: offerEmailLogId("a", offeredAt), status: "FAILED" }) }));
    expect(retired).toEqual([offerEmailLogId("a", offeredAt)]);
    // Nothing through the module client: the write commits with the lapse.
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("lets a failed read throw, as a write inside a transaction must", async () => {
    const tx = { emailLog: { findMany: vi.fn().mockRejectedValue(new Error("aborted")), updateMany: vi.fn() } };
    await expect(retireReplayableOfferEmails(tx as never, [{ bookingId: "a", offeredAt }], "the offer lapsed")).rejects.toThrow("aborted");
  });
});

describe("waitlistOfferEmailStillWanted, the retry job's check (round 3, item 2)", () => {
  const id = offerEmailLogId("booking1", offeredAt);
  it.each([
    ["the live offer it is for", { status: "WAITLIST_OFFERED", waitlistOfferedAt: offeredAt }, true],
    ["a confirmed offer", { status: "PAYMENT_PENDING", waitlistOfferedAt: null }, "the booking is PAYMENT_PENDING"],
    ["a lapsed or returned offer", { status: "WAITLISTED", waitlistOfferedAt: null }, "the booking is WAITLISTED"],
    ["a cancelled booking", { status: "CANCELLED", waitlistOfferedAt: null }, "the booking is CANCELLED"],
    ["a later offer to the same booking", { status: "WAITLIST_OFFERED", waitlistOfferedAt: new Date(offeredAt.getTime() + 1) }, "the booking holds a different offer"],
    ["a booking that no longer exists", null, "the booking no longer exists"],
  ])("answers for %s", async (_case, booking, answer) => {
    db.bookingFindUnique.mockResolvedValue(booking);
    await expect(waitlistOfferEmailStillWanted({ id, bookingId: "booking1", createdAt: offeredAt })).resolves.toBe(answer);
  });

  it("is not wanted when the row names no booking", async () => {
    await expect(waitlistOfferEmailStillWanted({ id, bookingId: null, createdAt: offeredAt })).resolves.toBe("the email names no booking");
    expect(db.bookingFindUnique).not.toHaveBeenCalled();
  });

  it("throws on a failed read, so the job leaves the row as found", async () => {
    db.bookingFindUnique.mockRejectedValue(new Error("db down"));
    await expect(waitlistOfferEmailStillWanted({ id, bookingId: "booking1", createdAt: offeredAt })).rejects.toThrow("db down");
  });
});

describe("a row the release before #5433 wrote, with no key (round 4, item 1)", () => {
  const OLD_ID = "clx0prerelease0000000000";

  it("reads no offer time from an id without this release's key, and the exact one from a keyed id", () => {
    expect(offerTimeOfEmailLogId("booking1", OLD_ID)).toBeNull();
    expect(offerTimeOfEmailLogId("booking1", offerEmailLogId("booking1", offeredAt))).toEqual(offeredAt);
    // Another booking's keyed row, a trailing tail and a non-number are not this booking's.
    expect(offerTimeOfEmailLogId("booking1", offerEmailLogId("booking12", offeredAt))).toBeNull();
    expect(offerTimeOfEmailLogId("booking1", `${offerEmailLogId("booking1", offeredAt)}x`)).toBeNull();
    expect(offerTimeOfEmailLogId("booking1", "email:waitlist-offer:booking1:soon")).toBeNull();
    expect(offerTimeOfEmailLogId("booking1", `email:waitlist-offer:booking1:0${offeredAt.getTime()}`)).toBeNull();
    expect(offerTimeOfEmailLogId("booking1", "email:waitlist-offer:booking1:")).toBeNull();
    expect(offerTimeOfEmailLogId("booking1", "email:waitlist-offer:booking1:NaN")).toBeNull();
  });

  it("is replayed while the booking is offered at all, as that release would: the offer is not left untold", async () => {
    db.bookingFindUnique.mockResolvedValue({ status: "WAITLIST_OFFERED", waitlistOfferedAt: offeredAt });
    await expect(waitlistOfferEmailStillWanted({ id: OLD_ID, bookingId: "booking1", createdAt: offeredAt })).resolves.toBe(true);
  });

  it("is retired when it predates the booking's current offer, so an earlier offer's email is not replayed for a later one (round 5, F2)", async () => {
    const reofferedAt = new Date(offeredAt.getTime() + 3 * 86_400_000);
    db.bookingFindUnique.mockResolvedValue({ status: "WAITLIST_OFFERED", waitlistOfferedAt: reofferedAt });
    await expect(waitlistOfferEmailStillWanted({ id: OLD_ID, bookingId: "booking1", createdAt: offeredAt })).resolves.toBe(
      "the email predates the booking's current offer",
    );
  });

  it("allows the clock tolerance: a row dated up to WAITLIST_EMAIL_LOOKBACK_MS before the offer is still its own", async () => {
    db.bookingFindUnique.mockResolvedValue({ status: "WAITLIST_OFFERED", waitlistOfferedAt: offeredAt });
    const atEdge = new Date(offeredAt.getTime() - WAITLIST_EMAIL_LOOKBACK_MS);
    await expect(waitlistOfferEmailStillWanted({ id: OLD_ID, bookingId: "booking1", createdAt: atEdge })).resolves.toBe(true);
    await expect(waitlistOfferEmailStillWanted({ id: OLD_ID, bookingId: "booking1", createdAt: new Date(atEdge.getTime() - 1) })).resolves.toBe(
      "the email predates the booking's current offer",
    );
  });

  it("is the same lookback the admin waitlist page ties an email row to its offer by", () => {
    expect(offerEmailLookupStart(offeredAt)).toEqual(new Date(offeredAt.getTime() - WAITLIST_EMAIL_LOOKBACK_MS));
  });

  it.each([["WAITLISTED"], ["PAYMENT_PENDING"], ["CANCELLED"]])("is retired once the booking is %s: no offer of it is live", async (status) => {
    db.bookingFindUnique.mockResolvedValue({ status, waitlistOfferedAt: null });
    await expect(waitlistOfferEmailStillWanted({ id: OLD_ID, bookingId: "booking1", createdAt: offeredAt })).resolves.toBe(`the booking is ${status}`);
  });
});

describe("waitlistOfferMovedOn, the one same-live-offer rule (round 4, item 4)", () => {
  it.each([
    ["the same live offer", { status: "WAITLIST_OFFERED", waitlistOfferedAt: offeredAt }, null],
    ["another offer", { status: "WAITLIST_OFFERED", waitlistOfferedAt: new Date(offeredAt.getTime() + 1) }, "the booking holds a different offer"],
    ["an offer with no time", { status: "WAITLIST_OFFERED", waitlistOfferedAt: null }, "the booking holds a different offer"],
    ["an ended offer", { status: "WAITLISTED", waitlistOfferedAt: null }, "the booking is WAITLISTED"],
  ] as const)("answers for %s", (_case, booking, answer) => {
    expect(waitlistOfferMovedOn(booking as never, offeredAt)).toBe(answer);
  });
});

describe("the retrying window follows the transport timeouts (round 4, item 6)", () => {
  const queuedAgo = (ms: number) => ({ status: EmailLogStatus.QUEUED, attempts: 2, ...body(true, new Date(NOW.getTime() - ms)) });
  const MINUTE = 60_000;

  it("keeps a replay claimed 30 minutes ago as the retry cron's when the transport may still be sending it", () => {
    vi.stubEnv("EMAIL_SMTP_SOCKET_TIMEOUT_MS", "600000");
    try {
      expect(offerEmailRowState(queuedAgo(30 * MINUTE), NOW)).toBe("retrying");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the same replay as sent with the default timeouts, whose window is 20.5 minutes", () => {
    expect(offerEmailRowState(queuedAgo(30 * MINUTE), NOW)).toBe("sent");
    expect(offerEmailRowState(queuedAgo(20 * MINUTE), NOW)).toBe("retrying");
  });
});
