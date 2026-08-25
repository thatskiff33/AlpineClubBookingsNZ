"use client";

import { useSession } from "next-auth/react";

import { EnvironmentSafetyPanel } from "@/components/admin/environment-safety-panel";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * Environment Safety — the Full-Admin surface for "is this installation the
 * club's live site, or a copy?" (ENV-SAFETY 1, #3034; epic #2986).
 *
 * THE WHOLE SCREEN IS FULL ADMIN, which is why it is shaped like
 * `/admin/club-time` and `/admin/config-transfer` rather than like an ordinary
 * settings section. There is no view tier and no edit tier to distinguish, so
 * there is nothing for `AdminViewOnlySectionBanner` to explain; a support-area
 * admin who reaches the page (the route is registered under `support` so it
 * resolves to a concrete permission area instead of the `overview` catch-all) is
 * told plainly that this one is Full Admin only. The real enforcement is
 * server-side — `requireAdmin({ permission: false })` on both verbs of
 * `/api/admin/environment-safety` — and this check exists so the screen does not
 * offer an action it knows will be refused.
 *
 * THE BLURB SAYS WHAT IS TRUE TODAY, and since #3035 and #3036 that is the whole
 * of it: a confirmed copy sends no member email (INV-CONFIG-004) and no Xero
 * contact it touches keeps an address that can reach anybody (INV-CONFIG-005).
 * #3034 shipped a second paragraph saying the acting parts had not landed yet,
 * precisely so nobody restored a copy of the live database, read this page and
 * believed it was already safe; the change that made the claim true is the change
 * that removed it.
 *
 * WHAT IT STILL DOES NOT SAY, because it would not be true: that a copy leaves
 * the club's Xero alone. It does not. It goes on writing invoices, credit notes
 * and contacts — on purpose, so settlement behaviour stays testable — and if it
 * is connected to the club's real Xero organisation it rewrites the email
 * addresses on real contacts. The panel below reports how many, which is the part
 * an operator has to be able to see.
 */
export default function EnvironmentSafetyPage() {
  const { data: session } = useSession();
  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  if (session && !fullAdmin) {
    return (
      <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
        The environment setting is available to full administrators only.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Environment Safety</h1>
        <p className="text-sm text-muted-foreground">
          Whether this installation is the club&apos;s live site or a copy of it.
          It matters because a copy restored from the live database holds real
          members and their real email addresses, so anything that reaches the
          outside world has to know which one it is running on. This site never
          guesses: the deployment says so explicitly, and where nothing says, the
          answer is &ldquo;not configured&rdquo; rather than either one.
        </p>
        <p className="text-sm text-muted-foreground">
          A copy sends no email to members, and it replaces the email address on
          every Xero contact it touches with one that cannot be delivered, so
          Xero cannot email a member from a copy either. A copy still writes
          invoices and credit notes — deliberately, so settlement behaviour stays
          testable — which means that if it is connected to the club&apos;s real
          Xero organisation, those replaced addresses are real accounting records
          being edited. Point a copy at a test Xero organisation wherever you
          can. While nothing has declared which installation this is, nothing is
          written to Xero at all — no invoice, credit note, contact, payment or
          credit allocation — though reading from Xero still works, so these
          screens keep loading.
        </p>
      </div>
      <EnvironmentSafetyPanel />
    </div>
  );
}
