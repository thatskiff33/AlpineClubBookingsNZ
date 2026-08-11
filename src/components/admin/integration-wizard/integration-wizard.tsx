"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AdminViewOnlySectionBanner } from "@/components/admin/view-only-action";
import { useWizardCursor } from "./use-integration-wizard";
import type { IntegrationWizardProps, WizardStepHelpers } from "./types";
import { getWizardStepSkipCopy, isWizardStepOptional } from "./types";

/**
 * Reusable, PROVIDER-AGNOSTIC guided-setup wizard shell (#2080).
 *
 * Everything here is provider-neutral: the shell renders a stepper, gates
 * advance on each step's own `isVerified(context)`, resumes from a persisted
 * cursor, and frames every state with the view-only banner. Xero (this issue),
 * Stripe (C4) and Google (C5) are each just a `context` + `steps` config passed
 * in — there is deliberately no provider name, copy, or import in this file.
 *
 * Gating: a step is "passed" when it verifies (or is optional and
 * acknowledged). The furthest reachable step is the FIRST unpassed step, so the
 * operator can freely revisit completed steps but can never jump a gate — even
 * via a deep link or a stale persisted cursor.
 *
 * Optional steps (C3's skippable webhook step): an unverified optional step may
 * be acknowledged via a shell-rendered "skip" action, which persists its id and
 * lets gating pass it. Verification always supersedes an acknowledgement
 * (verified > acknowledged), re-derived from live truth so a step never shows
 * both the amber "skipped" and green "verified" state at once, and an
 * acknowledged step stays re-enterable.
 */
export function IntegrationWizard<Ctx>({
  wizardId,
  title,
  description,
  steps,
  context,
  contextLoading,
  onRefresh,
  canEdit,
  viewOnlyBanner: viewOnlyBannerText,
  initialStepId,
  completion,
}: IntegrationWizardProps<Ctx>) {
  const cursor = useWizardCursor(wizardId);

  // Derived gating from live server truth (never from a persisted flag).
  const verifiedFlags = useMemo(
    () => steps.map((step) => step.isVerified(context)),
    [steps, context],
  );
  const acknowledgedSet = useMemo(
    () => new Set(cursor.acknowledged),
    [cursor.acknowledged],
  );
  // A step is acknowledged-only when it was skipped but has NOT since verified;
  // verification supersedes the acknowledgement, so a verified step never counts
  // here (its stepper mark stays the green "verified" tick, not amber "skipped").
  const acknowledgedOnlyFlags = useMemo(
    () =>
      steps.map(
        (step, i) =>
          !verifiedFlags[i] &&
          isWizardStepOptional(step) &&
          acknowledgedSet.has(step.id),
      ),
    [steps, verifiedFlags, acknowledgedSet],
  );
  const passedFlags = useMemo(
    () => steps.map((_, i) => verifiedFlags[i] || acknowledgedOnlyFlags[i]),
    [steps, verifiedFlags, acknowledgedOnlyFlags],
  );
  const firstUnpassed = passedFlags.indexOf(false);
  const maxReachable = firstUnpassed === -1 ? steps.length - 1 : firstUnpassed;
  const allPassed = firstUnpassed === -1;

  // The step cursor, tagged with WHO placed it. The tag is what keeps the resume
  // initialisation below safe: that effect can only run after an await (the
  // wizard-progress GET), and React flushes it in a LATER step than the commit
  // that painted a clickable stepper — so an operator can move the cursor before
  // it ever runs. It therefore stands down when the tag says the operator got
  // there first, instead of dragging them back to the resume step and discarding
  // their click (#2781).
  const [step, setStep] = useState<{
    index: number;
    /** "default" until the cursor has been placed deliberately. */
    owner: "default" | "resume" | "operator";
  }>({ index: 0, owner: "default" });
  const index = step.index;
  // True once the cursor has been placed — by the resume initialisation or by
  // the operator themselves — so focus-on-step-change (below) can arm WITHOUT
  // stealing focus on the initial resume render.
  const ready = step.owner !== "default";

  // Initialise the cursor ONCE, after both the persisted cursor and the provider
  // context have loaded, so the resume target is clamped against real gating.
  useEffect(() => {
    if (contextLoading || !cursor.loaded) return;
    const target = initialStepId ?? cursor.persistedStepId;
    // First-run default is the FIRST step, not the furthest reachable one: an
    // informational step 1 verifies trivially, and auto-advancing past it would
    // land a first-time operator on "enter credentials" without ever seeing the
    // portal guide (caught by the #2080 wizard E2E). A fully-passed wizard opens
    // on the last step instead so the completion summary is what greets a
    // returning operator. A persisted cursor or ?step= deep-link still resumes,
    // clamped to the reachable range.
    const fallback = allPassed ? steps.length - 1 : 0;
    const desired =
      target != null ? steps.findIndex((s) => s.id === target) : fallback;
    const start = Math.min(
      Math.max(desired === -1 ? fallback : desired, 0),
      maxReachable,
    );
    // A functional update, deliberately: it sees the very latest tag, including
    // an operator click that landed in this same batch, so a late resume can
    // never overwrite one (#2781). It is also what makes this run-once — every
    // later re-run finds a placed cursor and returns it unchanged.
    setStep((previous) =>
      previous.owner === "default"
        ? { index: start, owner: "resume" }
        : previous,
    );
  }, [
    contextLoading,
    cursor.loaded,
    cursor.persistedStepId,
    initialStepId,
    maxReachable,
    steps,
  ]);

  // If the context regresses (e.g. a credential Replace re-arms verification and
  // shrinks the reachable range), clamp the current step back into range.
  useEffect(() => {
    if (!ready) return;
    setStep((previous) =>
      previous.index > maxReachable
        ? { ...previous, index: maxReachable }
        : previous,
    );
  }, [ready, index, maxReachable]);

  // Focus management (a11y): on a step change, move focus to the new step's
  // container so keyboard and screen-reader users are taken to the fresh content
  // — and so focus is never dropped to <body> when the Continue button unmounts
  // on the last step. The resume render itself does NOT steal focus (the page
  // just loaded); only later navigations do.
  const stepContainerRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    const previous = lastFocusedIndexRef.current;
    lastFocusedIndexRef.current = step.index;
    if (previous === null) {
      // First observation once the cursor is placed. A resume render adopts it
      // silently; a first placement the OPERATOR made still moves focus, because
      // their click can be the first thing this effect ever sees when it beat
      // the resume initialisation (#2781).
      if (step.owner !== "operator") return;
    } else if (previous === step.index) {
      return;
    }
    stepContainerRef.current?.focus();
  }, [step, ready]);

  function goTo(next: number) {
    const clamped = Math.min(Math.max(next, 0), maxReachable);
    // The operator owns the cursor from here on, so a resume initialisation
    // that has not run yet stands down rather than undoing this (#2781).
    //
    // Deliberately unconditional: do NOT skip this when `clamped === index`.
    // Clicking the step you are already on is exactly how an operator says
    // "stay here", and before initialisation that click is the only thing that
    // stops a persisted cursor moving them elsewhere. Bailing out to save the
    // one wasted render would re-open #2781 for that click. (`cursor.persist`
    // already dedupes the POST, so the waste is a render, not a request.)
    setStep({ index: clamped, owner: "operator" });
    cursor.persist(steps[clamped].id, cursor.acknowledged);
  }

  // Skip an optional, unverified step: acknowledge it (persist its id so gating
  // passes it) and advance. A no-op for a required or already-verified step.
  function skipCurrent() {
    const step = steps[index];
    if (!isWizardStepOptional(step) || verifiedFlags[index]) return;
    const nextAcknowledged = acknowledgedSet.has(step.id)
      ? cursor.acknowledged
      : [...cursor.acknowledged, step.id];
    // On the last step there is nowhere to advance to; acknowledging it there
    // flips the wizard into its complete state in place.
    const nextIndex = Math.min(index + 1, steps.length - 1);
    cursor.persist(steps[nextIndex].id, nextAcknowledged);
    setStep({ index: nextIndex, owner: "operator" });
  }

  // Banner frame rendered in EVERY branch (the live-region-position rule,
  // AGENTS.md / #2160): only the card below swaps, the banner stays mounted.
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      {viewOnlyBannerText}
    </AdminViewOnlySectionBanner>
  );

  if (contextLoading || !cursor.loaded) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="flex min-h-[240px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        </div>
      </div>
    );
  }

  const activeStep = steps[index];
  const helpers: WizardStepHelpers = {
    canEdit,
    refresh: onRefresh,
    goNext: () => goTo(index + 1),
    isVerified: verifiedFlags[index],
    optional: isWizardStepOptional(activeStep),
    acknowledged: acknowledgedOnlyFlags[index],
    skip: skipCurrent,
    // The shell's vouch (#2324): `viewOnlyBanner` above is rendered in EVERY
    // branch of this component — the loading early-return included — so a step's
    // gated controls may drop their own per-button reason and lean on it. The
    // literal `true` is the whole channel; there is no runtime condition here to
    // get wrong, and the type in `types.ts` forbids anything else.
    ancestorRendersViewOnlyBanner: true,
  };
  const isLast = index === steps.length - 1;
  const currentPassed = passedFlags[index];
  // A skip action shows only while an optional step is neither verified nor yet
  // acknowledged (an acknowledged step is already passed and stays re-enterable).
  const canSkip =
    helpers.optional && !verifiedFlags[index] && !acknowledgedOnlyFlags[index];
  const skipCopy = getWizardStepSkipCopy(activeStep);
  const completionBadgeLabel = completion?.badgeLabel ?? "Complete";

  return (
    <div>
      {viewOnlyBanner}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{title}</CardTitle>
              {description ? (
                <CardDescription>{description}</CardDescription>
              ) : null}
            </div>
            <Badge variant={allPassed ? "success" : "secondary"}>
              {allPassed
                ? completionBadgeLabel
                : `Step ${index + 1} of ${steps.length}`}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Stepper — a completed/reachable step is a button; an upcoming
              (gated) step is disabled so the gate cannot be jumped. One column
              on mobile; on wider screens the tracks auto-fit to the step count
              so 2-, 3- and 4-step wizards (C4/C5) all lay out correctly. */}
          <ol className="grid grid-cols-1 gap-2 sm:[grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
            {steps.map((step, i) => {
              const reachable = i <= maxReachable;
              const active = i === index;
              const verified = verifiedFlags[i];
              const acknowledgedOnly = acknowledgedOnlyFlags[i];
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => reachable && goTo(i)}
                    disabled={!reachable}
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      active
                        ? "border-primary bg-accent text-foreground"
                        : reachable
                          ? "border-border text-foreground hover:bg-accent"
                          : "cursor-not-allowed border-dashed border-border text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                        verified
                          ? "border-success-7 bg-success text-success-foreground"
                          : acknowledgedOnly
                            ? "border-warning-7 bg-warning text-warning-foreground"
                            : active
                              ? "border-primary text-foreground"
                              : "border-border text-muted-foreground",
                      )}
                    >
                      {verified ? (
                        <Check className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {step.title}
                      </span>
                      {acknowledgedOnly ? (
                        <span className="block truncate text-xs text-warning-11">
                          Skipped for now
                        </span>
                      ) : step.summary ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {step.summary}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          {/* tabIndex={-1} focus target: the shell moves focus here on a step
              change so keyboard/SR users land on the new content and focus is
              never dropped to <body> when Continue unmounts on the last step. */}
          <div
            ref={stepContainerRef}
            tabIndex={-1}
            className="rounded-md border p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {activeStep.render(context, helpers)}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
            >
              Back
            </Button>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {canSkip ? (
                <div className="flex flex-col items-end gap-0.5">
                  <Button type="button" variant="ghost" onClick={skipCurrent}>
                    {skipCopy.skipLabel}
                  </Button>
                  {skipCopy.skipDescription ? (
                    <span className="max-w-xs text-right text-xs text-muted-foreground">
                      {skipCopy.skipDescription}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {isLast ? (
                allPassed ? (
                  <div className="flex flex-col items-end gap-0.5">
                    <Badge variant="success">
                      <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
                      {completion?.message ?? "Setup complete"}
                    </Badge>
                    {completion?.hint ? (
                      <span className="max-w-xs text-right text-xs text-muted-foreground">
                        {completion.hint}
                      </span>
                    ) : null}
                  </div>
                ) : canSkip ? null : (
                  <span className="text-sm text-muted-foreground">
                    Complete this step to finish.
                  </span>
                )
              ) : (
                <Button
                  type="button"
                  onClick={() => goTo(index + 1)}
                  disabled={!currentPassed}
                >
                  Continue
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
