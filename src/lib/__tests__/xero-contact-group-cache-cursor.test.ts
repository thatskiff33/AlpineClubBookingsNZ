import { beforeEach, describe, expect, it, vi } from "vitest";

const { getXeroSyncCursor } = vi.hoisted(() => ({
  getXeroSyncCursor: vi.fn(),
}));

vi.mock("@/lib/xero-sync-cursors", async () => {
  const actual = (await vi.importActual("@/lib/xero-sync-cursors")) as typeof import("@/lib/xero-sync-cursors");
  return { ...actual, getXeroSyncCursor };
});

import { getXeroContactGroupCacheLastRefreshedAt } from "@/lib/xero-contact-groups";
import { DEFAULT_XERO_SYNC_SCOPE } from "@/lib/xero-sync-cursors";
import {
  CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
  CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
} from "@/lib/xero-contact-cache";

describe("getXeroContactGroupCacheLastRefreshedAt", () => {
  beforeEach(() => {
    getXeroSyncCursor.mockReset();
  });

  it("reads the dedicated full-refresh cursor with the default scope", async () => {
    getXeroSyncCursor.mockResolvedValue({
      lastSuccessfulSyncAt: new Date("2026-07-05T09:30:00.000Z"),
    });

    const result = await getXeroContactGroupCacheLastRefreshedAt();

    expect(getXeroSyncCursor).toHaveBeenCalledWith(
      CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE,
      DEFAULT_XERO_SYNC_SCOPE
    );
    expect(result).toBe("2026-07-05T09:30:00.000Z");
  });

  it("ignores per-contact CONTACT_GROUP_CACHE writes so single-contact syncs cannot mask staleness", async () => {
    // Simulate the two cursors diverging: a per-contact reconciliation just
    // bumped CONTACT_GROUP_CACHE to "now", while the last full refresh is days
    // old. The hint must report the (older) full-refresh time.
    const fullRefreshAt = new Date("2026-07-01T00:00:00.000Z");
    const perContactBumpAt = new Date("2026-07-06T23:59:00.000Z");
    getXeroSyncCursor.mockImplementation(async (resource: string) => {
      if (resource === CONTACT_GROUP_FULL_REFRESH_CURSOR_RESOURCE) {
        return { lastSuccessfulSyncAt: fullRefreshAt };
      }
      if (resource === CONTACT_GROUP_CACHE_CURSOR_RESOURCE) {
        return { lastSuccessfulSyncAt: perContactBumpAt };
      }
      return null;
    });

    const result = await getXeroContactGroupCacheLastRefreshedAt();

    expect(result).toBe(fullRefreshAt.toISOString());
    expect(getXeroSyncCursor).not.toHaveBeenCalledWith(
      CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
      DEFAULT_XERO_SYNC_SCOPE
    );
  });

  it("returns null when no full refresh has ever run", async () => {
    getXeroSyncCursor.mockResolvedValue(null);

    expect(await getXeroContactGroupCacheLastRefreshedAt()).toBeNull();
  });

  it("returns null when the cursor exists but has no successful sync timestamp", async () => {
    getXeroSyncCursor.mockResolvedValue({ lastSuccessfulSyncAt: null });

    expect(await getXeroContactGroupCacheLastRefreshedAt()).toBeNull();
  });
});
