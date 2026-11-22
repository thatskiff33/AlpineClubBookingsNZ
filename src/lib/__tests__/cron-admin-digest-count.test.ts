import { describe, expect, it, vi } from "vitest";

// The helper under test is pure; the module's senders and client stay unused.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/email", () => ({ sendAdminDailyDigestAlert: vi.fn() }));

import {
  countDigestAlerts,
  type DigestAlertEmailGroup,
} from "../cron-admin-digest";

/**
 * #5407 item 12: the digest's alert count per line. For each template and
 * subject the count is the most copies any one officer received; a line is
 * the sum over its pairs.
 */
function group(
  templateName: string,
  subject: string,
  to: string,
  copies = 1,
): DigestAlertEmailGroup {
  return { templateName, subject, to, _count: { _all: copies } };
}

const NO_ALERTS = {
  newBookings: 0,
  paymentFailures: 0,
  capacityWarnings: 0,
  bookingsBumped: 0,
  pendingDeadlines: 0,
  xeroErrors: 0,
};

describe("countDigestAlerts", () => {
  it("counts nothing when no alert email was sent", () => {
    expect(countDigestAlerts([])).toEqual(NO_ALERTS);
  });

  it("counts one alert copied to three officers once", () => {
    expect(
      countDigestAlerts([
        group("admin-new-booking", "New Booking: Jane", "a@example.org"),
        group("admin-new-booking", "New Booking: Jane", "b@example.org"),
        group("admin-new-booking", "New Booking: Jane", "c@example.org"),
      ]),
    ).toEqual({ ...NO_ALERTS, newBookings: 1 });
  });

  it("counts repeated same-subject alerts by one officer's copies", () => {
    expect(
      countDigestAlerts([
        group("admin-payment-failure", "Payment Failed", "a@example.org", 2),
        group("admin-payment-failure", "Payment Failed", "b@example.org", 2),
      ]),
    ).toEqual({ ...NO_ALERTS, paymentFailures: 2 });
  });

  it("takes the officer who received the most when the audience changed", () => {
    expect(
      countDigestAlerts([
        group("admin-payment-failure", "Payment Failed", "a@example.org", 1),
        group("admin-payment-failure", "Payment Failed", "b@example.org", 3),
        group("admin-payment-failure", "Payment Failed", "c@example.org", 2),
      ]),
    ).toEqual({ ...NO_ALERTS, paymentFailures: 3 });
  });

  it("sums distinct subjects within a line", () => {
    expect(
      countDigestAlerts([
        group("admin-new-booking", "New Booking: Jane", "a@example.org"),
        group("admin-new-booking", "New Booking: Sam", "a@example.org", 2),
      ]),
    ).toEqual({ ...NO_ALERTS, newBookings: 3 });
  });

  it("folds both Xero templates into one line", () => {
    expect(
      countDigestAlerts([
        group("admin-xero-sync-error", "Xero Sync Error", "a@example.org", 2),
        group("admin-xero-repeated-failure", "Repeated Xero Failure: x", "a@example.org"),
      ]),
    ).toEqual({ ...NO_ALERTS, xeroErrors: 3 });
  });

  it("keeps the same subject under two templates apart", () => {
    expect(
      countDigestAlerts([
        group("admin-xero-sync-error", "Same", "a@example.org"),
        group("admin-xero-repeated-failure", "Same", "a@example.org"),
      ]),
    ).toEqual({ ...NO_ALERTS, xeroErrors: 2 });
  });

  it("maps every digest template to its own line", () => {
    expect(
      countDigestAlerts([
        group("admin-new-booking", "s", "a@example.org"),
        group("admin-payment-failure", "s", "a@example.org"),
        group("admin-capacity-warning", "s", "a@example.org"),
        group("admin-booking-bumped", "s", "a@example.org"),
        group("admin-pending-deadline", "s", "a@example.org"),
      ]),
    ).toEqual({
      newBookings: 1,
      paymentFailures: 1,
      capacityWarnings: 1,
      bookingsBumped: 1,
      pendingDeadlines: 1,
      xeroErrors: 0,
    });
  });

  it("ignores a template the digest does not count", () => {
    expect(
      countDigestAlerts([group("admin-daily-digest", "Digest", "a@example.org")]),
    ).toEqual(NO_ALERTS);
  });
});
