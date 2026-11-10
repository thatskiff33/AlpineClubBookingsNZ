"use client";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { HutFeesSection } from "./hut-fees-section";
import { FinanceFeesSections } from "./finance-fees-sections";

// Client shell for the consolidated fee console (#1933, E7). The three sections
// render in order — Hut Fees, then Joining Fees + Annual Membership Fees (both
// finance) — each self-gating on the server-computed edit flag for its area.
export function FeesPageClient({
  hutFeesCanEdit,
  financeCanEdit,
}: {
  hutFeesCanEdit: boolean;
  financeCanEdit: boolean;
}) {
  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Fees"
        description="Hut nightly fees, joining fees, and annual membership fees in one place. Hut fees are edited by bookings admins; joining and annual fees by finance admins — you may be able to edit one group and only view the other."
      />
      <HutFeesSection canEdit={hutFeesCanEdit} />
      <FinanceFeesSections financeCanEdit={financeCanEdit} />
    </div>
  );
}
