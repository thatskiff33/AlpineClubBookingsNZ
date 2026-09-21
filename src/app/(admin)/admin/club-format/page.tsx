"use client";

import { useSession } from "next-auth/react";

import { ClubFormatPanel } from "@/components/admin/club-format-panel";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * Club Currency & Locale — the Full-Admin maintenance surface for the two
 * settings that decide how this club's money and dates are written (stage 1 of
 * programme #3205, #3563). INV-CONFIG-006.
 *
 * THE WHOLE SCREEN IS FULL ADMIN, which is why it is shaped like
 * `/admin/club-time`, `/admin/environment` and `/admin/config-transfer` rather
 * than like an ordinary settings section. There is no view tier and no edit
 * tier to distinguish, so there is nothing for `AdminViewOnlySectionBanner` to
 * explain; a support-area admin who reaches the page (the route is registered
 * under `support` so it resolves to a concrete permission area instead of the
 * `overview` catch-all) is told plainly that this one is Full Admin only. The
 * real enforcement is server-side — `requireAdmin({ permission: false })` on
 * both verbs of `/api/admin/club-format` — and this check exists so the screen
 * does not offer an action it knows will be refused.
 *
 * THE BLURB SAYS WHAT IS TRUE TODAY, WHICH IS LESS THAN IT WILL SAY. Stage 1
 * records the currency and locale; no production code path reads them yet, so
 * the amounts and dates the site shows still come from the deployment's
 * `CURRENCY` and `LOCALE`. Owner decision D1 on #3205 accepted that in exchange
 * for no throwaway plumbing. Saying otherwise here would have an operator
 * change this setting expecting the screens to follow, and then find they had
 * not — so the panel says so in as many words. The disclaimer goes when the
 * readers arrive (#3564 to #3566): the change that makes the claim true is the
 * change that gets to make it.
 */
export default function ClubFormatPage() {
  const { data: session } = useSession();
  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  if (session && !fullAdmin) {
    return (
      <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
        The club&apos;s currency and locale are available to full administrators
        only.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Club Currency &amp; Locale</h1>
        <p className="text-sm text-muted-foreground">
          The currency this club charges in, and the way it writes numbers and
          dates. Both are properties of the CLUB, not of the server it runs on
          and not of whoever is looking: a member reading the site from another
          country should see the club&apos;s currency, not their own.
        </p>
        <p className="text-sm text-muted-foreground">
          These were server settings (<code>CURRENCY</code> and{" "}
          <code>LOCALE</code>) until now. They were copied here once, and from
          now on this page is the only thing that decides them — changing them
          on the server will do nothing.
        </p>
      </div>
      <ClubFormatPanel />
    </div>
  );
}
