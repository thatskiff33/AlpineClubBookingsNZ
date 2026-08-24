"use client";

import { useSession } from "next-auth/react";

import { ClubTimeZonePanel } from "@/components/admin/club-time-zone-panel";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * Club Time Zone — the Full-Admin maintenance surface for the club's time zone
 * (CT-1, #2989; epic #2988).
 *
 * THE WHOLE SCREEN IS FULL ADMIN, which is why it is shaped like
 * `/admin/config-transfer` rather than like an ordinary settings section. There
 * is no view tier and no edit tier to distinguish, so there is nothing for
 * `AdminViewOnlySectionBanner` to explain; a support-area admin who reaches the
 * page (the route is registered under `support` so it resolves to a concrete
 * permission area rather than the `overview` catch-all) is told plainly that this
 * one is Full Admin only. The real enforcement is server-side —
 * `requireAdmin({ permission: false })` on both verbs of
 * `/api/admin/club-time-zone` — and this check exists so the screen does not
 * offer an action it knows will be refused.
 *
 * THE BLURB SAYS WHAT IS TRUE TODAY, which is less than it first said (#2989
 * review). CT-1 records the zone; no production code path reads it yet, so the
 * times the site shows and the club-local schedules still come from the
 * deployment's `TZ`. Saying otherwise here would have an operator change this
 * setting expecting displayed times to follow, and then find they had not. The
 * second paragraph goes when the reader of the setting arrives — the change that
 * makes the claim true is the change that gets to make it.
 */
export default function ClubTimePage() {
  const { data: session } = useSession();
  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  if (session && !fullAdmin) {
    return (
      <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
        The club time zone is available to full administrators only.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Club Time Zone</h1>
        <p className="text-sm text-muted-foreground">
          The one time zone this club runs on. It is a property of the CLUB, not
          of the server or of whoever is looking: a member reading the site from
          another country should see club time, not their own.
        </p>
        <p className="text-sm text-muted-foreground">
          It is recorded here, and the site moves onto it as the rest of the
          club-time work lands. Until then the times the site shows — booking
          confirmations, rosters, reminders, cut-offs — and when club-local
          scheduled jobs fire still follow the TZ setting this deployment starts
          with, so keep the two the same.
        </p>
      </div>
      <ClubTimeZonePanel />
    </div>
  );
}
