export type FinanceReportCategoryKindValue = "REVENUE" | "EXPENSE";

export interface DefaultFinanceReportCategory {
  kind: FinanceReportCategoryKindValue;
  name: string;
  sortOrder: number;
}

export const DEFAULT_FINANCE_REPORT_CATEGORIES: readonly DefaultFinanceReportCategory[] = [
  { kind: "REVENUE", name: "Hut Fees", sortOrder: 10 },
  { kind: "REVENUE", name: "Subscriptions", sortOrder: 20 },
  { kind: "REVENUE", name: "Entrance Fees", sortOrder: 30 },
  { kind: "REVENUE", name: "Other Revenue", sortOrder: 90 },
  { kind: "EXPENSE", name: "Accommodation Operations", sortOrder: 10 },
  { kind: "EXPENSE", name: "Catering", sortOrder: 20 },
  { kind: "EXPENSE", name: "Utilities", sortOrder: 30 },
  { kind: "EXPENSE", name: "Maintenance", sortOrder: 40 },
  { kind: "EXPENSE", name: "Insurance & Compliance", sortOrder: 50 },
  { kind: "EXPENSE", name: "Admin & Software", sortOrder: 60 },
  { kind: "EXPENSE", name: "Payment & Bank Fees", sortOrder: 70 },
  { kind: "EXPENSE", name: "Other Expenses", sortOrder: 90 },
] as const;
