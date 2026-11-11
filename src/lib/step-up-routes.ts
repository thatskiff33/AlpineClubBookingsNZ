/**
 * Destructive admin routes that ask for a fresh proof (#4619, INV-AUTH-010).
 *
 * One list of operations and one list of routes. The census walks each admin
 * handler's calls, through helpers, and the two lists have to match. Handlers
 * call `requireRecentAuth`; they do not copy the window or the refusal.
 */

export const STEP_UP_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type StepUpHttpMethod = (typeof STEP_UP_HTTP_METHODS)[number];

/** Named exports a handler reaches. The file is the module that defines the export. */
export const STEP_UP_OPERATIONS = [
  { file: "src/lib/backup-restore.ts", exportName: "restoreLocalBackup" },
  { file: "src/lib/integration-credentials.ts", exportName: "setIntegrationCredential" },
  { file: "src/lib/integration-credentials.ts", exportName: "setIntegrationCredentialInTransaction" },
  { file: "src/lib/integration-credentials.ts", exportName: "deleteIntegrationCredential" },
  { file: "src/lib/integration-credentials.ts", exportName: "deleteIntegrationCredentialInTransaction" },
  { file: "src/lib/mirotalk-config-write.ts", exportName: "setMirotalkSecret" },
  { file: "src/lib/mirotalk-config-write.ts", exportName: "clearMirotalkSecret" },
  { file: "src/lib/mirotalk-config-write.ts", exportName: "clearMirotalkSecretsForAddressMove" },
  { file: "src/lib/xero-oauth.ts", exportName: "disconnectXero" },
  { file: "src/lib/member-access-role-writes.ts", exportName: "ensureMemberAccessRoles" },
  { file: "src/lib/member-access-role-writes.ts", exportName: "ensureMemberAccessRolesFromCompatibilityFields" },
  { file: "src/lib/member-merge.ts", exportName: "executeMemberMerge" },
  { file: "src/lib/member-lifecycle-actions.ts", exportName: "createMemberDeleteRequest" },
  { file: "src/lib/config-transfer/apply.ts", exportName: "applyConfigImport" },
  { file: "src/lib/stripe.ts", exportName: "processRefund" },
  { file: "src/lib/payment-transactions.ts", exportName: "refundPaymentTransactions" },
  { file: "src/lib/card-refund-dead-row-actions.ts", exportName: "tryDeadCardRefundAgain" },
  { file: "src/lib/card-refund-dead-row-actions.ts", exportName: "closeCardRefundNothingLeftOwed" },
  { file: "src/lib/card-refund-paid-another-way.ts", exportName: "closeCardRefundPaidAnotherWay" },
  { file: "src/lib/card-refund-paid-twice.ts", exportName: "resolveCardRefundPaidTwice" },
  { file: "src/lib/manual-refund-task-resolution.ts", exportName: "resolveManualRefundTask" },
  { file: "src/lib/manual-refund-task-reopen.ts", exportName: "reopenManualRefundTask" },
  { file: "src/lib/bank-refund-void-follow-up.ts", exportName: "pickRefundForUnmatchedVoid" },
  { file: "src/lib/member-contact-erasure.ts", exportName: "MEMBER_CONTACT_ERASURE_PATCH" },
] as const;

/**
 * Prisma writes attributed to the function that contains the call, then to
 * its callers. A different function in the same file does not mark the file.
 */
export const STEP_UP_PRISMA_WRITES = {
  memberAccessRole: ["create", "createMany", "delete", "deleteMany", "update", "updateMany", "upsert"],
  accessRoleDefinition: ["create", "createMany", "delete", "deleteMany", "update", "updateMany", "upsert"],
  loginSecuritySetting: ["create", "update", "updateMany", "upsert"],
  clubModuleSettings: ["create", "update", "updateMany", "upsert"],
} as const;

/**
 * Persists a refreshed Xero OAuth token. Not an officer credential write.
 * The census does not enter this function.
 */
export const XERO_TOKEN_REFRESH = {
  file: "src/lib/xero-token-store.ts",
  exportName: "saveXeroTokens",
} as const;

/**
 * Member export has no shared destructive helper. It stays listed while the
 * handler still calls `escapeCsvCell` (including through the `csvEscape` alias).
 */
export const MEMBER_EXPORT_ROUTE = {
  file: "src/app/api/admin/members/export/route.ts",
  method: "GET",
  csvFile: "src/lib/csv.ts",
  csvExport: "escapeCsvCell",
} as const;

/** #4618. Absent until that child merges; the census requires POST once the file exists. */
export const FACTOR_RESET_ROUTE = {
  file: "src/app/api/admin/security/two-factor-reset/[memberId]/route.ts",
  method: "POST",
} as const;

export type StepUpRoute = {
  method: StepUpHttpMethod;
  file: string;
};

export const STEP_UP_ROUTES = [
  { method: "POST", file: "src/app/api/admin/backups/restore/route.ts" },
  { method: "POST", file: "src/app/api/admin/backups/config/route.ts" },
  { method: "POST", file: "src/app/api/admin/integrations/credentials/route.ts" },
  { method: "POST", file: "src/app/api/admin/integrations/mirotalk/credentials/route.ts" },
  { method: "DELETE", file: "src/app/api/admin/integrations/mirotalk/credentials/route.ts" },
  { method: "PUT", file: "src/app/api/admin/integrations/mirotalk/route.ts" },
  { method: "POST", file: "src/app/api/admin/alpine-server/settings/route.ts" },
  { method: "POST", file: "src/app/api/admin/xero/disconnect/route.ts" },
  { method: "POST", file: "src/app/api/admin/access-roles/route.ts" },
  { method: "PATCH", file: "src/app/api/admin/access-roles/[id]/route.ts" },
  { method: "DELETE", file: "src/app/api/admin/access-roles/[id]/route.ts" },
  { method: "PUT", file: "src/app/api/admin/members/[id]/route.ts" },
  { method: "POST", file: "src/app/api/admin/members/route.ts" },
  { method: "POST", file: "src/app/api/admin/members/bulk-update/route.ts" },
  { method: "POST", file: "src/app/api/admin/members/import/route.ts" },
  { method: "POST", file: "src/app/api/admin/members/[id]/merge/route.ts" },
  { method: "POST", file: "src/app/api/admin/members/[id]/lifecycle/delete/route.ts" },
  { method: "POST", file: "src/app/api/admin/deletion-requests/[id]/route.ts" },
  { method: "POST", file: "src/app/api/admin/xero/import-member-contact/route.ts" },
  { method: "GET", file: "src/app/api/admin/lodge/route.ts" },
  { method: "POST", file: "src/app/api/admin/lodge/route.ts" },
  { method: "POST", file: "src/app/api/admin/config-transfer/apply/route.ts" },
  { method: "PUT", file: "src/app/api/admin/security/password-policy/route.ts" },
  { method: "PUT", file: "src/app/api/admin/security/magic-link/route.ts" },
  { method: "PUT", file: "src/app/api/admin/modules/route.ts" },
  { method: "PUT", file: "src/app/api/admin/refund-requests/[id]/route.ts" },
  { method: "POST", file: "src/app/api/admin/payments/card-refunds/[id]/try-card-again/route.ts" },
  { method: "POST", file: "src/app/api/admin/payments/card-refunds/[id]/paid-another-way/route.ts" },
  { method: "POST", file: "src/app/api/admin/payments/card-refunds/[id]/paid-twice-resolved/route.ts" },
  { method: "POST", file: "src/app/api/admin/payments/card-refunds/[id]/nothing-left-owed/route.ts" },
  { method: "POST", file: "src/app/api/admin/payments/manual-refund-tasks/[id]/route.ts" },
  { method: "POST", file: "src/app/api/admin/payments/manual-refund-tasks/[id]/reopen/route.ts" },
  { method: "POST", file: "src/app/api/admin/payments/bank-refund-voids/[id]/pick/route.ts" },
  { method: "PATCH", file: "src/app/api/admin/booking-change-requests/[id]/route.ts" },
  { method: "PATCH", file: "src/app/api/admin/booking-exception-requests/[id]/route.ts" },
  { method: "POST", file: "src/app/api/admin/booking-change-requests/[id]/quote/route.ts" },
  { method: "PATCH", file: "src/app/api/admin/bookings/[id]/review/route.ts" },
  { method: "POST", file: "src/app/api/admin/booking-requests/[id]/correct/route.ts" },
  { method: "POST", file: "src/app/api/admin/booking-requests/[id]/decline/route.ts" },
  { method: "POST", file: "src/app/api/admin/booking-requests/[id]/release-hold/route.ts" },
  { method: "POST", file: "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts" },
  { method: "GET", file: "src/app/api/admin/members/export/route.ts" },
] as const satisfies readonly StepUpRoute[];

export function stepUpRouteKey(file: string, method: string): string {
  return `${method} ${file}`;
}

/** `src/app/api/admin/members/[id]/route.ts` → `/api/admin/members/[id]`. */
export function adminRouteApiPath(file: string): string {
  const prefix = "src/app";
  const suffix = "/route.ts";
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) {
    throw new Error(`Not an App Router route file: ${file}`);
  }
  return file.slice(prefix.length, -suffix.length);
}
