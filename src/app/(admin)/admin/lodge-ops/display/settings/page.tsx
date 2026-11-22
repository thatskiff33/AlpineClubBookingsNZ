import { redirect } from "next/navigation";
import { adminHref } from "@/lib/admin-hubs";

// LTV-035 (hoppers99/AlpineClubBookingsNZ#81): the per-lodge display settings (config glob, name granularity,
// committee notice) relocated into the lodge configuration hub
// (/admin/lodges/[id]) so they edit the lodge being viewed rather than always
// the club default lodge (old backlog hoppers99/AlpineClubBookingsNZ#64). This path now permanently redirects
// to the Display Devices page (/admin/display/devices, moved off /admin/display
// by fork issue hoppers99/AlpineClubBookingsNZ#109 when that path became the Lobby Display hub) so old
// bookmarks / links keep working; a pointer on that page directs admins to the
// new per-lodge home. Devices is the closest surviving Lobby Display surface.
export default function AdminDisplaySettingsRedirect() {
  redirect(adminHref("display-devices"));
}
