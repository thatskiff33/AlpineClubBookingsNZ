import { LodgeInstructionsPanel } from "@/components/admin/lodge-instructions-panel";
import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";
import { pluralHutLeaderLabel } from "@/config/hut-leader-label";

export default function LodgeInstructionsAdminPage() {
  const hutLeadersLower = pluralHutLeaderLabel(CLUB_HUT_LEADER_LABEL).toLowerCase();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Lodge Instructions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Maintain the opening, closing, and day-to-day instructions{" "}
          {hutLeadersLower} rely on. These documents are protected content: they
          are only visible to admins and assigned {hutLeadersLower}, never on the
          public website.
        </p>
      </div>

      <LodgeInstructionsPanel />
    </div>
  );
}
