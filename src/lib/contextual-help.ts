export type HelpScope = "admin" | "finance";

export type HelpField = {
  name: string;
  description: string;
};

export type HelpSection = {
  title: string;
  details: string[];
};

/**
 * A plain-English question and answer pair, distilled from an entry's own help
 * content. Defined here (rather than in `@/lib/help/types`) so this file has no
 * dependency on the help/* corpus and there is no import cycle; `help/types.ts`
 * re-exports it. Consumed by the help corpus (`@/lib/help`) and the AI grounding
 * serializer for epic #2094.
 */
export type HelpQuestion = {
  q: string;
  a: string;
  link?: { href: string; label: string };
  group?: string;
};

export type ContextualHelpContent = {
  title: string;
  summary: string;
  actions: string[];
  fields?: HelpField[];
  sections?: HelpSection[];
  notes?: string[];
  questions?: HelpQuestion[];
};

/**
 * Booking status glossary — the plain-English meaning of every booking status
 * badge a member (or operator) can see. Exported as a single source of truth so
 * both the admin/finance contextual help below and the member booking pages
 * (#1371 F28 / #1072) render the identical text.
 */
export const BOOKING_STATUS_GLOSSARY: string[] = [
  "Draft — saved but not submitted; holds no beds.",
  "Pending — provisional non-member hold; does not consume capacity.",
  "Awaiting Review — waiting on an admin decision; keeps its beds so approval cannot overbook.",
  "Payment Pending — awaiting payment; beds are not reserved until money is committed.",
  "Confirmed (Unpaid) — pay-on-account booking; the lodge is reserved while the emailed Xero invoice is outstanding, and it flips to Paid on reconciliation.",
  "Paid — paid in full; holds capacity.",
  "Completed — the stay has started or finished; keeps consuming capacity until checkout.",
  "Waitlisted — queued for a spot; no beds held.",
  "Waitlist Offered — a spot opened; time-limited offer to confirm and pay.",
  "Bumped — displaced when capacity changed; no beds held.",
  "Cancelled — cancelled; no beds held.",
];

type HelpEntry = {
  path: string;
  content: ContextualHelpContent;
};

function entry(path: string, content: ContextualHelpContent): HelpEntry {
  return { path, content };
}

function help(
  title: string,
  summary: string,
  actions: string[],
  fields: HelpField[] = [],
  notes: string[] = [],
  sections: HelpSection[] = [],
): ContextualHelpContent {
  return { title, summary, actions, fields, notes, sections };
}

const adminFallbackHelp = help(
  "Admin Help",
  "This admin page manages a protected club workflow. Use the page heading, filters, tables, and action buttons to find the record you need, make a deliberate change, and check any confirmation or audit feedback after saving.",
  [
    "Use search, filters, and tabs first so you are changing the right record set.",
    "Open the record detail, dialog, or action button for the smallest change that completes the task.",
    "Read validation errors and confirmation prompts before retrying or approving a destructive action.",
  ],
  [
    {
      name: "Filters",
      description:
        "Narrow long lists by status, date, member, or workflow type before acting.",
    },
    {
      name: "Status",
      description:
        "Shows the record's current lifecycle state and usually controls which actions are available.",
    },
    {
      name: "Reason or notes",
      description:
        "Capture operator context for audit logs and future committee review when the page asks for it.",
    },
  ],
  [
    "Admin actions can affect bookings, members, payments, emails, or public content. Confirm the target record before saving.",
    "If a provider or background job is involved, prefer retry/requeue controls over manual data edits.",
  ],
);

const financeFallbackHelp = help(
  "Finance Help",
  "The finance workspace summarises booking, revenue, cost, and Xero-derived reporting data for operators with finance access.",
  [
    "Choose the reporting view and date windows, then apply the filters.",
    "Use CSV or PDF export for committee packs or offline reconciliation.",
    "Finance managers can run a manual sync when the sync status shows stale or missing data.",
  ],
  [
    {
      name: "View",
      description:
        "Switches between revenue, costs, bookings, balance sheet, and related finance lenses.",
    },
    {
      name: "Range",
      description:
        "Sets the main reporting period. Custom dates override the preset range.",
    },
    {
      name: "Compare",
      description:
        "Chooses the comparison window used by trend cards and variance summaries.",
    },
    {
      name: "Forward",
      description:
        "Adds a future-looking window for expected booking or revenue signals.",
    },
  ],
  [
    "Money values are shown from stored integer cents and mapped finance snapshots; this page does not move money.",
    "Xero data depends on the latest successful finance sync and the report mapping configuration in Admin > Setup.",
  ],
);

const adminHelpEntries: HelpEntry[] = [
  entry(
    "/admin/dashboard",
    help(
      "Admin Dashboard",
      "The dashboard is the starting point for operational triage across bookings, members, lodge tasks, payments, Xero, and support signals.",
      [
        "Review queue counts and warning panels before opening a specific workflow.",
        "Follow links from cards to the underlying queue or detail page.",
        "Use the Needs Attention menu for work that currently has pending records.",
      ],
      [
        {
          name: "Needs attention",
          description:
            "Highlights queues that require operator action, such as applications, refunds, issues, and hut-leader gaps.",
        },
        {
          name: "Recent activity",
          description:
            "Shows current operational signals so admins can decide which workflow to open next.",
        },
      ],
    ),
  ),
  entry(
    "/admin/booking-requests",
    help(
      "Booking Requests",
      "This page manages public or internal booking requests before they become normal bookings.",
      [
        "Open each request, check the requested dates and guest counts, then price, quote, approve, decline, or ask for changes. Sending a quote auto-holds the beds, so a manual Hold slots step only shows for school requests.",
        "Use status tabs to separate new requests from quoted, queried, and completed requests.",
        "Check capacity and payment expectations before sending a quote or approval.",
      ],
      [
        {
          name: "Status",
          description:
            "Shows where the request sits: submitted, verified, priced, quoted, waiting on the requester, approved, declined, or cancelled.",
        },
        {
          name: "Price or quote",
          description:
            "Controls the offer sent to the requester and should reflect the latest dates, guest mix, and policy rules.",
        },
        {
          name: "Hold",
          description:
            "Manually reserves capacity for a school request before it is approved or quoted. Sending a quote auto-holds the beds on other requests, so the manual Hold slots button only appears for school requests.",
        },
      ],
      [
        "Approving or quoting can affect lodge capacity and customer expectations. Recheck date-only lodge nights before sending.",
      ],
    ),
  ),
  entry(
    "/admin/member-applications",
    help(
      "Applications",
      "This page tracks membership applications, nomination progress, and admin approval or rejection.",
      [
        "Filter to pending applications, review applicant details, and inspect nomination status.",
        "Refresh or replace nominators only when the applicant's nomination path needs recovery.",
        "Approve or reject only after checking required evidence and committee policy.",
      ],
      [
        {
          name: "Application status",
          description:
            "Tracks whether the applicant is waiting for nominators, waiting for admin review, approved, or rejected.",
        },
        {
          name: "Nominator slots",
          description:
            "Show who has been asked to nominate and whether each confirmation is complete or stale.",
        },
        {
          name: "Admin decision",
          description:
            "Records the final approval or rejection action and associated audit history.",
        },
      ],
      [
        "Application decisions affect membership lifecycle and login access. Confirm the applicant identity before approval.",
      ],
    ),
  ),
  entry(
    "/admin/family-groups",
    help(
      "Family Groups",
      "Family groups link adults and dependents so shared bookings, dependents, inherited emails, and family requests can be reviewed safely.",
      [
        "Review pending join, adult, child, and removal requests before changing relationships.",
        "Open a group to inspect adults, dependents, login holders, and inherited contact details.",
        "Use explicit approve, reject, link, or unlink actions rather than editing unrelated member fields.",
      ],
      [
        {
          name: "Login holder",
          description:
            "The adult account that can manage family/dependent records for the group.",
        },
        {
          name: "Dependent",
          description:
            "A child or non-login family member whose contact and booking context is managed through the group.",
        },
        {
          name: "Request status",
          description:
            "Shows whether a family change is waiting, approved, rejected, or completed.",
        },
      ],
      [
        "Family changes can affect account access and member privacy. Check names and emails carefully before approving.",
      ],
    ),
  ),
  entry(
    "/admin/refund-requests",
    help(
      "Refunds & Credits",
      "This page reviews refund appeals, member-credit requests, and related payment recovery decisions.",
      [
        "Filter pending requests, inspect the booking/payment history, then approve, decline, or record a follow-up.",
        "Keep Stripe refund paths and Internet Banking/Xero settlement paths distinct.",
        "Use notes to explain the operator decision for later audit review.",
      ],
      [
        {
          name: "Requested amount",
          description:
            "The amount requested by the member or calculated from the booking change, stored and handled in cents.",
        },
        {
          name: "Settlement source",
          description:
            "Identifies whether money movement belongs to Stripe, Internet Banking, member credit, or manual follow-up.",
        },
        {
          name: "Decision reason",
          description:
            "Records why the refund or credit was approved, declined, or deferred.",
        },
      ],
      [
        "Refund and credit actions are high-risk money workflows. Reconcile against the booking and payment record before acting.",
      ],
    ),
  ),
  entry(
    "/admin/membership-cancellations",
    help(
      "Cancellations",
      "This page handles membership cancellation, archive, and related lifecycle action requests.",
      [
        "Review requested cancellations and any participant confirmations.",
        "Check blockers such as future bookings, unpaid obligations, or family participant state.",
        "Approve, reject, withdraw, archive, or complete the request only after the blockers are clear.",
      ],
      [
        {
          name: "Participant status",
          description:
            "Shows whether each affected family member has confirmed, declined, or still needs action.",
        },
        {
          name: "Blockers",
          description:
            "Future bookings, payments, or account constraints that should stop completion until resolved.",
        },
        {
          name: "Lifecycle action",
          description:
            "The requested account change, such as cancellation, archive, delete, or rejoin follow-up.",
        },
      ],
      [
        "Membership lifecycle changes can remove access. Confirm the requested members before completing the action.",
      ],
    ),
  ),
  entry(
    "/admin/issue-reports",
    help(
      "Issue Reports",
      "Issue reports collect screenshots and operator/member notes about problems seen in the app.",
      [
        "Filter by open or resolved status, inspect the report context, and follow the linked page if needed.",
        "Use status changes and notes to track whether the issue has been triaged, resolved, or closed as not reproducible.",
        "Escalate reproducible product bugs into a GitHub issue when code work is needed.",
      ],
      [
        {
          name: "Page URL",
          description:
            "The route where the reporter saw the problem, useful for reproducing the issue.",
        },
        {
          name: "Screenshot",
          description:
            "A captured visual context if the reporter included one.",
        },
        {
          name: "Status",
          description:
            "Tracks whether the issue report is open, in progress, resolved, or closed.",
        },
      ],
    ),
  ),
  entry(
    "/admin/hut-leaders",
    help(
      "Hut Leaders",
      "This page assigns hut leaders, monitors gaps, and manages kiosk PIN access for lodge operations.",
      [
        "Review unassigned dates, assign eligible members, and check existing hut-leader coverage.",
        "Reset or issue kiosk PINs only for the correct hut leader.",
        "Use date filters to focus on the operational window that needs coverage.",
      ],
      [
        {
          name: "Assignment date",
          description:
            "The lodge date the hut leader is responsible for.",
        },
        {
          name: "Eligible member",
          description:
            "A member who can be assigned to a hut-leader role for the selected date.",
        },
        {
          name: "PIN",
          description:
            "The kiosk access code used by the hut leader; reset it only when necessary.",
        },
      ],
      [
        "The Staying tab is booking-derived: it lists adult members who hold the standard member (USER) role and have an operational booking overlapping the selected dates. Use the Any member tab for a season-long custodian who has no booking of their own.",
        "An assignment can optionally hold one bed for its whole date range. That takes the bed out of the bookable pool and off the allocation board for every covered night, with no booking anywhere — the custodian is never a guest, never on the chore roster, and never invoiced for the held bed.",
        "The hold covers the start date to the end date inclusive, including the night of the end date itself. Dates that came from the automatic assignment end on a guest's departure day, so trim the end date by one before adding a bed, or the bed stays held for a night after everyone has left.",
        "A member whose only roles are custom (definition-backed) roles cannot be assigned as hut leader. Keep the standard member (USER) role ticked on their account so they stay eligible.",
      ],
      [
        {
          title: "Hold a bed for a season-long custodian",
          details: [
            "Pick the nights the custodian is in residence, then choose them on the Any member tab.",
            "In Hold a bed (optional), choose their bed. Leave it as No bed — role only if they are not sleeping in the lodge.",
            "A bed that already has guests allocated on it, or that another custodian holds, is listed with the exact nights that block it — clear those first on the bed allocation page.",
            "If the hold puts the lodge over capacity on any night you are asked to confirm; that can be perfectly correct, because the custodian really is sleeping there.",
          ],
        },
      ],
    ),
  ),
  entry(
    "/admin/bookings",
    help(
      "Bookings",
      "This page searches and manages normal booking records after they have been created.",
      [
        "Use member, date, status, and payment filters to find the target booking.",
        "Open a booking to inspect guests, payments, capacity status, notes, and available actions.",
        "Use cancel, copy, force-confirm, or review actions only when the booking state allows it.",
      ],
      [
        {
          name: "Booking status",
          description:
            "Shows whether the booking is draft, pending, confirmed, paid, waitlisted, cancelled, or completed.",
        },
        {
          name: "Check-in / check-out",
          description:
            "Date-only lodge nights used for pricing, capacity, and guest stay ranges.",
        },
        {
          name: "Payment status",
          description:
            "The associated payment lifecycle, separate from the booking lifecycle.",
        },
      ],
      [
        "Booking actions can affect capacity and money. Confirm the date range and payment source before changing state.",
      ],
      [
        {
          title: "Booking status glossary",
          details: BOOKING_STATUS_GLOSSARY,
        },
      ],
    ),
  ),
  entry(
    "/admin/book",
    help(
      "Book on Behalf",
      "This page lets an admin create a booking for a member or approved requester.",
      [
        "Choose the member or requester first, then set lodge nights and guests.",
        "Review the calculated quote, policies, capacity warnings, and payment options before confirming.",
        "Use this flow for assisted booking only; members should self-serve when possible.",
      ],
      [
        {
          name: "Member",
          description:
            "The account that owns the booking and receives booking communications. Selecting the member loads their family group (from your bookings:edit permission) so you can add family guests at the correct member price.",
        },
        {
          name: "Guests",
          description:
            "The staying people who consume beds and may have individual stay ranges.",
        },
        {
          name: "Quote",
          description:
            "The calculated price in integer cents after rates, policies, and discounts.",
        },
      ],
    ),
  ),
  entry(
    "/admin/bed-allocation",
    help(
      "Bed Allocation",
      "Bed allocation assigns paid or confirmed guests to rooms and beds for specific lodge nights.",
      [
        "Select the date or booking window, then review unallocated guests and room availability.",
        "Use auto-allocation for ordinary cases and manual moves for operational exceptions.",
        "When a booking is paid or confirmed, automatic allocation gives Held bookings first claim: it may move a blocking Provisional allocation to a free bed, or return it to the awaiting queue, so a Held booking gets a bed. The manual 'Run auto-allocation' button does not displace; a Held or admin-approved allocation is never displaced.",
        "Approve allocations only after checking room rules, capacity, and any hut-leader notes.",
      ],
      [
        {
          name: "Room and bed",
          description:
            "The physical sleeping place assigned to a guest for a lodge night.",
        },
        {
          name: "Allocation source",
          description:
            "Shows whether the placement came from auto-allocation or a manual operator change.",
        },
        {
          name: "Approval",
          description:
            "Locks or confirms allocation output for lodge operations.",
        },
      ],
      [
        "Bed allocation must not create more occupants than available beds for a lodge night.",
      ],
    ),
  ),
  entry(
    "/admin/waitlist",
    help(
      "Waitlist",
      "The waitlist page manages members waiting for capacity and offers places when beds become available.",
      [
        "Review requested nights, capacity changes, and active offers.",
        "Send an offer only when the booking can be fulfilled and the expiry window is appropriate.",
        "Force-confirm only when you understand any overbooked nights shown in the confirmation prompt.",
      ],
      [
        {
          name: "Offer expiry",
          description:
            "The deadline for the member to accept a waitlist offer before it lapses.",
        },
        {
          name: "Requested nights",
          description:
            "The date-only lodge nights the member wants to book.",
        },
        {
          name: "Capacity",
          description:
            "The available bed count after existing capacity-holding bookings are considered.",
        },
      ],
    ),
  ),
  entry(
    "/admin/seasons",
    help(
      "Seasons",
      "This page defines the seasonal date windows (name, type, dates, active) used by booking quotes. Nightly hut-fee rates live on the Fees page.",
      [
        "Create or edit season windows before the booking period opens.",
        "Set overlapping dates carefully; a season window drives which nightly rates apply.",
        "Manage the nightly rates for each season on the Fees page (Hut Fees section).",
      ],
      [
        {
          name: "Season dates",
          description:
            "The date-only range where this season applies.",
        },
        {
          name: "Season type",
          description:
            "Whether the window is a Winter or Summer season.",
        },
        {
          name: "Active",
          description:
            "Whether the season window is currently in effect.",
        },
      ],
    ),
  ),
  entry(
    "/admin/fees",
    help(
      "Fees",
      "This page consolidates every fee schedule: Hut Fees (nightly rates per lodge, season, membership type and age tier), Joining Fees, and Annual Membership Fees with their invoice components and family billing recipients.",
      [
        "Hut Fees editing needs bookings edit access; Joining and Annual fees need finance edit access.",
        "Amounts are stored as GST-inclusive integer cents; effective-dated ranges may not overlap for one schedule.",
        "Choose a lodge to edit its per-season nightly rate grid.",
      ],
      [
        {
          name: "Hut fee rate",
          description:
            "The nightly price for a membership type and age tier in a season, stored as integer cents.",
        },
        {
          name: "Joining fee",
          description:
            "The one-off fee a new member pays, per membership type and age tier.",
        },
        {
          name: "Annual membership fee",
          description:
            "The recurring membership fee, optionally split into named invoice-line components.",
        },
      ],
    ),
  ),
  entry(
    "/admin/age-tier-settings",
    help(
      "Age Groups",
      "Age groups define how member and guest ages map to infant, child, youth, and adult pricing or policy behavior.",
      [
        "Review the current tier boundaries before changing fees or membership type rules.",
        "Update age ranges only when the club policy changes.",
        "Save and then recheck booking quote behavior in a non-production environment for high-impact changes.",
      ],
      [
        {
          name: "Minimum age",
          description:
            "The first age included in a tier.",
        },
        {
          name: "Maximum age",
          description:
            "The last age included in a tier, if the tier has an upper bound.",
        },
        {
          name: "Tier code",
          description:
            "The system label used by pricing, membership types, and Xero group rules.",
        },
      ],
    ),
  ),
  entry(
    "/admin/promo-codes",
    help(
      "Promo Codes",
      "Promo codes apply controlled discounts to eligible bookings.",
      [
        "Create codes with clear validity dates, usage limits, and discount rules.",
        "Deactivate or expire a code instead of deleting historical context.",
        "Test the code against a quote before publishing it to members.",
      ],
      [
        {
          name: "Code",
          description:
            "The member-entered value used during booking.",
        },
        {
          name: "Discount",
          description:
            "The configured price reduction, stored and applied in cents or percent according to the code type.",
        },
        {
          name: "Usage limit",
          description:
            "Controls how many times the code can be redeemed.",
        },
      ],
    ),
  ),
  entry(
    "/admin/booking-policies",
    help(
      "Booking Policies",
      "Booking policies control cancellation rules, group discounts, minimum stays, and public request settings.",
      [
        "Open the policy area you need and edit only the rule that is changing.",
        "Check effective dates, booking status, and member/non-member behavior before saving.",
        "Review the wording members or requesters will see after the policy change.",
      ],
      [
        {
          name: "Effective window",
          description:
            "The dates or conditions where a policy applies.",
        },
        {
          name: "Penalty or discount",
          description:
            "The configured cents or percent value used by quotes, cancellations, or public requests.",
        },
        {
          name: "Public request setting",
          description:
            "Controls how non-member request workflows behave.",
        },
      ],
    ),
  ),
  entry(
    "/admin/payments",
    help(
      "Payments",
      "Payments shows payment records, reconciliation state, and recovery actions across Stripe and Internet Banking paths.",
      [
        "Filter by member, booking, status, source, or date to find the payment record.",
        "Inspect provider IDs, booking links, and transaction kind before taking recovery action.",
        "Use generated invoices or retry actions only when the payment source matches the workflow.",
      ],
      [
        {
          name: "Payment source",
          description:
            "Identifies Stripe, Internet Banking, or another supported settlement path.",
        },
        {
          name: "Transaction kind",
          description:
            "Shows whether the payment is primary, additional, refund-related, or recovery-related.",
        },
        {
          name: "Provider ID",
          description:
            "The external Stripe or Xero identifier used for reconciliation.",
        },
      ],
    ),
  ),
  entry(
    "/admin/internet-banking",
    help(
      "Internet Banking",
      "This page configures and monitors Internet Banking payment instructions and Xero invoice settlement behavior.",
      [
        "Review bank-account wording and payment references before publishing instructions.",
        "Check Xero invoice status for bookings using Internet Banking.",
        "Keep Internet Banking settlement separate from Stripe payment recovery.",
      ],
      [
        {
          name: "Payment reference",
          description:
            "The member-facing reference used to match bank payments to bookings.",
        },
        {
          name: "Xero invoice",
          description:
            "The accounting invoice created or linked for settlement.",
        },
        {
          name: "Instruction text",
          description:
            "The payment directions shown to members choosing Internet Banking.",
        },
      ],
    ),
  ),
  entry(
    "/admin/reports",
    help(
      "Reports",
      "Reports provides admin-facing operational exports and summaries for bookings, members, payments, and lodge activity.",
      [
        "Choose the report type and date range before generating output.",
        "Export only the data needed for the operational question.",
        "Check filters before sharing a report outside the admin team.",
      ],
      [
        {
          name: "Report type",
          description:
            "Selects which dataset or summary is generated.",
        },
        {
          name: "Date range",
          description:
            "Limits records to the relevant operational window.",
        },
        {
          name: "Export",
          description:
            "Downloads the filtered report for offline review.",
        },
      ],
    ),
  ),
  entry(
    "/admin/xero/setup",
    help(
      "Xero Setup",
      "Xero Setup connects and maps the operational Xero integration used by accounting, Internet Banking, contacts, and finance reports.",
      [
        "Connect or disconnect Xero only during a planned maintenance window.",
        "Map accounts, items, contact groups, and finance report categories before relying on automation.",
        "Use provider tests and backfill controls to verify setup after changes.",
      ],
      [
        {
          name: "Account mapping",
          description:
            "Links club revenue, expense, liability, and bank concepts to Xero accounts.",
        },
        {
          name: "Item code",
          description:
            "Maps booking and membership line items to Xero item codes.",
        },
        {
          name: "Finance report mapping",
          description:
            "Groups Xero report lines into the finance dashboard categories.",
        },
      ],
      [
        "Xero setup affects live accounting behavior. Do not use live provider credentials for exploratory work.",
      ],
    ),
  ),
  entry(
    "/admin/xero",
    help(
      "Xero Sync",
      "Xero Sync monitors accounting connection health, queued operations, contact links, invoices, and replayable provider failures.",
      [
        "Review health and operation queues before retrying or resolving failures.",
        "Use requeue, retry, or resolve actions according to the displayed provider error.",
        "Open linked local records to confirm whether Xero and app state agree.",
      ],
      [
        {
          name: "Operation status",
          description:
            "Shows whether a queued Xero operation is pending, running, succeeded, failed, or non-replayable.",
        },
        {
          name: "Local record",
          description:
            "The booking, member, payment, or contact record tied to a Xero object.",
        },
        {
          name: "Provider error",
          description:
            "The Xero response that explains why an operation failed or needs repair.",
        },
      ],
      [
        "Prefer built-in retry and repair actions over manual database edits.",
      ],
    ),
  ),
  entry(
    "/admin/members",
    help(
      "Members",
      "Members is the main directory for member records, login access, profile data, roles, imports, and member-level actions.",
      [
        "Search or filter first, then open the member detail page for edits.",
        "Use bulk import/update only with reviewed CSV data and clear rollback expectations.",
        "Check access roles, seasonal membership type, family group, and subscription status separately.",
      ],
      [
        {
          name: "Access role",
          description:
            "Controls app access such as user, admin, finance, lodge, or organisation access. On-behalf booking family selection works from a Booking Officer's bookings:edit permission, so dropping membership:view from a customised role does not break member pricing.",
        },
        {
          name: "Seasonal membership type",
          description:
            "Controls season-specific booking rate, block-booking behavior, and subscription policy.",
        },
        {
          name: "Can login",
          description:
            "Only one member per email should be login-capable; shared-email family members may be non-login records.",
        },
      ],
      [
        "Member changes can affect privacy, access, bookings, and subscriptions. Confirm the target member before saving.",
      ],
    ),
  ),
  entry(
    "/admin/subscriptions",
    help(
      "Subscriptions",
      "Subscriptions tracks membership subscription invoices, payment state, lockout behavior, and season-specific dues.",
      [
        "Filter by season, member, status, or overdue state.",
        "Inspect the linked member and Xero/payment records before marking or retrying anything.",
        "Use subscription lockout settings for policy changes rather than one-off manual edits.",
      ],
      [
        {
          name: "Subscription status",
          description:
            "Shows unpaid, paid, overdue, not required, or not invoiced state.",
        },
        {
          name: "Season",
          description:
            "The membership year or seasonal period the subscription belongs to.",
        },
        {
          name: "Invoice",
          description:
            "The Xero or payment record used to settle the subscription.",
        },
      ],
    ),
  ),
  entry(
    "/admin/induction",
    help(
      "Induction",
      "Induction pages manage induction templates, sign-offs, and member completion tracking.",
      [
        "Review outstanding induction requirements and signed-off members.",
        "Edit templates carefully because wording may be used for future member compliance.",
        "Use print or detail views when a physical sign-off record is needed.",
      ],
      [
        {
          name: "Template",
          description:
            "The induction content or checklist members must complete.",
        },
        {
          name: "Sign-off",
          description:
            "A recorded member acknowledgement for a specific induction.",
        },
        {
          name: "Status",
          description:
            "Shows whether an induction is pending, completed, or needs follow-up.",
        },
      ],
    ),
  ),
  entry(
    "/admin/communications",
    help(
      "Communications",
      "Communications sends and reviews member email or notification messages.",
      [
        "Choose the audience carefully before composing or sending.",
        "Preview message content and token output when available.",
        "Review delivery history for failures, suppressions, or follow-up needs.",
      ],
      [
        {
          name: "Audience",
          description:
            "The selected member group or recipients for the message.",
        },
        {
          name: "Template",
          description:
            "Reusable subject/body content, often with supported tokens.",
        },
        {
          name: "Delivery history",
          description:
            "Shows sent, failed, suppressed, or pending communications.",
        },
      ],
      [
        "Email changes can expose private information. Verify recipients before sending.",
      ],
    ),
  ),
  entry(
    "/admin/notices",
    help(
      "Member Notices",
      "Member Notices posts committee news to targeted member audiences and tracks who has read each notice.",
      [
        "Target a notice to everyone or to specific members, membership types, lodges, or committee roles.",
        "Publish when ready; optionally email the notice to the audience once on publish.",
        "Open a notice to see the read-status report and, where required, acknowledgements.",
      ],
      [
        {
          name: "Audience",
          description:
            "Who can see the notice: everyone, or a targeted set of members, types, lodges, or roles.",
        },
        {
          name: "Financial members only",
          description:
            "When set, group audiences reach only paid-up or exempt members; individually targeted members always see it.",
        },
        {
          name: "Read receipts",
          description:
            "Records when each member first opened the notice, and their acknowledgement when required.",
        },
      ],
      [
        "Notices can carry private committee information. Check the audience before publishing.",
      ],
    ),
  ),
  entry(
    "/admin/lockers",
    help(
      "Lockers",
      "Lockers manages lodge locker assignments and availability.",
      [
        "Search for the member or locker before assigning a locker.",
        "Record start/end dates or status changes when a locker changes hands.",
        "Use notes for operational context such as key returns or access issues.",
      ],
      [
        {
          name: "Locker",
          description:
            "The physical locker identifier used at the lodge.",
        },
        {
          name: "Assigned member",
          description:
            "The member currently responsible for the locker.",
        },
        {
          name: "Status",
          description:
            "Shows whether the locker is available, assigned, inactive, or needs follow-up.",
        },
      ],
    ),
  ),
  entry(
    "/admin/family-suggestions",
    help(
      "Family Suggestions",
      "Family Suggestions surfaces likely family relationships based on member data so admins can create or dismiss groups deliberately.",
      [
        "Review each suggestion against names, emails, ages, and addresses.",
        "Create the family group only when the relationship is clear.",
        "Dismiss suggestions that are wrong or not useful.",
      ],
      [
        {
          name: "Suggested members",
          description:
            "Records that appear related based on shared details.",
        },
        {
          name: "Confidence clues",
          description:
            "Shared email, address, surname, or dependent age information that explains the suggestion.",
        },
      ],
    ),
  ),
  entry(
    "/admin/roster",
    help(
      "Roster",
      "Roster manages lodge day rosters and printable operational lists.",
      [
        "Select the roster date, review expected guests, and prepare the daily view.",
        "Use print views for lodge handover or offline use.",
        "Check hut-leader coverage and booking state before relying on the roster.",
      ],
      [
        {
          name: "Roster date",
          description:
            "The lodge date being prepared.",
        },
        {
          name: "Guests",
          description:
            "People expected to be staying or arriving around the selected date.",
        },
      ],
    ),
  ),
  entry(
    "/admin/chores",
    help(
      "Chores",
      "Chores configures lodge chore lists, rosters, and guest task assignment behavior.",
      [
        "Create or edit chore definitions before generating rosters.",
        "Check frequency and active flags so chores rotate as intended.",
        "Use roster previews before publishing or printing assignments.",
      ],
      [
        {
          name: "Chore",
          description:
            "The task name and instructions shown to hut leaders or guests.",
        },
        {
          name: "Frequency",
          description:
            "Controls how often the chore should appear in generated rosters.",
        },
        {
          name: "Active",
          description:
            "Controls whether the chore is eligible for future rosters.",
        },
      ],
    ),
  ),
  entry(
    "/admin/lodge",
    help(
      "Lodge Kiosk",
      "Lodge Kiosk settings and tools support arrivals, departures, chores, PIN access, and day-of-lodge operations.",
      [
        "Review kiosk access and current lodge day information.",
        "Use arrivals/departures and roster views to support the hut leader.",
        "Adjust lodge-facing settings only when operational policy changes.",
      ],
      [
        {
          name: "Kiosk PIN",
          description:
            "The access code used for lodge/kiosk workflows.",
        },
        {
          name: "Arrivals and departures",
          description:
            "Guest movement signals for the selected lodge day.",
        },
      ],
    ),
  ),
  entry(
    "/admin/work-parties",
    help(
      "Work Parties",
      "Work Parties manages volunteer work-party events, attendance, and operational details.",
      [
        "Create events with clear dates, capacity, tasks, and contact instructions.",
        "Review attendees and update status as people sign up or cancel.",
        "Use notes for tools, access, safety, or follow-up actions.",
      ],
      [
        {
          name: "Event date",
          description:
            "When the work party occurs.",
        },
        {
          name: "Capacity",
          description:
            "How many volunteers or attendees can join.",
        },
        {
          name: "Tasks",
          description:
            "The work or maintenance items planned for the event.",
        },
      ],
    ),
  ),
  entry(
    "/admin/calendar",
    help(
      "Events Calendar",
      "The club events calendar for meetings, working bees, and committee video meetings. Every member sees it; committee members and admins with lodge edit can add, edit, and delete events, while other members are read-only.",
      [
        "Click a day (or New event) to add an event, and set a Repeat rule for recurring meetings such as the 3rd Tuesday of each month.",
        "When editing a repeating event, choose This event only or All events in the series.",
        "Tick Video meeting (MiroTalk) to attach a join link committee members and admins can open.",
      ],
      [
        {
          name: "Repeat",
          description:
            "Daily, weekly, monthly by day of month, or monthly by nth weekday, with an interval and an optional end (a date or a number of times).",
        },
        {
          name: "Who can edit",
          description:
            "Committee members (an active committee assignment) and admins with lodge edit; all other members are read-only.",
        },
        {
          name: "Video meeting (MiroTalk)",
          description:
            "Attaches a self-hosted MiroTalk room to the event; requires MIROTALK_URL to point at your MiroTalk instance.",
        },
      ],
    ),
  ),
  entry(
    "/admin/lodge-instructions",
    help(
      "Lodge Instructions",
      "Lodge Instructions edits protected instruction documents for hut leaders and lodge readers.",
      [
        "Edit only the instruction document that matches the operational topic.",
        "Use supported text tokens when the instructions need live club values.",
        "Preview or read the protected route after saving important wording changes.",
      ],
      [
        {
          name: "Document",
          description:
            "The opening, closing, or day-to-day instruction record being edited.",
        },
        {
          name: "Body",
          description:
            "Sanitised HTML content shown to authorised lodge readers.",
        },
        {
          name: "Tokens",
          description:
            "Supported placeholders resolved on read surfaces, such as club name or lodge capacity.",
        },
      ],
    ),
  ),
  // Registered at the PREFIX, so every Lobby Display page — the hub, Devices,
  // Templates, the Visual builder, the wizard itself — resolves to this entry.
  // That is the "always-available Help link" the guided setup wizard needs
  // (#2249): the hub's gold setup card disappears once a screen is live, but a
  // club replacing a TV a year later still needs to find the wizard, and the
  // Help panel is the one affordance present on all of those pages.
  entry(
    "/admin/display",
    help(
      "Lobby Display",
      "Lobby Display pairs the TVs in your lodges and authors the boards they show. Three words, two of them stored: a Layout is the skeleton, a Template is a Layout filled in, and a board is what a screen actually shows.",
      [
        "Setting up a screen for the first time, or replacing one? Open the guided setup wizard at /admin/display/setup — it walks the whole path from the module being off to a TV showing the right board, and it can be re-run safely at any time.",
        "Use Devices to pair a screen, swap which board it shows, change its refresh interval, or revoke a screen that has left the building.",
        "Use the Visual builder to compose a board without writing HTML; Layouts and Templates are the advanced, hand-authored equivalents.",
        "Restore built-in boards on the Templates page if the shipped boards are missing — it never runs by itself, and it overwrites anything saved under a reserved built-in key.",
      ],
      [
        {
          name: "Device",
          description:
            "One lobby screen, bound to a lodge. It holds its own token once paired, so pairing survives reboots until you revoke it.",
        },
        {
          name: "Pairing code",
          description:
            "The six characters the screen shows while it waits. You type them into the admin; the screen then claims its own token on its next poll.",
        },
        {
          name: "Board / Template",
          description:
            "What the screen shows. A device bound to no template falls back to the club default board.",
        },
        {
          name: "Lodge display settings",
          description:
            "The per-lodge values boards print through {{config:…}} tokens (Wi-Fi, checkout time, notices) and the guest-name privacy setting.",
        },
      ],
      [
        "The guided setup wizard remembers its position for the WHOLE club, not per admin — two admins running it share one place in the flow. Every step re-checks real state, so a shared position can only change which step opens first.",
        "Everything under Lobby Display is hidden while the Lobby TV display module is off, except the guided setup wizard, whose first step turns the module on.",
        "A value a board asks for but the lodge has not saved renders as a visible placeholder on the wall, so fill the lodge details in before the TV goes up.",
      ],
    ),
  ),
  entry(
    "/admin/stuck-states",
    help(
      "Stuck States",
      "Stuck States aggregates workflows that appear stale, inconsistent, or blocked across bookings, payments, Xero, email, waitlist, and lodge tasks.",
      [
        "Review the highest-severity rows first.",
        "Open the linked record and resolve the underlying cause rather than hiding the symptom.",
        "Use retry/recovery controls where available and record manual follow-up when needed.",
      ],
      [
        {
          name: "Severity",
          description:
            "How urgently the stuck state should be investigated.",
        },
        {
          name: "Owner",
          description:
            "The operational area expected to act, such as Admin, Finance, Lodge, or System.",
        },
        {
          name: "Target",
          description:
            "The booking, payment, member, job, or provider record to inspect.",
        },
      ],
    ),
  ),
  entry(
    "/admin/health",
    help(
      "System Health",
      "System Health shows runtime, database, provider, and readiness indicators for operators.",
      [
        "Check readiness and dependency status before investigating user reports.",
        "Use timestamps and provider health messages to distinguish stale data from current outages.",
        "Escalate recurring failures to deployment or provider support workflows.",
      ],
      [
        {
          name: "Readiness",
          description:
            "Whether the app and required dependencies are healthy enough to serve traffic.",
        },
        {
          name: "Provider status",
          description:
            "Health or connectivity information for external services.",
        },
      ],
    ),
  ),
  entry(
    "/admin/email-deliverability",
    help(
      "Email Deliverability",
      "Email Deliverability monitors SES feedback, bounces, complaints, suppressions, and reissue actions.",
      [
        "Review suppressions or failures before resending important emails.",
        "Clear suppressions only when the address problem has been corrected.",
        "Use reissue-token actions for failed membership or password flows when appropriate.",
      ],
      [
        {
          name: "Suppression",
          description:
            "An address-level SES block caused by bounce or complaint feedback.",
        },
        {
          name: "Failure",
          description:
            "An email send that did not complete or needs operator review.",
        },
        {
          name: "Reissue",
          description:
            "Creates a fresh email token or action link after a failure is resolved.",
        },
      ],
    ),
  ),
  entry(
    "/admin/background-jobs",
    help(
      "Background Jobs",
      "Background Jobs shows scheduled work such as cron runs, retries, payment recovery, Xero sync, email retry, and maintenance tasks.",
      [
        "Check the latest run status, duration, and error text.",
        "Retry only idempotent jobs or jobs with explicit retry controls.",
        "Use job history to confirm whether a failure is new or recurring.",
      ],
      [
        {
          name: "Run status",
          description:
            "Whether the job succeeded, failed, is running, or was skipped.",
        },
        {
          name: "Started / finished",
          description:
            "Timestamps used to detect stale or overlapping runs.",
        },
        {
          name: "Error",
          description:
            "The failure message or provider response captured by the job.",
        },
      ],
    ),
  ),
  entry(
    "/admin/audit-log",
    help(
      "Audit Log",
      "Audit Log records important admin, member, provider, and system actions for traceability.",
      [
        "Filter by actor, entity, category, severity, outcome, or date.",
        "Open metadata when you need before/after details for a change.",
        "Use audit evidence to reconstruct who changed what and why.",
      ],
      [
        {
          name: "Actor",
          description:
            "The member, system job, or provider event that performed the action.",
        },
        {
          name: "Entity",
          description:
            "The record type and id affected by the action.",
        },
        {
          name: "Metadata",
          description:
            "Structured context such as before/after values, provider IDs, or request information.",
        },
      ],
    ),
  ),
  entry(
    "/admin/deletion-requests",
    help(
      "Deletion Requests",
      "Deletion Requests tracks member data deletion requests and operator follow-up.",
      [
        "Review the requester identity and any legal or operational blockers.",
        "Check linked bookings, payments, family records, and audit obligations before completion.",
        "Record decisions and completion notes for accountability.",
      ],
      [
        {
          name: "Requester",
          description:
            "The member or account that asked for deletion.",
        },
        {
          name: "Blockers",
          description:
            "Records that may need retention or resolution before deletion can proceed.",
        },
        {
          name: "Outcome",
          description:
            "The approved, rejected, completed, or deferred decision.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup",
    help(
      "Setup",
      "Setup collects first-install readiness and links to focused setup hubs.",
      [
        "Complete required setup steps before opening public workflows.",
        "Use provider tests and progress indicators to confirm configuration is working.",
        "Open the setup hub cards for lower-frequency membership, booking, finance, integration, cancellation, and notification setup pages.",
        "Review Finance Report Mappings from the Finance drill-down when Xero-backed reports are enabled.",
      ],
      [
        {
          name: "Setup progress",
          description:
            "Shows which required configuration areas are complete or still missing.",
        },
        {
          name: "Provider tests",
          description:
            "Safe checks that confirm external configuration without using exploratory live data.",
        },
        {
          name: "Setup hubs",
          description:
            "Cards that route setup work into focused drill-down pages instead of one long checklist.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/foundations",
    help(
      "Initial Setup",
      "Initial Setup groups first-install readiness, modules, lodge records, and health checks.",
      [
        "Open Setup Checklist before marking setup complete.",
        "Review Modules and Lodges before enabling module-backed or multi-lodge workflows.",
        "Use System Health to confirm runtime readiness before launch.",
      ],
      [
        {
          name: "Setup Checklist",
          description:
            "Readiness KPIs, blockers, provider tests, and setup progress.",
        },
        {
          name: "Modules",
          description:
            "Club-level activation controls for optional workflows.",
        },
        {
          name: "System Health",
          description:
            "Runtime and provider readiness checks used before launch.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/finance",
    help(
      "Finance setup",
      "Finance setup groups finance reporting, Xero setup, sync mappings, and the finance report mapping editor.",
      [
        "Open Finance Dashboard for reporting views and sync-health context.",
        "Open Xero Setup or Xero Mappings before changing accounting sync behavior.",
        "Expand Finance Report Mappings only when editing the report groups used by the finance dashboard.",
      ],
      [
        {
          name: "Finance Dashboard",
          description:
            "Finance reporting views that read from synced accounting data.",
        },
        {
          name: "Xero Mappings",
          description:
            "Account and item-code mappings used by operational Xero sync.",
        },
        {
          name: "Finance Report Mappings",
          description:
            "Collapsed editor for grouping Xero profit-and-loss lines into dashboard report sections.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/booking-rules",
    help(
      "Booking Rules",
      "Booking Rules groups the setup pages that define booking eligibility, pricing, capacity, and booking copy.",
      [
        "Open Booking Policies before changing cancellation, minimum-stay, public-request, or group-discount behavior.",
        "Review Hut Fees & Seasons and Age Groups before accepting priced bookings.",
        "Use Rooms & Beds and Booking Messages for inventory and member-facing booking copy.",
      ],
      [
        {
          name: "Booking Policies",
          description:
            "Rules that affect holds, cancellation, minimum stays, public requests, and group discounts.",
        },
        {
          name: "Hut Fees & Seasons",
          description:
            "Season windows and nightly rates used by booking pricing.",
        },
        {
          name: "Rooms & Beds",
          description:
            "Capacity and allocation inventory used by lodge stays.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/integrations",
    help(
      "Operational Integrations",
      "Operational Integrations groups provider-backed setup pages for accounting, email, modules, and health checks.",
      [
        "Open Xero Setup before connecting or changing operational accounting sync.",
        "Review Modules before enabling provider-backed workflows.",
        "Use Email Deliverability and Provider Health for runtime diagnostics.",
      ],
      [
        {
          name: "Xero Setup",
          description:
            "OAuth connection and accounting settings used by Xero-backed workflows.",
        },
        {
          name: "Email Deliverability",
          description:
            "SES/SMTP delivery and suppression diagnostics.",
        },
        {
          name: "Provider Health",
          description:
            "Safe runtime checks for provider readiness.",
        },
      ],
    ),
  ),
  entry(
    "/admin/setup/cancellation",
    help(
      "Cancellation setup",
      "Cancellation setup groups member cancellation settings, request handling, and related email copy.",
      [
        "Open Membership Cancellation before changing cancellation warning or rejoin-process text.",
        "Review Cancellation Requests before changing live policy that affects pending requests.",
        "Use Email Messages for cancellation and lifecycle message wording.",
      ],
      [
        {
          name: "Membership Cancellation",
          description:
            "Settings for cancellation copy and Xero cancellation handling.",
        },
        {
          name: "Cancellation Requests",
          description:
            "Pending member requests that may be affected by policy changes.",
        },
        {
          name: "Email Messages",
          description:
            "Audited templates used by cancellation and member lifecycle workflows.",
        },
      ],
    ),
  ),
  entry(
    "/admin/membership-setup",
    help(
      "Membership & Members setup",
      "Membership & Members groups the setup pages that define membership policy, profile fields, and subscription access behavior.",
      [
        "Open Membership Types for seasonal categories, booking-rate behavior, subscription behavior, age tiers, and Xero group rules.",
        "Open Member Fields before changing what members or applicants are asked to provide.",
        "Review Subscription Lockout before enabling or changing access restrictions for unpaid subscriptions.",
      ],
      [
        {
          name: "Membership Types",
          description:
            "Seasonal categories that drive booking policy, subscriptions, age-tier eligibility, and optional Xero contact-group rules.",
        },
        {
          name: "Member Fields",
          description:
            "Extra profile fields collected from members and applicants.",
        },
        {
          name: "Subscription Lockout",
          description:
            "Policy controls for when unpaid subscriptions restrict booking or access actions.",
        },
      ],
    ),
  ),
  entry(
    "/admin/bookings-setup",
    help(
      "Bookings Setup",
      "Bookings Setup groups lower-frequency pages that shape booking inventory and member-facing booking copy.",
      [
        "Open Rooms & Beds before changing bed-allocation inventory.",
        "Open Booking Messages when booking, payment, cancellation, or group-booking wording needs an operator-approved update.",
        "Check module and permission gates if a setup card is hidden for the current admin.",
      ],
      [
        {
          name: "Rooms & Beds",
          description:
            "Lodge room and bed inventory used by bed-allocation workflows.",
        },
        {
          name: "Booking Messages",
          description:
            "Editable wording shown during booking, payment, cancellation, and group-trip flows.",
        },
      ],
    ),
  ),
  entry(
    "/admin/integrations",
    help(
      "Integrations",
      "Integrations groups provider-backed setup pages for accounting and other connected services.",
      [
        "Open Xero Setup to connect or test accounting configuration.",
        "Keep provider tests on non-production credentials unless a live test window is approved.",
        "Check finance mappings after changing Xero setup that affects reports or invoices.",
      ],
      [
        {
          name: "Xero Setup",
          description:
            "OAuth connection, account mapping, provider checks, and sync configuration for Xero-backed workflows.",
        },
      ],
    ),
  ),
  entry(
    "/admin/appearance",
    help(
      "Site Appearance & Content",
      "Site Appearance & Content groups public-facing style, content, banner, media, and mountain-condition setup.",
      [
        "Open Site Style before changing shared theme, logo, colour, or font settings.",
        "Use Page Content, Site Content, and Site Banners for public copy and notice changes.",
        "Use Image Manager and Mountain Conditions only for reviewed public-media or module-backed content updates.",
      ],
      [
        {
          name: "Site Style",
          description:
            "Public theme, logo, colours, fonts, and first-run style completion.",
        },
        {
          name: "Content pages",
          description:
            "Page content, shared site chrome, public banners, and reusable public text.",
        },
        {
          name: "Media",
          description:
            "Filesystem images and module-backed mountain-condition content used by public pages.",
        },
      ],
    ),
  ),
  entry(
    "/admin/notifications",
    help(
      "Notifications & Email",
      "Notifications & Email groups delivery rules, recipients, automated message wording, and member-facing notification copy.",
      [
        "Open Delivery Rules and Recipients before changing who receives admin or system alerts.",
        "Open Email Messages for audited email-template wording.",
        "Use Booking Messages and Membership Cancellation when changing member-facing copy tied to those workflows.",
      ],
      [
        {
          name: "Delivery Rules",
          description:
            "Controls which admin and system emails are sent when jobs or alerts run.",
        },
        {
          name: "Recipients",
          description:
            "The active admins selected for each system-alert category.",
        },
        {
          name: "Message wording",
          description:
            "Email, booking, and cancellation text that members or admins see in workflow messages.",
        },
      ],
    ),
  ),
  entry(
    "/admin/modules",
    help(
      "Modules",
      "Modules turn optional club features on or off at the club level.",
      [
        "Review current module state before enabling a feature.",
        "Enable only the modules the club is ready to operate and support.",
        "Disable modules that should be hidden from users while preserving existing data.",
      ],
      [
        {
          name: "Enabled",
          description:
            "Makes the feature visible and usable where route gating allows it.",
        },
        {
          name: "Disabled",
          description:
            "Hides or blocks the feature without deleting its stored data.",
        },
        {
          name: "Module dependency",
          description:
            "Some features also require provider settings, roles, or setup data before they are useful.",
        },
      ],
    ),
  ),
  entry(
    "/admin/subscription-lockout",
    help(
      "Subscription Lockout",
      "Subscription Lockout controls whether unpaid or overdue subscriptions restrict member access or booking behavior.",
      [
        "Review the current policy before changing lockout behavior.",
        "Set grace periods and affected statuses according to committee policy.",
        "Check member-facing wording and subscription states before enabling enforcement.",
      ],
      [
        {
          name: "Grace period",
          description:
            "How long a member can remain overdue before lockout applies.",
        },
        {
          name: "Affected status",
          description:
            "Which subscription states trigger restrictions.",
        },
        {
          name: "Lockout message",
          description:
            "The member-facing explanation shown when access is restricted.",
        },
      ],
    ),
  ),
  entry(
    "/admin/membership-types",
    help(
      "Membership Types",
      "Membership Types define seasonal member categories, booking rate behavior, subscription behavior, and optional Xero contact-group rules.",
      [
        "Use the type list to scan status, policy behavior, allowed tiers, assignment counts, and order.",
        "Create or edit a type in the editor before assigning it to members or rolling seasons forward.",
        "Use the separate roll-forward section to preview changes and exceptions before applying them.",
        "When adding Xero rules, choose Managed only when sync should assert membership in the Xero group.",
        "Keep access roles separate from seasonal membership type policy.",
        "Delete removes an unused custom type outright; a custom type that still has seasonal assignments must be merged into another active type (reassign, then delete). Built-in types can never be deleted or merged.",
        "Before merging, check the Xero-rule warning: reassigned members keep their Xero contact-group membership until the next periodic Xero reconciliation.",
      ],
      [
        {
          name: "Booking behavior",
          description:
            "Controls member-rate, non-member-rate, or block-booking behavior for this type.",
        },
        {
          name: "Subscription behavior",
          description:
            "Controls whether this type requires a subscription invoice.",
        },
        {
          name: "Allowed age tiers",
          description:
            "Limits the age bands that can use the membership type.",
        },
        {
          name: "Xero rule mode",
          description:
            "Managed means sync adds matching members to the group; Accepted means the group is allowed if present but is not enforced by sync.",
        },
        {
          name: "Xero age scope",
          description:
            "Restricts a rule to one age tier or applies it to every allowed age tier for the membership type.",
        },
      ],
      [],
      [
        {
          title: "Xero rules",
          details: [
            "A membership-type Xero rule links this type to a Xero contact group, separately from age-tier Xero groups.",
            "Managed rules actively add matching members to the selected group during Xero membership sync.",
            "Accepted rules tolerate the selected group when it is already present, but sync will not add members to it.",
            "The age scope and Xero group together define where the rule applies; only one Managed rule is allowed for the same age scope.",
            "Changing type rules or merging types does not synchronously resync existing members. They reconcile through the existing periodic and mismatch tooling.",
          ],
        },
      ],
    ),
  ),
  entry(
    "/admin/site-style",
    help(
      "Site Style",
      "Site Style controls the public website theme, colours, fonts, logo, and page-level style rules.",
      [
        "Complete required style fields before opening the public website.",
        "Upload or choose branding assets with appropriate alt text.",
        "Use custom CSS only for reviewed public-page styling changes.",
      ],
      [
        {
          name: "Logo",
          description:
            "The database-stored public logo used by website chrome.",
        },
        {
          name: "Colours and fonts",
          description:
            "Theme values applied to public website pages.",
        },
        {
          name: "Custom CSS",
          description:
            "Reviewed style rules for specific public page presentation.",
        },
      ],
    ),
  ),
  entry(
    "/admin/page-content",
    help(
      "Page Content",
      "Page Content creates and edits routable public website pages and their menu settings.",
      [
        "Use Add Page for new public pages and Edit for existing pages.",
        "Set slug, menu title/order, header content, body HTML, and publish state deliberately.",
        "Use token help and the image picker when inserting supported dynamic content.",
      ],
      [
        {
          name: "Slug",
          description:
            "The unique URL segment for the public page.",
        },
        {
          name: "Menu title and order",
          description:
            "Controls whether and where the page appears in public navigation.",
        },
        {
          name: "Body",
          description:
            "Sanitised rich HTML displayed on the page.",
        },
      ],
      [
        "Scripts and unsafe HTML are removed on save and render.",
      ],
    ),
  ),
  entry(
    "/admin/site-banners",
    help(
      "Site Banners",
      "Site Banners publishes plain-text public notices above the website and member headers for a date window.",
      [
        "Create a banner with message, priority, start date, end date, and active state.",
        "Use priority to communicate urgency: urgent, warning, or notify.",
        "Edit a banner when wording changes; visitors who dismissed the old wording will see the updated banner again.",
      ],
      [
        {
          name: "Priority",
          description:
            "Controls the faded red, amber, or blue styling and announcement role.",
        },
        {
          name: "Display window",
          description:
            "Inclusive New Zealand date-only start and end dates.",
        },
        {
          name: "Active",
          description:
            "Controls whether the banner can show during its display window.",
        },
      ],
    ),
  ),
  entry(
    "/admin/site-content",
    help(
      "Site Content",
      "Site Content edits shared public website chrome that is not a standalone page, such as footer columns.",
      [
        "Open the section you need and save one shared content block at a time.",
        "Use supported text tokens for live club values.",
        "Clear optional footer columns only when they should disappear from the public footer.",
      ],
      [
        {
          name: "Section",
          description:
            "The shared content block being edited, such as footer blurb or quick links.",
        },
        {
          name: "HTML",
          description:
            "Sanitised rich content rendered in shared website chrome.",
        },
        {
          name: "Tokens",
          description:
            "Supported placeholders such as club name, currency, lodge capacity, or Facebook URL.",
        },
      ],
    ),
  ),
  entry(
    "/admin/mountain-conditions",
    help(
      "Mountain Conditions",
      "Mountain Conditions manages public or operational condition information for ski field and lodge visitors.",
      [
        "Review current conditions before publishing updates.",
        "Update wording, severity, or visibility when mountain or access conditions change.",
        "Coordinate urgent operational warnings with Site Banners when visitors need immediate notice.",
      ],
      [
        {
          name: "Condition",
          description:
            "The latest status or description shown to visitors or operators.",
        },
        {
          name: "Visibility",
          description:
            "Controls whether the condition information is displayed.",
        },
      ],
    ),
  ),
  entry(
    "/admin/image-manager",
    help(
      "Image Manager",
      "Image Manager uploads and organises filesystem-backed public images used by public website content.",
      [
        "Choose the correct directory before uploading.",
        "Use descriptive filenames and alt text where the workflow supports it.",
        "Delete only images that are no longer referenced by public content.",
      ],
      [
        {
          name: "Directory",
          description:
            "The public image folder or grouping where the file will be stored.",
        },
        {
          name: "Image file",
          description:
            "A PNG, JPEG, GIF, WebP, or AVIF file within the configured size limit.",
        },
        {
          name: "Public path",
          description:
            "The URL path used by public pages or rich-text image insertion.",
        },
      ],
    ),
  ),
  entry(
    "/admin/rooms-beds",
    help(
      "Rooms & Beds",
      "Rooms & Beds configures lodge room and bed inventory used by capacity and bed allocation.",
      [
        "Create or edit rooms and beds to match the physical lodge layout.",
        "Import from config only when you intend to align database beds to configured defaults.",
        "Deactivate beds rather than deleting history where existing allocations may refer to them.",
      ],
      [
        {
          name: "Room",
          description:
            "A physical lodge room containing one or more beds.",
        },
        {
          name: "Bed",
          description:
            "An individual bed that can be allocated to a guest.",
        },
        {
          name: "Active",
          description:
            "Controls whether a room or bed participates in future allocation.",
        },
      ],
    ),
  ),
  entry(
    "/admin/member-fields",
    help(
      "Member Fields",
      "Member Fields controls optional member-profile fields and how they appear in profile or admin workflows.",
      [
        "Review which fields are required, optional, hidden, or admin-only.",
        "Change field visibility only when membership policy or data collection needs change.",
        "Test profile editing after changing required fields.",
      ],
      [
        {
          name: "Required",
          description:
            "Members must provide this value when the field is shown.",
        },
        {
          name: "Visible",
          description:
            "Controls whether the field appears to members, admins, or both.",
        },
        {
          name: "Field label",
          description:
            "The wording users see beside the field.",
        },
      ],
    ),
  ),
  entry(
    "/admin/notifications",
    help(
      "Notifications & Email",
      "Notifications & Email configures notification recipients, rules, delivery policies, and email-related settings.",
      [
        "Choose the rule, recipient, or delivery policy area you need.",
        "Review who receives each notification before saving.",
        "Use previews or test paths where available before relying on new wording.",
      ],
      [
        {
          name: "Recipient",
          description:
            "The role, member, or address that receives a notification.",
        },
        {
          name: "Rule",
          description:
            "The event and conditions that trigger a notification.",
        },
        {
          name: "Delivery mode",
          description:
            "Controls whether a template sends always, only with content, or is disabled.",
        },
      ],
    ),
  ),
  entry(
    "/admin/booking-messages",
    help(
      "Booking Messages",
      "Booking Messages edits reusable wording shown or sent during booking workflows.",
      [
        "Open the message template that matches the booking state or action.",
        "Use previews to confirm token output and member-facing wording.",
        "Reset to defaults only when you intentionally want to discard custom wording.",
      ],
      [
        {
          name: "Template",
          description:
            "The message slot used by a booking workflow.",
        },
        {
          name: "Subject and body",
          description:
            "The email or UI wording members see.",
        },
        {
          name: "Tokens",
          description:
            "Supported placeholders replaced with booking, member, or club values.",
        },
      ],
    ),
  ),
  entry(
    "/admin/committee",
    help(
      "Committee",
      "Committee manages master roles, role email aliases, and public/member-visible committee assignments.",
      [
        "Create or archive master roles before assigning members to them.",
        "Set public display flags deliberately; new assignments should stay hidden until reviewed.",
        "Use role email aliases for public contact routing when privacy matters.",
        "When an assignment is Contactable, choose per assignment whether public contact messages route to the committee role email, the member's own email, or a custom address (role falls back to the member email when the role alias is blank).",
      ],
      [
        {
          name: "Master role",
          description:
            "The reusable committee position, such as president or bookings officer.",
        },
        {
          name: "Assignment",
          description:
            "Links a member to a role with display and contact flags.",
        },
        {
          name: "Role email alias",
          description:
            "A server-side contact address used before any member-email fallback.",
        },
      ],
    ),
  ),
  entry(
    "/admin/access-roles",
    help(
      "Access roles and admin areas",
      "Access roles grant per-area admin access at one of three levels — none, view, or edit. Assign one or more roles to a member; their effective access is the strongest level each role grants per area.",
      [
        "Open a role to set its per-area access, or create a custom role, then assign roles to members from the member editor.",
        "Give the least access that does the job: view where a role only needs to read, edit only where it must change records.",
        "Deleting or narrowing a role changes every current holder — check who holds it before you save.",
      ],
      [
        {
          name: "Admin Overview",
          description:
            "Dashboard and cross-area entry points, including the pending-counts badges.",
        },
        {
          name: "Bookings & Beds",
          description:
            "Bookings, booking requests, policies, waitlist, bed allocation, seasons, age tiers, and promo codes.",
        },
        {
          name: "Membership",
          description:
            "Members, applications, families, memberships, inductions, communications, committee, lockers, and member lodge-access.",
        },
        {
          name: "Finance",
          description:
            "Payments, subscriptions, refunds, reports, Xero sync, accounting setup, and member credits.",
        },
        {
          name: "Lodge Operations",
          description:
            "Hut leaders, rosters, chores, work parties, lodge settings, and lodges.",
        },
        {
          name: "Content",
          description:
            "Public page content, site chrome, banners, images, and site style.",
        },
        {
          name: "Support & System",
          description:
            "Setup, modules, health, deliverability, audit, issue reports, and booking messages.",
        },
      ],
      [
        "Each area grants none, view, or edit. Edit implies view; anything other than a read requires edit, and a read-only page needs only view.",
        "A member can hold several roles; their access is the maximum level each role grants per area — levels merge upward and never subtract.",
        "The six seeded roles (Read-only Admin, Booking Officer, Membership Officer, Content Manager, Treasurer, Finance Viewer) are starting points you can edit or delete; an edit applies to every holder on their next request.",
        "Full Admin is a protected role with edit everywhere. Its permissions are never editable, and you cannot demote or deactivate your own account. No admin action that deactivates, de-logins, or archives an account — member edit, bulk update, archive, deletion approval, membership cancellation, login-holder transfer, or dependent linking — can remove the last active Full Admin, and only a Full Admin can perform those actions on another account that holds privileged access, so a scoped admin (such as a Membership Officer) cannot lock admins out this way. Still keep a second Full Admin account for continuity.",
      ],
    ),
  ),
];

const financeHelpEntries: HelpEntry[] = [
  entry(
    "/finance",
    help(
      "Finance Dashboard",
      "The Finance dashboard combines booking metrics, revenue/cost views, mapped Xero snapshots, sync diagnostics, and export tools.",
      [
        "Choose the view, date range, comparison range, and forward window, then apply filters.",
        "Use CSV or PDF exports for committee reporting or offline reconciliation.",
        "If you are a finance manager, run a manual sync when the sync status indicates stale or missing data.",
      ],
      [
        {
          name: "View",
          description:
            "Selects the report lens, such as revenue, costs, bookings, balance sheet, or reconciliation.",
        },
        {
          name: "Range",
          description:
            "Sets the main reporting period; custom from/to dates override preset windows.",
        },
        {
          name: "Compare",
          description:
            "Sets the comparison period used by trends and variance summaries.",
        },
        {
          name: "Forward",
          description:
            "Adds a future-looking window for expected booking or revenue signals.",
        },
        {
          name: "Expense filters",
          description:
            "Limit cost views to mapped Xero categories or individual expense lines.",
        },
      ],
      [
        "Finance dashboard output depends on the latest successful finance sync and Admin > Setup finance mappings.",
        "Exports reflect the currently applied filters.",
      ],
      [
        {
          title: "Sync status",
          details: [
            "The status banner explains whether finance data is current, stale, missing, or blocked by provider errors.",
            "Manual sync is available to finance managers only.",
          ],
        },
        {
          title: "Charts and KPI cards",
          details: [
            "Cards summarise the selected window and comparison window.",
            "Trend and mix charts use the same filters as the report table and exports.",
          ],
        },
      ],
    ),
  ),
];

/**
 * Plain-English Q&A distilled from the highest-traffic admin/finance entries
 * above (and the two fallbacks). Attached to the existing entry content objects
 * below so `getContextualHelp` and the unified help corpus (`@/lib/help`) return
 * the identical object — no new entry definitions, purely additive. Answers are
 * one to three sentences drawn from each entry's own summary/actions/notes.
 */
const ADMIN_HELP_QUESTIONS: Record<string, HelpQuestion[]> = {
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
      a: "Search or filter to the member first, then open their detail page to make edits.",
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
      q: "Can automatic allocation displace a guest?",
      a: "For a paid or confirmed booking it can move a blocking Provisional allocation so a Held booking gets a bed, but the manual Run auto-allocation button never displaces a Held or admin-approved allocation.",
    },
    {
      q: "What must allocation never do?",
      a: "It must never create more occupants than available beds for a lodge night.",
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

const FINANCE_HELP_QUESTIONS: Record<string, HelpQuestion[]> = {
  "/finance": [
    {
      q: "What does the Finance dashboard show?",
      a: "Booking metrics, revenue and cost views, mapped Xero snapshots, sync diagnostics, and export tools.",
    },
    {
      q: "How do I change the reporting period?",
      a: "Set the view, date range, comparison range, and forward window, then apply the filters.",
    },
    {
      q: "How do I export for a committee pack?",
      a: "Use the CSV or PDF export. Exports reflect the currently applied filters.",
    },
    {
      q: "The finance data looks stale — what do I do?",
      a: "If you are a finance manager, run a manual sync. The dashboard depends on the latest successful finance sync and the Admin > Setup finance mappings.",
    },
    {
      q: "Does this page move money?",
      a: "No. It reads mapped Xero snapshots and stored integer-cent figures for reporting only.",
    },
  ],
};

const ADMIN_FALLBACK_QUESTIONS: HelpQuestion[] = [
  {
    q: "How do I find the right record?",
    a: "Use the page's search, filters, and tabs first so you are acting on the correct record set.",
  },
  {
    q: "How do I make a change safely?",
    a: "Open the record detail, dialog, or action button for the smallest change that completes the task, and read any validation or confirmation prompt before you save.",
  },
  {
    q: "What if a provider or background job is involved?",
    a: "Prefer the built-in retry or requeue controls over manual data edits.",
  },
];

const FINANCE_FALLBACK_QUESTIONS: HelpQuestion[] = [
  {
    q: "How do I choose what the finance view shows?",
    a: "Pick the reporting view and date windows, then apply the filters.",
  },
  {
    q: "How do I export finance data?",
    a: "Use CSV or PDF export for committee packs or offline reconciliation.",
  },
  {
    q: "The data looks out of date — what can I do?",
    a: "Finance managers can run a manual sync when the sync status shows stale or missing data. The workspace does not move money itself.",
  },
];

for (const candidate of adminHelpEntries) {
  const questions = ADMIN_HELP_QUESTIONS[candidate.path];
  if (questions) {
    candidate.content.questions = questions;
  }
}

for (const candidate of financeHelpEntries) {
  const questions = FINANCE_HELP_QUESTIONS[candidate.path];
  if (questions) {
    candidate.content.questions = questions;
  }
}

adminFallbackHelp.questions = ADMIN_FALLBACK_QUESTIONS;
financeFallbackHelp.questions = FINANCE_FALLBACK_QUESTIONS;

export function normalisePath(pathname: string | null | undefined) {
  if (!pathname) {
    return "/";
  }
  const withoutQuery = pathname.split(/[?#]/, 1)[0] || "/";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

function isPathMatch(pathname: string, entryPath: string) {
  return pathname === entryPath || pathname.startsWith(`${entryPath}/`);
}

export function getContextualHelp(
  pathname: string | null | undefined,
  scope: HelpScope,
): ContextualHelpContent {
  const path = normalisePath(pathname);
  const entries = scope === "admin" ? adminHelpEntries : financeHelpEntries;
  const fallback = scope === "admin" ? adminFallbackHelp : financeFallbackHelp;

  return (
    entries
      .filter((candidate) => isPathMatch(path, candidate.path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.content ?? fallback
  );
}

// test seam
export function getContextualHelpPaths(scope: HelpScope): string[] {
  return (scope === "admin" ? adminHelpEntries : financeHelpEntries).map(
    (candidate) => candidate.path,
  );
}
