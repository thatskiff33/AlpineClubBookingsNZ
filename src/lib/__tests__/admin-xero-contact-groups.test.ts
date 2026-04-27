import { describe, expect, it, vi } from "vitest";
import {
  loadAdminXeroContactGroups,
  type ContactGroupsFetch,
} from "@/lib/admin-xero-contact-groups";

function mockResponse(input: { ok: boolean; payload: unknown }) {
  return {
    ok: input.ok,
    json: vi.fn().mockResolvedValue(input.payload),
  };
}

describe("loadAdminXeroContactGroups", () => {
  it("uses cached groups when available", async () => {
    const fetchImpl = vi.fn<ContactGroupsFetch>().mockResolvedValue(
      mockResponse({
        ok: true,
        payload: {
          groups: [{ id: "group_1", name: "Adults", contactCount: 12 }],
          refreshed: false,
        },
      })
    );

    const result = await loadAdminXeroContactGroups({
      fallbackToRefreshIfEmpty: true,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/xero/contact-groups");
    expect(result).toEqual({
      groups: [{ id: "group_1", name: "Adults", contactCount: 12 }],
      refreshed: false,
    });
  });

  it("falls back to a live refresh when the cache is empty", async () => {
    const fetchImpl = vi
      .fn<ContactGroupsFetch>()
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          payload: {
            groups: [],
            refreshed: false,
          },
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          payload: {
            groups: [{ id: "group_2", name: "Youth", contactCount: 8 }],
            refreshed: true,
          },
        })
      );

    const result = await loadAdminXeroContactGroups({
      fallbackToRefreshIfEmpty: true,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/admin/xero/contact-groups");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/admin/xero/contact-groups?refresh=1"
    );
    expect(result).toEqual({
      groups: [{ id: "group_2", name: "Youth", contactCount: 8 }],
      refreshed: true,
    });
  });

  it("can force a live refresh directly", async () => {
    const fetchImpl = vi.fn<ContactGroupsFetch>().mockResolvedValue(
      mockResponse({
        ok: true,
        payload: {
          groups: [{ id: "group_3", name: "Children", contactCount: 4 }],
          refreshed: true,
        },
      })
    );

    await loadAdminXeroContactGroups({
      refreshFromXero: true,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/admin/xero/contact-groups?refresh=1"
    );
  });

  it("surfaces route error messages", async () => {
    const fetchImpl = vi.fn<ContactGroupsFetch>().mockResolvedValue(
      mockResponse({
        ok: false,
        payload: {
          error: "Xero rate limit hit. Please wait a moment and try again.",
        },
      })
    );

    await expect(
      loadAdminXeroContactGroups({
        fetchImpl,
      })
    ).rejects.toThrow("Xero rate limit hit. Please wait a moment and try again.");
  });
});
