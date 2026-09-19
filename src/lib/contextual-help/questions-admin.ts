/**
 * The curated question chips for each admin page.
 *
 * Distilled from that page's own help content, and attached to it by
 * `./index.ts` at load. Kept beside the entries rather than inside them because
 * the same three fallback questions answer for every unmapped page.
 */
import type { HelpQuestion } from "./types";

export const ADMIN_HELP_QUESTIONS: Record<string, HelpQuestion[]> = {
  "/admin/dashboard": [
    {
      q: "Where do I start each day?",
      a: "The dashboard is your triage hub. Check the queue counts and warning panels first, then open the specific workflow that needs work.",
    },
    {
      q: "What does the Needs Attention menu show?",
      a: "Queues that currently hold pending records needing operator action, such as applications, refunds, issue reports, and hut-leader gaps.",
    },
    {
      q: "How do I get to a specific queue?",
      a: "Follow the link on the relevant dashboard card through to its underlying queue or detail page.",
    },
  ],
  "/admin/booking-requests": [
    {
      q: "What is a booking request?",
      a: "A public or internal request for a stay that has not yet become a normal booking. You price, quote, approve, decline, or ask for changes.",
    },
    {
      q: "Does sending a quote reserve beds?",
      a: "Yes. Sending a quote auto-holds the beds, so a manual Hold slots step only appears for school requests.",
    },
    {
      q: "How do I separate new requests from ones I have already actioned?",
      a: "Use the status tabs. They split submitted requests from quoted, queried, and completed ones.",
    },
    {
      q: "What should I check before quoting?",
      a: "Recheck the requested date-only lodge nights, guest counts, and capacity before you send a quote or approval.",
    },
    {
      q: "How does a non-member get to the request form?",
      a: "By default, only from you. The form ships unlisted: nothing on the public site links to it and search engines are told to ignore it, so you copy the link from the Public Requests tab and send it to a guest the club has agreed to host. If your club would rather advertise it, give the Booking Requests page a menu title under Site Appearance & Content → Page Content and it joins the site menu and becomes searchable.",
    },
  ],
  "/admin/bookings": [
    {
      q: "How do I find a specific booking?",
      a: "Use the member, date, status, and payment filters to narrow the list to the booking you need.",
    },
    {
      q: "What can I do to a booking here?",
      a: "Open it to inspect guests, payments, capacity, and notes, then cancel, copy, force-confirm, or review it when the booking state allows.",
    },
    {
      q: "What does each booking status mean?",
      a: "See the booking status glossary in this page's help. It explains every badge from Draft through Confirmed (Unpaid) to Completed.",
    },
    {
      q: "What should I confirm before changing a booking?",
      a: "Booking actions can affect capacity and money, so confirm the date range and payment source before you change state.",
    },
  ],
  "/admin/members": [
    {
      q: "How do I edit a member?",
      a: "Search or filter to the member, use their name or Open to enter the read-only detail page, expand the relevant section, then choose that section's Edit.",
    },
    {
      q: "What does Access mean here?",
      a: "Account readiness, not role: No login, Not invited, Invited, or Can log in. The same label and tone appears on Subscriptions.",
    },
    {
      q: "What does the access role control?",
      a: "App access — user, admin, finance, lodge, or organisation. On-behalf booking family selection works from a Booking Officer's bookings:edit permission.",
    },
    {
      q: "Can two family members share one email?",
      a: "Only one member per email should be login-capable; shared-email family members can be kept as non-login records.",
    },
    {
      q: "How do I bulk update members?",
      a: "Use bulk import or update only with reviewed CSV data and a clear rollback expectation.",
    },
  ],
  "/admin/member-applications": [
    {
      q: "What does this page track?",
      a: "Membership applications, nomination progress, and admin approval or rejection.",
    },
    {
      q: "What do the nominator slots show?",
      a: "Who has been asked to nominate the applicant and whether each confirmation is complete or stale.",
    },
    {
      q: "When should I approve an application?",
      a: "Only after checking the required evidence and committee policy, and confirming the applicant's identity.",
    },
    {
      q: "Why would I refresh or replace nominators?",
      a: "Only when the applicant's nomination path needs recovery — for example a nominator who cannot confirm.",
    },
  ],
  "/admin/payments": [
    {
      q: "How do I find a payment?",
      a: "Filter by member, booking, status, source, or date to locate the payment record.",
    },
    {
      q: "How do I tell Stripe from Internet Banking payments?",
      a: "The payment source field identifies Stripe, Internet Banking, or another settlement path. Keep the recovery paths distinct.",
    },
    {
      q: "What is the transaction kind?",
      a: "It shows whether the payment is primary, additional, refund-related, or recovery-related.",
    },
    {
      q: "When should I retry or generate an invoice?",
      a: "Only when the payment source matches the workflow. Check the provider IDs and booking link first.",
    },
  ],
  "/admin/xero": [
    {
      q: "What does Xero Sync show?",
      a: "Accounting connection health, queued operations, contact links, invoices, and replayable provider failures.",
    },
    {
      q: "How do I fix a failed Xero operation?",
      a: "Use the requeue, retry, or resolve action that matches the displayed provider error, and prefer built-in repair over manual database edits.",
    },
    {
      q: "How do I check whether Xero and the app agree?",
      a: "Open the linked local record — the booking, member, payment, or contact tied to the Xero object — and compare.",
    },
    {
      q: "What does a non-replayable operation mean?",
      a: "The operation status marks it as failed in a way retry cannot fix. Investigate the provider error before acting.",
    },
  ],
  "/admin/seasons": [
    {
      q: "What do seasons control?",
      a: "The seasonal date windows — name, type, dates, active — that decide which nightly rates a booking quote uses.",
    },
    {
      q: "Where do I set the nightly rates?",
      a: "On the Fees page, in the Hut Fees section. Seasons only define the windows, not the prices.",
    },
    {
      q: "What is the season type?",
      a: "Whether the window is a Winter or Summer season.",
    },
    {
      q: "When should I create a season window?",
      a: "Before the booking period opens, taking care with overlapping dates since the window drives which rates apply.",
    },
  ],
  "/admin/waitlist": [
    {
      q: "What does the waitlist page do?",
      a: "It manages members waiting for capacity and offers them a place when beds free up.",
    },
    {
      q: "When should I send an offer?",
      a: "Only when the booking can be fulfilled and the expiry window is appropriate.",
    },
    {
      q: "What is offer expiry?",
      a: "The deadline for the member to accept a waitlist offer before it lapses.",
    },
    {
      q: "What does force-confirm do?",
      a: "It confirms a booking despite overbooked nights. Use it only when you understand the overbooking shown in the confirmation prompt.",
    },
  ],
  "/admin/bed-allocation": [
    {
      q: "What does bed allocation do?",
      a: "It assigns paid or confirmed guests to rooms and beds for specific lodge nights.",
    },
    {
      q: "When should I use auto versus manual allocation?",
      a: "Use auto-allocation for ordinary cases and manual moves for operational exceptions.",
    },
    {
      q: "Can I move an allocated guest to another night?",
      a: "No. Dragging an existing allocation chooses another bed only and keeps its original NZ lodge night, even when you hover over a different date column. Before anything moves, choose this allocation night or every existing allocation night for this person on the booking, including off-screen nights, then review the exact changed and unchanged rows. If nothing would change, confirming writes no approval or audit record.",
    },
    {
      q: "Can automatic allocation displace a guest?",
      a: "For a paid or confirmed booking it can move a blocking Provisional allocation so a Held booking gets a bed, but the manual Run auto-allocation button never displaces a Held or admin-approved allocation.",
    },
    {
      q: "What must allocation never do?",
      a: "It must never create more occupants than available beds for a lodge night.",
    },
    {
      q: "Where do I turn auto allocation on or change the preference order?",
      a: "In Bookings Setup -> Rooms & Beds, at the foot of the page, for the lodge chosen at the top. This board links to it for the lodge you are looking at. Changes there apply to the next allocation run and never move a guest who is already placed.",
    },
  ],
  "/admin/communications": [
    {
      q: "What does Communications do?",
      a: "It sends and reviews member email or notification messages.",
    },
    {
      q: "What should I check before sending?",
      a: "Choose the audience carefully and verify the recipients, because email can expose private information.",
    },
    {
      q: "Can I preview a message?",
      a: "Yes, preview the message content and token output where available before sending.",
    },
    {
      q: "How do I spot delivery problems?",
      a: "Review the delivery history for failures, suppressions, or messages needing follow-up.",
    },
  ],
  "/admin/modules": [
    {
      q: "What are modules?",
      a: "Club-level switches that turn optional features on or off.",
    },
    {
      q: "What happens when I disable a module?",
      a: "The feature is hidden or blocked, but its stored data is preserved.",
    },
    {
      q: "Why is a feature not working after I enabled it?",
      a: "Some features also need provider settings, roles, or setup data before they are useful. Check the module's dependencies.",
    },
    {
      q: "Which modules should I enable?",
      a: "Only the ones the club is ready to operate and support.",
    },
  ],
  "/admin/roster": [
    {
      q: "What is the roster for?",
      a: "Preparing lodge day rosters and printable operational lists.",
    },
    {
      q: "How do I prepare a day?",
      a: "Select the roster date, review the expected guests, and prepare the daily view.",
    },
    {
      q: "How do I print a roster?",
      a: "Use the print views for lodge handover or offline use.",
    },
    {
      q: "What should I check before relying on it?",
      a: "Hut-leader coverage and booking state for the selected date.",
    },
  ],
  "/admin/audit-log": [
    {
      q: "What does the audit log record?",
      a: "Important admin, member, provider, and system actions, for traceability.",
    },
    {
      q: "How do I narrow the log?",
      a: "Filter by actor, entity, category, severity, outcome, or date.",
    },
    {
      q: "How do I see what changed in a record?",
      a: "Open the metadata for structured before/after values, provider IDs, or request information.",
    },
    {
      q: "What is the actor?",
      a: "The member, system job, or provider event that performed the action.",
    },
  ],
  "/admin/setup": [
    {
      q: "What is the Setup page for?",
      a: "First-install readiness. It collects the required setup steps and links to focused setup hubs.",
    },
    {
      q: "What should I do before opening public workflows?",
      a: "Complete the required setup steps and use the provider tests and progress indicators to confirm configuration works.",
    },
    {
      q: "What are the setup hubs?",
      a: "Cards that route lower-frequency membership, booking, finance, integration, cancellation, and notification setup into focused drill-down pages.",
    },
    {
      q: "Where are the finance report mappings?",
      a: "In the Finance drill-down, reviewed when Xero-backed reports are enabled.",
    },
  ],
};
