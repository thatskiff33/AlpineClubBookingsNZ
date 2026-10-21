function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isXeroDailyMembershipRefreshEnabled(): boolean {
  return isEnabled(process.env.XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH);
}

export function isXeroLiveMemberGroupLookupsEnabled(): boolean {
  return isEnabled(process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS);
}

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): the operator switch
 * that lets the nightly undo of voided bank-transfer refund notes WRITE.
 * Unset or anything but "true" is report-only: the job classifies every voided
 * note and logs what it would do, and moves nothing. The owner runs the count
 * script (`pnpm run xero:bank-refund-void-count`) first, then sets it.
 */
export function isXeroBankRefundVoidWritesEnabled(): boolean {
  return isEnabled(process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES);
}

function isXeroAutoloadContactGroupsEnabled(): boolean {
  return isEnabled(process.env.XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS);
}

export function getXeroFeatureFlags() {
  return {
    dailyMembershipRefresh: isXeroDailyMembershipRefreshEnabled(),
    liveMemberGroupLookups: isXeroLiveMemberGroupLookupsEnabled(),
    autoLoadContactGroups: isXeroAutoloadContactGroupsEnabled(),
  };
}
