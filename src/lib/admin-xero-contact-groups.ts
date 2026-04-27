export interface AdminXeroContactGroup {
  id: string;
  name: string;
  contactCount: number;
}

interface ContactGroupsResponsePayload {
  groups?: AdminXeroContactGroup[];
  error?: string;
  refreshed?: boolean;
}

type ContactGroupsFetchResponse = {
  ok: boolean;
  json(): Promise<ContactGroupsResponsePayload | null>;
};

export type ContactGroupsFetch = (
  input: string,
  init?: RequestInit
) => Promise<ContactGroupsFetchResponse>;

export interface LoadAdminXeroContactGroupsResult {
  groups: AdminXeroContactGroup[];
  refreshed: boolean;
}

interface LoadAdminXeroContactGroupsOptions {
  refreshFromXero?: boolean;
  fallbackToRefreshIfEmpty?: boolean;
  fetchImpl?: ContactGroupsFetch;
}

async function requestContactGroups(
  fetchImpl: ContactGroupsFetch,
  refreshFromXero: boolean
): Promise<LoadAdminXeroContactGroupsResult> {
  const suffix = refreshFromXero ? "?refresh=1" : "";
  const response = await fetchImpl(`/api/admin/xero/contact-groups${suffix}`);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to load Xero contact groups");
  }

  return {
    groups: Array.isArray(payload?.groups) ? payload.groups : [],
    refreshed: payload?.refreshed === true,
  };
}

export async function loadAdminXeroContactGroups(
  options: LoadAdminXeroContactGroupsOptions = {}
): Promise<LoadAdminXeroContactGroupsResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as ContactGroupsFetch);
  const refreshFromXero = options.refreshFromXero === true;
  const initial = await requestContactGroups(fetchImpl, refreshFromXero);

  if (
    !refreshFromXero &&
    options.fallbackToRefreshIfEmpty &&
    initial.groups.length === 0
  ) {
    return requestContactGroups(fetchImpl, true);
  }

  return initial;
}
