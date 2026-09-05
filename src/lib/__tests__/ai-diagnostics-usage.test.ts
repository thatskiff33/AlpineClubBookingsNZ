import { readFileSync } from "fs";
import path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// A flexible prisma mock: interactive $transaction(fn) calls fn(db); array-form
// $transaction([...]) resolves the ops. The same `db` object is the tx client.
// Everything is built inside vi.hoisted so the vi.mock factory (hoisted to the
// top of the file) can reference it without a TDZ error.
const mocks = vi.hoisted(() => {
  const execRaw = vi.fn();
  const resvDeleteMany = vi.fn();
  const resvAggregate = vi.fn();
  const resvCreate = vi.fn();
  const settingsFindUnique = vi.fn();
  const monthlyFindUnique = vi.fn();
  const monthlyUpsert = vi.fn();
  const eventCreate = vi.fn();
  const eventFindMany = vi.fn();
  const transaction = vi.fn();
  const reportAiError = vi.fn();
  const dbShape = {
    $executeRaw: execRaw,
    diagnosticsBudgetReservation: {
      deleteMany: resvDeleteMany,
      aggregate: resvAggregate,
      create: resvCreate,
    },
    diagnosticsSettings: { findUnique: settingsFindUnique },
    diagnosticsUsageMonthly: {
      findUnique: monthlyFindUnique,
      upsert: monthlyUpsert,
    },
    diagnosticsUsageEvent: {
      create: eventCreate,
      findMany: eventFindMany,
    },
    $transaction: transaction,
  } as Record<string, unknown> & { $transaction: typeof transaction };
  return {
    execRaw,
    resvDeleteMany,
    resvAggregate,
    resvCreate,
    settingsFindUnique,
    monthlyFindUnique,
    monthlyUpsert,
    eventCreate,
    eventFindMany,
    transaction,
    reportAiError,
    dbShape,
  };
});

const dbShape = mocks.dbShape;

vi.mock("@/lib/prisma", () => ({ prisma: mocks.dbShape }));
vi.mock("@/lib/observability-bridge", () => ({ reportAiError: mocks.reportAiError }));

import {
  AI_DIAGNOSTICS_PRICE_TABLE_NZ_CENTS_PER_MTOK,
  DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS,
  DIAGNOSTICS_MAX_TOOL_ROUNDS,
  WORST_CASE_ROUNDTRIP_CENTS,
  computeWorstCaseRoundtripCents,
  decideReservation,
  diagnosticsUsageMonthKey,
  estimateDiagnosticsCostCents,
  isDiagnosticsMeteringHealthy,
  reserveDiagnosticsBudget,
  resetDiagnosticsMeteringHealthForTests,
  settleDiagnosticsRoundtrip,
} from "@/lib/ai-diagnostics-usage";

beforeEach(() => {
  vi.clearAllMocks();
  resetDiagnosticsMeteringHealthForTests();
  mocks.execRaw.mockResolvedValue(1);
  mocks.resvDeleteMany.mockResolvedValue({ count: 0 });
  mocks.resvAggregate.mockResolvedValue({ _sum: { reservedCents: 0 } });
  mocks.resvCreate.mockResolvedValue({ id: "resv_1" });
  mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
  mocks.monthlyFindUnique.mockResolvedValue({ settledCents: 0 });
  mocks.monthlyUpsert.mockResolvedValue({});
  mocks.eventCreate.mockResolvedValue({});
  // interactive form calls fn(db); array form resolves ops.
  mocks.transaction.mockImplementation((arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: typeof dbShape) => unknown)(dbShape)
      : Promise.all(arg as unknown[]),
  );
});

describe("diagnosticsUsageMonthKey (Pacific/Auckland)", () => {
  it("crosses the month at the NZ boundary, not UTC", () => {
    expect(diagnosticsUsageMonthKey(new Date("2026-06-30T13:00:00Z"))).toBe("2026-07");
    expect(diagnosticsUsageMonthKey(new Date("2026-07-31T11:59:00Z"))).toBe("2026-07");
  });
});

describe("estimateDiagnosticsCostCents", () => {
  it("prices a known model from the table (ceil)", () => {
    // opus-5: input 900, output 4500 cents/MTok.
    const cents = estimateDiagnosticsCostCents("claude-opus-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    expect(cents).toBe(900);
  });

  it("is 0 only for zero usage, never negative", () => {
    expect(
      estimateDiagnosticsCostCents("claude-opus-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0);
  });

  it("bills at least 1 cent whenever any usage is present", () => {
    expect(
      estimateDiagnosticsCostCents("claude-opus-5", {
        inputTokens: 1,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(1);
  });

  it("prices an UNKNOWN model at the highest known row (fail-expensive)", () => {
    const rows = Object.values(AI_DIAGNOSTICS_PRICE_TABLE_NZ_CENTS_PER_MTOK);
    const highestOutput = Math.max(...rows.map((r) => r.output));
    const unknown = estimateDiagnosticsCostCents("some-future-model", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    expect(unknown).toBe(highestOutput);
    // ...and never cheaper than any known model priced the same way.
    for (const model of Object.keys(AI_DIAGNOSTICS_PRICE_TABLE_NZ_CENTS_PER_MTOK)) {
      const known = estimateDiagnosticsCostCents(model, {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      });
      expect(unknown).toBeGreaterThanOrEqual(known);
    }
  });
});

describe("worst-case roundtrip reservation size", () => {
  it("is a positive integer that bounds a real roundtrip", () => {
    expect(WORST_CASE_ROUNDTRIP_CENTS).toBe(computeWorstCaseRoundtripCents());
    expect(Number.isInteger(WORST_CASE_ROUNDTRIP_CENTS)).toBe(true);
    expect(WORST_CASE_ROUNDTRIP_CENTS).toBeGreaterThan(0);
  });

  it("over-counts a plausible real roundtrip (fail-expensive reservation)", () => {
    // A realistic roundtrip: 12k input, 1.5k output on opus-5.
    const real = estimateDiagnosticsCostCents("claude-opus-5", {
      inputTokens: 12_000,
      outputTokens: 1_500,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    expect(WORST_CASE_ROUNDTRIP_CENTS).toBeGreaterThan(real);
  });

  it("bounds a whole session at rounds x worst-case", () => {
    expect(DIAGNOSTICS_MAX_TOOL_ROUNDS).toBeGreaterThan(0);
    const sessionWorstCase = DIAGNOSTICS_MAX_TOOL_ROUNDS * WORST_CASE_ROUNDTRIP_CENTS;
    expect(sessionWorstCase).toBeGreaterThan(WORST_CASE_ROUNDTRIP_CENTS);
  });
});

describe("decideReservation — the budget-admission guard (mutation-verified)", () => {
  it("DENIES when settled + reserved + reserve exceeds the budget by ONE cent", () => {
    // 900 + 60 + 41 = 1001 > 1000. A mutant that drops `activeReservedCents`
    // (900 + 41 = 941 <= 1000) would wrongly allow this — the assertion fails it.
    expect(
      decideReservation({
        settledCents: 900,
        activeReservedCents: 60,
        reserveCents: 41,
        budgetCents: 1000,
      }).allowed,
    ).toBe(false);
  });

  it("ALLOWS the reservation that lands exactly on the budget (<= is load-bearing)", () => {
    // 900 + 60 + 40 = 1000 == budget. A mutant flipping `<=` to `<` would deny.
    expect(
      decideReservation({
        settledCents: 900,
        activeReservedCents: 60,
        reserveCents: 40,
        budgetCents: 1000,
      }).allowed,
    ).toBe(true);
  });

  it("DENIES any reservation when the budget is zero (hard-off)", () => {
    // A mutant dropping the `budgetCents > 0` guard would allow reserveCents<=0 math.
    expect(
      decideReservation({
        settledCents: 0,
        activeReservedCents: 0,
        reserveCents: 1,
        budgetCents: 0,
      }).allowed,
    ).toBe(false);
  });

  it("DENIES a reservation larger than the whole budget", () => {
    expect(
      decideReservation({
        settledCents: 0,
        activeReservedCents: 0,
        reserveCents: 1001,
        budgetCents: 1000,
      }).allowed,
    ).toBe(false);
  });

  it("DENIES a non-positive reservation (no free reservation)", () => {
    expect(
      decideReservation({
        settledCents: 0,
        activeReservedCents: 0,
        reserveCents: 0,
        budgetCents: 1000,
      }).allowed,
    ).toBe(false);
  });

  it("counts the SETTLED term (a mutant dropping settledCents would over-admit)", () => {
    // settled fills the budget on its own; any positive reserve must be denied.
    expect(
      decideReservation({
        settledCents: 1000,
        activeReservedCents: 0,
        reserveCents: 1,
        budgetCents: 1000,
      }).allowed,
    ).toBe(false);
  });
});

describe("reserveDiagnosticsBudget — concurrency-safe guarded claim", () => {
  it("takes the per-month advisory lock, sweeps expired, then inserts when within budget", async () => {
    const result = await reserveDiagnosticsBudget({ reserveCents: 40 });
    expect(result).toMatchObject({ ok: true, reservationId: "resv_1", reserveCents: 40 });

    // The advisory lock is the FIRST statement in the transaction (serialisation).
    expect(mocks.execRaw).toHaveBeenCalledTimes(1);
    const lockSql = String(mocks.execRaw.mock.calls[0][0]);
    expect(lockSql).toContain("pg_advisory_xact_lock");
    // The expired-reservation reclaim ran before the insert.
    expect(mocks.resvDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ expiresAt: expect.anything() }),
      }),
    );
    expect(mocks.resvCreate).toHaveBeenCalledTimes(1);
  });

  it("LOST CLAIM runs NO side effect: an over-budget reserve inserts nothing", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 100 });
    mocks.monthlyFindUnique.mockResolvedValue({ settledCents: 80 });
    mocks.resvAggregate.mockResolvedValue({ _sum: { reservedCents: 0 } });
    // 80 + 0 + 40 = 120 > 100 → denied.
    const result = await reserveDiagnosticsBudget({ reserveCents: 40 });
    expect(result).toEqual({ ok: false, reason: "over_budget", budgetCents: 100 });
    expect(mocks.resvCreate).not.toHaveBeenCalled();
  });

  it("counts LIVE reservations from other in-flight calls (no overspend under burst)", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 100 });
    mocks.monthlyFindUnique.mockResolvedValue({ settledCents: 0 });
    // Two 40c reservations already live; a third 40c would reach 120 > 100.
    mocks.resvAggregate.mockResolvedValue({ _sum: { reservedCents: 80 } });
    const result = await reserveDiagnosticsBudget({ reserveCents: 40 });
    expect(result).toEqual({ ok: false, reason: "over_budget", budgetCents: 100 });
    expect(mocks.resvCreate).not.toHaveBeenCalled();
  });

  it("denies with budget_not_set when the budget is zero and inserts nothing", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 0 });
    const result = await reserveDiagnosticsBudget({ reserveCents: 40 });
    expect(result).toEqual({ ok: false, reason: "budget_not_set", budgetCents: 0 });
    expect(mocks.resvCreate).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the metering delegates are unavailable (blue/green)", async () => {
    // Simulate an old-colour client with no reservation delegate.
    const original = dbShape.diagnosticsBudgetReservation;
    (dbShape as { diagnosticsBudgetReservation?: unknown }).diagnosticsBudgetReservation =
      undefined;
    try {
      const result = await reserveDiagnosticsBudget({ reserveCents: 40 });
      expect(result).toMatchObject({ ok: false, reason: "metering_unavailable" });
      expect(mocks.transaction).not.toHaveBeenCalled();
    } finally {
      dbShape.diagnosticsBudgetReservation = original;
    }
  });

  it("FAILS CLOSED (and reports) when the reserve transaction throws", async () => {
    mocks.transaction.mockRejectedValue(new Error("db down"));
    const result = await reserveDiagnosticsBudget({ reserveCents: 40 });
    expect(result).toMatchObject({ ok: false, reason: "metering_unavailable" });
    expect(mocks.reportAiError).toHaveBeenCalled();
  });
});

describe("settleDiagnosticsRoundtrip — release reservation, book cost, meter", () => {
  const baseInput = {
    reservationId: "resv_1",
    surface: "diagnostics",
    model: "claude-opus-5",
    roundIndex: 0,
    success: true,
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    },
  };

  it("releases the reservation, writes ONE approved-metadata event, and rolls the cost", async () => {
    await settleDiagnosticsRoundtrip(baseInput);
    expect(mocks.resvDeleteMany).toHaveBeenCalledWith({ where: { id: "resv_1" } });
    expect(mocks.eventCreate).toHaveBeenCalledTimes(1);
    expect(mocks.monthlyUpsert).toHaveBeenCalledTimes(1);
    expect(isDiagnosticsMeteringHealthy()).toBe(true);

    // The event row carries ONLY approved metadata — no prompt/answer/args/payload.
    const eventData = (mocks.eventCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    const approved = new Set([
      "month",
      "adminMemberId",
      "surface",
      "model",
      "roundIndex",
      "success",
      "errorCode",
      "statusCode",
      "durationMs",
      "inputTokens",
      "outputTokens",
      "cacheWriteTokens",
      "cacheReadTokens",
      "costCents",
      "errorMessage",
      "createdAt",
    ]);
    for (const key of Object.keys(eventData)) {
      expect(approved.has(key)).toBe(true);
    }
    expect(eventData).not.toHaveProperty("prompt");
    expect(eventData).not.toHaveProperty("question");
    expect(eventData).not.toHaveProperty("answer");
  });

  it("still books the cost when the reservation was already reclaimed (idempotent release)", async () => {
    mocks.resvDeleteMany.mockResolvedValue({ count: 0 }); // sweep already removed it
    await settleDiagnosticsRoundtrip(baseInput);
    expect(mocks.monthlyUpsert).toHaveBeenCalledTimes(1);
    expect(isDiagnosticsMeteringHealthy()).toBe(true);
  });

  it("counts a session once (first roundtrip) but every roundtrip against roundtripCount", async () => {
    await settleDiagnosticsRoundtrip({ ...baseInput, roundIndex: 0 });
    const first = (mocks.monthlyUpsert.mock.calls[0][0] as {
      create: { requestCount: number; roundtripCount: number };
    }).create;
    expect(first.requestCount).toBe(1);
    expect(first.roundtripCount).toBe(1);

    await settleDiagnosticsRoundtrip({ ...baseInput, roundIndex: 2 });
    const second = (mocks.monthlyUpsert.mock.calls[1][0] as {
      update: { requestCount: { increment: number }; roundtripCount: { increment: number } };
    }).update;
    expect(second.requestCount.increment).toBe(0);
    expect(second.roundtripCount.increment).toBe(1);
  });

  it("METERING-FAILURE-CLOSES: consecutive settle failures trip the circuit breaker", async () => {
    mocks.transaction.mockRejectedValue(new Error("meter write failed"));
    expect(isDiagnosticsMeteringHealthy()).toBe(true);
    await settleDiagnosticsRoundtrip(baseInput);
    await settleDiagnosticsRoundtrip(baseInput);
    expect(isDiagnosticsMeteringHealthy()).toBe(true); // 2 < threshold(3)
    await settleDiagnosticsRoundtrip(baseInput);
    // 3 consecutive failures: the breaker is now OPEN — the route must not spend.
    expect(isDiagnosticsMeteringHealthy()).toBe(false);
    expect(mocks.reportAiError).toHaveBeenCalledTimes(3);
  });

  it("a successful settle RESETS the breaker", async () => {
    mocks.transaction.mockRejectedValue(new Error("meter write failed"));
    await settleDiagnosticsRoundtrip(baseInput);
    await settleDiagnosticsRoundtrip(baseInput);
    await settleDiagnosticsRoundtrip(baseInput);
    expect(isDiagnosticsMeteringHealthy()).toBe(false);
    // Recover: the next settle succeeds.
    mocks.transaction.mockImplementation((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: typeof dbShape) => unknown)(dbShape)
        : Promise.all(arg as unknown[]),
    );
    await settleDiagnosticsRoundtrip(baseInput);
    expect(isDiagnosticsMeteringHealthy()).toBe(true);
  });

  it("records a metering failure (does not spend blind) when delegates are unavailable", async () => {
    const original = dbShape.diagnosticsUsageEvent;
    (dbShape as { diagnosticsUsageEvent?: unknown }).diagnosticsUsageEvent = undefined;
    try {
      await settleDiagnosticsRoundtrip(baseInput);
      expect(mocks.reportAiError).toHaveBeenCalled();
      expect(mocks.monthlyUpsert).not.toHaveBeenCalled();
    } finally {
      dbShape.diagnosticsUsageEvent = original;
    }
  });
});

describe("settle serialises against reserve on the per-month lock (money-safety invariant)", () => {
  // The overspend hole this pins: reserveDiagnosticsBudget reads settled spend
  // and live reservations as two READ COMMITTED statements. If a settle could
  // commit its (delete-reservation + settledCents increment) BETWEEN those reads,
  // the just-settled roundtrip would be counted in NEITHER term — reservation
  // already gone, settled increment not yet in the reserve's snapshot — so the
  // reserve under-counts committed spend and can admit an over-budget roundtrip.
  // The fix makes settle take the SAME per-month advisory lock as reserve as its
  // first statement, so the two mutually exclude for the month. The real-DB,
  // multi-connection proof of the interleaving is CI-owned (opt-in race harness,
  // follow-up #2532); here we pin the mechanism the proof rests on: settle takes
  // the identical lock key, first, before any budget mutation.
  const settleInput = {
    reservationId: "resv_1",
    surface: "diagnostics",
    model: "claude-opus-5",
    roundIndex: 0,
    success: true,
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    },
  };

  it("takes the per-month advisory lock as its FIRST statement, before release/event/rollup", async () => {
    const now = new Date("2026-08-15T00:00:00Z");
    const month = diagnosticsUsageMonthKey(now);

    await settleDiagnosticsRoundtrip({ ...settleInput, now });

    // The advisory lock ran exactly once, keyed to this billing month. (A mutant
    // that removes the lock from settle makes this 0 — reddening the assertion.)
    expect(mocks.execRaw).toHaveBeenCalledTimes(1);
    const lockSql = String(mocks.execRaw.mock.calls[0][0]);
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(lockSql).toContain("diagnostics-budget-reserve");
    expect(mocks.execRaw.mock.calls[0][1]).toBe(month);

    // ...and it is the FIRST statement — strictly before the reservation release,
    // the event write, and the monthly rollup. Removing the lock leaves these
    // invocationCallOrder look-ups undefined, so the ordering assertions fail too.
    const lockOrder = mocks.execRaw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(mocks.resvDeleteMany.mock.invocationCallOrder[0]);
    expect(lockOrder).toBeLessThan(mocks.eventCreate.mock.invocationCallOrder[0]);
    expect(lockOrder).toBeLessThan(mocks.monthlyUpsert.mock.invocationCallOrder[0]);
  });

  it("acquires the IDENTICAL lock key as reserve for the same month (mutual exclusion)", async () => {
    const now = new Date("2026-08-15T00:00:00Z");
    const month = diagnosticsUsageMonthKey(now);

    await reserveDiagnosticsBudget({ reserveCents: 40, now });
    await settleDiagnosticsRoundtrip({ ...settleInput, now });

    // Reserve locked once (call 0), settle locked once (call 1). Same SQL
    // template and same month argument ⇒ the SAME PostgreSQL advisory lock ⇒ a
    // reserve and a settle for the month serialise on it. A mutant dropping the
    // settle lock leaves only one execRaw call and fails the count assertion.
    expect(mocks.execRaw).toHaveBeenCalledTimes(2);
    const reserveLock = String(mocks.execRaw.mock.calls[0][0]);
    const settleLock = String(mocks.execRaw.mock.calls[1][0]);
    expect(settleLock).toBe(reserveLock);
    expect(mocks.execRaw.mock.calls[0][1]).toBe(month);
    expect(mocks.execRaw.mock.calls[1][1]).toBe(month);
  });

  it("takes ONLY the one month lock (no second lock ⇒ no lock-ordering deadlock)", async () => {
    const now = new Date("2026-08-15T00:00:00Z");
    await settleDiagnosticsRoundtrip({ ...settleInput, now });
    // Exactly one advisory-lock statement in the whole settle transaction.
    expect(mocks.execRaw).toHaveBeenCalledTimes(1);
  });
});

describe("fail-closed defaults", () => {
  it("ships with a NZ$0 budget (no spend until an admin sets one)", () => {
    expect(DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS).toBe(0);
  });
});

describe("real-Postgres over-budget race proof stays wired into CI (#2532)", () => {
  // The race suite is `describe.skip` unless RUN_CONCURRENCY_RACE_TESTS=1, and
  // it reaches CI ONLY because `concurrency-lock-races.realdb.test.ts` imports
  // it — that harness file is what the workflow's race step actually runs.
  // Delete the import and the money-safety proof silently stops executing while
  // every suite still reports green. Same guard shape as the #2363 trigger
  // proof in `booking-policy-exception-foundation.test.ts`.
  const raceTestPath = "src/lib/__tests__/ai-diagnostics-budget-race.realdb.test.ts";

  function repoFile(relativePath: string) {
    // Test helper: reads a fixed repo file under process.cwd(); the path is
    // test-controlled, not user input.
    return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
  }

  it("is imported by the guarded hosted-PostgreSQL harness the CI step runs", () => {
    const harness = repoFile("src/lib/__tests__/concurrency-lock-races.realdb.test.ts");
    expect(harness).toContain('import "./ai-diagnostics-budget-race.realdb.test";');

    const workflow = repoFile(".github/workflows/ci.yml");
    expect(workflow).toContain(
      "npx vitest run src/lib/__tests__/concurrency-lock-races.realdb.test.ts",
    );
    expect(workflow).toContain('RUN_CONCURRENCY_RACE_TESTS: "1"');
  });

  it("keeps its opt-in + dedicated-loopback-database guards and its forced barrier", () => {
    const raceTest = repoFile(raceTestPath);
    // Opt-in only, dedicated database only — ordinary `npm test` must never
    // need a live PostgreSQL.
    expect(raceTest).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(raceTest).toContain("CONCURRENCY_RACE_DATABASE_URL");
    expect(raceTest).toContain("concurrency_race_1881");
    // The interleaving is FORCED by a held advisory lock plus a pg_locks
    // barrier, never by a sleep. A rewrite back to hopeful racing would make
    // the suite flaky in CI and vacuous on a fast machine.
    expect(raceTest).toContain("pg_advisory_xact_lock(hashtext(${BUDGET_LOCK_NAME})");
    expect(raceTest).toContain("FROM pg_locks");
    expect(raceTest).toContain("waitForBudgetLockWaiters(2)");
    // `backend_xid IS NULL` is the clause that makes the barrier discriminating
    // rather than decorative: a cross-connection row count cannot see an
    // uncommitted insert under READ COMMITTED, but a backend that has written
    // already holds a transaction id. Drop this and "took the lock after the
    // insert" stops being detectable.
    expect(raceTest).toContain("backend_xid IS NULL");
  });

  it("keeps the barrier as the first clock to expire on the failure path", () => {
    const raceTest = repoFile(raceTestPath);
    const readMs = (name: string) => {
      const match = new RegExp(`const ${name} = ([\\d_]+);`).exec(raceTest);
      expect(match, `${name} must stay a literal millisecond constant`).not.toBe(
        null,
      );
      return Number(match![1].replaceAll("_", ""));
    };
    const barrierMs = readMs("LOCK_POLL_TIMEOUT_MS");
    const suiteMs = readMs("RACE_TEST_TIMEOUT_MS");

    // Each reserver runs on Prisma's default 5s interactive-transaction
    // timeout, and the time it spends blocked on the advisory lock counts
    // against that. A barrier budget close to 5s means a loaded runner reports
    // "0 winners" from two P2028 timeouts instead of naming the missing lock.
    expect(barrierMs).toBeLessThanOrEqual(2_500);
    // Vitest's per-test default is 5000ms (vitest.config.mts sets none), so the
    // race describe must declare its own, comfortably above the barrier, or a
    // generic "Test timed out" pre-empts the named diagnostic.
    expect(suiteMs).toBeGreaterThanOrEqual(barrierMs * 4);
    expect(raceTest).toContain("{ timeout: RACE_TEST_TIMEOUT_MS },");
  });
});

describe("real-Postgres read-only SEAM proof stays wired into CI (AID-8 F2)", () => {
  // Exactly the #2532 budget-race guard shape, for the AID-7b seam proof
  // (`ai-diagnostics-readonly-seam.realdb.test.ts`). That suite is `describe.skip`
  // unless RUN_CONCURRENCY_RACE_TESTS=1, and it reaches CI ONLY because
  // `concurrency-lock-races.realdb.test.ts` imports it. `review-findings-contracts`
  // pins the WORKFLOW STEP that runs the concurrency harness, but nothing pinned the
  // IMPORT EDGE: delete that one `import` line and the server-level proof (25006
  // write-refusal, repeatable-read, statement_timeout) silently stops running while
  // every suite still reports green. This is that missing pin.
  function repoFile(relativePath: string) {
    // Test helper: reads a fixed repo file under process.cwd(); the path is
    // test-controlled, not user input.
    return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
  }

  it("is imported by the guarded hosted-PostgreSQL harness the CI step runs", () => {
    const harness = repoFile("src/lib/__tests__/concurrency-lock-races.realdb.test.ts");
    expect(harness).toContain(
      'import "./ai-diagnostics-readonly-seam.realdb.test";',
    );

    // And the harness itself is what the CI step runs, pinned alongside the
    // budget-race guard above so both edges of the chain are covered.
    const workflow = repoFile(".github/workflows/ci.yml");
    expect(workflow).toContain(
      "npx vitest run src/lib/__tests__/concurrency-lock-races.realdb.test.ts",
    );
    expect(workflow).toContain('RUN_CONCURRENCY_RACE_TESTS: "1"');
  });

  it("keeps its opt-in + dedicated-loopback-database guards", () => {
    const seamTest = repoFile(
      "src/lib/__tests__/ai-diagnostics-readonly-seam.realdb.test.ts",
    );
    // Opt-in only, dedicated database only — ordinary `npm test` must never need a
    // live PostgreSQL to keep this proof honest.
    expect(seamTest).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(seamTest).toContain("CONCURRENCY_RACE_DATABASE_URL");
    expect(seamTest).toContain("concurrency_race_1881");
    // The proof's teeth: a real INSERT refused with 25006 on a connection whose
    // privileges would otherwise permit it. A rewrite that dropped this would make
    // the suite pass without proving the READ ONLY fence takes at the server.
    expect(seamTest).toContain("25006");
  });
});
