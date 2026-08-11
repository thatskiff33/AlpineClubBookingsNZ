/**
 * The shared evidence-state vocabulary and diagnostic-case contract (AID-6A, #2375).
 *
 * The two properties these tests exist to protect are the ones the whole product
 * rests on, and both are easy to lose by accident:
 *
 *  1. A DENIAL IS NOT AN ABSENCE. `permission_denied` must never collapse into
 *     "nothing found" or "unavailable", because the correct handling of a denial is
 *     to say which permission is missing and stop — and the incorrect handling is for
 *     the model to fill the gap from somewhere else.
 *  2. AN INFERENCE IS NOT A RULE RESULT. A case that holds only inferred blockers
 *     has to be reportable AS an inference.
 */
import { describe, expect, it } from "vitest";

import type { AdminPermissionArea } from "@/lib/admin-permissions";

import {
  DIAGNOSTICS_TOOL_FAILURE_MESSAGES,
  DIAGNOSTICS_TOOL_SCHEMA_VERSION,
  type DiagnosticsToolAudit,
  type DiagnosticsToolFailureReason,
  type DiagnosticsToolResult,
} from "../../tools/types";
import {
  createDiagnosticCase,
  recordCaseEvidence,
  summariseDiagnosticCase,
  type DiagnosticFinding,
} from "../case";
import {
  DIAGNOSTICS_EVIDENCE_STATES,
  DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS,
  evidenceStateForToolResult,
  isWithheldEvidenceState,
  worstEvidenceState,
} from "../states";

const OBSERVED_AT = "2026-08-03T09:00:00.000Z";

function audit(
  overrides: Partial<DiagnosticsToolAudit> = {},
): DiagnosticsToolAudit {
  return {
    toolId: "diagnostics.system_event_correlation",
    areasChecked: ["support"],
    authOutcome: "allowed",
    failureReason: null,
    argsHash: "hash",
    resultHash: "hash",
    rowCount: 0,
    byteCount: 0,
    durationMs: 1,
    roundIndex: 0,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function success(
  rows: Record<string, string>[],
  truncated = false,
  observedAt = OBSERVED_AT,
): DiagnosticsToolResult {
  return {
    schemaVersion: DIAGNOSTICS_TOOL_SCHEMA_VERSION,
    status: "ok",
    toolId: "diagnostics.system_event_correlation",
    label: "System and security event correlation",
    rows,
    truncated,
    observedAt,
    audit: audit({ rowCount: rows.length, observedAt }),
  };
}

function failure(
  reason: DiagnosticsToolFailureReason,
  options: {
    missingAreas?: AdminPermissionArea[];
    areasChecked?: AdminPermissionArea[];
    observedAt?: string;
    toolId?: string;
  } = {},
): DiagnosticsToolResult {
  const observedAt = options.observedAt ?? OBSERVED_AT;
  const result: DiagnosticsToolResult = {
    schemaVersion: DIAGNOSTICS_TOOL_SCHEMA_VERSION,
    status: "error",
    toolId: options.toolId ?? "diagnostics.finance_event_correlation",
    reason,
    message: DIAGNOSTICS_TOOL_FAILURE_MESSAGES[reason],
    observedAt,
    audit: audit({
      toolId: options.toolId ?? "diagnostics.finance_event_correlation",
      areasChecked: options.areasChecked ?? ["support", "finance"],
      authOutcome: "denied",
      failureReason: reason,
      resultHash: null,
      observedAt,
    }),
  };
  if (options.missingAreas) result.missingAreas = options.missingAreas;
  return result;
}

function finding(
  overrides: Partial<DiagnosticFinding> = {},
): DiagnosticFinding {
  return {
    code: "booking.payment_not_settled",
    statement: "The required payment has not settled.",
    confidence: "authoritative_blocker",
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

describe("evidence states (#2375)", () => {
  it("gives every failure reason a state, and every state a sentence", () => {
    // A total map, so a new failure reason cannot compile until somebody has decided
    // what an operator and the model should be told about it.
    for (const reason of Object.keys(
      DIAGNOSTICS_TOOL_FAILURE_MESSAGES,
    ) as DiagnosticsToolFailureReason[]) {
      const state = evidenceStateForToolResult(failure(reason));
      expect(DIAGNOSTICS_EVIDENCE_STATES, reason).toContain(state);
    }
    for (const state of DIAGNOSTICS_EVIDENCE_STATES) {
      expect(
        DIAGNOSTICS_EVIDENCE_STATE_DESCRIPTIONS[state].length,
        state,
      ).toBeGreaterThan(10);
    }
  });

  it("keeps a DENIAL distinct from an absence and from an outage", () => {
    expect(evidenceStateForToolResult(failure("permission_denied"))).toBe(
      "permission_denied",
    );
    expect(evidenceStateForToolResult(failure("actor_blocked"))).toBe(
      "actor_blocked",
    );
    // Neither of these is a denial, and neither may be reported as one.
    expect(evidenceStateForToolResult(failure("metering_unavailable"))).toBe(
      "temporarily_unavailable",
    );
    expect(evidenceStateForToolResult(failure("evidence_unavailable"))).toBe(
      "evidence_unavailable",
    );
    expect(evidenceStateForToolResult(success([]))).toBe("not_found");
  });

  it("separates `not_configured` from `not_ready`, which are different operator actions", () => {
    expect(evidenceStateForToolResult(failure("database_not_configured"))).toBe(
      "not_configured",
    );
    expect(evidenceStateForToolResult(failure("database_role_unsafe"))).toBe(
      "not_ready",
    );
    expect(evidenceStateForToolResult(failure("database_grants_missing"))).toBe(
      "not_ready",
    );
  });

  it("distinguishes an empty result, a truncated one and a full one", () => {
    // The distinction #2375 requires: "we looked and there is nothing" is a different
    // fact from "here is what we found", and "here is the first part" is a third.
    expect(evidenceStateForToolResult(success([]))).toBe("not_found");
    expect(evidenceStateForToolResult(success([{ a: "1" }]))).toBe("ok");
    expect(evidenceStateForToolResult(success([{ a: "1" }], true))).toBe(
      "result_truncated",
    );
  });

  it("picks the WORSE of two states, and cannot be made to pick the better one", () => {
    // The combining rule the case recorder uses when a caller has rendered a result and
    // the BLOCK asserts something worse than the retrieval did (a listing the block had
    // to clip). Order is the declared best-to-worst order of the vocabulary, and the
    // operation is symmetric, so nothing can be laundered back to `ok` by argument
    // position.
    expect(worstEvidenceState("ok", "result_truncated")).toBe("result_truncated");
    expect(worstEvidenceState("result_truncated", "ok")).toBe("result_truncated");
    expect(worstEvidenceState("permission_denied", "result_truncated")).toBe(
      "permission_denied",
    );
    expect(worstEvidenceState("result_truncated", "permission_denied")).toBe(
      "permission_denied",
    );
    expect(worstEvidenceState("ok", "ok")).toBe("ok");
    for (const state of DIAGNOSTICS_EVIDENCE_STATES) {
      expect(worstEvidenceState("ok", state), state).toBe(state);
      expect(worstEvidenceState(state, "ok"), state).toBe(state);
    }
  });

  it("marks only the withheld states as withheld", () => {
    expect(isWithheldEvidenceState("permission_denied")).toBe(true);
    expect(isWithheldEvidenceState("actor_blocked")).toBe(true);
    for (const state of DIAGNOSTICS_EVIDENCE_STATES) {
      if (state === "permission_denied" || state === "actor_blocked") continue;
      expect(isWithheldEvidenceState(state), state).toBe(false);
    }
  });
});

describe("diagnostic case (#2375)", () => {
  it("records a DENIAL as an outcome, not as a missing source", () => {
    // The whole reason `recordCaseEvidence` is called for failures too. A case that
    // simply contained no finance evidence would read as "there is no finance
    // problem"; this one says the evidence was withheld and which permission unlocks it.
    const diagnosticCase = createDiagnosticCase("booking.cannot_confirm");
    recordCaseEvidence(diagnosticCase, success([{ action: "booking.confirm" }]));
    recordCaseEvidence(
      diagnosticCase,
      failure("permission_denied", { missingAreas: ["finance"] }),
    );

    const summary = summariseDiagnosticCase(diagnosticCase);
    expect(summary.complete).toBe(false);
    expect(summary.hasWithheldEvidence).toBe(true);
    expect(summary.withheldAreas).toEqual(["finance"]);
    expect(summary.states).toEqual(["ok", "permission_denied"]);
    expect(diagnosticCase.sources).toHaveLength(2);
  });

  it("records the state the MODEL WAS SHOWN when the block clipped the rows", () => {
    // The retrieval was complete; the evidence block could not list all of it (its own
    // character cap drops whole rows). Without this, the case says `ok` and
    // `summariseDiagnosticCase` marks it COMPLETE, while the model answered from part of
    // the set — the same class of defect as an empty result reading as an absence.
    const diagnosticCase = createDiagnosticCase("system.what_happened");
    const outcome = recordCaseEvidence(
      diagnosticCase,
      success([{ action: "a" }, { action: "b" }]),
      "result_truncated",
    );
    expect(outcome.state).toBe("result_truncated");
    // The retrieved row count is unchanged — it is a fact about the read, not about the
    // listing — so the case still says how much evidence existed.
    expect(outcome.rowCount).toBe(2);
    expect(summariseDiagnosticCase(diagnosticCase).complete).toBe(false);
  });

  it("will not let a presented state downgrade a denial", () => {
    // The parameter exists to QUALIFY a record further, never to soften one. A caller
    // passing `ok` for a denied read still records the denial.
    const diagnosticCase = createDiagnosticCase("finance.why_unpaid");
    const outcome = recordCaseEvidence(
      diagnosticCase,
      failure("permission_denied", { missingAreas: ["finance"] }),
      "ok",
    );
    expect(outcome.state).toBe("permission_denied");
    const summary = summariseDiagnosticCase(diagnosticCase);
    expect(summary.hasWithheldEvidence).toBe(true);
    expect(summary.withheldAreas).toEqual(["finance"]);
  });

  it("falls back to the tool's declared areas when a denial names none", () => {
    // `missingAreas` is only populated for a per-area denial. For `actor_blocked` there
    // is no authorized actor at all, so the areas the tool DECLARES are the honest
    // answer to "what would this have needed".
    const diagnosticCase = createDiagnosticCase("member.cannot_book");
    recordCaseEvidence(
      diagnosticCase,
      failure("actor_blocked", { areasChecked: ["support", "membership"] }),
    );
    expect(summariseDiagnosticCase(diagnosticCase).withheldAreas).toEqual([
      "membership",
      "support",
    ]);
  });

  it("takes the recorded areas from the audit metadata, not from the caller", () => {
    const diagnosticCase = createDiagnosticCase("payment.stuck");
    const outcome = recordCaseEvidence(
      diagnosticCase,
      failure("permission_denied", {
        areasChecked: ["support", "finance"],
        missingAreas: ["finance"],
      }),
    );
    expect(outcome.areas).toEqual(["support", "finance"]);
    expect(outcome.missingAreas).toEqual(["finance"]);
    expect(outcome.rowCount).toBe(0);
  });

  it("treats `not_found` as a COMPLETE case — nothing was withheld", () => {
    // "We looked and there is no such event" is a finished investigation. Only a
    // withheld or failed source makes a case incomplete.
    const diagnosticCase = createDiagnosticCase("system.incident");
    recordCaseEvidence(diagnosticCase, success([]));
    const summary = summariseDiagnosticCase(diagnosticCase);
    expect(summary.complete).toBe(true);
    expect(summary.hasWithheldEvidence).toBe(false);
  });

  it("treats a TRUNCATED source as incomplete", () => {
    const diagnosticCase = createDiagnosticCase("system.incident");
    recordCaseEvidence(diagnosticCase, success([{ a: "1" }], true));
    expect(summariseDiagnosticCase(diagnosticCase).complete).toBe(false);
  });

  it("tracks the freshness window across every source", () => {
    const diagnosticCase = createDiagnosticCase("booking.cannot_confirm");
    recordCaseEvidence(
      diagnosticCase,
      success([{ a: "1" }], false, "2026-08-03T09:00:00.000Z"),
    );
    recordCaseEvidence(
      diagnosticCase,
      success([{ a: "2" }], false, "2026-08-03T08:00:00.000Z"),
    );
    recordCaseEvidence(
      diagnosticCase,
      failure("query_failed", { observedAt: "2026-08-03T10:00:00.000Z" }),
    );
    // Lexical comparison is chronological for fixed-width ISO instants, which is why
    // no parsing (and no timezone) is involved.
    expect(diagnosticCase.earliestObservedAt).toBe("2026-08-03T08:00:00.000Z");
    expect(diagnosticCase.latestObservedAt).toBe("2026-08-03T10:00:00.000Z");
  });

  it("reports nothing about freshness before any evidence is folded in", () => {
    const diagnosticCase = createDiagnosticCase("booking.cannot_confirm");
    expect(diagnosticCase.earliestObservedAt).toBeNull();
    expect(diagnosticCase.latestObservedAt).toBeNull();
    // An empty case is vacuously complete and has withheld nothing — which is the
    // honest reading, and is why the caller must add sources before summarising.
    expect(summariseDiagnosticCase(diagnosticCase).complete).toBe(true);
  });

  it("separates an AUTHORITATIVE blocker from an inferred one", () => {
    const authoritative = createDiagnosticCase("booking.cannot_confirm");
    authoritative.blockers.push(finding());
    let summary = summariseDiagnosticCase(authoritative);
    expect(summary.hasAuthoritativeBlocker).toBe(true);
    expect(summary.hasInferredBlockerOnly).toBe(false);

    const inferred = createDiagnosticCase("booking.cannot_confirm");
    inferred.blockers.push(finding({ confidence: "inferred" }));
    summary = summariseDiagnosticCase(inferred);
    expect(summary.hasAuthoritativeBlocker).toBe(false);
    // The flag a caller uses to frame the answer as a likely cause rather than a
    // verdict — #2375 forbids presenting an inference as a rule result.
    expect(summary.hasInferredBlockerOnly).toBe(true);
  });

  it("does not claim an inference when a case has no blockers at all", () => {
    const diagnosticCase = createDiagnosticCase("booking.cannot_confirm");
    const summary = summariseDiagnosticCase(diagnosticCase);
    expect(summary.hasInferredBlockerOnly).toBe(false);
    expect(summary.hasAuthoritativeBlocker).toBe(false);
  });

  it("still reports an inference as such when an authoritative blocker exists elsewhere", () => {
    // One authoritative blocker is enough to make the case a verdict; the inferred one
    // beside it stays classified as inferred on the finding itself.
    const diagnosticCase = createDiagnosticCase("booking.cannot_confirm");
    diagnosticCase.blockers.push(finding(), finding({ confidence: "inferred" }));
    const summary = summariseDiagnosticCase(diagnosticCase);
    expect(summary.hasAuthoritativeBlocker).toBe(true);
    expect(summary.hasInferredBlockerOnly).toBe(false);
    expect(
      diagnosticCase.blockers.map((blocker) => blocker.confidence),
    ).toEqual(["authoritative_blocker", "inferred"]);
  });

  it("keeps history apart from current facts", () => {
    // The distinction #2375 requires the agent to preserve: a recorded past event says
    // nothing about the present, and the case shape refuses to blur them by putting
    // them in one list.
    const diagnosticCase = createDiagnosticCase("payment.stuck");
    diagnosticCase.facts.push(
      finding({ code: "payment.unpaid", confidence: "confirmed_current" }),
    );
    diagnosticCase.history.push(
      finding({ code: "payment.attempt_failed", confidence: "historical" }),
    );
    expect(diagnosticCase.facts).toHaveLength(1);
    expect(diagnosticCase.history).toHaveLength(1);
    expect(diagnosticCase.facts[0].confidence).toBe("confirmed_current");
    expect(diagnosticCase.history[0].confidence).toBe("historical");
  });

  it("de-duplicates and sorts the areas that would complete the picture", () => {
    const diagnosticCase = createDiagnosticCase("booking.cannot_confirm");
    recordCaseEvidence(
      diagnosticCase,
      failure("permission_denied", { missingAreas: ["finance"] }),
    );
    recordCaseEvidence(
      diagnosticCase,
      failure("permission_denied", {
        toolId: "diagnostics.membership_event_correlation",
        areasChecked: ["support", "membership"],
        missingAreas: ["membership", "finance"],
      }),
    );
    expect(summariseDiagnosticCase(diagnosticCase).withheldAreas).toEqual([
      "finance",
      "membership",
    ]);
  });
});
