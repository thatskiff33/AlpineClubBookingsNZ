import type { EmailSendOutcome } from "@/lib/email/core";

/**
 * The mailer's own outcome shapes, for the tests that stub a send helper
 * (ENV-SAFETY 2, #3035; INV-CONFIG-004).
 *
 * WHY THESE ARE SHARED RATHER THAN RE-STUBBED PER FILE. `sendEmail` RETURNS
 * rather than throws when nothing was transmitted, so a caller that advances
 * business state — a "reminder sent" stamp, an audit row, an age tier and a
 * minted invitation token — has to inspect the outcome. Several of those callers
 * were stubbed as `mockResolvedValue(undefined)`, which was harmless while they
 * ignored the outcome and is a landmine once they do not: `undefined.status`
 * throws inside the loop, the caller's own `catch` swallows it, and every
 * assertion about the withhold path silently measures the catch branch instead.
 * That happened while writing the #3035 tests.
 *
 * Typed as `EmailSendOutcome`, so a shape that drifts from the mailer's real
 * union fails to compile here rather than passing a test against a fiction.
 */
export const EMAIL_SENT: EmailSendOutcome = {
  status: "sent",
  emailLogId: "email-log-1",
  messageId: "message-1",
};

/**
 * The environment-safety withhold, per reason.
 *
 * `environment_non_production` is TERMINAL — a confirmed copy, nothing to retry —
 * and the other two are faults that clear when an operator fixes the deployment.
 * Callers key on that distinction rather than on the status alone, which is why
 * every test that exercises one of them names the reason.
 */
export function emailWithheldForEnvironment(
  reason:
    | "environment_non_production"
    | "environment_unknown"
    | "capture_transport_in_production",
): EmailSendOutcome {
  return { status: "withheld_for_environment", emailLogId: "email-log-1", reason };
}

/** The per-booking "No emails" withhold (#2258), deliberate or fail-closed. */
export function emailWithheldForBooking(
  reason: "booking_no_emails" | "booking_flag_unreadable",
  bookingId = "booking-1",
): EmailSendOutcome {
  return {
    status: "withheld_for_booking",
    emailLogId: "email-log-1",
    bookingId,
    reason,
  };
}
