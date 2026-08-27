/**
 * Help for the "Finance" admin section: payments, internet banking, reports and
 * the Xero integration.
 *
 * Section per the sidebar's `buildAdminNavSections`. The separate `/finance` workspace
 * (the finance-scope help) lives in `../finance.ts`.
 */
import { entry, help, type HelpEntry } from "../types";

export const adminFinanceHelpEntries: HelpEntry[] = [
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
    "/admin/payments",
    help(
      "Payments",
      "Payments shows payment records, reconciliation state, and recovery actions across Stripe and Internet Banking paths.",
      [
        "Filter by member, booking, status, source, or date to find the payment record.",
        "Use Reset to restore all filters, sort, and page, including the rolling three-month Updated range through today.",
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
      "Reports provides admin-facing operational exports and summaries for stay-night bookings, booked revenue, collected cash, members, and lodge activity.",
      [
        "Choose a Quick Range, including Next Month, or enter From and To dates.",
        "Set the Lodge and Deleted filters, then select Update to refresh the report.",
        "Use Reset to restore the rolling default date range and hide deleted bookings without changing the selected lodge.",
        "Check the active range and filters before exporting CSV or PDF or sharing a report outside the admin team.",
      ],
      [
        {
          name: "Quick Range",
          description:
            "Sets common date windows without changing the Lodge or Deleted filters.",
        },
        {
          name: "Lodge and Deleted",
          description:
            "Scopes which lodge and soft-deleted bookings are included.",
        },
        {
          name: "Export",
          description:
            "Downloads the filtered report for offline review.",
        },
      ],
      [],
      [
        {
          title: "How report metrics are counted",
          details: [
            "Booked Revenue allocates each booking's integer-cent final price across every lodge night in its complete stay, with any remainder assigned deterministically, before the selected date range is sliced. It is allocated booking value, not collected cash, and money is displayed to exact cents in the page and exports.",
            "Net Collected Cash is the captured payment amount less refunds for overlapping bookings. It is payment-derived and is not allocated across stay nights; Outstanding Additions is shown separately. If an additional payment is marked collected without a matching captured payment record, a warning names how much Net Collected Cash may understate and tells you to ask a developer to reconcile the affected payment ledgers before trusting the figure; the same warning is included in CSV and PDF exports.",
            "Booking and revenue totals include only Pending, Payment Pending, Confirmed, Paid, Awaiting Review, and Completed bookings whose stays overlap the selected nights.",
            "Occupancy keeps its narrower operational meaning: only Paid and Completed bookings occupy beds, and custodian bed holds remain excluded.",
          ],
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
];
