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
      moved: false,
    },
    {
      id: "internet-banking",
      label: "Internet Banking",
      oldPath: "/admin/internet-banking",
      area: "finance",
      flags: ["xeroIntegration", "internetBankingPayments"],
      moved: false,
    },
    {
      id: "refund-requests",
      label: "Refunds & Credits",
      oldPath: "/admin/refund-requests",
      area: "finance",
      moved: false,
    },
    {
      id: "subscriptions",
      label: "Subscriptions",
      oldPath: "/admin/subscriptions",
      area: "finance",
      moved: false,
    },
    {
      id: "reports",
      label: "Reports",
      oldPath: "/admin/reports",
      area: "finance",
      moved: false,
    },
    {
      id: "xero",
      label: "Xero Sync",
      oldPath: "/admin/xero",
      area: "finance",
      flags: ["xeroIntegration"],
      moved: false,
    },
    {
      id: "xero-member-grouping",
      label: "Xero Member Grouping",
      oldPath: "/admin/xero/member-grouping",
      area: "finance",
      flags: ["xeroIntegration"],
      moved: false,
    },
    {
      id: "xero-record",
      label: "Xero Record",
      oldPath: "/admin/xero/records/[localModel]/[localId]",
      area: "finance",
      flags: ["xeroIntegration"],
      moved: false,
    },
    {
      id: "xero-setup",
      label: "Xero Setup",
      oldPath: "/admin/xero/setup",
      area: "finance",
      flags: ["xeroIntegration"],
      moved: false,
    },
  ],
});
