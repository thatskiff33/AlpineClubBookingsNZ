/**
 * The email registry's entries for the nightly booking money check's alert
 * (`admin-booking-money-census`, #4910, `INV-PAY-164`): its editor default and
 * when it goes. Kept out of `email-message-registry.ts` and
 * `email-message-audit-defaults.ts`, both past their size ceilings; they
 * spread these in through `email-message-external-alerts.ts`.
 */
import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";
import { BOOKING_LEDGER_CENSUS_COMMAND, BOOKING_MONEY_CENSUS_ALERT_NOTE } from "@/lib/booking-money-census-job";

/**
 * The alert's default subject and body; typed by its own literal key, never by
 * `EmailAuditTemplateName`, which is derived from the map it joins.
 */
export const BOOKING_MONEY_CENSUS_ALERT_DEFAULTS = {
  "admin-booking-money-census": {
    "defaultSubject": "Booking money check: {{count}} new",
    "defaultBody": "Booking Money Check\n\n" + BOOKING_MONEY_CENSUS_ALERT_NOTE + "\n\nNew findings: {{count}}\n{{details}}\n\nFor the full report, run " + BOOKING_LEDGER_CENSUS_COMMAND + " on the server.\n\nOpen Stuck States: {{reviewUrl}}"
  },
} as const;

export const BOOKING_MONEY_CENSUS_ALERT_TRIGGER: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "admin-booking-money-census": {
    triggerSummary:
      "The nightly booking money check (05:30, club time) found a booking whose money records disagree, or could not be compared, that it has not reported before. Known classes of difference are never emailed; they are listed on the Stuck States page (#4910)",
    frequency:
      "Once per disagreement (a census class on a booking), in one email per night that lists every new disagreement. Guarded by a cross-instance claim, which is kept once any admin is sent the email or has a copy queued for the email retry cron, held for a day when no admin can receive it, and given back when the send throws before reaching anyone. A night with nothing new sends nothing",
  },
};
