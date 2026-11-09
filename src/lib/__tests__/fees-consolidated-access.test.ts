import { describe, expect, it } from "vitest";
import {
  canAccessConsolidatedFeesPage,
  emptyAdminPermissionMatrix,
  getAdminRouteRequirement,
  isConsolidatedFeesPath,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { feesSectionEditAccess } from "@/app/(admin)/admin/rules/fees/_components/fees-access";

// The consolidated /admin/fees console (#1933, E7): admission on bookings OR
// finance view, but each section keeps its historical edit area. These tests pin
// both directions so a bookings-only editor and a finance-only editor each reach
// the page and get exactly one editable group.
function matrix(over: Partial<AdminPermissionMatrix>): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...over };
}

describe("consolidated /admin/fees access (#1933, E7)", () => {
  it("resolves the page prefix to a concrete (bookings) area for the drift guard", () => {
    expect(getAdminRouteRequirement("/admin/fees", "GET")?.area).toBe("bookings");
  });

  it("recognises the fees path and its subpaths", () => {
    expect(isConsolidatedFeesPath("/admin/fees")).toBe(true);
    expect(isConsolidatedFeesPath("/admin/fees/")).toBe(true);
    expect(isConsolidatedFeesPath("/admin/fees?lodgeId=abc")).toBe(true);
    expect(isConsolidatedFeesPath("/admin/fee-configuration")).toBe(false);
    expect(isConsolidatedFeesPath("/admin/seasons")).toBe(false);
  });

  it("admits a viewer on bookings OR finance, denies neither", () => {
    expect(canAccessConsolidatedFeesPage(matrix({ bookings: "view" }))).toBe(true);
    expect(canAccessConsolidatedFeesPage(matrix({ finance: "view" }))).toBe(true);
    expect(canAccessConsolidatedFeesPage(matrix({ bookings: "edit" }))).toBe(true);
    expect(canAccessConsolidatedFeesPage(matrix({ finance: "edit" }))).toBe(true);
    expect(canAccessConsolidatedFeesPage(matrix({ membership: "edit" }))).toBe(false);
    expect(canAccessConsolidatedFeesPage(emptyAdminPermissionMatrix())).toBe(false);
  });

  it("gives a bookings-only editor Hut Fees edit but Joining/Annual read-only", () => {
    const access = feesSectionEditAccess(matrix({ bookings: "edit" }));
    expect(access).toEqual({ hutFeesCanEdit: true, financeCanEdit: false });
  });

  it("gives a finance-only editor Joining/Annual edit but Hut Fees read-only", () => {
    const access = feesSectionEditAccess(matrix({ finance: "edit" }));
    expect(access).toEqual({ hutFeesCanEdit: false, financeCanEdit: true });
  });

  it("treats view-only in either area as no edit in that section", () => {
    expect(feesSectionEditAccess(matrix({ bookings: "view", finance: "view" }))).toEqual({
      hutFeesCanEdit: false,
      financeCanEdit: false,
    });
  });
});
