import { redirect } from "next/navigation";

import { ClubFormatPanel } from "@/components/admin/club-format-panel";
import { guardAdminLayout } from "@/lib/admin-layout-guard";
import { CLUB_FORMAT_REACH, CLUB_FORMAT_SERVER_SETTINGS } from "@/lib/club-format-copy";
import { readXeroBaseCurrencyForViewer } from "@/lib/xero-base-currency-server";

/**
 * Club Currency & Locale — the maintenance surface for the two settings that
 * decide how this club's money and dates are written (stage 1 of programme
 * #3205, #3563). INV-CONFIG-006.
 *
 * EVERY ADMIN MAY OPEN IT; ONLY A FULL ADMIN MAY CHANGE IT (owner decision on
 * #3596). Stage 1 shaped this screen like `/admin/club-time`,
 * `/admin/environment` and `/admin/config-transfer` — a Full Admin test here
 * and an "available to full administrators only" panel for everyone else —
 * and those three still are. This one stopped being their twin on READ access
 * only: an admin investigating why an amount or a date is written the way it
 * is can now see the setting that decides it. The layout admits any admitted
 * admin (`ANY_ADMIN_ADMISSION_PATHS`), so there is no longer a refusal to
 * render here; the panel resolves Full Admin itself and shows everyone else the
 * values read-only under the canonical view-only banner. The enforcement is
 * server-side on both verbs of `/api/admin/club-format` — `"any-admin"` on the
 * read, Full Admin on the write.
 *
 * THE PAGE RE-RUNS THE ADMIN GUARD for the Xero base-currency warning (#3633).
 * The base currency comes from the Xero organisation summary, which only a
 * finance viewer may read (`XERO_ORGANISATION_READ_PERMISSION`), and reading it
 * can cost a live Xero call. A layout's gate does not stop its page rendering,
 * so the page runs `guardAdminLayout()` itself (as `ai-diagnostics/page.tsx`
 * does) and hands the reader the guard's DATABASE-fresh member, never the bare
 * JWT session: a deactivated account, a pending forced password change or an
 * unfinished two-factor sign-in is redirected before Xero is asked anything.
 * `readXeroBaseCurrencyForViewer` then hands everyone outside the finance
 * audience `null`, and the panel shows no warning.
 *
 * THE BLURB SAYS WHAT IS TRUE TODAY. Stage 1 recorded the setting, stage 2
 * (#3564) moved the browser screens onto it, #3565 every amount and #3566 every
 * date, email, the AI spend currency and sorting. What it reaches, and the one
 * thing it does not, is rendered from `@/lib/club-format-copy`, shared with the
 * confirmation panel and the contextual help so the three cannot disagree.
 */
export default async function ClubFormatPage() {
  const guard = await guardAdminLayout();
  if (guard.outcome === "redirect") redirect(guard.destination);
  const xeroBaseCurrency = await readXeroBaseCurrencyForViewer(guard.member);
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
        <p className="text-sm text-muted-foreground">{CLUB_FORMAT_REACH}</p>
        <p className="text-sm text-muted-foreground">
          {CLUB_FORMAT_SERVER_SETTINGS}
        </p>
      </div>
      <ClubFormatPanel xeroBaseCurrency={xeroBaseCurrency} />
    </div>
  );
}
