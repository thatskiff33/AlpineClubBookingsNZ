import type { FinanceDashboardSelection } from "@/lib/finance-dashboard-ranges";
import {
  buildFinanceSyncHealth,
  type FinanceSyncHealthTone,
} from "@/lib/finance-sync-health";
import type {
  FinanceDashboardKpiCard,
  FinanceDashboardStatusPanel,
  FinanceDashboardViewModel,
} from "@/lib/finance-dashboard-page/model";

const SYNC_HEALTH_BADGE_TONES: Record<
  FinanceSyncHealthTone,
  "success" | "warning" | "destructive"
> = {
  green: "success",
  amber: "warning",
  red: "destructive",
};

const SYNC_HEALTH_BADGE_LABELS: Record<FinanceSyncHealthTone, string> = {
  green: "OK",
  amber: "Attention",
  red: "Action",
};

export async function buildSyncHealthDashboard(
  selection: FinanceDashboardSelection
): Promise<FinanceDashboardViewModel> {
  const health = await buildFinanceSyncHealth({
    currentMonth: selection.currentMonth,
  });

  const cards: FinanceDashboardKpiCard[] = [
    {
      title: "Sync confidence",
      value: health.overallLabel,
      description:
        "Worst signal across the daily sync, reconciliation, Xero operations, and stored monthly facts.",
    },
    ...health.sections.map((section) => {
      const worst =
        section.signals.find((signal) => signal.tone === section.tone) ??
        section.signals[0];
      return {
        title: section.title,
        value: worst?.value ?? "No signals",
        description: worst?.detail ?? section.description,
        footnote: worst && worst.label !== section.title ? worst.label : undefined,
      };
    }),
  ];

  const statusPanels: FinanceDashboardStatusPanel[] = health.sections.map(
    (section) => ({
      title: section.title,
      description: section.description,
      badgeLabel: SYNC_HEALTH_BADGE_LABELS[section.tone],
      badgeTone: SYNC_HEALTH_BADGE_TONES[section.tone],
      items: section.signals.map((signal) => ({
        label: signal.label,
        value: signal.value,
        detail: signal.detail,
        emphasis: signal.tone !== "green",
        href: signal.href,
        linkLabel: signal.linkLabel,
      })),
    })
  );

  return {
    cards,
    trends: [],
    mix: null,
    statusPanels,
    costFilters: null,
    sourceNotes: [
      {
        label: "Health signals",
        description:
          "Aggregates the sync diagnostics, revenue reconciliation, Xero operation outbox, and monthly fact freshness the platform already tracks. Opening this view does not call Xero live.",
      },
      {
        label: "Fixing issues",
        description:
          "Failed or pending operations are retried from the Xero admin console; category mapping gaps are fixed in the setup mappings panel.",
        href: "/admin/xero",
        linkLabel: "Open Xero admin",
      },
    ],
    exportSections: [
      {
        title: "Sync health signals",
        rows: health.sections.flatMap((section) =>
          section.signals.map((signal) => ({
            Section: section.title,
            Signal: signal.label,
            Value: signal.value,
            Status: signal.tone,
            Detail: signal.detail ?? "",
          }))
        ),
      },
    ],
    warnings: health.warnings,
  };
}
