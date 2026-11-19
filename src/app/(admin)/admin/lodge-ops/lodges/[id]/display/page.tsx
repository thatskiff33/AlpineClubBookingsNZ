import { BackLink } from "@/components/admin/back-link";
import { LodgeDisplaySettingsCard } from "../_components/lodge-display-settings-card";
import { adminHref } from "@/lib/admin-hubs";

// Per-lodge lobby-display settings as a Configure sub-page (#110), matching the
// Rooms & Beds / Lockers pattern rather than sitting inline on the lodge hub.
// The card (LodgeDisplaySettingsCard) is unchanged — it fetches + saves against
// the admin display lodge-config API for this lodge.
export default async function LodgeDisplaySettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="space-y-4">
      <BackLink
        href={adminHref("lodge-detail", { id })}
        label="Lodge configuration"
      />
      <LodgeDisplaySettingsCard lodgeId={id} />
    </div>
  );
}
