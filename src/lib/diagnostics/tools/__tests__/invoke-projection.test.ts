/**
 * The projection, redaction and byte-ceiling gates, exercised against HOSTILE
 * registry entries.
 *
 * These cases use hostile synthetic registry entries so each guard can be exercised
 * in isolation from the shipped pack bounds. The AID-6A/B/C entries carry real
 * database-derived values and can encounter long or structurally hostile evidence;
 * mocking the registry here proves the shared guards independently of the current
 * catalogue.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

import { reportAiError } from "@/lib/observability-bridge";

import { authorizeDiagnosticsToolCall } from "../authorize";
import {
  getDiagnosticsDatabase,
  runDiagnosticsReadOnlyQuery,
} from "../database";
import { recordDiagnosticsToolAudit } from "../audit";
import { createEmptyDiagnosticsConsentLedger } from "../consent";
import { invokeDiagnosticsTool } from "../invoke";
import { createDiagnosticsToolSession } from "../session";
import type {
  DiagnosticsSelectOnlyToolEntry,
  DiagnosticsToolEntry,
} from "../define";
import { DIAGNOSTICS_TOOL_BOUNDS, type DiagnosticsToolRow } from "../types";

vi.mock("../authorize", () => ({ authorizeDiagnosticsToolCall: vi.fn() }));
vi.mock("../database", () => ({
  getDiagnosticsDatabase: vi.fn(),
  runDiagnosticsReadOnlyQuery: vi.fn(),
}));
vi.mock("../audit", () => ({ recordDiagnosticsToolAudit: vi.fn() }));
vi.mock("@/lib/observability-bridge", () => ({ reportAiError: vi.fn() }));

/** The entry the mocked registry hands back; each test reshapes it. */
let entry: DiagnosticsToolEntry;

vi.mock("../registry", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../registry");
  return {
    ...actual,
    // Only the LOOKUP is stubbed. `isValidDiagnosticsToolId` stays real so the id
    // hygiene the executor depends on is not quietly bypassed.
    findDiagnosticsTool: (id: string) => (id === entry.id ? entry : undefined),
  };
});

const authorizeMock = vi.mocked(authorizeDiagnosticsToolCall);
const reportMock = vi.mocked(reportAiError);
const getDatabaseMock = vi.mocked(getDiagnosticsDatabase);
const runQueryMock = vi.mocked(runDiagnosticsReadOnlyQuery);
const auditMock = vi.mocked(recordDiagnosticsToolAudit);

const FAKE_POOL = {} as unknown as Parameters<
  typeof runDiagnosticsReadOnlyQuery
>[1];

const FULL_MATRIX = Object.fromEntries(
  ADMIN_PERMISSION_AREAS.map((area) => [area.key, "view"]),
) as AdminPermissionMatrix;

function makeEntry(
  project: (row: Record<string, unknown>) => DiagnosticsToolRow,
  // Narrowed to the SELECT-only arm rather than the union (#2786). Every call site
  // overrides a limit and none changes `source`, and a `Partial` of the union now
  // widens `source` back to both arms — which would let a fixture claim to be
  // server-owned while omitting the seam declaration that arm requires.
  overrides: Partial<DiagnosticsSelectOnlyToolEntry> = {},
): DiagnosticsToolEntry {
  return {
    id: "diagnostics.hostile_probe",
    label: "Hostile probe",
    description: "A registry entry that exists only to exercise the guards.",
    requiredAreas: ["support"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    source: "select_only_sql",
    sql: "SELECT 1 AS one",
    parseArgs: () => ({
      ok: true,
      source: "select_only_sql",
      args: {},
      params: [],
    }),
    project,
    rowLimit: 5,
    byteLimit: DIAGNOSTICS_TOOL_BOUNDS.maxResultBytes,
    surfacesPersonalData: false,
    ...overrides,
  };
}

function invoke() {
  const session = createDiagnosticsToolSession();
  session.beginRound();
  return invokeDiagnosticsTool({
    toolId: "diagnostics.hostile_probe",
    args: {},
    actingMemberId: "member-1",
    session,
    invocationChannel: "model_tool_use",
    consent: createEmptyDiagnosticsConsentLedger(),
    observedAt: new Date("2026-08-02T00:00:00.000Z"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMock.mockResolvedValue({ ok: true, matrix: FULL_MATRIX });
  getDatabaseMock.mockResolvedValue({
    ok: true,
    pool: FAKE_POOL,
    roleName: "ai_diagnostics_ro",
  });
  auditMock.mockResolvedValue(undefined);
});

describe("projection is the column allowlist (#2374, ADR-004 §2)", () => {
  it("drops every column the entry did not name", async () => {
    entry = makeEntry((row) => ({ status: String(row.status ?? "") }));
    runQueryMock.mockResolvedValue({
      ok: true,
      durationMs: 1,
      rows: [
        {
          status: "CONFIRMED",
          // The query over-selected. The projection is what stops it travelling.
          email: "member@example.org",
          password_hash: "$2b$10$abcdefghijklmnop",
        },
      ],
    });

    const result = await invoke();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rows).toEqual([{ status: "CONFIRMED" }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("member@example.org");
    expect(serialized).not.toContain("$2b$10$");
  });

  it("redacts a secret that a free-text column carried", async () => {
    entry = makeEntry((row) => ({ note: String(row.note ?? "") }));
    runQueryMock.mockResolvedValue({
      ok: true,
      durationMs: 1,
      rows: [{ note: "operator pasted Authorization: Bearer abc123def456ghi" }],
    });

    const result = await invoke();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(String(result.rows[0].note)).toContain("[REDACTED]");
    expect(String(result.rows[0].note)).not.toContain("abc123def456ghi");
  });

  it("caps a long free-text value rather than shipping it whole", async () => {
    entry = makeEntry((row) => ({ note: String(row.note ?? "") }));
    runQueryMock.mockResolvedValue({
      ok: true,
      durationMs: 1,
      rows: [{ note: "x".repeat(5_000) }],
    });

    const result = await invoke();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const note = String(result.rows[0].note);
    expect(note).toHaveLength(DIAGNOSTICS_TOOL_BOUNDS.fieldValueMaxChars);
    expect(note.endsWith("…")).toBe(true);
  });

  it("passes flat scalars through untouched", async () => {
    entry = makeEntry(() => ({ n: 3, flag: false, nothing: null }));
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 1, rows: [{}] });

    const result = await invoke();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rows).toEqual([{ n: 3, flag: false, nothing: null }]);
    }
  });
});

describe("a projection that breaks its contract discards the whole result (#2374)", () => {
  it.each([
    ["a nested object", () => ({ nested: { a: 1 } })],
    ["an array", () => ({ list: [1, 2, 3] })],
    ["a Date", () => ({ when: new Date() })],
    ["undefined", () => ({ missing: undefined })],
    ["NaN", () => ({ n: Number.NaN })],
    ["Infinity", () => ({ n: Number.POSITIVE_INFINITY })],
    ["-Infinity", () => ({ n: Number.NEGATIVE_INFINITY })],
    // The module docstring names bigint; node-postgres hands an int8 column back
    // as a string, but a projection that parsed one would produce a bigint, and
    // `JSON.stringify` throws on those — so it must be refused here, not later.
    // `BigInt(10)` rather than `10n`: the test tsconfig targets below ES2020, where
    // a bigint LITERAL is a compile error (`tsc -p tsconfig.test.json` catches it,
    // `npm test` does not).
    ["a bigint", () => ({ big: BigInt(10) })],
    ["a function", () => ({ fn: () => 1 })],
    ["a symbol", () => ({ sym: Symbol("s") })],
  ])("refuses %s", async (_label, project) => {
    entry = makeEntry(project as never);
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 2, rows: [{}] });

    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("redaction_failed");
    // Nothing partial: no rows key at all on a failure result.
    expect(result).not.toHaveProperty("rows");
    expect(result.audit.rowCount).toBe(0);
  });

  it("refuses a projection that returns more fields than a row may carry", async () => {
    entry = makeEntry(() =>
      Object.fromEntries(
        Array.from(
          { length: DIAGNOSTICS_TOOL_BOUNDS.maxFieldsPerRow + 1 },
          (_unused, index) => [`field_${index}`, index],
        ),
      ),
    );
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 2, rows: [{}] });

    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("redaction_failed");
  });

  it("refuses when the projection itself throws", async () => {
    entry = makeEntry(() => {
      throw new Error("projection bug");
    });
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 2, rows: [{}] });

    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("redaction_failed");
  });
});

describe("the byte ceiling REFUSES rather than trimming (#2374)", () => {
  it("refuses a result over the tool's own byte limit", async () => {
    entry = makeEntry((row) => ({ note: String(row.note ?? "") }), {
      byteLimit: 128,
      rowLimit: 5,
    });
    runQueryMock.mockResolvedValue({
      ok: true,
      durationMs: 3,
      rows: [{ note: "y".repeat(200) }],
    });

    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("result_too_large");
    // A silent trim would be worse than a refusal: the model would present a
    // partial answer as whole. Nothing comes back at all.
    expect(result).not.toHaveProperty("rows");
    expect(result.audit.byteCount).toBe(0);
    expect(result.audit.resultHash).toBeNull();
  });

  it("clamps a tool's row limit to the substrate ceiling", async () => {
    entry = makeEntry(() => ({ one: 1 }), {
      rowLimit: DIAGNOSTICS_TOOL_BOUNDS.maxRows * 10,
    });
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 1, rows: [{}] });

    await invoke();
    expect(runQueryMock.mock.calls[0][0].rowLimit).toBe(
      DIAGNOSTICS_TOOL_BOUNDS.maxRows,
    );
  });

  it("accepts a result whose byte count EXACTLY equals the limit", async () => {
    // The boundary, not a comfortable margin. `>` vs `>=` at the size gate is a
    // one-character mutation, and a test with 26 bytes against a 64-byte limit
    // cannot tell the two apart. The limit is derived from the actual serialized
    // length so the assertion stays exact if the canonical form ever changes.
    entry = makeEntry(() => ({ ok: true }), { rowLimit: 1 });
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 1, rows: [{}] });

    const probe = await invoke();
    expect(probe.status).toBe("ok");
    if (probe.status !== "ok") return;
    const exactBytes = probe.audit.byteCount;
    expect(exactBytes).toBeGreaterThan(0);

    // Exactly at the limit: allowed.
    entry = makeEntry(() => ({ ok: true }), {
      rowLimit: 1,
      byteLimit: exactBytes,
    });
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 1, rows: [{}] });
    const atLimit = await invoke();
    expect(atLimit.status).toBe("ok");

    // One byte under: refused. This is the half that pins the comparison.
    entry = makeEntry(() => ({ ok: true }), {
      rowLimit: 1,
      byteLimit: exactBytes - 1,
    });
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 1, rows: [{}] });
    const overLimit = await invoke();
    expect(overLimit.status).toBe("error");
    if (overLimit.status === "error") {
      expect(overLimit.reason).toBe("result_too_large");
    }
  });
});

describe("a FIXED projection means fixed across rows too (#2374)", () => {
  it("refuses a projection whose rows disagree about their fields", async () => {
    // A `??`-less nullable column or a conditional spread produces rows with
    // different key sets. That is not a fixed projection, and evidence whose rows
    // silently disagree about what they contain invites the model to read a missing
    // field as a meaningful absence.
    let call = 0;
    // Annotated `DiagnosticsToolRow` because the two branches infer a union with an
    // optional `b`, which the row type's index signature rejects — the shape is the
    // point of the test, so it is declared rather than inferred.
    entry = makeEntry((): DiagnosticsToolRow => {
      call += 1;
      return call === 1 ? { a: 1, b: 2 } : { a: 1 };
    });
    runQueryMock.mockResolvedValue({
      ok: true,
      durationMs: 1,
      rows: [{}, {}],
    });

    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("redaction_failed");
  });

  it("accepts rows whose fields match in a different declaration order", async () => {
    // Key ORDER is not part of the shape — canonical JSON sorts keys anyway, and
    // refusing on order would reject a perfectly fixed projection.
    let call = 0;
    entry = makeEntry(() => {
      call += 1;
      return call === 1 ? { a: 1, b: 2 } : { b: 3, a: 4 };
    });
    runQueryMock.mockResolvedValue({
      ok: true,
      durationMs: 1,
      rows: [{}, {}],
    });

    const result = await invoke();
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.rows).toHaveLength(2);
  });
});

describe("a projection fault does not forward a row value to observability (AID-8 F1)", () => {
  // The leakage hazard, verbatim: `reportAiError` hands its `err` to
  // `Sentry.captureException` with NO redaction, and the `beforeSend` net covers
  // structural fields but has no value-shaped rule for a member/guest NAME spliced
  // into an error MESSAGE. A projection that throws while choking on a row value can
  // put that value in the message, so the executor must forward a fixed-message
  // error carrying only the error CLASS. Reverting that wrap turns this test red.
  const MEMBER_NAME = "Jarrah Quartermaine-Testperson";

  it("forwards only the error class, never the name the projection threw", async () => {
    entry = makeEntry(() => {
      // A projection fault whose message quotes the very row value it failed on —
      // exactly what a first-party calculation or a driver error can produce.
      throw new Error(
        `invalid input for member "${MEMBER_NAME}" while projecting row`,
      );
    });
    runQueryMock.mockResolvedValue({ ok: true, durationMs: 2, rows: [{}] });

    const result = await invoke();
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.reason).toBe("redaction_failed");

    const forwarded = reportMock.mock.calls.find(
      ([payload]) => payload.tag === "diagnostics-tool-projection",
    );
    expect(forwarded, "the projection fault was reported").toBeDefined();
    const payload = forwarded![0];
    const err = payload.err;
    expect(err).toBeInstanceOf(Error);

    // Nothing forwarded to observability — the error object OR the surrounding
    // payload — may carry the name. `Sentry.captureException` sees the message and
    // stack; both derive from the wrapped message here.
    const forwardedError = err as Error;
    expect(forwardedError.message).not.toContain(MEMBER_NAME);
    expect(forwardedError.stack ?? "").not.toContain(MEMBER_NAME);
    expect(JSON.stringify(payload.context ?? {})).not.toContain(MEMBER_NAME);
    // And what it DOES carry is the classifying label plus the error class.
    expect(forwardedError.message).toBe(
      "Diagnostics tool projection or redaction failed (Error)",
    );
  });
});
