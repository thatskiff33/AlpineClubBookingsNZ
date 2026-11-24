/**
 * #5433 review (round 2, items 2, 3, 4, 5b): the one definition of whether a
 * member was told of a waitlist offer, from its email's row; and the
 * retirement of a replayable row once the offer is over.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findUnique: vi.fn(), updateMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { emailLog: { findUnique: db.findUnique, updateMany: db.updateMany } } }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { EmailLogStatus } from "@prisma/client";

import { EMAIL_RETRY_MAX_ATTEMPTS } from "@/lib/email/retry-selection";
import {
  isOfferEmailRowTold,
  offerEmailLogId,
  offerEmailRowState,
  retireOfferEmailIfReplayable,
} from "@/lib/waitlist-offer-email-state";

const body = (replayable: boolean) => ({ htmlBody: null, bookingRetryHtmlBody: replayable ? "<p>the offer</p>" : null });
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
    ["QUEUED past its first attempt (the retry cron is replaying it)", { status: EmailLogStatus.QUEUED, attempts: 2, ...body(true) }, "retrying", false],
    ["withheld by No emails", { status: EmailLogStatus.SKIPPED_NO_EMAILS, attempts: 1, ...body(false) }, "withheld", true],
    ["withheld by a non-production copy", { status: EmailLogStatus.SKIPPED_NON_PRODUCTION, attempts: 1, ...body(false) }, "withheld", true],
    ["FAILED, replayable", { status: EmailLogStatus.FAILED, attempts: 1, ...body(true) }, "retrying", false],
    ["FAILED at the ceiling", { status: EmailLogStatus.FAILED, attempts: EMAIL_RETRY_MAX_ATTEMPTS, ...body(true) }, "undeliverable", false],
    ["FAILED with no body (the gate's copy, a fail-closed read)", { status: EmailLogStatus.FAILED, attempts: 1, ...body(false) }, "undeliverable", false],
    ["BOUNCED (a suppressed address, or a bounce after SENT)", { status: EmailLogStatus.BOUNCED, attempts: 1, ...body(true) }, "undeliverable", false],
  ])("reads %s", (_case, row, state, told) => {
    expect(offerEmailRowState(row)).toBe(state);
    if (row) expect(isOfferEmailRowTold(row)).toBe(told);
  });

  it("classifies every status the schema has", () => {
    for (const status of Object.values(EmailLogStatus)) {
      expect(() => offerEmailRowState({ status, attempts: 1, ...body(true) })).not.toThrow();
      expect(offerEmailRowState({ status, attempts: 1, ...body(true) })).not.toBe(undefined);
    }
  });
});

describe("retireOfferEmailIfReplayable (round 2, item 4)", () => {
  it("retires a replayable row with an update guarded on the row as read, so the retry cron's claim and this cannot both win", async () => {
    db.findUnique.mockResolvedValue({ status: EmailLogStatus.FAILED, attempts: 2, ...body(true) });
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
    db.findUnique.mockResolvedValue(row);
    await retireOfferEmailIfReplayable("booking1", offeredAt, "the offer lapsed");
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    db.findUnique.mockRejectedValue(new Error("db down"));
    await expect(retireOfferEmailIfReplayable("booking1", offeredAt, "the offer lapsed")).resolves.toBeUndefined();
  });
});
