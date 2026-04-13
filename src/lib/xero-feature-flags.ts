function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isXeroDailyMembershipRefreshEnabled(): boolean {
  return isEnabled(process.env.XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH);
}

export function isXeroLiveMemberGroupLookupsEnabled(): boolean {
  return isEnabled(process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS);
}

export function isXeroAutoloadContactGroupsEnabled(): boolean {
  return isEnabled(process.env.XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS);
}

export function getXeroFeatureFlags() {
  return {
    dailyMembershipRefresh: isXeroDailyMembershipRefreshEnabled(),
    liveMemberGroupLookups: isXeroLiveMemberGroupLookupsEnabled(),
    autoLoadContactGroups: isXeroAutoloadContactGroupsEnabled(),
  };
}
