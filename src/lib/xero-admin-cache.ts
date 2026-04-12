export interface XeroAccount {
  code: string;
  name: string;
  type: string;
  class: string;
}

export interface XeroItem {
  itemID: string;
  code: string;
  name: string;
  description: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

let cachedAccounts: XeroAccount[] | null = null;
let accountsCacheExpiresAt = 0;

let cachedItems: XeroItem[] | null = null;
let itemsCacheExpiresAt = 0;

export function getCachedChartOfAccounts(): XeroAccount[] | null {
  if (!cachedAccounts || Date.now() >= accountsCacheExpiresAt) {
    return null;
  }

  return cachedAccounts;
}

export function setCachedChartOfAccounts(accounts: XeroAccount[]) {
  cachedAccounts = accounts;
  accountsCacheExpiresAt = Date.now() + CACHE_TTL_MS;
}

export function clearChartOfAccountsCache() {
  cachedAccounts = null;
  accountsCacheExpiresAt = 0;
}

export function getCachedItems(): XeroItem[] | null {
  if (!cachedItems || Date.now() >= itemsCacheExpiresAt) {
    return null;
  }

  return cachedItems;
}

export function setCachedItems(items: XeroItem[]) {
  cachedItems = items;
  itemsCacheExpiresAt = Date.now() + CACHE_TTL_MS;
}

export function clearItemsCache() {
  cachedItems = null;
  itemsCacheExpiresAt = 0;
}
