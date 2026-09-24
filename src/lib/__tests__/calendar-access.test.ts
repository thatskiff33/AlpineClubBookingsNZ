import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  committeeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    committeeAssignment: { findFirst: mocks.committeeFindFirst },
  },
}));

import {
  canManageCalendarEvents,
  canEditCalendarEvents,
} from "@/lib/calendar-access";

const lodgeEditMatrix = {
  overview: "none",
  bookings: "none",
  membership: "none",
  finance: "none",
  lodge: "edit",
  content: "none",
  support: "none",
} as const;

const noAccessMatrix = { ...lodgeEditMatrix, lodge: "none" } as const;

describe("canManageCalendarEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("grants a lodge-edit admin without touching the committee table", async () => {
    const result = await canManageCalendarEvents({
      canLogin: true,
      id: "member-1",
      adminPermissionMatrix: lodgeEditMatrix,
    });
    expect(result).toBe(true);
    expect(mocks.committeeFindFirst).not.toHaveBeenCalled();
  });

  it("grants a non-admin who holds an active committee assignment", async () => {
    mocks.committeeFindFirst.mockResolvedValue({ id: "assign-1" });
    const result = await canManageCalendarEvents({
      canLogin: true,
      id: "member-2",
      adminPermissionMatrix: noAccessMatrix,
    });
    expect(result).toBe(true);
    expect(mocks.committeeFindFirst).toHaveBeenCalledOnce();
  });

  it("denies a plain member with no committee assignment", async () => {
    mocks.committeeFindFirst.mockResolvedValue(null);
    const result = await canManageCalendarEvents({
      canLogin: true,
      id: "member-3",
      adminPermissionMatrix: noAccessMatrix,
    });
    expect(result).toBe(false);
  });
});

describe("canEditCalendarEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("grants a lodge-edit admin", () => {
    // canEditCalendarEvents reads only the admin matrix (AdminPermissionInput);
    // it takes no member id because it never consults the committee table.
    expect(
      canEditCalendarEvents({ canLogin: true, adminPermissionMatrix: lodgeEditMatrix }),
    ).toBe(true);
  });

  it("DENIES an active committee member (create-only, never edit/delete)", () => {
    // Even if this member holds an active committee assignment, edit/delete is
    // admin-only — the gate must not consult the committee table at all.
    mocks.committeeFindFirst.mockResolvedValue({ id: "assign-1" });
    expect(
      canEditCalendarEvents({ canLogin: true, adminPermissionMatrix: noAccessMatrix }),
    ).toBe(false);
    expect(mocks.committeeFindFirst).not.toHaveBeenCalled();
  });

  it("denies a plain member with no committee assignment", () => {
    expect(
      canEditCalendarEvents({ canLogin: true, adminPermissionMatrix: noAccessMatrix }),
    ).toBe(false);
  });
});
