import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

// Per-section edit access for the consolidated /admin/fees console (#1933, E7).
// Admission to the page is OR (bookings OR finance view — see
// canAccessConsolidatedFeesPage), but each section keeps its historical edit
// area: Hut Fees → bookings:edit; Joining/Annual/Family → finance:edit. Pure
// and dependency-free so it can be unit-tested and computed server-side.
export type FeesSectionEditAccess = {
  hutFeesCanEdit: boolean;
  financeCanEdit: boolean;
};

export function feesSectionEditAccess(
  matrix: AdminPermissionMatrix,
): FeesSectionEditAccess {
  return {
    hutFeesCanEdit: matrix.bookings === "edit",
    financeCanEdit: matrix.finance === "edit",
  };
}
