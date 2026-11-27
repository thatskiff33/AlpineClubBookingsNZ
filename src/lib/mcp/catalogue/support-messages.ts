/**
 * The Support area's messages: booking message wording, email templates, the
 * club's email settings, delivery policies, an officer's alert choices,
 * delivery suppressions and failed emails. Part of the Support & System
 * officer actions (ALP-724): spread into `MCP_ACTIONS`.
 *
 * Kinds: every change here is `destructive`. Wording, templates, email
 * settings and delivery policies are club-wide configuration whose result is
 * read or emailed to members (owner decision, #5305 comment 7093303964); an
 * officer's alert choices are another person's record; clearing a suppression
 * lets mail reach that address again; retrying a failed email sends it, and
 * dismissing one cannot be undone from the app (#5305 comment 7092977781).
 * The two previews render with sample data and save nothing, so they run as
 * reads. Reissuing a failed email's link is website-only (`sign-in-access`).
 *
 * Website-only parts, refused by the route on an AI app request: the email
 * settings' `publicUrl` and the templates that carry a one-time `{{token}}`
 * link (`sign-in-access`), and the booking messages that
 * `carriesPaymentInstructions` (`club-setup`).
 */
import {
  adminNotificationPreferencesUpdateSchema,
  bookingMessageResetSchema,
  bookingMessageWordingSchema,
  emailFailureReviewSchema,
  emailMessageSettingsConnectionUpdateSchema,
  emailSuppressionClearSchema,
  emailTemplatePreviewSchema,
  emailTemplateQuerySchema,
  emailTemplateResetSchema,
  emailTemplateUpdateSchema,
  notificationDeliveryPolicyUpdateSchema,
} from "@/lib/admin-support-api/messages";
import {
  ADMIN_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
  BOOKING_MESSAGE_PREVIEW_CONNECTION_SHAPE,
  BOOKING_MESSAGE_RESET_CONNECTION_SHAPE,
  BOOKING_MESSAGE_SAVED_CONNECTION_SHAPE,
  BOOKING_MESSAGE_WORDING_LIST_CONNECTION_SHAPE,
  EMAIL_FAILURE_REQUEUED_CONNECTION_SHAPE,
  EMAIL_FAILURE_REVIEWED_CONNECTION_SHAPE,
  EMAIL_SETTINGS_CONNECTION_SHAPE,
  EMAIL_SUPPRESSION_CLEARED_CONNECTION_SHAPE,
  EMAIL_SUPPRESSION_LIST_CONNECTION_SHAPE,
  EMAIL_TEMPLATE_CONNECTION_SHAPE,
  EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE,
  EMAIL_TEMPLATE_PREVIEW_CONNECTION_SHAPE,
  EMAIL_TEMPLATE_RESET_CONNECTION_SHAPE,
  EMAIL_TEMPLATE_SAVED_CONNECTION_SHAPE,
  NOTIFICATION_DELIVERY_POLICY_LIST_CONNECTION_SHAPE,
  NOTIFICATION_DELIVERY_POLICY_SAVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/support-messages";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

/** The two previews admit a Support viewer, though a `POST` would infer edit. */
const SUPPORT_VIEW = { area: "support", level: "view" } as const;

export const SUPPORT_MESSAGE_MCP_ACTIONS: readonly McpAction[] = [
  // --- Booking message wording ---------------------------------------------
  {
    id: "list_booking_message_wording",
    title: "List the booking messages' wording",
    summary:
      "Officer: every short message the booking screens show members (payment method notes, booking detail notices): its `key`, section, label, what it is for, the default wording, the wording in force, the tokens it may use, and the club's saved change if any.",
    method: "GET",
    path: "/api/admin/booking-messages",
    kind: "read",
    returns: BOOKING_MESSAGE_WORDING_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "preview_booking_message",
    title: "Preview booking message wording",
    summary:
      "Officer: checks new wording for a booking message (`messageKey` from `list_booking_message_wording`) and shows it with sample data filled in. Saves nothing.",
    method: "POST",
    path: "/api/admin/booking-messages/preview",
    body: bookingMessageWordingSchema,
    kind: "read",
    preview: true,
    requires: SUPPORT_VIEW,
    returns: BOOKING_MESSAGE_PREVIEW_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_booking_message",
    title: "Change a booking message's wording",
    summary:
      "Officer: saves new wording for a booking message (`messageKey` from `list_booking_message_wording`), which members then see on the booking screens. Unknown tokens are refused. The messages that tell members where to pay by bank transfer (Internet Banking pending, the payment link and payment request bank details) are changed on the club website only. Answers the saved wording.",
    method: "PUT",
    path: "/api/admin/booking-messages",
    body: bookingMessageWordingSchema,
    kind: "destructive",
    returns: BOOKING_MESSAGE_SAVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "reset_booking_message",
    title: "Reset a booking message to its default",
    summary:
      "Officer: deletes the club's wording for a booking message (`messageKey`), so members see the default again. `reset` is false when there was nothing to reset. The bank-transfer payment messages are reset on the club website only.",
    method: "POST",
    path: "/api/admin/booking-messages/reset",
    body: bookingMessageResetSchema,
    kind: "destructive",
    returns: BOOKING_MESSAGE_RESET_CONNECTION_SHAPE,
    core: false,
  },

  // --- Email templates -------------------------------------------------------
  {
    id: "list_email_templates",
    title: "List email templates",
    summary:
      "Officer: every email the site sends: its `key`, label, audience, what sends it and how often, whether its delivery can be changed and its default delivery, the subject of the club's saved change if any, and whether that change has gone stale (`staleContent.reasons`), plus saved changes that use a retired token or miss a required one. No wording: read one template with `get_email_template`.",
    method: "GET",
    path: "/api/admin/email-templates",
    kind: "read",
    returns: EMAIL_TEMPLATE_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_email_template",
    title: "Read an email template",
    summary:
      "Officer: one email template (`templateName` from `list_email_templates`) whole: its default subject and body, the tokens it may use and must keep, subject phrases it may not add, the club's saved subject and body (plain and formatted) if any, and why that saved change has gone stale.",
    method: "GET",
    path: "/api/admin/email-templates",
    query: emailTemplateQuerySchema,
    kind: "read",
    returns: EMAIL_TEMPLATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "preview_email_template",
    title: "Preview an email template",
    summary:
      "Officer: checks a subject and body for an email template (`templateName` from `list_email_templates`) and renders the email with sample data, as members would receive it. Send `bodyText`, or a formatted `bodyHtml`. Saves and sends nothing; a refusal lists the token or content problems.",
    method: "POST",
    path: "/api/admin/email-templates/preview",
    body: emailTemplatePreviewSchema,
    kind: "read",
    preview: true,
    requires: SUPPORT_VIEW,
    returns: EMAIL_TEMPLATE_PREVIEW_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_email_template",
    title: "Change an email template",
    summary:
      "Officer: saves the club's subject and body for an email template (`templateName` from `list_email_templates`), which every later email of that kind uses. Send at least one of `subject`, `bodyText` or a formatted `bodyHtml`; null or empty returns that part to the default. Refused, listing the problems, if a token is unknown or a required one is missing. An email carrying a one-time sign-in, reset or invitation link (a required `token`) is changed on the club website only. Answers the saved change.",
    method: "PUT",
    path: "/api/admin/email-templates",
    body: emailTemplateUpdateSchema,
    kind: "destructive",
    returns: EMAIL_TEMPLATE_SAVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "reset_email_template",
    title: "Reset an email template to its default",
    summary:
      "Officer: deletes the club's subject and body for an email template (`templateName`), so it sends the default again. The deleted wording is kept in the audit log. `reset` is false when there was nothing to reset.",
    method: "POST",
    path: "/api/admin/email-templates/reset",
    body: emailTemplateResetSchema,
    kind: "destructive",
    returns: EMAIL_TEMPLATE_RESET_CONNECTION_SHAPE,
    core: false,
  },

  // --- The club's email settings -------------------------------------------
  {
    id: "get_email_settings",
    title: "Read the club's email settings",
    summary:
      "Officer: the names and addresses emails are sent with (`settings`: club and bookings name, sender name, support and contact email, public address, and the default lodge's name and travel note) and which of them the club saved itself (`persisted`; null fields use the default). Never a door code.",
    method: "GET",
    path: "/api/admin/email-settings",
    kind: "read",
    returns: EMAIL_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_email_settings",
    title: "Change the club's email settings",
    summary:
      "Officer: changes the names and addresses every email is sent with: club name, bookings name, sender name, and support and contact email. Fields left out are unchanged; null returns one to the default. The public address the links point to, sign-in links among them, is changed on the club website. Answers the settings as `get_email_settings` does.",
    method: "PUT",
    path: "/api/admin/email-settings",
    body: emailMessageSettingsConnectionUpdateSchema,
    kind: "destructive",
    returns: EMAIL_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },

  // --- Delivery policies and officers' alerts --------------------------------
  {
    id: "list_notification_delivery_policies",
    title: "List officer email delivery policies",
    summary:
      "Officer: for each email the site sends officers or the system, whether it is sent `always`, only when there is something to report (`content_only`) or never (`disabled`), its default, and whether it can be changed.",
    method: "GET",
    path: "/api/admin/notification-delivery-policies",
    kind: "read",
    returns: NOTIFICATION_DELIVERY_POLICY_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_notification_delivery_policy",
    title: "Change an officer email's delivery policy",
    summary:
      "Officer: sets whether an officer or system email (`templateName` from `list_notification_delivery_policies`) is sent `always`, `content_only` or is `disabled`. Refused for a locked one. Answers the saved policy.",
    method: "PUT",
    path: "/api/admin/notification-delivery-policies",
    body: notificationDeliveryPolicyUpdateSchema,
    kind: "destructive",
    returns: NOTIFICATION_DELIVERY_POLICY_SAVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_officer_alerts",
    title: "Change an officer's email alerts",
    summary:
      "Officer: switches an officer's email alerts on or off (`memberId`, and `preferences` naming each alert to change, such as `adminNewBooking` or `adminDailyDigest`). Only alerts for areas that officer can edit are accepted. Answers the alerts that officer will now be sent.",
    method: "PUT",
    path: "/api/admin/notifications",
    body: adminNotificationPreferencesUpdateSchema,
    kind: "destructive",
    returns: ADMIN_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
    core: false,
  },

  // --- Delivery suppressions and failed emails ------------------------------
  {
    id: "list_email_suppressions",
    title: "List stopped email addresses",
    summary:
      "Officer: how many addresses the site has stopped emailing after a bounce or complaint, and the latest 50: the address, why, how many events, and the last bounce or complaint detail. The `id` is what `clear_email_suppression` takes.",
    method: "GET",
    path: "/api/admin/email-suppressions",
    kind: "read",
    returns: EMAIL_SUPPRESSION_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "clear_email_suppression",
    title: "Let the site email an address again",
    summary:
      "Officer: clears a stopped address (`id` from `list_email_suppressions`) so the site emails it again, with an optional `reason` kept in the audit log. Do this only once the address is fixed: another bounce stops it again.",
    method: "POST",
    path: "/api/admin/email-suppressions/[id]/clear",
    params: routeIdParamsSchema,
    body: emailSuppressionClearSchema,
    kind: "destructive",
    returns: EMAIL_SUPPRESSION_CLEARED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "retry_failed_email",
    title: "Try a failed email again",
    summary:
      "Officer: hands an email that ran out of send attempts (`id` from `emailFailures` in `get_system_health`, where `recovery` is `retry`) back to the email job, which sends it if the recipient may still be emailed. Refused for any other failure.",
    method: "POST",
    path: "/api/admin/email-failures/[id]/retry",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: EMAIL_FAILURE_REQUEUED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "dismiss_failed_email",
    title: "Dismiss a failed email",
    summary:
      "Officer: marks an email that ran out of send attempts (`id` from `emailFailures` in `get_system_health`) as reviewed, with an optional `reason`, so it leaves the queue unsent.",
    method: "POST",
    path: "/api/admin/email-failures/[id]/review",
    params: routeIdParamsSchema,
    body: emailFailureReviewSchema,
    kind: "destructive",
    returns: EMAIL_FAILURE_REVIEWED_CONNECTION_SHAPE,
    core: false,
  },
];
