import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5298 (INV-INT-043): a row a crash left QUEUED is re-sent only when it never
 * reached the mail server, and flagged to officers otherwise. The guards' race
 * against a live sender is proved on PostgreSQL in
 * `stranded-queued-email.realdb.test.ts`; this suite pins what each kind of
 * stranded row becomes.
 */
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  alert: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { emailLog: { findMany: mocks.findMany, updateMany: mocks.updateMany } } }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: mocks.logError, debug: vi.fn() } }));
vi.mock("@/lib/email/delivery-failed-alert", () => ({ alertOfficersOfUndeliveredEmail: mocks.alert }));

import {
  claimEmailHandover,
  handLostHandoversToTheRetryJob,
  senderEmailRow,
  STRANDED_QUEUED_MAX_AGE_MS,
  strandedQueuedAfterMs,
  sweepStrandedQueuedEmails,
} from "@/lib/email/handover";
import { EMAIL_RETRY_MAX_ATTEMPTS, RETAINS_REPLAYABLE_EMAIL_BODY } from "@/lib/email/retry-selection";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const STRANDED_AT = new Date(NOW.getTime() - 31 * 60_000);

type Row = {
  id: string;
  to: string;
  templateName: string;
  attempts: number;
  lastAttemptAt: Date;
  handoverState: "PENDING" | "STARTED" | "UNCONFIRMED" | null;
};

function stranded(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    to: `${id}@example.org`,
    templateName: "booking-modified",
    attempts: 1,
    lastAttemptAt: STRANDED_AT,
    handoverState: "PENDING",
    ...overrides,
  };
}

/** The candidate read, then the which-keep-a-body read. */
function given(rows: Row[], withBody: string[]) {
  mocks.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(withBody.map((id) => ({ id })));
}

const writeFor = (id: string) =>
  mocks.updateMany.mock.calls.find(([args]) => args.where.id === id)?.[0] as
    | { where: Record<string, unknown>; data: Record<string, unknown> }
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // An early return leaves the body read's queued answer unconsumed.
  mocks.findMany.mockReset();
  mocks.updateMany.mockReset();
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.alert.mockResolvedValue(undefined);
});

describe("claimEmailHandover", () => {
  // Attempts 1 as well: the previous release's retry job claims a row the sweep
  // handed back without moving it off PENDING, and a stalled sender must not
  // then claim it too.
  it("moves only a QUEUED row still PENDING at its first attempt to STARTED, and restarts its stranded clock", async () => {
    await expect(claimEmailHandover("log-1")).resolves.toEqual(NOW);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "log-1", status: "QUEUED", handoverState: "PENDING", attempts: 1 },
      data: { handoverState: "STARTED", lastAttemptAt: NOW },
    });
  });

  it("is lost when the sweep or another sender moved the row first", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(claimEmailHandover("log-1")).resolves.toBeNull();
  });
});

// #5298: a sender that stalls past the threshold must not undo the sweep.
describe("senderEmailRow", () => {
  it("writes before the hand-over only while the row is still QUEUED and PENDING at its first attempt", async () => {
    const row = senderEmailRow("log-1", { deferred: false });
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(row.write({ status: "FAILED" }, "a failed send")).resolves.toBe(false);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "log-1", status: "QUEUED", handoverState: "PENDING", attempts: 1 },
      data: { status: "FAILED" },
    });
  });

  it("writes after the hand-over only while the row is as this sender claimed it", async () => {
    const row = senderEmailRow("log-1", { deferred: false });
    await expect(row.claimHandover("booking-modified")).resolves.toBe(true);

    await row.write({ status: "SENT" }, "a sent email");
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: { id: "log-1", status: "QUEUED", handoverState: "STARTED", lastAttemptAt: NOW },
      data: { status: "SENT" },
    });
  });

  it("does not send when the claim is lost or cannot be written, and never throws", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 }).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(senderEmailRow("log-1", { deferred: false }).claimHandover("t")).resolves.toBe(false);
    await expect(senderEmailRow("log-2", { deferred: false }).claimHandover("t")).resolves.toBe(false);
    mocks.updateMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(senderEmailRow("log-3", { deferred: false }).write({ status: "BOUNCED" }, "a suppressed email")).resolves.toBe(false);
  });

  it("writes a deferred row by id, as the retry job owns it and the sweep never touches it", async () => {
    await senderEmailRow("log-1", { deferred: true }).write({ status: "BOUNCED" }, "a suppressed email");
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "log-1" }, data: { status: "BOUNCED" } });
  });
});

// A caller-retried alert one recipient received: its owner sends nothing more,
// so the copy that lost its hand-over must not wait for the sweep's release.
describe("handLostHandoversToTheRetryJob", () => {
  it("fails the copies with their bodies kept, only while nobody has handed them over", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 2 });
    await handLostHandoversToTheRetryJob(["log-1", "log-2"], "admin-stripe-dispute");

    const [{ where, data }] = mocks.updateMany.mock.calls[0]!;
    expect(where).toEqual({ id: { in: ["log-1", "log-2"] }, status: "QUEUED", handoverState: "PENDING", attempts: 1 });
    expect(data).toEqual({ status: "FAILED", errorMessage: expect.stringContaining("email retry job sends it") });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("reports a copy something else settled first, or a failed write, and never throws", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    await handLostHandoversToTheRetryJob(["log-1", "log-2"], "admin-stripe-dispute");
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({ handedOver: 1 }),
      expect.stringContaining("that recipient may not get it"),
    );

    mocks.updateMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(handLostHandoversToTheRetryJob(["log-3"], "admin-stripe-dispute")).resolves.toBeUndefined();
  });

  it("writes nothing when no hand-over was lost", async () => {
    await handLostHandoversToTheRetryJob([], "admin-stripe-dispute");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("strandedQueuedAfterMs", () => {
  it("is 30 minutes, or longer when the transport timeouts let a send stay in flight longer", () => {
    expect(strandedQueuedAfterMs()).toBe(30 * 60_000);
    vi.stubEnv("EMAIL_SMTP_SOCKET_TIMEOUT_MS", "600000");
    try {
      expect(strandedQueuedAfterMs()).toBeGreaterThan(100 * 60_000);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("sweepStrandedQueuedEmails", () => {
  it("looks only at QUEUED rows past the threshold and inside the week", async () => {
    given([], []);
    await sweepStrandedQueuedEmails(NOW);
    expect(mocks.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        status: "QUEUED",
        lastAttemptAt: {
          lt: new Date(NOW.getTime() - 30 * 60_000),
          gte: new Date(NOW.getTime() - STRANDED_QUEUED_MAX_AGE_MS),
        },
      },
      take: 50,
    });
    expect(mocks.findMany.mock.calls[0]![0].select).not.toHaveProperty("htmlBody");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("hands a never-sent row with a body back to the retry job, attempts and backoff unchanged, without an alert", async () => {
    given([stranded("resend")], ["resend"]);

    await expect(sweepStrandedQueuedEmails(NOW)).resolves.toEqual({ requeued: 1, released_to_owner: 0, never_sent: 0, unconfirmed: 0 });

    const write = writeFor("resend")!;
    expect(write.where).toEqual({
      id: "resend",
      status: "QUEUED",
      handoverState: "PENDING",
      attempts: 1,
      lastAttemptAt: STRANDED_AT,
      ...RETAINS_REPLAYABLE_EMAIL_BODY,
    });
    expect(write.data).toEqual({ status: "FAILED", errorMessage: expect.stringContaining("being sent again") });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("puts a never-sent row with no body at the retry ceiling and tells officers it was never sent", async () => {
    given([stranded("bodiless", { templateName: "password-reset" })], []);

    await expect(sweepStrandedQueuedEmails(NOW)).resolves.toEqual({ requeued: 0, released_to_owner: 0, never_sent: 1, unconfirmed: 0 });

    expect(writeFor("bodiless")!.data).toEqual({
      status: "FAILED",
      attempts: EMAIL_RETRY_MAX_ATTEMPTS,
      lastAttemptAt: NOW,
      errorMessage: expect.stringContaining("Never sent"),
    });
    expect(mocks.alert).toHaveBeenCalledWith({
      recipient: "bodiless@example.org",
      templateName: "password-reset",
      attemptCount: 1,
      stranded: "never_sent",
    });
  });

  // #5298 review: such an alert's owner sends it again when nobody received it
  // (#4669), so a re-send by the retry job as well would be a second copy.
  it("releases a never-sent caller-retried alert to its owner: body dropped, no re-send, no officer alert", async () => {
    given([stranded("owned", { templateName: "admin-bank-transfer-settlement-figure" })], ["owned"]);

    await expect(sweepStrandedQueuedEmails(NOW)).resolves.toEqual({ requeued: 0, released_to_owner: 1, never_sent: 0, unconfirmed: 0 });

    expect(writeFor("owned")!.data).toEqual({
      status: "FAILED",
      htmlBody: null,
      bookingRetryHtmlBody: null,
      errorMessage: expect.stringContaining("the alert's own retry sends it again"),
    });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it.each<[string, Pick<Row, "handoverState" | "attempts">]>([
    ["a sender that started its hand-over", { handoverState: "STARTED", attempts: 1 }],
    ["the previous release, which records nothing", { handoverState: null, attempts: 1 }],
    ["the previous release's retry job, which claims without moving it off PENDING", { handoverState: "PENDING", attempts: 2 }],
  ])("flags, and never re-sends, a row from %s", async (_label, state) => {
    given([stranded("maybe", state)], ["maybe"]);

    await expect(sweepStrandedQueuedEmails(NOW)).resolves.toEqual({ requeued: 0, released_to_owner: 0, never_sent: 0, unconfirmed: 1 });

    const write = writeFor("maybe")!;
    expect(write.where).toEqual({ id: "maybe", status: "QUEUED", ...state, lastAttemptAt: STRANDED_AT });
    expect(write.data).toEqual({
      status: "FAILED",
      attempts: EMAIL_RETRY_MAX_ATTEMPTS,
      lastAttemptAt: NOW,
      handoverState: "UNCONFIRMED",
      errorMessage: expect.stringContaining("may already have reached the recipient"),
    });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ stranded: "unconfirmed" }));
  });

  it("does nothing more for a row whose guarded write lost to a sender or another sweep", async () => {
    given([stranded("raced", { handoverState: "STARTED" })], []);
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(sweepStrandedQueuedEmails(NOW)).resolves.toEqual({ requeued: 0, released_to_owner: 0, never_sent: 0, unconfirmed: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("never throws: a failed read is logged, and one row's failed write does not stop the rest", async () => {
    mocks.findMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(sweepStrandedQueuedEmails(NOW)).resolves.toEqual({ requeued: 0, released_to_owner: 0, never_sent: 0, unconfirmed: 0 });

    given([stranded("broken"), stranded("fine")], ["broken", "fine"]);
    mocks.updateMany.mockRejectedValueOnce(new Error("deadlock"));
    await expect(sweepStrandedQueuedEmails(NOW)).resolves.toEqual({ requeued: 1, released_to_owner: 0, never_sent: 0, unconfirmed: 0 });
    expect(mocks.logError).toHaveBeenCalledTimes(2);
  });
});
