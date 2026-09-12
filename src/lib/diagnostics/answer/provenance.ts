/**
 * AI Diagnostics — the ONE-LINE PROVENANCE SUMMARY (AID-7, #2378; owner decision D10,
 * 12 Aug 2026).
 *
 * D10 settled the shape: "a one-line summary per answer, expandable to the full detail
 * (tool used, observed-at, unreadable areas, stale page context, capped results)", and
 * one binding rule about what may be hidden:
 *
 *   "The honesty markers are never dropped from the collapsed line. 'Something could
 *    not be read' or 'this was stale' belongs in the one-line summary, not only behind
 *    the expander — the expander is for detail, not for the existence of a caveat."
 *
 * SO THE CAVEAT IS BUILT HERE, ON THE SERVER, AND TRAVELS AS TEXT. The alternative —
 * shipping the source list and letting the component compose a sentence — puts the one
 * rule D10 actually laid down inside a React component, where the next person to
 * restyle the line can drop it without touching anything that looks like a decision.
 * It is also the same argument `states.ts` makes for its own operator sentences: the
 * words the operator reads and the words the model was shown come from one place.
 *
 * WHAT THE LINE MAY NEVER SAY. No record ids, no personal fields, no tool arguments,
 * no row contents. It names WHERE evidence came from and WHAT was missing from it —
 * `DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS` and the registry's own tool labels are the
 * only text sources, and both are server-owned.
 */

import "server-only";

import type { DiagnosticCaseSummary } from "../case/case";
import type { DiagnosticsEvidenceState } from "../case/states";
import { diagnosticsToolRequiresProviderCheck } from "../tools/registry";
import type { DiagnosticsAskProvenance, DiagnosticsAskSource } from "./contract";
import { must } from "@/lib/indexed-access";

/**
 * States that mean the evidence a source returned is INCOMPLETE rather than absent or
 * withheld — the "capped results" half of D10's list.
 */
function isPartialState(state: DiagnosticsEvidenceState): boolean {
  return state === "result_truncated";
}

/**
 * States that mean the evidence is older than this question.
 *
 * `stale` is the only one, and `states.ts` is explicit that nothing in the tool
 * substrate raises it — every tool read is executed at invocation time and stamped
 * with its own instant, so a retrieval is never itself stale. Its producer is "the
 * CASE layer (AID-7, #2378), which re-shows evidence gathered earlier in a
 * conversation". This loop does NOT re-show earlier evidence: each question gathers
 * its own, and prior turns travel as text with no evidence attached. So the marker is
 * wired and correct, and today it does not fire.
 *
 * IT IS KEPT ANYWAY, and that is a deliberate choice rather than dead code. D10 names
 * staleness as one of the two markers that must never leave the collapsed line, and
 * the case layer may legitimately start folding `stale` in — a follow-up that re-shows
 * a prior turn's evidence would produce it on day one. A marker added later, by
 * someone reading a component, is a marker that arrives without the collapsed-line
 * rule attached to it.
 */
function isStaleState(state: DiagnosticsEvidenceState): boolean {
  return state === "stale";
}

/**
 * Sources worth naming in the collapsed line: the ones that actually produced rows.
 *
 * `provider_check_required` belongs here (#2815): its own contract opens "stored
 * evidence WAS retrieved" — the state qualifies the evidence's liveness, never its
 * retrieval. Leaving it out made a stored-finance answer open with "No live data
 * could be read", which is wrong twice: data was read, and the actual caveat (it is
 * what the platform last recorded, not the provider's live answer) went unsaid.
 */
function readSources(sources: readonly DiagnosticsAskSource[]): DiagnosticsAskSource[] {
  return sources.filter(
    (source) =>
      source.state === "ok" ||
      source.state === "result_truncated" ||
      source.state === "provider_check_required",
  );
}

/**
 * Human-readable "how long ago", from whole minutes.
 *
 * DELIBERATELY COARSE. The exact instant is in the expander, where it belongs; the
 * collapsed line answers "is this fresh enough to act on", and a to-the-second
 * timestamp reads as precision the answer does not have — the evidence was read at
 * that instant and may have moved since, which is the whole reason the instant is
 * shown at all.
 */
function agoPhrase(observedAt: string, now: Date): string {
  const read = Date.parse(observedAt);
  if (!Number.isFinite(read)) return "just now";
  const seconds = Math.max(0, Math.round((now.getTime() - read) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
}

export interface BuildDiagnosticsProvenanceInput {
  sources: readonly DiagnosticsAskSource[];
  summary: DiagnosticCaseSummary;
  roundsUsed: number;
  /** Injected so the phrasing is deterministic under test. */
  now?: Date;
}

/**
 * Build the collapsed line and its markers.
 *
 * THE ORDER OF THE SENTENCE IS THE DECISION. What was read comes first, because that
 * is what the operator asked for; the caveat comes second and is never omitted when it
 * applies. An answer with no evidence at all says so outright rather than presenting
 * itself as unsourced prose — "based only on the deployed code" is a materially
 * different answer from "read from live booking data", and the operator is deciding
 * whether to trust it.
 */
export function buildDiagnosticsProvenance(
  input: BuildDiagnosticsProvenanceInput,
): DiagnosticsAskProvenance {
  const now = input.now ?? new Date();
  const sources = [...input.sources];
  const read = readSources(sources);

  const hasPermissionWithheld = input.summary.withheldAreas.length > 0;
  const hasConsentWithheld = input.summary.hasConsentWithheld;
  const hasSearchWithheld = input.summary.hasSearchWithheld;
  const hasPartialEvidence = sources.some((source) => isPartialState(source.state));
  const hasStaleEvidence = sources.some((source) => isStaleState(source.state));
  // KEYED ON THE TOOL, NOT ONLY THE FOLDED STATE (#2815, both review lenses). A
  // source carries ONE state, and a truncated or empty read from a stored-provider
  // tool rightly keeps `result_truncated`/`not_found` — but the collapsed line is a
  // LIST of caveats, and losing the console caveat there is losing it exactly where
  // it matters most: the packs' own scope lines are emphatic that "nothing matching
  // means nothing was RECORDED — not that the provider never sent one".
  const hasProviderCheckRequired = sources.some(
    (source) =>
      source.state === "provider_check_required" ||
      diagnosticsToolRequiresProviderCheck(source.toolId),
  );
  // Anything withheld at all — including a locked-out actor, which
  // `summariseDiagnosticCase` counts in `hasWithheldEvidence` but in none of the three
  // specific flags, so testing only those three would drop it from the line.
  const hasCaveat =
    input.summary.hasWithheldEvidence ||
    hasPartialEvidence ||
    hasStaleEvidence ||
    hasProviderCheckRequired ||
    sources.some(
      (source) =>
        source.state !== "ok" &&
        source.state !== "not_found" &&
        source.state !== "result_truncated",
    );

  const parts: string[] = [];

  if (read.length === 0) {
    parts.push(
      sources.length === 0
        ? "No live data was read — this answer is based on the deployed code and the page you are on"
        : "No live data could be read for this answer",
    );
  } else {
    // `read.length === 0` was handled in the branch above, so element 0 exists.
    const latest = read.reduce(
      (newest, source) => (source.observedAt > newest ? source.observedAt : newest),
      must(read[0], "provenance: read is non-empty but has no element 0").observedAt,
    );
    const labels = [...new Set(read.map((source) => source.label))];
    // At most two names, then a count. A narrow column is D10's whole premise, and a
    // line that lists six tool labels is the metadata-taller-than-the-answer failure
    // the decision rejected.
    const named =
      labels.length <= 2
        ? labels.join(" and ")
        : `${labels[0]}, ${labels[1]} and ${labels.length - 2} more`;
    parts.push(`Read from ${named}, ${agoPhrase(latest, now)}`);
  }

  // THE CAVEATS. Each names its own remedy's subject, because the three have three
  // different fixes and `states.ts` is emphatic that merging them misdirects the
  // operator: an area is asked for, a record is selected, a tick is ticked.
  const caveats: string[] = [];
  if (hasPermissionWithheld) {
    caveats.push(
      `some evidence could not be read with your admin access (${input.summary.withheldAreas.join(", ")})`,
    );
  }
  if (hasConsentWithheld) {
    caveats.push("some evidence was not read because this question did not include it");
  }
  if (hasSearchWithheld) {
    caveats.push("a search was not allowed on this question");
  }
  if (hasPartialEvidence) {
    caveats.push("part of a longer result was left out");
  }
  if (hasStaleEvidence) {
    caveats.push("some of it was read earlier and may have changed");
  }
  if (hasProviderCheckRequired) {
    // #2815, and D10's rule applies in full: this is an honesty marker, so it lives
    // in the COLLAPSED line. The remedy is specific — the provider's own console —
    // because that is the one thing an operator can actually do about stored state.
    // Worded to be true of a FOUND value and of an ABSENCE alike: an empty webhook
    // or refund read means nothing was recorded, never that the provider agrees.
    caveats.push(
      "provider state here is what the platform last recorded, not a live answer — confirm against Stripe or Xero's own console before acting on it",
    );
  }
  // A withheld source that is none of the above — a locked-out actor, an unconfigured
  // deployment, a tool that failed. Named generically rather than left silent: D10's
  // rule is about the EXISTENCE of a caveat reaching the collapsed line.
  if (caveats.length === 0 && hasCaveat) {
    caveats.push("some evidence could not be gathered");
  }

  const line =
    caveats.length > 0
      ? `${parts.join("")} — ${caveats.join("; ")}.`
      : `${parts.join("")}.`;

  return {
    line,
    hasCaveat,
    hasPermissionWithheld,
    hasConsentWithheld,
    hasSearchWithheld,
    hasPartialEvidence,
    hasStaleEvidence,
    hasProviderCheckRequired,
    withheldAreas: [...input.summary.withheldAreas],
    sources,
    roundsUsed: input.roundsUsed,
  };
}
