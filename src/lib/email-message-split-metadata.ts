/**
 * The email registry's metadata that lives outside `REQUIRED_TEMPLATE_TOKENS`
 * and `TEMPLATE_TRIGGER_METADATA` in `email-message-registry.ts`, which is past
 * its size ceiling: those objects spread these in, so a template added in its
 * own module costs the registry no line. Each trigger entry says when the email
 * goes and how often, as the template editor shows it.
 */
import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";
import {
  OWED_NOTICE_ALERT_REQUIRED_TOKENS,
  OWED_NOTICE_ALERT_TRIGGERS,
} from "@/lib/email-message-owed-notice-triggers";

/** The tokens an edited body must keep, for the templates registered here. */
export const SPLIT_REQUIRED_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  ...OWED_NOTICE_ALERT_REQUIRED_TOKENS,
};

export const SPLIT_TEMPLATE_TRIGGERS: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  ...OWED_NOTICE_ALERT_TRIGGERS,
  "admin-booking-money-census": {
    triggerSummary:
      "The nightly booking money check (05:30, club time) found a booking whose money records disagree, or a known class of difference, that it has not reported before (#4910)",
    frequency:
      "Once per finding (a census class on a booking), in one email per night that lists every new finding. Guarded by a cross-instance claim, which is kept once any admin is sent the email or has a copy queued for the email retry cron, held for a day when no admin can receive it, and given back when the send throws before reaching anyone. A night with nothing new sends nothing",
  },
};
