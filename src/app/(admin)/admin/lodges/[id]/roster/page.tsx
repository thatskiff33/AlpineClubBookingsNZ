import { BackLink } from "@/components/admin/back-link";
import { LodgeRosterSettingsCard } from "../_components/lodge-roster-settings-card";

// Member roster settings for one lodge (#2942), as a Configure sub-page of the
// lodge hub — the same shape the lobby display settings take next door, and the
// shape the Rooms & Beds and Lockers areas take, rather than a fourth card
// stacked inline on the hub.
//
// The page is NOT gated on the `memberLodgeRoster` module. An administrator has
// to be able to choose how much of a name the roster shows before they switch
// the roster on; a page that only appeared afterwards would mean publishing the
// default in the meantime. The card says whether the roster is on yet.
export default async function LodgeRosterSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="space-y-4">
      <BackLink
        href={`/admin/lodges/${encodeURIComponent(id)}`}
        label="Lodge configuration"
      />
      <LodgeRosterSettingsCard lodgeId={id} />
    </div>
  );
}
