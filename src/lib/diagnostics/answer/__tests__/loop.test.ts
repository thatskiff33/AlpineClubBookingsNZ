/**
 * THE ANSWER LOOP'S CONTRACT (AID-7, #2378).
 *
 * The loop holds no permission logic — every gate is in `invoke.ts` — so what is
 * tested here is the SEQUENCING it is responsible for, and each case below is a way
 * the sequence could be wrong without anything throwing:
 *
 *  - a reservation released by nothing pins worst-case budget until the TTL sweep;
 *  - `operator_action` passed as the channel would hand the model the operator's own
 *    authority and disable the gate the people-search tick rests on;
 *  - a tool list built once would keep offering round 0's answer after the ledger
 *    widened;
 *  - a refusal treated as a stop would lose the evidence that stops the model
 *    inventing an answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runRound: vi.fn(),
  invoke: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  listDefinitions: vi.fn(),
}));

vi.mock("../provider", async () => {
  const actual = (await vi.importActual("../provider")) as typeof import("../provider");
  return { ...actual, runDiagnosticsProviderRound: mocks.runRound };
});
vi.mock("../../tools/invoke", () => ({ invokeDiagnosticsTool: mocks.invoke }));
vi.mock("../../tools/definitions", () => ({
  listDiagnosticsToolDefinitions: mocks.listDefinitions,
}));
vi.mock("@/lib/ai-diagnostics-usage", async () => {
  const actual = (await vi.importActual("@/lib/ai-diagnostics-usage")) as typeof import("@/lib/ai-diagnostics-usage");
  return {
    ...actual,
    reserveDiagnosticsBudget: mocks.reserve,
    settleDiagnosticsRoundtrip: mocks.settle,
  };
});
vi.mock("@/lib/observability-bridge", () => ({ reportAiError: vi.fn() }));

import { runDiagnosticsAnswer } from "../loop";
import { createDiagnosticsConsentLedger } from "../../tools/consent";
import { createDiagnosticsToolSession } from "../../tools/session";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

const MATRIX = {} as AdminPermissionMatrix;
const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

function answerRound(text: string) {
  return {
    ok: true as const,
    text,
    toolUses: [],
    truncated: false,
    wantsTools: false,
    usage: USAGE,
    assistantContent: [{ type: "text" as const, text }],
  };
}

function toolRound(name: string, id = "tu_1") {
  return {
    ok: true as const,
    text: "",
    toolUses: [{ id, name, input: {} }],
    truncated: false,
    wantsTools: true,
    usage: USAGE,
    assistantContent: [
      { type: "tool_use" as const, id, name, input: {} },
    ] as never,
  };
}

function okResult(toolId: string) {
  return {
    schemaVersion: 1,
    status: "ok" as const,
    toolId,
    label: `${toolId} label`,
    rows: [{ a: 1 }],
    truncated: false,
    observedAt: "2026-08-12T00:00:00.000Z",
    audit: { areasChecked: ["support"], toolId },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "sk-test",
    actingMemberId: "member-1",
    matrix: MATRIX,
    question: "why is this stuck?",
    priorTurns: [],
    consent: createDiagnosticsConsentLedger({
      recordConsentGranted: false,
      peopleSearchGranted: false,
      selectedRecords: [],
    }),
    session: createDiagnosticsToolSession(),
    ...overrides,
  } as Parameters<typeof runDiagnosticsAnswer>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reserve.mockResolvedValue({
    ok: true,
    reservationId: "res-1",
    reserveCents: 5,
    month: "2026-08",
  });
  mocks.settle.mockResolvedValue(undefined);
  mocks.listDefinitions.mockReturnValue([]);
});

describe("budget: every exit settles what it reserved (#2378)", () => {
  it("settles a successful round", async () => {
    mocks.runRound.mockResolvedValue(answerRound("here is why"));
    const result = await runDiagnosticsAnswer(input());
    expect(result.ok).toBe(true);
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    expect(mocks.settle.mock.calls[0][0]).toMatchObject({
      reservationId: "res-1",
      success: true,
      usage: USAGE,
    });
  });

  it("settles a FAILED round, with the error code", async () => {
    mocks.runRound.mockResolvedValue({ ok: false, code: "overloaded", usage: USAGE });
    const result = await runDiagnosticsAnswer(input());
    expect(result.ok).toBe(false);
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    expect(mocks.settle.mock.calls[0][0]).toMatchObject({
      success: false,
      errorCode: "overloaded",
    });
  });

  it("settles even when the provider THROWS instead of returning a failure", async () => {
    // The provider documents itself as never throwing. This asserts the loop does not
    // depend on that staying true, because the reservation is the one piece of state
    // that outlives the request.
    mocks.runRound.mockRejectedValue(new Error("socket died"));
    const result = await runDiagnosticsAnswer(input());
    expect(result.ok).toBe(false);
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    expect(mocks.settle.mock.calls[0][0]).toMatchObject({ success: false });
  });

  it("builds the offer list BEFORE reserving, so a listing fault strands nothing", async () => {
    // The one call in a round the provider try/catch does not cover is the tool
    // listing. The contract review (13 Aug 2026) found it sitting between reserve
    // and settle, where a throw stranded worst-case budget until the TTL sweep;
    // the ordering — list, then reserve — is what this pins.
    mocks.listDefinitions.mockImplementation(() => {
      throw new Error("registry fault");
    });
    await expect(runDiagnosticsAnswer(input())).rejects.toThrow("registry fault");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("never reserves when the round budget is already spent", async () => {
    // `beginRound` refuses first, so an exhausted loop must not take a reservation it
    // will only have to release.
    const session = createDiagnosticsToolSession({ maxRounds: 0 });
    const result = await runDiagnosticsAnswer(input({ session }));
    expect(result.ok).toBe(false);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.runRound).not.toHaveBeenCalled();
  });

  it("returns budget_exhausted without calling the provider", async () => {
    mocks.reserve.mockResolvedValue({
      ok: false,
      reason: "over_budget",
      budgetCents: 100,
    });
    const result = await runDiagnosticsAnswer(input());
    expect(result).toMatchObject({ ok: false, reason: "budget_exhausted" });
    expect(mocks.runRound).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("distinguishes metering_unavailable from a spent budget", async () => {
    mocks.reserve.mockResolvedValue({
      ok: false,
      reason: "metering_unavailable",
      budgetCents: 100,
    });
    const result = await runDiagnosticsAnswer(input());
    expect(result).toMatchObject({ ok: false, reason: "metering_unavailable" });
  });
});

describe("the model never invokes on the operator's channel (#2378, Q2)", () => {
  it("passes model_tool_use, and this question's own ledger", async () => {
    mocks.runRound
      .mockResolvedValueOnce(toolRound("booking_block_state"))
      .mockResolvedValueOnce(answerRound("because the deposit is unpaid"));
    mocks.invoke.mockResolvedValue(okResult("booking_block_state"));

    const consent = createDiagnosticsConsentLedger({
      recordConsentGranted: true,
      peopleSearchGranted: false,
      selectedRecords: [],
    });
    const session = createDiagnosticsToolSession();
    await runDiagnosticsAnswer(input({ consent, session }));

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const call = mocks.invoke.mock.calls[0][0];
    // The whole people-search gate rests on this value. `operator_action` here would
    // make gate 4a a no-op for every model tool call.
    expect(call.invocationChannel).toBe("model_tool_use");
    expect(call.consent).toBe(consent);
    expect(call.session).toBe(session);
    expect(call.actingMemberId).toBe("member-1");
  });
});

describe("tool results are evidence, not stops (#2378)", () => {
  it("feeds a REFUSAL back as a tool_result and keeps going", async () => {
    mocks.runRound
      .mockResolvedValueOnce(toolRound("member_search"))
      .mockResolvedValueOnce(answerRound("I could not look that up"));
    mocks.invoke.mockResolvedValue({
      schemaVersion: 1,
      status: "error",
      toolId: "member_search",
      reason: "operator_action_required",
      message: "not allowed",
      observedAt: "2026-08-12T00:00:00.000Z",
      audit: { areasChecked: ["membership"], toolId: "member_search" },
    });

    const result = await runDiagnosticsAnswer(input());
    expect(result.ok).toBe(true);
    // The refusal is recorded as a source with the search state, so the operator is
    // told a tick would have answered it — not that diagnostics cannot do it.
    expect(result.sources[0]).toMatchObject({
      toolId: "member_search",
      state: "search_consent_required",
    });
    expect(result.summary.hasSearchWithheld).toBe(true);

    // And the model was sent the block, marked NOT an error: a denial is not a
    // malfunction to retry against a gate that will refuse identically.
    const secondCall = mocks.runRound.mock.calls[1][0];
    const toolResultTurn = secondCall.messages.at(-1);
    expect(toolResultTurn.role).toBe("user");
    expect(toolResultTurn.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
      is_error: false,
    });
  });

  it("rebuilds the tool OFFER list every round", async () => {
    mocks.runRound
      .mockResolvedValueOnce(toolRound("a"))
      .mockResolvedValueOnce(answerRound("done"));
    mocks.invoke.mockResolvedValue(okResult("a"));

    await runDiagnosticsAnswer(input());
    // Once per round. A list built once would keep offering round 0's answer after
    // gate 11 widened the ledger mid-answer.
    expect(mocks.listDefinitions).toHaveBeenCalledTimes(2);
  });
});

describe("the loop is bounded (#2378)", () => {
  it("stops at the round limit and says so", async () => {
    mocks.runRound.mockResolvedValue(toolRound("a"));
    mocks.invoke.mockResolvedValue(okResult("a"));
    const session = createDiagnosticsToolSession({ maxRounds: 2 });

    const result = await runDiagnosticsAnswer(input({ session }));
    expect(result).toMatchObject({ ok: false, reason: "round_limit_reached" });
    expect(mocks.runRound).toHaveBeenCalledTimes(2);
    // Partial evidence still travels, so a run that ran out of rounds can still
    // explain what it managed to read.
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it("reports an empty final answer as no_answer rather than an empty bubble", async () => {
    mocks.runRound.mockResolvedValue(answerRound(""));
    const result = await runDiagnosticsAnswer(input());
    expect(result).toMatchObject({ ok: false, reason: "no_answer" });
  });

  it("maps a provider refusal to its own reason", async () => {
    mocks.runRound.mockResolvedValue({ ok: false, code: "refusal", usage: USAGE });
    const result = await runDiagnosticsAnswer(input());
    expect(result).toMatchObject({ ok: false, reason: "provider_refused" });
  });

  it("does not leak an auth failure to the caller", async () => {
    // A bad stored key is an operator-fixable fault, but naming it to whoever happens
    // to be asking tells them about the deployment's credentials.
    mocks.runRound.mockResolvedValue({ ok: false, code: "auth", usage: USAGE });
    const result = await runDiagnosticsAnswer(input());
    expect(result).toMatchObject({ ok: false, reason: "provider_unavailable" });
  });
});

describe("stored provider evidence is never presented as ok (#2815)", () => {
  /**
   * `states.ts` names the answer loop as `provider_check_required`'s producer:
   * a tool whose evidenceScope carries the finance pack's stored-provider
   * disclosure read what the platform last WROTE DOWN, and a stored SUCCEEDED
   * presented as `ok` is a stored state presented as live provider truth —
   * the gap AID-7's contract review found. The membership test is the
   * disclosure text itself (`diagnosticsToolRequiresProviderCheck`), so these
   * cases run against the REAL registry, not a mock of it.
   */
  it("folds provider_check_required onto an ok read from a disclosure-carrying tool", async () => {
    const toolId = "diagnostics.payment_diagnostic_summary";
    mocks.runRound
      .mockResolvedValueOnce(toolRound(toolId))
      .mockResolvedValueOnce(answerRound("the stored state is SUCCEEDED"));
    mocks.invoke.mockResolvedValue(okResult(toolId));

    const result = await runDiagnosticsAnswer(input());
    expect(result.ok).toBe(true);
    expect(result.sources[0]).toMatchObject({
      toolId,
      state: "provider_check_required",
    });
  });

  it("leaves an ok read from an unmarked tool alone", async () => {
    // A REAL registered id, deliberately: the first cut used the unregistered
    // "member_search", which only exercised the unknown-id short-circuit — a
    // mutant marking EVERY registered tool passed it (#2815 review).
    mocks.runRound
      .mockResolvedValueOnce(toolRound("diagnostics.member_search"))
      .mockResolvedValueOnce(answerRound("found them"));
    mocks.invoke.mockResolvedValue(okResult("diagnostics.member_search"));

    const result = await runDiagnosticsAnswer(input());
    expect(result.sources[0]).toMatchObject({ state: "ok" });
  });

  it("keeps result_truncated on a truncated finance read — the fold takes only ok", async () => {
    // Dropping the `=== "ok"` guard would turn this into provider_check_required
    // (index 6 beats result_truncated's 1 under worstEvidenceState) and the
    // "part of a longer result was left out" caveat would vanish. The console
    // caveat still reaches the operator for this source — provenance keys it on
    // the TOOL, not the folded state.
    const toolId = "diagnostics.payment_diagnostic_summary";
    mocks.runRound
      .mockResolvedValueOnce(toolRound(toolId))
      .mockResolvedValueOnce(answerRound("part of the ledger"));
    mocks.invoke.mockResolvedValue({ ...okResult(toolId), truncated: true });

    const result = await runDiagnosticsAnswer(input());
    expect(result.sources[0]).toMatchObject({ state: "result_truncated" });
  });

  it("never overrides a more specific state — a denial stays a denial", async () => {
    const toolId = "diagnostics.payment_diagnostic_summary";
    mocks.runRound
      .mockResolvedValueOnce(toolRound(toolId))
      .mockResolvedValueOnce(answerRound("that was not available"));
    mocks.invoke.mockResolvedValue({
      schemaVersion: 1,
      status: "error" as const,
      toolId,
      reason: "permission_denied",
      message: "finance access required",
      missingAreas: ["finance"],
      observedAt: "2026-08-12T00:00:00.000Z",
      audit: { areasChecked: ["finance"], toolId },
    });

    const result = await runDiagnosticsAnswer(input());
    expect(result.sources[0]).toMatchObject({ state: "permission_denied" });
  });
});
