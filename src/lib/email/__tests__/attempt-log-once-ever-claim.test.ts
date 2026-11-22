import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5255 (`INV-INT-042`): an admin alert sent under a once-ever claim writes its
 * email row only together with the claim's confirm, in one transaction, so
 * the sweep's give-back and the row cannot both win. Only the alert's own
 * emails carry the claim: a second alert in the same send, and any email sent
 * outside one, are recorded exactly as before.
 */
const db = vi.hoisted(() => {
  const topLevelCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "log-top", ...args.data }));
  const txCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "log-tx", ...args.data }));
  const confirm = vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 }));
  const tx = { emailLog: { create: txCreate }, alertCooldown: { updateMany: confirm } };
  return {
    topLevelCreate,
    txCreate,
    confirm,
    transaction: vi.fn(async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)),
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: { create: db.topLevelCreate, findUnique: vi.fn() },
    $transaction: db.transaction,
    member: { findMany: vi.fn(async () => [{ email: "officer@example.org", canLogin: true, accessRoles: [] }]) },
  },
}));
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: logger }));

const sendEmail = vi.hoisted(() =>
  vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({ status: "sent", emailLogId: "log-1", messageId: null })),
);
vi.mock("@/lib/email/core", () => ({ sendEmail }));
const escalate = vi.hoisted(() => vi.fn<(args: { outcomes: { status: string }[] }) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/email-admin-alert-escalation", () => ({ recordAdminAlertDeliveryEscalation: escalate }));
vi.mock("@/lib/admin-permissions", () => ({ hasAdminAreaAccess: () => true }));

import { recordEmailAttempt } from "@/lib/email/attempt-log";
import { sendAdminAlertTo, sendUnmuteableAdminAlert } from "@/lib/email/admin-alerts-shared";
import { newOnceEverClaimHandle, OnceEverClaimRefusedError, runWithOnceEverClaim } from "@/lib/once-ever-claim-context";

const CLAIMED_AT = new Date("2026-07-01T00:00:00.000Z");
const attempt = {
  recipient: "officer@example.org",
  subject: "Alert",
  templateName: "admin-payment-failure",
  html: "<p>Alert</p>",
  bookingContext: "none" as const,
  bodyOverrideApplied: false,
  persistHtmlBody: true,
  hasAttachments: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.confirm.mockResolvedValue({ count: 1 });
});

describe("recordEmailAttempt under a once-ever claim (#5255)", () => {
  it("confirms the claim and writes the row in one transaction, with the same row as an unclaimed send", async () => {
    const claim = newOnceEverClaimHandle("once:1", CLAIMED_AT);

    await expect(recordEmailAttempt({ ...attempt, onceEverClaim: claim })).resolves.toEqual({ kind: "created", emailLogId: "log-tx" });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.confirm).toHaveBeenCalledWith({ where: { key: "once:1", lastAlertedAt: CLAIMED_AT }, data: { awaitingSendSince: null } });
    expect(db.topLevelCreate).not.toHaveBeenCalled();
    expect(claim).toMatchObject({ rowWritten: true, rowWriteFailed: false });

    await recordEmailAttempt(attempt);
    expect(db.txCreate.mock.calls[0]![0]).toEqual(db.topLevelCreate.mock.calls[0]![0]);
  });

  it("writes no row and throws when the claim is no longer this sender's, so nothing is sent", async () => {
    db.confirm.mockResolvedValueOnce({ count: 0 });
    const claim = newOnceEverClaimHandle("once:1", CLAIMED_AT);

    const refused = recordEmailAttempt({ ...attempt, onceEverClaim: claim });
    await expect(refused).rejects.toBeInstanceOf(OnceEverClaimRefusedError);
    await expect(refused).rejects.toMatchObject({ cause: { message: expect.stringMatching(/no longer held/) } });
    expect(db.txCreate).not.toHaveBeenCalled();
    expect(db.topLevelCreate).not.toHaveBeenCalled();
    expect(claim).toMatchObject({ rowWritten: false, rowWriteFailed: true });
  });

  it("throws on a database error rather than sending with no row, unlike an unclaimed send", async () => {
    db.txCreate.mockRejectedValueOnce(new Error("connection lost"));
    const claim = newOnceEverClaimHandle("once:1", CLAIMED_AT);
    const failed = recordEmailAttempt({ ...attempt, onceEverClaim: claim });
    await expect(failed).rejects.toBeInstanceOf(OnceEverClaimRefusedError);
    await expect(failed).rejects.toMatchObject({ cause: { message: "connection lost" } });
    expect(claim.rowWriteFailed).toBe(true);

    // Without a claim the row stays best effort, as before #5255.
    db.topLevelCreate.mockRejectedValueOnce(new Error("connection lost"));
    await expect(recordEmailAttempt(attempt)).resolves.toEqual({ kind: "created", emailLogId: null });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a claim on an email that also carries an event key", async () => {
    await expect(
      recordEmailAttempt({ ...attempt, idempotencyKey: "event-1", onceEverClaim: newOnceEverClaimHandle("once:1", CLAIMED_AT) }),
    ).rejects.toThrow(/event key/);
  });
});

describe("only the alert's own emails carry the claim (#5255)", () => {
  const alert = { subject: "Alert", html: "<p>Alert</p>", templateName: "admin-payment-failure", preferenceKey: "adminPaymentFailure" as const };
  const claimOf = (call: number) => sendEmail.mock.calls[call]![0].onceEverClaim;

  it("passes the claim to every recipient of the first alert, and to no later alert in the same send", async () => {
    const handle = newOnceEverClaimHandle("once:1", CLAIMED_AT);

    await runWithOnceEverClaim(handle, async () => {
      await sendAdminAlertTo({ ...alert, emails: ["a@example.org", "b@example.org"] });
      await sendAdminAlertTo({ ...alert, emails: ["c@example.org"] });
    });

    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(claimOf(0)).toBe(handle);
    expect(claimOf(1)).toBe(handle);
    expect(sendEmail.mock.calls[2]![0]).not.toHaveProperty("onceEverClaim");
  });

  it("sends an alert outside any claim with exactly the arguments it always had", async () => {
    await sendAdminAlertTo({ ...alert, emails: ["a@example.org"] });
    expect(sendEmail.mock.calls[0]![0]).toEqual({
      to: "a@example.org",
      subject: "Alert",
      html: "<p>Alert</p>",
      bookingContext: "none",
      templateName: "admin-payment-failure",
      templateData: undefined,
      attachments: undefined,
      // #5407: every admin alert copy reports when its row is written.
      onAttemptLogged: expect.any(Function),
    });
  });

  it("passes the claim through the unmuteable sender too", async () => {
    const handle = newOnceEverClaimHandle("once:1", CLAIMED_AT);
    await runWithOnceEverClaim(handle, () =>
      sendUnmuteableAdminAlert({ subject: "Alert", html: "<p>Alert</p>", templateName: "admin-payment-failure", requirement: { area: "finance", level: "edit" } }),
    );
    expect(claimOf(0)).toBe(handle);
    expect(handle.taken).toBe(true);
  });
});

describe("a refused claim is not a delivery failure (#5255)", () => {
  const alert = { subject: "Alert", html: "<p>Alert</p>", templateName: "admin-payment-failure", preferenceKey: "adminPaymentFailure" as const };
  const refused = () => new OnceEverClaimRefusedError("once:1", new Error("no longer held"));

  it("records no undeliverable escalation and queues nothing when every recipient's claim was refused", async () => {
    sendEmail.mockRejectedValue(refused());
    const result = await sendAdminAlertTo({ ...alert, emails: ["a@example.org", "b@example.org"] });
    sendEmail.mockReset();

    expect(escalate).not.toHaveBeenCalled();
    expect(result).toEqual({ deliveryAllowed: true, recipients: 2, sent: 0, queuedForRetry: 0, notDelivered: 2, failedBeforeLogged: 0 });
  });

  it("escalates only the genuine failure when one recipient was refused and another's send failed", async () => {
    // The failed copy's row was written first, so the retry cron replays it (#5407).
    sendEmail.mockRejectedValueOnce(refused()).mockImplementationOnce(async ({ onAttemptLogged }) => {
      (onAttemptLogged as (id: string) => void)("log-2");
      throw new Error("SES down");
    });
    const result = await sendAdminAlertTo({ ...alert, emails: ["a@example.org", "b@example.org"] });

    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0]![0].outcomes).toEqual([{ status: "failed" }]);
    expect(result).toMatchObject({ sent: 0, queuedForRetry: 1, notDelivered: 1 });
  });

  it("MUTATION: an ordinary send failure still escalates as undeliverable", async () => {
    sendEmail.mockRejectedValueOnce(new Error("SES down"));
    await sendAdminAlertTo({ ...alert, emails: ["a@example.org"] });
    expect(escalate.mock.calls[0]![0].outcomes).toEqual([{ status: "failed" }]);
  });

  it("the unmuteable sender records no escalation when every recipient's claim was refused, but still does for a failure", async () => {
    const unmuteable = { subject: "Alert", html: "<p>Alert</p>", templateName: "admin-payment-failure", requirement: { area: "finance", level: "edit" } } as const;
    sendEmail.mockRejectedValueOnce(refused());
    await sendUnmuteableAdminAlert(unmuteable);
    expect(escalate).not.toHaveBeenCalled();

    sendEmail.mockRejectedValueOnce(new Error("SES down"));
    await sendUnmuteableAdminAlert(unmuteable);
    expect(escalate.mock.calls[0]![0].outcomes).toEqual([{ status: "failed" }]);
  });
});
