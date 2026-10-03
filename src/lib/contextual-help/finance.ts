/**
 * Help for the `/finance` workspace — the finance-scope corpus, separate from
 * the admin one and resolved under `scope: "finance"`.
 */
import { entry, help, type HelpEntry } from "./types";

export const financeHelpEntries: HelpEntry[] = [
  entry(
    "/finance",
    help(
      "Finance Dashboard",
      "The Finance dashboard combines booking metrics, revenue/cost views, mapped Xero snapshots, sync diagnostics, and export tools.",
      [
        "Choose the view, date range, comparison range, and forward window, then apply filters.",
        "Use Reset to restore Last Month, Previous Period, Next Month, and empty expense filters without changing the current view or lodge scope.",
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
            "Net Collected Cash is captured payments less refunds and credits for every booking staying in the window, whatever its status: cancelled bookings count only what the club kept of what was paid (money not refunded, credited or owed back by hand, plus account credit the cancellation kept; nothing if never paid), and deleted bookings never count. The admin dashboard, Payments and Reports use the same rule.",
            "No Finance figure counts a deleted booking, the same as Reports' default view.",
            "Trend and mix charts use the same filters as the report table and exports.",
          ],
        },
      ],
    ),
  ),
];
