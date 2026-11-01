import { BackLink } from "@/components/admin/back-link";
import { LodgeCentralLodgeCard } from "../_components/lodge-central-lodge-card";

// Which lodge in the Alpine Central Server's registry this is (#62), as a
// Configure sub-page of the lodge hub — the shape the roster and lobby display
// settings take next door. Not gated on Other lodges sharing: an administrator
// can link the lodge before turning sharing on, and the card says whether it
// is on yet.
export default async function LodgeCentralLodgePage({
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
      <LodgeCentralLodgeCard lodgeId={id} />
    </div>
  );
}
