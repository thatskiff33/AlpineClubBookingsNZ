// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

// The hook derives its answer from the next-auth client session; drive both the
// resolution `status` and the merged permission matrix per test (#2065).
let sessionData: unknown = null;
let sessionStatus: "loading" | "authenticated" | "unauthenticated" = "loading";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: sessionData, status: sessionStatus }),
}));

import {
  useAdminAreaEditAccess,
  useAdminAreaViewAccess,
  useCanOpenAdminPath,
} from "../use-admin-area-edit-access";

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  return {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "view",
    lodge: "view",
    content: "view",
    support: "view",
    ...overrides,
  };
}

function setSession(
  status: typeof sessionStatus,
  matrixValue?: AdminPermissionMatrix,
) {
  sessionStatus = status;
  sessionData = matrixValue
    ? { user: { id: "u1", adminPermissionMatrix: matrixValue } }
    : null;
}

afterEach(() => {
  sessionData = null;
  sessionStatus = "loading";
});

describe("useAdminAreaEditAccess tri-state (#2065)", () => {
  it("returns undefined while the client session is still resolving", () => {
    setSession("loading");
    const { result } = renderHook(() => useAdminAreaEditAccess("content"));
    expect(result.current).toBeUndefined();
  });

  it("returns true once resolved for an edit-capable admin", () => {
    setSession("authenticated", matrix({ content: "edit" }));
    const { result } = renderHook(() => useAdminAreaEditAccess("content"));
    expect(result.current).toBe(true);
  });

  it("returns false once resolved for a view-only admin", () => {
    setSession("authenticated", matrix({ content: "view" }));
    const { result } = renderHook(() => useAdminAreaEditAccess("content"));
    expect(result.current).toBe(false);
  });

  it("returns false once resolved with no signed-in user", () => {
    setSession("unauthenticated");
    const { result } = renderHook(() => useAdminAreaEditAccess("content"));
    expect(result.current).toBe(false);
  });

  it("gates on the requested area's edit level, not another area", () => {
    setSession("authenticated", matrix({ content: "edit", lodge: "view" }));
    expect(
      renderHook(() => useAdminAreaEditAccess("lodge")).result.current,
    ).toBe(false);
    expect(
      renderHook(() => useAdminAreaEditAccess("content")).result.current,
    ).toBe(true);
  });
});

describe("useAdminAreaViewAccess tri-state (#2065)", () => {
  it("returns undefined while the session is resolving", () => {
    setSession("loading");
    const { result } = renderHook(() => useAdminAreaViewAccess("finance"));
    expect(result.current).toBeUndefined();
  });

  it("returns true for an admin who can view the area", () => {
    setSession("authenticated", matrix({ finance: "view" }));
    const { result } = renderHook(() => useAdminAreaViewAccess("finance"));
    expect(result.current).toBe(true);
  });

  it("returns false once resolved with no signed-in user", () => {
    setSession("unauthenticated");
    const { result } = renderHook(() => useAdminAreaViewAccess("finance"));
    expect(result.current).toBe(false);
  });
});

describe("useCanOpenAdminPath (#4581)", () => {
  it("is undefined while the session resolves, then follows the route map's area", () => {
    setSession("loading");
    expect(renderHook(() => useCanOpenAdminPath("/admin/lockers")).result.current).toBeUndefined();

    setSession("authenticated", matrix({ membership: "none" }));
    expect(renderHook(() => useCanOpenAdminPath("/admin/lockers")).result.current).toBe(false);

    setSession("authenticated", matrix({ membership: "view", lodge: "none" }));
    expect(renderHook(() => useCanOpenAdminPath("/admin/lockers")).result.current).toBe(true);
  });
});
