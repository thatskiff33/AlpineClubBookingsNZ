/**
 * The executor's gate chain, gate by gate. Two things are asserted about every
 * failure and not just the happy path, because they are the properties that make
 * this substrate safe rather than merely functional:
 *
 *   1. NO ROWS ESCAPE. Every non-success exit returns a result with no evidence.
 *   2. EVERY EXIT IS AUDITED, with approved metadata only.
 *
 * The ORDER of the gates is asserted too. Authorization must run before argument
 * parsing (otherwise the error shape is an oracle for a tool's argument schema)
 * and before any database connection is opened (otherwise an unauthorized caller
 * still costs a connection).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionArea,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

import { authorizeDiagnosticsToolCall } from "../authorize";
import {
  getDiagnosticsDatabase,
  runDiagnosticsReadOnlyQuery,
} from "../database";
import { recordDiagnosticsToolAudit } from "../audit";
import { invokeDiagnosticsTool } from "../invoke";
import {
  DIAGNOSTICS_CORRELATION_CATEGORY_SETS,
  DIAGNOSTICS_MEMBERSHIP_CORRELATION_TOOL_ID,
  DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS,
} from "../packs/support-correlation";
import { DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID } from "../registry";
import { renderToolResultEvidenceBlock } from "../render";
import { createDiagnosticsToolSession } from "../session";
import type { DiagnosticsToolAuditInput } from "../audit";

vi.mock("../authorize", () => ({
  authorizeDiagnosticsToolCall: vi.fn(),
}));
vi.mock("../database", () => ({
  getDiagnosticsDatabase: vi.fn(),
  runDiagnosticsReadOnlyQuery: vi.fn(),
}));
vi.mock("../audit", () => ({
  recordDiagnosticsToolAudit: vi.fn(),
}));
vi.mock("@/lib/observability-bridge", () => ({ reportAiError: vi.fn() }));

let meteringHealthy = true;
vi.mock("@/lib/ai-diagnostics-usage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai-diagnostics-usage")>();
  return { ...actual, isDiagnosticsMeteringHealthy: () => meteringHealthy };
});

const authorizeMock = vi.mocked(authorizeDiagnosticsToolCall);
const getDatabaseMock = vi.mocked(getDiagnosticsDatabase);
const runQueryMock = vi.mocked(runDiagnosticsReadOnlyQuery);
const auditMock = vi.mocked(recordDiagnosticsToolAudit);

const OBSERVED_AT = new Date("2026-08-02T03:04:05.000Z");
const ACTOR = "member-1";

/** A pool stand-in: the executor only hands it to the (mocked) query runner. */
const FAKE_POOL = { fake: "pool" } as unknown as Parameters<
  typeof runDiagnosticsReadOnlyQuery
>[1];

const FULL_MATRIX = Object.fromEntries(
  ADMIN_PERMISSION_AREAS.map((area) => [area.key, "view"]),
) as AdminPermissionMatrix;

function allowAuthorization(): void {
  // The executor consumes the VERDICT, not the matrix — the matrix is returned
  // for callers that go on to build a definition list.
  authorizeMock.mockResolvedValue({ ok: true, matrix: FULL_MATRIX });
}

function denyAuthorization(
  reason:
    | "actor_unresolved"
    | "actor_blocked"
    | "actor_read_failed"
    | "permission_denied",
  missingAreas: AdminPermissionArea[] = [],
): void {
  authorizeMock.mockResolvedValue({ ok: false, reason, missingAreas });
}

function databaseReady(): void {
  getDatabaseMock.mockResolvedValue({
    ok: true,
    pool: FAKE_POOL,
    roleName: "ai_diagnostics_ro",
  });
}

function queryReturns(rows: Record<string, unknown>[], durationMs = 7): void {
  runQueryMock.mockResolvedValue({ ok: true, rows, durationMs });
}

const PROBE_ROW = {
  probe_ok: true,
  transaction_read_only: "on",
  // PostgreSQL's own rendering of a millisecond GUC, not `5000ms`.
  statement_timeout: "5s",
  statement_timeout_ms: 5000,
  // A column the projection must drop. Distinctive on purpose: it is the sentinel
  // the "nothing raw reaches the audit row" assertions look for.
  leaked_secret: "SENTINEL-RAW-ROW-VALUE",
};

/** What the probe's projection makes of `PROBE_ROW`. */
const PROJECTED_PROBE_ROW = {
  probeOk: true,
  transactionReadOnly: "on",
  statementTimeout: "5s",
  statementTimeoutMs: 5000,
};

/** A session with one round open, ready to claim a call. */
function openSession(overrides: Parameters<typeof createDiagnosticsToolSession>[0] = {}) {
  const session = createDiagnosticsToolSession(overrides);
  session.beginRound();
  return session;
}

function invoke(
  overrides: Partial<Parameters<typeof invokeDiagnosticsTool>[0]> = {},
) {
  return invokeDiagnosticsTool({
    toolId: DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID,
    args: {},
    actingMemberId: ACTOR,
    session: openSession(),
    observedAt: OBSERVED_AT,
    ...overrides,
  });
}

function lastAudit(): DiagnosticsToolAuditInput {
  const call = auditMock.mock.calls.at(-1);
  if (!call) throw new Error("no audit row was written");
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  meteringHealthy = true;
  allowAuthorization();
  databaseReady();
  queryReturns([PROBE_ROW]);
  auditMock.mockResolvedValue(undefined);
});

describe("invokeDiagnosticsTool — the happy path (#2374)", () => {
  it("returns the projected rows with approved audit metadata", async () => {
    const result = await invoke();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.toolId).toBe(DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID);
    expect(result.rows).toEqual([PROJECTED_PROBE_ROW]);
    // The registry's projection is the column allowlist: a column the query
    // returned but the entry did not name cannot survive it.
    expect(JSON.stringify(result.rows)).not.toContain("SENTINEL-RAW-ROW-VALUE");
    expect(result.truncated).toBe(false);
    expect(result.observedAt).toBe(OBSERVED_AT.toISOString());

    expect(result.audit).toMatchObject({
      toolId: DIAGNOSTICS_SUBSTRATE_PROBE_TOOL_ID,
      areasChecked: ["support"],
      authOutcome: "allowed",
      failureReason: null,
      rowCount: 1,
      durationMs: 7,
      roundIndex: 0,
    });
    expect(result.audit.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.audit.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.audit.byteCount).toBeGreaterThan(0);
  });

  it("passes the registry SQL, the bound parameters and the row limit to the reader", async () => {
    await invoke();
    expect(runQueryMock).toHaveBeenCalledTimes(1);
    const [queryInput, pool] = runQueryMock.mock.calls[0];
    expect(queryInput.sql).toContain("current_setting('transaction_read_only')");
    expect(queryInput.params).toEqual([]);
    expect(queryInput.rowLimit).toBe(1);
    expect(pool).toBe(FAKE_POOL);
  });

  it("records approved metadata ONLY — no raw argument or row value", async () => {
    const result = await invoke();
    expect(result.status).toBe("ok");

    const audited = lastAudit();
    expect(audited.actingMemberId).toBe(ACTOR);
    // The EXHAUSTIVE key set, so a future field added to `DiagnosticsToolAudit`
    // cannot reach a durable row without this list being edited deliberately.
    expect(Object.keys(audited.audit).sort()).toEqual([
      "areasChecked",
      "argsHash",
      "authOutcome",
      "byteCount",
      "durationMs",
      "failureReason",
      "observedAt",
      "resultHash",
      "roundIndex",
      "rowCount",
      "toolId",
    ]);
    // Nothing from the raw row, the projected row, or the arguments is in it.
    const serialized = JSON.stringify(audited.audit);
    expect(serialized).not.toContain("SENTINEL-RAW-ROW-VALUE");
    expect(serialized).not.toContain("transaction_read_only");
    expect(serialized).not.toContain("statementTimeout");
    expect(serialized).not.toContain("5s");
  });

  it("READS first, then AUDITS, then returns — in that order", async () => {
    // The real proof that evidence never precedes its audit row is the discard
    // test below ("DISCARDS evidence when the audit row cannot be written"): the
    // executor awaits the write and abandons the rows if it fails. This pins the
    // other half — that the write happens after the read, so the row it records
    // describes a read that actually occurred.
    const sequence: string[] = [];
    runQueryMock.mockImplementation(async () => {
      sequence.push("read");
      return { ok: true, rows: [PROBE_ROW], durationMs: 7 };
    });
    auditMock.mockImplementation(async () => {
      sequence.push("audit");
    });

    const result = await invoke();
    expect(result.status).toBe("ok");
    expect(sequence).toEqual(["read", "audit"]);
  });

  it("reports truncation when the reader found more rows than the limit", async () => {
    // The reader is asked for rowLimit + 1 precisely so this is knowable.
    queryReturns([PROBE_ROW, PROBE_ROW]);
    const result = await invoke();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("hashes the accepted arguments deterministically", async () => {
    const first = await invoke();
    const second = await invoke();
    expect(first.audit.argsHash).toBe(second.audit.argsHash);
  });

  it("carries the entry's SERVER-OWNED searched scope onto the result", async () => {
    // The wiring that makes the scope sentence reach the model (#2375). It is the one
    // line between a registry entry declaring what it searched and the renderer being
    // able to say so, and without it an empty correlation result renders as bare
    // `not_found` — "there is no evidence of this to report" — which is a claim about
    // the whole domain rather than about the audit categories the entry actually read.
    //
    // A real entry is used rather than a fixture: the value must come from the
    // REGISTRY, so a test that supplied its own scope would prove nothing.
    const correlation = DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS.find(
      (entry) => entry.id === DIAGNOSTICS_MEMBERSHIP_CORRELATION_TOOL_ID,
    );
    if (!correlation?.evidenceScope) throw new Error("no membership entry");
    queryReturns([]);

    const result = await invoke({ toolId: correlation.id, args: {} });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.evidenceScope).toBe(correlation.evidenceScope);
    // End to end: it is in the block the model reads, above the rows, and it survives
    // the empty-result path — which is the only path where it changes an answer.
    const block = renderToolResultEvidenceBlock(result);
    expect(block).toContain("scope: ");
    // The entry's own derived category set (#2581 made these derive from the
    // canonical taxonomy, and the membership set gained `family` and
    // `communication`), not a hard-coded pair a classification decision would
    // silently invalidate.
    expect(block).toContain(
      DIAGNOSTICS_CORRELATION_CATEGORY_SETS[correlation.id].join(", "),
    );
    expect(block).toContain("rows: none matched");
    expect(block.indexOf("scope:")).toBeLessThan(block.indexOf("rows:"));
  });

  it("OMITS the scope for an entry that declares none, rather than blanking it", async () => {
    // A blank `scope:` line would read as "we searched nothing", which is worse than
    // silence. The substrate probe declares no scope.
    const result = await invoke();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.evidenceScope).toBeUndefined();
    expect("evidenceScope" in result).toBe(false);
    expect(renderToolResultEvidenceBlock(result)).not.toContain("scope:");
  });
});

describe("invokeDiagnosticsTool — every gate fails closed (#2374)", () => {
  it("refuses an unknown tool id without authorizing or connecting", async () => {
    const result = await invoke({ toolId: "diagnostics.not_a_tool" });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("unknown_tool");
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(lastAudit().audit.toolId).toBe("diagnostics.not_a_tool");
  });

  it("does not echo a malformed tool id into the audit row", async () => {
    const result = await invoke({
      toolId: "'; DROP TABLE Member; --",
    });
    expect(result.status).toBe("error");
    // A hostile "tool id" is recorded as `unknown` rather than stored verbatim.
    expect(lastAudit().audit.toolId).toBe("unknown");
    if (result.status === "error") expect(result.toolId).toBe("unknown");
  });

  it("refuses when the session has no round open", async () => {
    const result = await invoke({ session: createDiagnosticsToolSession() });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("call_budget_exhausted");
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it("refuses once the per-round call allowance is spent", async () => {
    const session = openSession({ maxToolCallsPerRound: 1 });
    expect((await invoke({ session })).status).toBe("ok");
    const second = await invoke({ session });
    expect(second.status).toBe("error");
    if (second.status === "error") {
      expect(second.reason).toBe("call_budget_exhausted");
    }
  });

  it("claims a call even for an invocation it then denies", async () => {
    // Otherwise a caller could probe authorization for free, round after round.
    denyAuthorization("permission_denied", ["support"]);
    const session = openSession({ maxToolCallsPerRound: 1 });
    await invoke({ session });
    expect(session.stats().callsThisSession).toBe(1);
  });

  it("claims a call for an UNREGISTERED id too, so bogus ids are not unlimited", async () => {
    // An unknown id used to cost nothing while still writing a durable,
    // important-severity security audit row. One provider round of 60 hallucinated
    // or injected ids would then produce 60 rows with the counters still at zero,
    // and the advertised "4 tool calls per round" bound never engaging.
    const session = openSession({ maxToolCallsPerRound: 2 });
    const first = await invoke({ toolId: "diagnostics.probe_a", session });
    expect(first.status).toBe("error");
    expect(session.stats().callsThisSession).toBe(1);

    await invoke({ toolId: "diagnostics.probe_b", session });
    expect(session.stats().callsThisSession).toBe(2);

    // The allowance is now spent, and a REAL call is refused on budget.
    const third = await invoke({ session });
    expect(third.status).toBe("error");
    if (third.status === "error") {
      expect(third.reason).toBe("call_budget_exhausted");
    }
  });

  it.each([
    ["permission_denied", ["support"] as AdminPermissionArea[]],
    ["actor_unresolved", [] as AdminPermissionArea[]],
    // A locked-out admin (deactivated, or under a forced password change) is its own
    // reason: filing it as `actor_read_failed` made a deliberate lock-out
    // indistinguishable from a database fault, and told the admin to retry.
    ["actor_blocked", [] as AdminPermissionArea[]],
    ["actor_read_failed", [] as AdminPermissionArea[]],
  ] as const)("denies on %s without opening a connection", async (reason, missing) => {
    denyAuthorization(reason, [...missing]);
    const result = await invoke();

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe(reason);
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(runQueryMock).not.toHaveBeenCalled();
    expect(result.audit.authOutcome).toBe("denied");
    expect(result.audit.areasChecked).toEqual(["support"]);
    if (reason === "permission_denied") {
      expect(result.missingAreas).toEqual(["support"]);
    } else {
      expect(result.missingAreas).toBeUndefined();
    }
  });

  it("still authorizes a tool whose definition would have been WITHHELD", async () => {
    // Withholding is courtesy; this is the control. An invocation naming a tool
    // the caller may not use is authorized on its own merits and denied here.
    denyAuthorization("permission_denied", ["support"]);
    const result = await invoke();
    expect(authorizeMock).toHaveBeenCalledWith({
      actingMemberId: ACTOR,
      requiredAreas: ["support"],
    });
    expect(result.status).toBe("error");
  });

  it("authorizes BEFORE parsing arguments, so the error shape is not an oracle", async () => {
    denyAuthorization("permission_denied", ["support"]);
    const result = await invoke({ args: { nonsense: true } });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("permission_denied");
  });

  it("refuses arguments the tool's strict schema rejects, and hashes nothing", async () => {
    const result = await invoke({ args: { unexpected: 1 } });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("invalid_args");
    // Refused input is never hashed into a durable row.
    expect(result.audit.argsHash).toBeNull();
    expect(runQueryMock).not.toHaveBeenCalled();
    // The message must not echo the rejected input.
    expect(result.message).not.toContain("unexpected");
  });

  it("refuses to read when diagnostics usage cannot be metered", async () => {
    meteringHealthy = false;
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("metering_unavailable");
    }
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it.each([
    "database_not_configured",
    "database_role_unsafe",
    "database_grants_missing",
  ] as const)(
    "refuses when the credential is %s",
    async (reason) => {
      getDatabaseMock.mockResolvedValue({ ok: false, reason });
      const result = await invoke();
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.reason).toBe(reason);
      expect(runQueryMock).not.toHaveBeenCalled();
    },
  );

  it("refuses when the read fails or times out, recording the duration", async () => {
    runQueryMock.mockResolvedValue({ ok: false, durationMs: 5_001, timedOut: true });
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("query_failed");
    expect(result.audit.durationMs).toBe(5_001);
    expect(result.audit.rowCount).toBe(0);
    // The driver's message never reaches the caller.
    expect(result.message).not.toContain("timeout");
  });

  it("DISCARDS evidence when the audit row cannot be written", async () => {
    auditMock.mockRejectedValue(new Error("audit table unavailable"));
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("audit_unavailable");
    }
    // The read happened, but nothing came back from it.
    expect(runQueryMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("5000ms");
  });

  /**
   * Every way this suite can make the executor refuse, as one table. Used twice:
   * once to prove each exit is audited with its own reason, and once to prove no
   * exit carries evidence. `result_too_large` and `redaction_failed` need a tool
   * whose projection or size can be manipulated, so they live in
   * `invoke-projection.test.ts` and are asserted there the same two ways.
   */
  const FAILURE_ARRANGEMENTS: [string, () => void][] = [
    ["unknown_tool", () => {}],
    ["call_budget_exhausted", () => {}],
    ["permission_denied", () => denyAuthorization("permission_denied", ["support"])],
    ["actor_unresolved", () => denyAuthorization("actor_unresolved")],
    ["actor_blocked", () => denyAuthorization("actor_blocked")],
    ["actor_read_failed", () => denyAuthorization("actor_read_failed")],
    ["invalid_args", () => {}],
    [
      "metering_unavailable",
      () => {
        meteringHealthy = false;
      },
    ],
    [
      "database_not_configured",
      () =>
        getDatabaseMock.mockResolvedValue({
          ok: false,
          reason: "database_not_configured",
        }),
    ],
      [
        "database_role_unsafe",
      () =>
        getDatabaseMock.mockResolvedValue({
          ok: false,
          reason: "database_role_unsafe",
        }),
      ],
      [
        "database_grants_missing",
        () =>
          getDatabaseMock.mockResolvedValue({
            ok: false,
            reason: "database_grants_missing",
          }),
      ],
    [
      "query_failed",
      () =>
        runQueryMock.mockResolvedValue({
          ok: false,
          durationMs: 1,
          timedOut: false,
        }),
    ],
    [
      "audit_unavailable",
      () => auditMock.mockRejectedValue(new Error("audit table unavailable")),
    ],
    ["internal_error", () => getDatabaseMock.mockRejectedValue(new Error("boom"))],
  ];

  /** The per-reason invocation shape, for the two reasons that need one. */
  function invokeFor(reason: string) {
    if (reason === "unknown_tool") {
      return invoke({ toolId: "diagnostics.not_a_tool" });
    }
    if (reason === "call_budget_exhausted") {
      return invoke({ session: createDiagnosticsToolSession() });
    }
    if (reason === "invalid_args") return invoke({ args: { unexpected: 1 } });
    return invoke();
  }

  function resetArrangement(): void {
    vi.clearAllMocks();
    meteringHealthy = true;
    allowAuthorization();
    databaseReady();
    queryReturns([PROBE_ROW]);
    auditMock.mockResolvedValue(undefined);
  }

  it.each(FAILURE_ARRANGEMENTS)("audits the %s exit with its own reason", async (reason, arrange) => {
    resetArrangement();
    arrange();
    const result = await invoke_(reason);
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe(reason);
    // `audit_unavailable` writes twice on purpose: the success row that failed,
    // then the failure row. Every other exit writes exactly one.
    expect(auditMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(lastAudit().audit.failureReason).toBe(result.reason);
  });

  it.each(FAILURE_ARRANGEMENTS)("returns NO rows from the %s exit", async (reason, arrange) => {
    resetArrangement();
    arrange();
    const result = await invoke_(reason);
    expect(result.status).toBe("error");
    // The discriminated union makes this a type error, but the property that
    // matters at runtime is that no evidence key exists on the object at all —
    // a caller that reads `result.rows` defensively must get `undefined`, never a
    // partial set.
    expect(result).not.toHaveProperty("rows");
    expect(result).not.toHaveProperty("truncated");
    expect(JSON.stringify(result)).not.toContain("SENTINEL-RAW-ROW-VALUE");
    expect(result.audit.rowCount).toBe(0);
    expect(result.audit.byteCount).toBe(0);
    expect(result.audit.resultHash).toBeNull();
  });

  /** Alias so the two `it.each` blocks read as prose. */
  function invoke_(reason: string) {
    return invokeFor(reason);
  }

  it("clamps a tool's byte limit to the GLOBAL ceiling, never above it", async () => {
    // `Math.min(tool.byteLimit, maxResultBytes)` is the guard. Inverting it to
    // `Math.max` would let a future entry declare a byteLimit above the substrate's
    // own ceiling and ship a result the substrate promised it never would. Proven
    // by shrinking the global ceiling below the probe's own 256-byte limit.
    const { DIAGNOSTICS_TOOL_BOUNDS } = await import("../types");
    const original = DIAGNOSTICS_TOOL_BOUNDS.maxResultBytes;
    Object.defineProperty(DIAGNOSTICS_TOOL_BOUNDS, "maxResultBytes", {
      value: 4,
      configurable: true,
    });
    try {
      const result = await invoke();
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.reason).toBe("result_too_large");
      }
    } finally {
      Object.defineProperty(DIAGNOSTICS_TOOL_BOUNDS, "maxResultBytes", {
        value: original,
        configurable: true,
      });
    }
  });

  it("audits a refusal that never entered the loop as roundIndex -1, not round 0", async () => {
    // An unstarted session has no round. Recording 0 would claim the invocation
    // belonged to the first provider round, which it did not.
    const result = await invoke({
      toolId: "diagnostics.not_a_tool",
      session: createDiagnosticsToolSession(),
    });
    expect(result.status).toBe("error");
    expect(result.audit.roundIndex).toBe(-1);
    expect(lastAudit().audit.roundIndex).toBe(-1);
  });

  it("still audits when the SESSION ITSELF is malformed", async () => {
    // `stats()` is read once, synchronously, inside a guard. A session whose
    // `stats` throws used to make the catch-all throw — losing the audit row that
    // the whole never-throws wrapper exists to guarantee.
    const brokenSession = {
      limits: {
        maxRounds: 1,
        maxToolCallsPerRound: 1,
        maxToolCallsPerSession: 1,
      },
      beginRound: () => ({ ok: true as const, roundIndex: 0 }),
      claimToolCall: () => ({ ok: true as const, roundIndex: 0 }),
      stats: () => {
        throw new Error("session is broken");
      },
    };

    const result = await invoke({ session: brokenSession });
    // It does NOT reject, and it DOES write an audit row.
    expect(result.status).toBe("ok");
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("never throws — an unexpected fault becomes a typed, audited failure", async () => {
    // Collaborators are documented as never-throwing, so this is a bug case. It
    // must still fail closed WITH an audit row rather than let an exception
    // escape and lose the trail.
    getDatabaseMock.mockRejectedValue(new Error("pool exploded"));
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("internal_error");
    expect(result.message).not.toContain("pool exploded");
    expect(lastAudit().audit.failureReason).toBe("internal_error");
  });

  it("audits a fault AFTER authorization as allowed-then-failed, not as blocked", async () => {
    // `audit.ts` derives outcome `blocked` at severity `important` from
    // `authOutcome: "denied"`. The catch-all used to hard-code that for every fault
    // however far the invocation got, so an internal fault after a SUCCESSFUL
    // authorization was recorded in a 24-month security row as a permission block
    // against that admin — with `areasChecked` erased and `argsHash` dropped. A
    // dashboard keyed on blocked/`ai_diagnostics.tool_invocation` would report a
    // permission incident that never happened, and `failure` already exists for
    // exactly this case.
    getDatabaseMock.mockRejectedValue(new Error("pool exploded"));
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;

    expect(result.audit.authOutcome).toBe("allowed");
    expect(result.audit.areasChecked).toEqual(["support"]);
    // Gate 4 had already accepted and hashed the arguments.
    expect(result.audit.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.audit.roundIndex).toBe(0);
    expect(lastAudit().audit).toMatchObject({
      authOutcome: "allowed",
      areasChecked: ["support"],
      failureReason: "internal_error",
    });
  });

  it("still audits a fault BEFORE authorization as denied", async () => {
    // The other half: a fault that happens while authorizing has no allowed
    // outcome to report, and must not claim one.
    authorizeMock.mockRejectedValue(new Error("authorizer exploded"));
    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("internal_error");
    expect(result.audit.authOutcome).toBe("denied");
    expect(result.audit.argsHash).toBeNull();
    // The tool was known, so the areas it declares are still recorded — that is
    // what `DiagnosticsToolAudit.areasChecked` documents ("recorded even when the
    // check denied").
    expect(result.audit.areasChecked).toEqual(["support"]);
  });
});
