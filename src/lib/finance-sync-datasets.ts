import type { FinanceSyncDatasetDefinition } from "@/lib/finance-sync-service";

export const FINANCE_SYNC_BOOTSTRAP_DATASET_KEY = "bootstrap";

const financeSyncDatasets: FinanceSyncDatasetDefinition[] = [
  {
    key: FINANCE_SYNC_BOOTSTRAP_DATASET_KEY,
    async sync() {
      // Keep the daily runner on the durable sync boundary until concrete Xero datasets land.
      return [];
    },
  },
];

export function getFinanceSyncDatasets(): FinanceSyncDatasetDefinition[] {
  return financeSyncDatasets;
}
