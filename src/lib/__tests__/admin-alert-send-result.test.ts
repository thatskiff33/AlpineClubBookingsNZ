import { describe, expect, it } from "vitest";
import {
  adminAlertIsDeliveredOrQueued,
  adminAlertNeedsResend,
  adminAlertSendOutcome,
  type AdminAlertRecipientsResult,
  type AdminAlertSendResult,
} from "@/lib/email/admin-alert-send-result";

/**
 * #3643 reads a send four ways; #3672 counts recipients. One is derived from
 * the other, so the two readings can never disagree about who was reached.
 */
function result(overrides: Partial<AdminAlertSendResult>): AdminAlertSendResult {
  return {
    deliveryAllowed: true,
    recipients: 2,
    sent: 0,
    queuedForRetry: 0,
    notDelivered: 0,
    ...overrides,
  };
}

describe("adminAlertSendOutcome", () => {
  it("reads the delivery policy's skip before anything else", () => {
    expect(adminAlertSendOutcome(result({ deliveryAllowed: false, recipients: 0 }))).toBe(
      "skipped-by-policy",
    );
  });

  it("reads nobody opted in as no-recipients", () => {
    expect(adminAlertSendOutcome(result({ recipients: 0 }))).toBe("no-recipients");
  });

  it("reads any recipient sent as sent", () => {
    expect(adminAlertSendOutcome(result({ sent: 1, notDelivered: 1 }))).toBe("sent");
  });

  it("reads a copy the email retry cron will re-send as queued, never undelivered", () => {
    const queued = result({ queuedForRetry: 1, notDelivered: 1 });
    expect(adminAlertSendOutcome(queued)).toBe("queued-for-retry");
    expect(adminAlertIsDeliveredOrQueued(queued)).toBe(true);
  });

  it("reads recipients nobody reached as undelivered", () => {
    const nobody = result({ notDelivered: 2 });
    expect(adminAlertSendOutcome(nobody)).toBe("undelivered");
    expect(adminAlertIsDeliveredOrQueued(nobody)).toBe(false);
  });
});

/**
 * #5407: an alert nobody received is sent again only when some copy failed
 * before its EmailLog row existed. A refused, withheld or queued copy, a
 * policy skip and an empty audience are final.
 */
describe("adminAlertNeedsResend", () => {
  const recipientsResult = (overrides: Partial<AdminAlertRecipientsResult>): AdminAlertRecipientsResult => ({
    ...result({}),
    failedBeforeLogged: 0,
    ...overrides,
  });

  it("is true only for an undelivered alert with a copy that failed before its row", () => {
    expect(adminAlertNeedsResend(recipientsResult({ notDelivered: 2, failedBeforeLogged: 1 }))).toBe(true);
  });

  it.each([
    ["every copy refused or withheld on purpose", { notDelivered: 2 }],
    ["an officer received it", { sent: 1, notDelivered: 1, failedBeforeLogged: 1 }],
    ["the retry cron holds a copy", { queuedForRetry: 1, notDelivered: 1, failedBeforeLogged: 1 }],
    ["nobody is opted in", { recipients: 0 }],
    ["the delivery policy skipped it", { deliveryAllowed: false, recipients: 0 }],
  ])("is false when %s", (_label, overrides) => {
    expect(adminAlertNeedsResend(recipientsResult(overrides))).toBe(false);
  });
});
