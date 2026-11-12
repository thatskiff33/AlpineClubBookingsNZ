import { describe, expect, it } from "vitest";

import {
  adminListPage,
  adminQueueCreatedOrder,
  formatAdminListRange,
  parseAdminListPageParam,
} from "@/lib/admin-list-page";

describe("admin list page helpers (INV-OPS-017)", () => {
  it("derives totalPages from the total and page size", () => {
    expect(adminListPage({ page: 1, pageSize: 25, total: 40 })).toEqual({
      page: 1,
      pageSize: 25,
      total: 40,
      totalPages: 2,
    });
    expect(adminListPage({ page: 1, pageSize: 25, total: 25 }).totalPages).toBe(1);
    expect(adminListPage({ page: 1, pageSize: 25, total: 0 }).totalPages).toBe(0);
  });

  it("states the range shown and the total", () => {
    expect(formatAdminListRange({ page: 1, pageSize: 25, total: 40 })).toBe(
      "Showing 1–25 of 40",
    );
    expect(formatAdminListRange({ page: 2, pageSize: 25, total: 40 })).toBe(
      "Showing 26–40 of 40",
    );
    expect(formatAdminListRange({ page: 1, pageSize: 25, total: 3 })).toBe(
      "Showing 1–3 of 3",
    );
    expect(formatAdminListRange({ page: 1, pageSize: 25, total: 0 })).toBe(
      "Showing 0 of 0",
    );
  });

  it("orders pending filters oldest first and the rest newest first", () => {
    expect(adminQueueCreatedOrder(true)).toBe("asc");
    expect(adminQueueCreatedOrder(false)).toBe("desc");
  });

  it("reads a URL page as a positive integer or falls back to 1", () => {
    expect(parseAdminListPageParam("3")).toBe(3);
    expect(parseAdminListPageParam(null)).toBe(1);
    expect(parseAdminListPageParam("0")).toBe(1);
    expect(parseAdminListPageParam("-2")).toBe(1);
    expect(parseAdminListPageParam("2.5")).toBe(1);
    expect(parseAdminListPageParam("abc")).toBe(1);
  });
});
