import { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

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

export interface XeroAdminCacheMetadata {
  source: "memory" | "database" | "xero";
  lastRefreshedAt: string;
  expiresAt: string;
}

interface XeroAdminCacheEntry<T> {
  tenantId: string;
  values: T[];
  fetchedAt: number;
  expiresAt: number;
}

interface XeroAdminCacheRecord<T> {
  values: T[];
  metadata: XeroAdminCacheMetadata;
}

interface XeroAdminCacheStore {
  findUnique?: (args: {
    where: {
      cacheKey_tenantId: {
        cacheKey: string;
        tenantId: string;
      };
    };
  }) => Promise<{
    payload: unknown;
    fetchedAt: Date;
    expiresAt: Date;
  } | null>;
  upsert?: (args: {
    where: {
      cacheKey_tenantId: {
        cacheKey: string;
        tenantId: string;
      };
    };
    create: {
      cacheKey: string;
      tenantId: string;
      payload: Prisma.InputJsonValue;
      fetchedAt: Date;
      expiresAt: Date;
    };
    update: {
      payload: Prisma.InputJsonValue;
      fetchedAt: Date;
      expiresAt: Date;
    };
  }) => Promise<unknown>;
}

interface XeroTokenStore {
  findFirst?: (args: {
    select: {
      tenantId: true;
    };
  }) => Promise<{
    tenantId: string | null;
  } | null>;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CHART_OF_ACCOUNTS_CACHE_KEY = "chart-of-accounts";
const ITEMS_CACHE_KEY = "items";

let cachedAccounts: XeroAdminCacheEntry<XeroAccount> | null = null;
let cachedItems: XeroAdminCacheEntry<XeroItem> | null = null;

function getAdminCacheStore(): XeroAdminCacheStore | null {
  const cacheStore = (prisma as unknown as { xeroAdminCache?: XeroAdminCacheStore }).xeroAdminCache;
  return cacheStore ?? null;
}

function getXeroTokenStore(): XeroTokenStore | null {
  const tokenStore = (prisma as unknown as { xeroToken?: XeroTokenStore }).xeroToken;
  return tokenStore ?? null;
}

async function getActiveTenantId(): Promise<string | null> {
  const tokenStore = getXeroTokenStore();
  if (!tokenStore?.findFirst) {
    return null;
  }

  try {
    const record = await tokenStore.findFirst({
      select: {
        tenantId: true,
      },
    });

    return record?.tenantId ?? null;
  } catch (error) {
    logger.warn({ err: error }, "Failed to read active Xero tenant for admin cache");
    return null;
  }
}

function readFreshMemoryEntry<T>(
  entry: XeroAdminCacheEntry<T> | null,
  tenantId: string
): XeroAdminCacheRecord<T> | null {
  if (!entry || entry.tenantId !== tenantId || Date.now() >= entry.expiresAt) {
    return null;
  }

  return {
    values: entry.values,
    metadata: {
      source: "memory",
      lastRefreshedAt: new Date(entry.fetchedAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    },
  };
}

function writeMemoryEntry<T>(
  assign: (entry: XeroAdminCacheEntry<T> | null) => void,
  tenantId: string,
  values: T[],
  fetchedAtMs = Date.now()
): XeroAdminCacheMetadata {
  const expiresAtMs = fetchedAtMs + CACHE_TTL_MS;
  assign({
    tenantId,
    values,
    fetchedAt: fetchedAtMs,
    expiresAt: expiresAtMs,
  });

  return {
    source: "xero",
    lastRefreshedAt: new Date(fetchedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function setChartOfAccountsMemory(entry: XeroAdminCacheEntry<XeroAccount> | null) {
  cachedAccounts = entry;
}

function setItemsMemory(entry: XeroAdminCacheEntry<XeroItem> | null) {
  cachedItems = entry;
}

function isXeroAccountArray(payload: unknown): payload is XeroAccount[] {
  return Array.isArray(payload) && payload.every((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    const value = entry as Record<string, unknown>;
    return typeof value.code === "string"
      && typeof value.name === "string"
      && typeof value.type === "string"
      && typeof value.class === "string";
  });
}

function isXeroItemArray(payload: unknown): payload is XeroItem[] {
  return Array.isArray(payload) && payload.every((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    const value = entry as Record<string, unknown>;
    return typeof value.itemID === "string"
      && typeof value.code === "string"
      && typeof value.name === "string"
      && typeof value.description === "string";
  });
}

async function getPersistedCacheRecord<T>(
  cacheKey: string,
  tenantId: string,
  parsePayload: (payload: unknown) => payload is T[],
  writeMemory: (entry: XeroAdminCacheEntry<T> | null) => void
): Promise<XeroAdminCacheRecord<T> | null> {
  const cacheStore = getAdminCacheStore();
  if (!cacheStore?.findUnique) {
    return null;
  }

  try {
    const record = await cacheStore.findUnique({
      where: {
        cacheKey_tenantId: {
          cacheKey,
          tenantId,
        },
      },
    });

    if (!record || record.expiresAt.getTime() <= Date.now() || !parsePayload(record.payload)) {
      return null;
    }

    writeMemory({
      tenantId,
      values: record.payload,
      fetchedAt: record.fetchedAt.getTime(),
      expiresAt: record.expiresAt.getTime(),
    });

    return {
      values: record.payload,
      metadata: {
        source: "database",
        lastRefreshedAt: record.fetchedAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
      },
    };
  } catch (error) {
    logger.warn({ err: error, cacheKey, tenantId }, "Failed to read persisted Xero admin cache");
    return null;
  }
}

async function persistCacheRecord<T>(
  cacheKey: string,
  tenantId: string,
  values: T[],
  fetchedAtMs: number
): Promise<void> {
  const cacheStore = getAdminCacheStore();
  if (!cacheStore?.upsert) {
    return;
  }

  const fetchedAt = new Date(fetchedAtMs);
  const expiresAt = new Date(fetchedAtMs + CACHE_TTL_MS);
  const payload = values as Prisma.InputJsonValue;

  try {
    await cacheStore.upsert({
      where: {
        cacheKey_tenantId: {
          cacheKey,
          tenantId,
        },
      },
      create: {
        cacheKey,
        tenantId,
        payload,
        fetchedAt,
        expiresAt,
      },
      update: {
        payload,
        fetchedAt,
        expiresAt,
      },
    });
  } catch (error) {
    logger.warn({ err: error, cacheKey, tenantId }, "Failed to persist Xero admin cache");
  }
}

async function getCachedReferenceData<T>(
  cacheKey: string,
  entry: XeroAdminCacheEntry<T> | null,
  parsePayload: (payload: unknown) => payload is T[],
  writeMemory: (entry: XeroAdminCacheEntry<T> | null) => void
): Promise<XeroAdminCacheRecord<T> | null> {
  const tenantId = await getActiveTenantId();
  if (!tenantId) {
    return null;
  }

  const memoryEntry = readFreshMemoryEntry(entry, tenantId);
  if (memoryEntry) {
    return memoryEntry;
  }

  return getPersistedCacheRecord(cacheKey, tenantId, parsePayload, writeMemory);
}

async function setCachedReferenceData<T>(
  cacheKey: string,
  tenantId: string,
  values: T[],
  writeMemory: (entry: XeroAdminCacheEntry<T> | null) => void
): Promise<XeroAdminCacheMetadata> {
  const fetchedAtMs = Date.now();
  const metadata = writeMemoryEntry(writeMemory, tenantId, values, fetchedAtMs);
  await persistCacheRecord(cacheKey, tenantId, values, fetchedAtMs);
  return metadata;
}

export async function getCachedChartOfAccounts(): Promise<XeroAdminCacheRecord<XeroAccount> | null> {
  return getCachedReferenceData(
    CHART_OF_ACCOUNTS_CACHE_KEY,
    cachedAccounts,
    isXeroAccountArray,
    setChartOfAccountsMemory
  );
}

export async function setCachedChartOfAccounts(
  tenantId: string,
  accounts: XeroAccount[]
): Promise<XeroAdminCacheMetadata> {
  return setCachedReferenceData(
    CHART_OF_ACCOUNTS_CACHE_KEY,
    tenantId,
    accounts,
    setChartOfAccountsMemory
  );
}

export function clearChartOfAccountsCache() {
  cachedAccounts = null;
}

export async function getCachedItems(): Promise<XeroAdminCacheRecord<XeroItem> | null> {
  return getCachedReferenceData(
    ITEMS_CACHE_KEY,
    cachedItems,
    isXeroItemArray,
    setItemsMemory
  );
}

export async function setCachedItems(
  tenantId: string,
  items: XeroItem[]
): Promise<XeroAdminCacheMetadata> {
  return setCachedReferenceData(
    ITEMS_CACHE_KEY,
    tenantId,
    items,
    setItemsMemory
  );
}

export function clearItemsCache() {
  cachedItems = null;
}
