import { ClubFormatPanel } from "@/components/admin/club-format-panel";

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
 * render here, and the page needs no session of its own; the panel resolves
 * Full Admin itself and shows everyone else the values read-only under the
 * canonical view-only banner. The enforcement is server-side on both verbs of
 * `/api/admin/club-format` — `"any-admin"` on the read, Full Admin on the write.
 *
 * THE BLURB SAYS WHAT IS TRUE TODAY, WHICH IS STILL LESS THAN IT WILL SAY.
 * Stage 1 recorded the setting and no screen read it. Stage 2 (#3564) moved the
 * ten `"use client"` screens onto it — the currency label beside a fee or a
 * spend cap, the audit and health stamps, the promo counts, the lobby
 * display's date — so the setting now visibly does something.
 *
 * WHAT IT STILL DOES NOT DO, and the blurb has to keep saying so: every
 * AMOUNT is written by `formatCents` and the finance formatters, and every
 * date by the club-time kernel, all of which build their `Intl` objects at
 * module load from `CURRENCY` and `LOCALE`. Those are #3565; the remaining
 * server-side readers are #3566. So an operator who removes the server
 * variables today gets a page showing `CHF` beside amounts written in New
 * Zealand dollars, which is worse than either answer alone — and is exactly
 * why "keep them in step" is still the instruction. Each disclaimer goes with
 * the stage that makes its claim true; this one shrank rather than vanished.
 */
export default function ClubFormatPage() {
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
          <code>LOCALE</code>) until now. They were copied here once, and this
          page is the only thing that changes them from now on — editing them on
          the server no longer changes <em>this setting</em>.
        </p>
        <p className="text-sm text-muted-foreground">
          <strong>Leave the server settings in place, and in step.</strong> The
          admin screens now show the currency you choose here, and the lobby
          display writes its date your way. What is still written from the
          server&rsquo;s <code>CURRENCY</code> and <code>LOCALE</code> is every{" "}
          <em>amount</em> — every price, invoice figure and statement line —
          and every date the rest of the site prints. Those move across in the
          changes that follow. If the two disagree, you will see your chosen
          code beside amounts written the old way, so keep them the same until
          this note goes.
        </p>
      </div>
      <ClubFormatPanel />
    </div>
  );
}
