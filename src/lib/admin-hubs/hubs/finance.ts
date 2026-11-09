import { defineHub } from "../define";

/** Finance. */
export const FINANCE_HUB = defineHub({
  key: "finance",
  label: "Finance",
  prefix: "finance",
  pages: [
    {
      id: "payments",
      label: "Payments",
      oldPath: "/admin/payments",
      area: "finance",
      keywords: ["stripe", "transactions", "receipts"],
      moved: true,
    },
    {
      id: "internet-banking",
      label: "Internet Banking",
      oldPath: "/admin/internet-banking",
      area: "finance",
      flags: ["xeroIntegration", "internetBankingPayments"],
      moved: true,
    },
    {
      id: "refund-requests",
      label: "Refunds & Credits",
      oldPath: "/admin/refund-requests",
      area: "finance",
      moved: true,
    },
    {
      id: "subscriptions",
      label: "Subscriptions",
      oldPath: "/admin/subscriptions",
      area: "finance",
      moved: true,
    },
    {
      id: "reports",
      label: "Reports",
      oldPath: "/admin/reports",
      area: "finance",
      keywords: ["statements", "export", "analytics", "revenue"],
      moved: true,
    },
    {
      id: "xero",
      label: "Xero Sync",
      oldPath: "/admin/xero",
      area: "finance",
      flags: ["xeroIntegration"],
      keywords: ["accounting", "invoices", "reconcile"],
      // The mappings card, linked from Finance Setup and setup readiness. Its
      // element id is `xeroSectionId("mappings")`, pinned equal in the registry test.
      anchors: ["xero-section-mappings"],
      moved: true,
    },
    {
      id: "xero-member-grouping",
      label: "Xero Member Grouping",
      oldPath: "/admin/xero/member-grouping",
      area: "finance",
      flags: ["xeroIntegration"],
      moved: true,
    },
    {
      id: "xero-record",
      label: "Xero Record",
      oldPath: "/admin/xero/records/[localModel]/[localId]",
      area: "finance",
      flags: ["xeroIntegration"],
      kind: "detail",
      moved: true,
    },
    {
      id: "xero-setup",
      label: "Xero Setup",
      oldPath: "/admin/xero/setup",
      area: "finance",
      flags: ["xeroIntegration"],
      moved: true,
    },
  ],
});
