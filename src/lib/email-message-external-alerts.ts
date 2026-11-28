/**
 * Alerts whose email-registry entries live outside the registry: the owed-notice
 * alerts (#5433, `email-message-owed-notice-triggers.ts` and
 * `email-message-owed-notice-samples.ts`) and the officers' complaint alert
 * (#5469, `email-message-complaint-alert.ts`). Each alert's entries are defined
 * once, in its own module; this one only combines them, so
 * `email-message-registry.ts` and `email-message-audit-defaults.ts`, both past
 * their size budgets, import one thing and spread each kind of entry once.
 */
import {
  EMAIL_COMPLAINT_ALERT_DEFAULTS,
  EMAIL_COMPLAINT_ALERT_REQUIRED_TOKENS,
  EMAIL_COMPLAINT_ALERT_TOKENS,
  EMAIL_COMPLAINT_ALERT_TRIGGER,
  emailComplaintAlertSampleValue,
} from "@/lib/email-message-complaint-alert";
import { owedNoticeAlertSampleValue } from "@/lib/email-message-owed-notice-samples";
import {
  OWED_NOTICE_ALERT_DEFAULTS,
  OWED_NOTICE_ALERT_REQUIRED_TOKENS,
  OWED_NOTICE_ALERT_TRIGGERS,
} from "@/lib/email-message-owed-notice-triggers";

/** Default subject and body, for the audit defaults' base map. */
export const EXTERNAL_ALERT_DEFAULTS = { ...OWED_NOTICE_ALERT_DEFAULTS, ...EMAIL_COMPLAINT_ALERT_DEFAULTS } as const;

/** Tokens an edited body must keep, for the registry's `REQUIRED_TEMPLATE_TOKENS`. */
export const EXTERNAL_ALERT_REQUIRED_TOKENS = { ...OWED_NOTICE_ALERT_REQUIRED_TOKENS, ...EMAIL_COMPLAINT_ALERT_REQUIRED_TOKENS };

/** When each alert goes and how often, for the registry's `TEMPLATE_TRIGGER_METADATA`. */
export const EXTERNAL_ALERT_TRIGGERS = { ...OWED_NOTICE_ALERT_TRIGGERS, ...EMAIL_COMPLAINT_ALERT_TRIGGER };

/** Tokens these alerts add to the registry's approved list. */
export const EXTERNAL_ALERT_TOKENS = EMAIL_COMPLAINT_ALERT_TOKENS;

/** The preview sample for one of these alerts' tokens, or undefined for any other token. */
export function externalAlertSampleValue(token: string): string | undefined {
  return owedNoticeAlertSampleValue(token) ?? emailComplaintAlertSampleValue(token);
}
