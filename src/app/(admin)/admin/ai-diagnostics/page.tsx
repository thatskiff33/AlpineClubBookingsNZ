/**
 * AI Diagnostics — the full page (AID-7, #2378).
 *
 * IT LIVES INSIDE THE ADMIN PANEL, under Monitoring & Support, and inherits the
 * ordinary admin layout, sidebar and chrome. An earlier revision gave it a separate
 * `(diagnostics)` route group with its own workspace layout; the owner corrected that
 * on 12 Aug 2026 (superseding decision Q4 on #2378): Diagnostics belongs in the Help
 * chat bubble for an admin with the right permission, and a full page — where one is
 * needed — belongs in the admin panel like every other admin screen rather than as a
 * separate destination.
 *
 * WHY THAT IS BETTER HERE AND NOT MERELY DIFFERENT. Every question this product
 * answers is about something the operator was already looking at in the admin panel:
 * why this booking cannot be confirmed, why this member is blocked, why this payment
 * is pending. Taking them out of the panel to ask about it, and giving them a screen
 * with no sidebar to get back from, made the tool feel like a place to go instead of
 * a thing to ask.
 *
 * SECURITY IS UNCHANGED BY THE MOVE, and that is worth stating because it is the
 * whole reason the preamble was extracted first. The page is admitted by the same
 * `guardAdminLayout` sequence as every other admin page — session, a member row
 * re-read fresh, active, forced password change, two-factor gate, area permission —
 * and now inherits it from `(admin)/layout.tsx` rather than from a second layout that
 * had to be kept in step.
 *
 * WHAT IS HERE AND WHAT IS NOT. This page owns SETUP AND STATUS — readiness and the
 * monthly budget. It owns no ask box, and that is owner decision D8 rather than an
 * omission: all asking happens in the Help bubble, on whichever admin screen the
 * operator is looking at, so the consent ticks, the evidence display and the
 * transcript hardening are built and reviewed in one place instead of two that drift.
 * The "Asking a question" section below says where to go, in prose, because an empty
 * input that does nothing reads as a fault.
 *
 * THE MODULE FLAG IS TRI-STATE HERE, AND MUST BE READ AS ONE (#2803), which takes
 * BOTH halves: the markup distinguishing `null` from `false`, and the flag arriving
 * through the STRICT reader (`readDiagnosticsModuleFlag`), whose read failure is
 * `null`. The first cut had only the markup half — it read the flag through the
 * lenient route-gating loader, whose read failure is `false`, so every `null` branch
 * below was dead and an unreadable settings row still rendered as "Off" (the #2803
 * misreport, one layer above the fix).
 *
 * With the strict reader, `false` is still NEARLY unreachable here — the
 * `aiDiagnostics` feature-route rule 404s the page when the module is off — but the
 * proxy's read and this one are separate reads a moment apart, so a flip race can
 * show it. `null` means the club's module settings could not be READ, and a
 * `!moduleEnabled` test or a two-armed ternary collapses that into "Off", which is
 * a statement about the club's settings when the truth is a statement about this
 * request. Both branches below say which one they mean.
 *
 * READINESS IS TIERED ON THE SERVER (owner decision Q6). `readinessForAdmin` narrows
 * the full verdict for an administrator without `support:view`, and the detailed
 * shape never reaches this component for them — it is not hidden in the markup, it
 * is not sent. See `diagnostics-readiness-tiers.ts` for why that distinction is the
 * whole point.
 */

import { redirect } from "next/navigation";

import { guardAdminLayout } from "@/lib/admin-layout-guard";
import {
  getDiagnosticsReadiness,
  readDiagnosticsModuleFlag,
} from "@/lib/ai-diagnostics-config";
import { readinessForAdmin } from "@/lib/diagnostics-readiness-tiers";

import { AiSpendCurrencyCard } from "@/components/admin/ai-spend-currency-card";

import { DiagnosticsBudgetCard } from "./_components/diagnostics-budget-card";

export const metadata = { title: "AI Diagnostics" };

export default async function DiagnosticsPage() {
  // The layout has already run this and redirected if it refused. Running it again
  // here is deliberate and cheap: a page must never depend on a parent layout having
  // gated it, because layouts and pages are separately reachable in Next's rendering
  // model and a future refactor that moves this page changes which layout wraps it.
  const guard = await guardAdminLayout();
  if (guard.outcome === "redirect") redirect(guard.destination);

  // THE STRICT TRI-STATE READER, not `loadEffectiveModuleFlags()`. The lenient
  // loader treats any read failure as "modules off" — a deliberate fail-closed for
  // route gating, and exactly the wrong answer on an EVIDENCE surface: it would
  // render "Module: Off" for a settings row that could not be read, which is the
  // #2803 misreport this page's own markup exists to avoid. The correctness review
  // (13 Aug 2026) found the first cut using the lenient loader, which made every
  // `null` branch on this page and in the budget card dead code.
  const moduleFlag = await readDiagnosticsModuleFlag();
  const readiness = readinessForAdmin(
    await getDiagnosticsReadiness({ aiDiagnostics: moduleFlag }),
    guard.permissionMatrix,
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">AI Diagnostics</h1>
        <p className="text-sm text-muted-foreground">
          Ask why a booking, member, payment or job is in the state it is in. It
          reads the system and explains; it never changes anything.
        </p>
      </header>

      <section
        aria-labelledby="diagnostics-readiness-heading"
        className="rounded-lg border border-border bg-card p-4"
      >
        <h2
          id="diagnostics-readiness-heading"
          className="text-base font-semibold"
        >
          Status
        </h2>

        {readiness.tier === "coarse" ? (
          <div className="mt-2 flex flex-col gap-2 text-sm">
            <p className="font-medium">
              {readiness.ready ? "Ready to use" : "Not ready yet"}
            </p>
            {/* The honest substitute for a blocker list: what this reader can
                actually do about it. */}
            <p className="text-muted-foreground">{readiness.whoCanResolve}</p>
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2 text-sm">
            <p className="font-medium">
              {readiness.ready ? "Ready to use" : "Not ready yet"}
            </p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Module</dt>
                {/* Tri-state (#2803), never a boolean read. `Off` is a fact about
                    the club's settings; `Could not be read` is a fact about this
                    request, and a ternary that prints "Off" for `null` states the
                    first when only the second is true. */}
                <dd>
                  {readiness.moduleEnabled === null
                    ? "Could not be read"
                    : readiness.moduleEnabled
                      ? "On"
                      : "Off"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Credential</dt>
                <dd>{readiness.keyState}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Database role</dt>
                <dd>{readiness.databaseState}</dd>
              </div>
            </dl>
            {readiness.blockers.length > 0 && (
              <div>
                <h3 className="mt-2 text-sm font-medium">
                  What is still needed
                </h3>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {readiness.blockers.map((blocker) => (
                    <li key={String(blocker)}>{String(blocker)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* THE MODULE STATE COULD NOT BE READ (#2803). `null` is not "off".

            An earlier revision tested `!readiness.moduleEnabled` and offered "Open
            Feature modules" — telling an administrator to go and switch on a module
            that may well already be on, while the actual fault (the club's module
            settings could not be read) went unmentioned. It is exactly the failure
            #2803 was filed for, and the readiness contract states the rule in as
            many words: a consumer must render `null` as "unknown", never as "off".
            Testing `=== null` is what makes the branch mean what it says — `false`
            (reachable only in a flip race, since the feature-route rule 404s this
            page when the module is off) renders as the plain "Off" row above, a
            true statement about the club's settings rather than this notice's
            statement about a failed read. */}
        {readiness.moduleEnabled === null && (
          <p className="mt-3 text-sm text-muted-foreground">
            Whether the module is switched on could not be established — this is not
            the same as it being off, so switching it on will not help. The blocker
            list above names it, and it usually means the club settings could not be
            read. Try again shortly.
          </p>
        )}
      </section>

      <section
        aria-labelledby="diagnostics-budget-heading"
        className="rounded-lg border border-border p-4"
      >
        <h2 id="diagnostics-budget-heading" className="text-base font-semibold">
          Monthly budget
        </h2>
        {/* THE BUDGET LIVES HERE RATHER THAN IN THE READINESS BLOCK (owner decision
            3). Readiness detail is tiered behind `support:view` because a blocker
            list and a database role are operational internals; the budget is a
            control with its own permission story — readable and editable under the
            existing configuration-write boundary, and inert while the module is off.
            Folding it into the detailed tier made it look like an internal too. */}
        <div className="mt-3">
          <DiagnosticsBudgetCard moduleEnabled={readiness.moduleEnabled} />
        </div>
      </section>

      <section
        aria-labelledby="diagnostics-spend-currency-heading"
        className="rounded-lg border border-border p-4"
      >
        <h2
          id="diagnostics-spend-currency-heading"
          className="text-base font-semibold"
        >
          Currency for AI spend
        </h2>
        {/* ONE setting shared with the page-help assistant (#3354): the rate that
            turns New Zealand dollar AI prices into the club's currency before they
            count against EITHER module's cap. The same component renders on both
            settings pages so there is one place to state one fact; it is not
            module-gated because it belongs to two modules and spends nothing. */}
        <div className="mt-3">
          <AiSpendCurrencyCard />
        </div>
      </section>

      <section
        aria-labelledby="diagnostics-ask-heading"
        className="rounded-lg border border-dashed border-border p-4"
      >
        <h2 id="diagnostics-ask-heading" className="text-base font-semibold">
          Asking a question
        </h2>
        {/* THE ASKING HAPPENS IN THE HELP BUBBLE, NOT HERE (owner decision 12 Aug
            2026). This page owns setup and status; the bubble owns the
            conversation, so the consent tick, the evidence display and the
            transcript hardening are built and reviewed in ONE place rather than
            two that drift. Said plainly rather than shown as an inert input: an
            empty box that does nothing reads as a fault. */}
        <p className="mt-2 text-sm text-muted-foreground">
          You ask Diagnostics from the <strong>Help</strong> button, on whichever
          admin screen you are looking at — so you can ask about the booking,
          member or payment already in front of you.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          On the bookings, booking requests, waitlist and payments lists, the
          stethoscope beside a row starts a question about that booking or
          payment. Every answer shows where its evidence came from and when it
          was read.
        </p>
      </section>
    </div>
  );
}
