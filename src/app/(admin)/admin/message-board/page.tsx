import { notFound } from "next/navigation";

import { ClubPostsAdmin } from "@/components/admin/club-posts/club-posts-admin";
import {
  listClubPostsForAdmin,
  parseAdminPostTab,
} from "@/lib/club-posts-admin";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { auth } from "@/lib/auth";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";

export const metadata = {
  title: "Message board",
};

/**
 * Admin -> Membership -> Message board (#2998, epic #2992).
 *
 * The list is queried here, in the server component, with the tab and search in
 * the URL, so switching either is an ordinary navigation and a filtered queue
 * can be linked to.
 */
export default async function AdminMessageBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.commsPortal) {
    notFound();
  }

  // The (admin) layout has already established that this is an admin session.
  // This checks the AREA: `view` to open the screen, while every write route
  // separately requires `edit` — so a view-only admin reads the board and is
  // refused by the API as well as by the disabled controls.
  const session = await auth();
  const canView =
    session?.user &&
    hasAdminAreaAccess(session.user, { area: "membership", level: "view" });
  if (!canView) {
    notFound();
  }

  const params = await searchParams;
  const tab = parseAdminPostTab(params.tab);
  const q = params.q?.trim() || undefined;

  const posts = await listClubPostsForAdmin({ tab, q });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Message board</h1>
        <p className="text-muted-foreground">
          What members have written to the club. Hiding is reversible; removing
          deletes the text permanently.
        </p>
      </div>
      <ClubPostsAdmin posts={posts} tab={tab} query={q ?? ""} />
    </div>
  );
}
