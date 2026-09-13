/**
 * AI Diagnostics metering, cost estimation, and the CONCURRENCY-SAFE monthly
 * budget reservation (AID-2, #2371, epic #2369).
 *
 * A SEPARATE metering lane from the page-help AI assistant (`ai-assistant-usage.ts`).
 * It deliberately does NOT reuse the page-help one-call soft reserve, because a
 * diagnostics session is a MULTI-TOOL AGENTIC LOOP: it makes several paid provider
 * roundtrips, and a burst of concurrent sessions must not be able to overspend the
 * monthly budget. So:
 *
 *  - Budget RESERVES per provider ROUNDTRIP, not per session. Each paid roundtrip
 *    claims its worst-case cost BEFORE the provider call and settles the actual
 *    cost afterwards.
 *  - The reserve is a GUARDED CLAIM under a per-month advisory lock
 *    (docs/CONCURRENCY_AND_LOCKING.md): read live reservations + settled spend,
 *    check the sum against the budget, and insert the reservation — all atomic
 *    against every other reserver, so N concurrent reserves can never push
 *    `settled + reserved` over the budget. A denied reserve runs NO side effect.
 *  - The multi-tool loop is BOUNDED by DIAGNOSTICS_MAX_TOOL_ROUNDS, so a single
 *    session's worst-case spend is bounded (rounds x worst-case roundtrip) and the
 *    monthly budget bounds the sum across all sessions.
 *  - Every read/write FAILS CLOSED: a metering fault, missing delegate, or DB
 *    error denies the paid call (can't-meter / can't-prove-under-budget ⇒
 *    don't-spend), and a metering circuit breaker stops the route once usage can
 *    no longer be recorded.
 *
 * All money is club-currency integer cents (#3354, `INV-CONFIG-001`): the price
 * table below is in NZD cents, and every estimate — the worst-case reservation
 * and the settled cost — is converted ONCE per roundtrip through the
 * administrator-set NZD -> club-currency rate (`ai-spend-currency.ts`) before
 * it is reserved, booked or compared with the budget. Usage rows record the
 * club-currency cost at the rate in force when they were written and are never
 * rescaled. NO raw prompt, answer, tool arg/result, or provider payload is ever
 * stored — only approved metering metadata.
 */

import { prisma } from "@/lib/prisma";
import { APP_TIME_ZONE } from "@/config/operational";
import { AI_DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS } from "@/config/ai-spend";
import { convertNzdCentsToClubCents } from "@/lib/ai-spend-currency";
import { loadAiSpendCurrency } from "@/lib/ai-spend-currency-settings";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { reportAiError } from "@/lib/observability-bridge";
import type { AiUsage } from "@/lib/anthropic-client";

export const DIAGNOSTICS_SETTINGS_ID = "default";

/**
 * Default monthly budget when no DiagnosticsSettings row is stored: 0 =
 * hard-off. Unlike page-help (which defaults to 10.00 in the club's currency so
 * it works out of the box), a paid, admin-only diagnostics product ships with NO
 * budget so that enabling the module can never, by itself, authorise spend —
 * the operator sets a budget deliberately. This is a fail-closed default. The
 * value's one home is `src/config/ai-spend.ts`, which the module descriptions
 * also render.
 */
export const DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS =
  AI_DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS;

/**
 * Upper guard on the monthly budget a fat-finger can set (5,000.00 in the
 * club's currency). Diagnostics reasons over code with tools, so it can cost
 * materially more per session than a grounded page-help answer — the ceiling
 * is higher than page-help's 1,000.00, but still bounded.
 */
export const DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS = 500_000;

const WARNING_THRESHOLDS = [0.7, 0.85, 0.95] as const;

/**
 * How long a per-roundtrip reservation stays live before the reserve path's
 * opportunistic sweep may reclaim it. It is a CRASH-SAFETY backstop, not the
 * normal release path: a healthy call settles (and deletes) its reservation in
 * seconds. It only matters if a process dies between reserve and settle — the
 * reservation would otherwise pin worst-case budget for the rest of the month.
 * Comfortably longer than the provider wall-clock ceiling so a slow-but-alive
 * call is never reclaimed out from under itself.
 */
export const DIAGNOSTICS_RESERVATION_TTL_MS = 5 * 60 * 1000;

/**
 * NZD integer cents per MILLION tokens, per model. Derived from Anthropic's USD
 * list prices multiplied by a deliberately conservative FX of 1.8 NZD/USD (same
 * FX as page-help `ai-assistant-usage.ts`), so the estimate over-counts the true
 * bill and the cap trips early. UPDATE THIS TABLE whenever Anthropic changes
 * prices or the FX drifts materially.
 *
 * USD list prices (input / output / cache-write=1.25x input / cache-read=0.1x
 * input) per MTok, as of the AID-2 cost math:
 *   claude-opus-5:   $5.00 / $25.00 / $6.25 / $0.50
 *   claude-sonnet-5: $3.00 / $15.00 / $3.75 / $0.30
 *   claude-haiku-4-5:$1.00 / $5.00  / $1.25 / $0.10
 *
 * AID-7 (#2378) finalised the diagnostics model as `claude-sonnet-5`. An UNKNOWN
 * model is priced at the highest known row (fail-expensive), so a model swap never
 * silently under-counts.
 */
export const AI_DIAGNOSTICS_PRICE_TABLE_NZ_CENTS_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-opus-5": { input: 900, output: 4500, cacheWrite: 1125, cacheRead: 90 },
  "claude-sonnet-5": { input: 540, output: 2700, cacheWrite: 675, cacheRead: 54 },
  "claude-haiku-4-5": { input: 180, output: 900, cacheWrite: 225, cacheRead: 18 },
};

/**
 * Conservative per-roundtrip token bounds used to size the pre-call reservation.
 * Only bounded, permission-scoped excerpts and tool results reach the provider
 * (epic #2369 boundary), so a roundtrip's input is bounded; the tool/UI issues
 * enforce the real request caps. These are the reservation ceiling, reconciled
 * by post-call metering.
 */
export const DIAGNOSTICS_MAX_INPUT_TOKENS_PER_ROUNDTRIP = 32_000;
export const DIAGNOSTICS_MAX_OUTPUT_TOKENS_PER_ROUNDTRIP = 8_000;

/**
 * Hard cap on provider roundtrips in one diagnostics session. Bounds the
 * multi-tool loop so a single session's worst-case spend is
 * DIAGNOSTICS_MAX_TOOL_ROUNDS x WORST_CASE_ROUNDTRIP_CENTS, and the monthly
 * budget bounds the sum across sessions. The product loop MUST stop reserving at
 * this round count.
 */
export const DIAGNOSTICS_MAX_TOOL_ROUNDS = 8;

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** Per-field max across all known rows — used for an unknown model (fail-expensive). */
function highestPriceRow() {
  const rows = Object.values(AI_DIAGNOSTICS_PRICE_TABLE_NZ_CENTS_PER_MTOK);
  return {
    input: Math.max(...rows.map((r) => r.input)),
    output: Math.max(...rows.map((r) => r.output)),
    cacheWrite: Math.max(...rows.map((r) => r.cacheWrite)),
    cacheRead: Math.max(...rows.map((r) => r.cacheRead)),
  };
}

/**
 * Estimated NZD cents for one roundtrip — the price table's currency, before
 * the club-currency conversion `settleDiagnosticsRoundtrip` applies. Math.ceil
 * of the summed per-token cost; a minimum of 1 cent whenever ANY usage is
 * present (so a real call is never free in the ledger); 0 only when every token
 * count is zero. An unknown model is priced at the highest known row —
 * fail-expensive.
 */
export function estimateDiagnosticsCostCents(model: string, usage: AiUsage): number {
  const row = AI_DIAGNOSTICS_PRICE_TABLE_NZ_CENTS_PER_MTOK[model] ?? highestPriceRow();
  const raw =
    (usage.inputTokens * row.input +
      usage.outputTokens * row.output +
      usage.cacheWriteTokens * row.cacheWrite +
      usage.cacheReadTokens * row.cacheRead) /
    1_000_000;
  const anyUsage =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheWriteTokens > 0 ||
    usage.cacheReadTokens > 0;
  if (!anyUsage) return 0;
  return Math.max(1, Math.ceil(raw));
}

/**
 * The worst-case cost of a single provider roundtrip, in NZD cents (the price
 * table's currency; `reserveDiagnosticsBudget` converts it to club cents at the
 * configured rate before reserving) — the amount the pre-call gate RESERVES so
 * a roundtrip that would push spend over the budget is denied BEFORE it is
 * made. Fail-expensive: every input token is priced at the MORE EXPENSIVE of
 * the plain-input and cache-write rates, every output token at the output rate,
 * at the highest-priced known model. Post-call metering reconciles the actual
 * (usually far smaller) cost; this constant only bounds the reservation, never
 * what is charged to the ledger.
 */
export function computeWorstCaseRoundtripCents(): number {
  const row = highestPriceRow();
  const inputRate = Math.max(row.input, row.cacheWrite);
  const raw =
    (DIAGNOSTICS_MAX_INPUT_TOKENS_PER_ROUNDTRIP * inputRate +
      DIAGNOSTICS_MAX_OUTPUT_TOKENS_PER_ROUNDTRIP * row.output) /
    1_000_000;
  return Math.max(1, Math.ceil(raw));
}

export const WORST_CASE_ROUNDTRIP_CENTS = computeWorstCaseRoundtripCents();

// ---------------------------------------------------------------------------
// Month key (Pacific/Auckland)
// ---------------------------------------------------------------------------

const monthKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});

/**
 * The billing month, "YYYY-MM", in the app time zone (Pacific/Auckland). An
 * instant near a UTC month boundary can fall in a different NZ month, so the key
 * is computed in APP_TIME_ZONE, never from getUTCMonth/getMonth.
 */
export function diagnosticsUsageMonthKey(date: Date = new Date()): string {
  const parts = monthKeyFormatter.formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${year}-${month}`;
}

// ---------------------------------------------------------------------------
// Prisma delegate guard (blue/green: the client may predate the models)
// ---------------------------------------------------------------------------

type DiagnosticsPrisma = typeof prisma & {
  diagnosticsSettings?: {
    findUnique?: (args: unknown) => unknown;
  };
  diagnosticsUsageMonthly?: {
    findUnique?: (args: unknown) => unknown;
    upsert?: (args: unknown) => unknown;
  };
  diagnosticsUsageEvent?: {
    create?: (args: unknown) => unknown;
    findMany?: (args: unknown) => unknown;
  };
  diagnosticsBudgetReservation?: {
    create?: (args: unknown) => unknown;
    deleteMany?: (args: unknown) => unknown;
    aggregate?: (args: unknown) => unknown;
  };
};

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * The current monthly budget in club-currency integer cents. FAILS CLOSED to the
 * default (0 = no spend) when the settings delegate is unavailable (an old-colour
 * client through a blue/green drain). A DB error propagates to the caller
 * (getDiagnosticsReadiness treats it as not-ready).
 */
export async function loadDiagnosticsBudgetCents(): Promise<number> {
  const p = prisma as DiagnosticsPrisma;
  if (!p.diagnosticsSettings?.findUnique) {
    return DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS;
  }
  const settings = await prisma.diagnosticsSettings.findUnique({
    where: { id: DIAGNOSTICS_SETTINGS_ID },
  });
  return settings?.monthlyBudgetCents ?? DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS;
}

/**
 * The pure budget-admission guard, extracted so it can be exhaustively
 * mutation-tested without a database. A reservation is admitted ONLY when the
 * budget is positive, the reservation is positive, and the entire committed
 * (settled) plus in-flight (active reservations) worst-case spend, PLUS this
 * reservation, stays within the budget. Every term is integer cents.
 *
 * The `<=` is load-bearing: at exact budget the last reservation is admitted, and
 * one cent over is denied. `settledCents + activeReservedCents` is the invariant
 * the advisory lock protects — do not drop either term.
 */
export function decideReservation(params: {
  settledCents: number;
  activeReservedCents: number;
  reserveCents: number;
  budgetCents: number;
}): { allowed: boolean } {
  const { settledCents, activeReservedCents, reserveCents, budgetCents } = params;
  const allowed =
    budgetCents > 0 &&
    reserveCents > 0 &&
    settledCents + activeReservedCents + reserveCents <= budgetCents;
  return { allowed };
}

export type ReserveDiagnosticsBudgetResult =
  | { ok: true; reservationId: string; reserveCents: number; month: string }
  | {
      ok: false;
      reason: "over_budget" | "budget_not_set" | "metering_unavailable";
      budgetCents: number;
    };

export interface ReserveDiagnosticsBudgetInput {
  /**
   * Worst-case CLUB-CURRENCY cents to reserve for this roundtrip. Defaults to
   * WORST_CASE_ROUNDTRIP_CENTS converted at the configured rate (#3354); a
   * caller passing its own figure is responsible for it already being club cents.
   */
  reserveCents?: number;
  now?: Date;
}

/**
 * Reserve one provider roundtrip's worst-case cost against the monthly budget,
 * CONCURRENCY-SAFELY. Under a per-month advisory lock it reclaims expired
 * reservations, sums the live reservations + settled spend, and — only if that
 * sum plus this reservation stays within budget — inserts a reservation row. A
 * lost claim (over budget / budget not set) inserts NOTHING and returns
 * `ok: false`. Any fault fails closed to `metering_unavailable`.
 *
 * The caller makes the provider call AFTER this returns `ok: true` (outside any
 * DB transaction), then calls `settleDiagnosticsRoundtrip` (success or failure)
 * to release the reservation and book the real cost. A reservation that is
 * abandoned WITHOUT a provider request (or whose settle never lands) is reclaimed
 * by the next reserve's expiry sweep once `DIAGNOSTICS_RESERVATION_TTL_MS` passes,
 * so it self-heals rather than pinning worst-case budget for the month.
 */
export async function reserveDiagnosticsBudget(
  input: ReserveDiagnosticsBudgetInput = {},
): Promise<ReserveDiagnosticsBudgetResult> {
  const now = input.now ?? new Date();
  const month = diagnosticsUsageMonthKey(now);

  const p = prisma as DiagnosticsPrisma;
  if (
    !p.diagnosticsBudgetReservation?.create ||
    !p.diagnosticsBudgetReservation?.aggregate ||
    !p.diagnosticsBudgetReservation?.deleteMany ||
    !p.diagnosticsUsageMonthly?.findUnique ||
    !p.diagnosticsSettings?.findUnique
  ) {
    return {
      ok: false,
      reason: "metering_unavailable",
      budgetCents: DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS,
    };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Serialise every reserve for THIS month so the read-check-insert below is
      // atomic against concurrent reservers (guarded-claim discipline,
      // docs/CONCURRENCY_AND_LOCKING.md). Different months do not contend. The
      // lock is transaction-scoped and released on commit; the provider call
      // happens OUTSIDE this transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('diagnostics-budget-reserve'), hashtext(${month}))`;

      // Crash-safety sweep: reclaim expired reservations for this month so a
      // process that died between reserve and settle cannot wedge the budget.
      await tx.diagnosticsBudgetReservation.deleteMany({
        where: { month, expiresAt: { lte: now } },
      });

      // The rate is read HERE, under the same lock and in the same snapshot as
      // the budget (#3354): one primary-key read of a one-row table (and no
      // read at all for an NZD club), so it adds nothing material to the lock
      // hold. It is not part of the invariant the lock protects — every stored
      // term is already club cents — it only sizes THIS reservation.
      const [settings, monthly, activeAgg, currency] = await Promise.all([
        tx.diagnosticsSettings.findUnique({ where: { id: DIAGNOSTICS_SETTINGS_ID } }),
        tx.diagnosticsUsageMonthly.findUnique({ where: { month } }),
        tx.diagnosticsBudgetReservation.aggregate({
          _sum: { reservedCents: true },
          where: { month, expiresAt: { gt: now } },
        }),
        loadAiSpendCurrency(tx),
      ]);

      const budgetCents =
        settings?.monthlyBudgetCents ?? DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS;
      if (budgetCents <= 0) {
        return { ok: false as const, reason: "budget_not_set" as const, budgetCents };
      }

      const reserveCents =
        input.reserveCents ??
        convertNzdCentsToClubCents(
          WORST_CASE_ROUNDTRIP_CENTS,
          currency.clubUnitsPerNzdMicros,
        );
      const settledCents = monthly?.settledCents ?? 0;
      const activeReservedCents = activeAgg._sum.reservedCents ?? 0;

      const { allowed } = decideReservation({
        settledCents,
        activeReservedCents,
        reserveCents,
        budgetCents,
      });
      if (!allowed) {
        return { ok: false as const, reason: "over_budget" as const, budgetCents };
      }

      const reservation = await tx.diagnosticsBudgetReservation.create({
        data: {
          month,
          reservedCents: reserveCents,
          createdAt: now,
          expiresAt: new Date(now.getTime() + DIAGNOSTICS_RESERVATION_TTL_MS),
        },
        select: { id: true },
      });

      return {
        ok: true as const,
        reservationId: reservation.id,
        reserveCents,
        month,
      };
    });
  } catch (err) {
    // Fail closed: a fault reserving means we cannot prove we are under budget,
    // so we do not spend.
    reportAiError({
      tag: "diagnostics-budget-reserve",
      message: "Failed to reserve diagnostics budget",
      err,
      context: { month },
    });
    return {
      ok: false,
      reason: "metering_unavailable",
      budgetCents: DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS,
    };
  }
}

// ---------------------------------------------------------------------------
// Metering circuit breaker
// ---------------------------------------------------------------------------

export const DIAGNOSTICS_METERING_FAILURE_THRESHOLD = 3;
// Per-process counter: each blue/green replica trips its breaker independently.
// The cross-process spend control is the shared-DB reservation gate.
let consecutiveMeteringFailures = 0;

/**
 * Whether diagnostics usage can currently be recorded. Flips to false after
 * DIAGNOSTICS_METERING_FAILURE_THRESHOLD consecutive settle failures and stays
 * false until one settle succeeds. The route checks this BEFORE spending:
 * can't-meter ⇒ don't-spend.
 */
export function isDiagnosticsMeteringHealthy(): boolean {
  return consecutiveMeteringFailures < DIAGNOSTICS_METERING_FAILURE_THRESHOLD;
}

/** Test seam — reset the circuit-breaker state between tests. */
export function resetDiagnosticsMeteringHealthForTests(): void {
  consecutiveMeteringFailures = 0;
}

function recordMeteringFailure(err: unknown, context: Record<string, unknown>): void {
  consecutiveMeteringFailures += 1;
  reportAiError({
    tag: "diagnostics-usage-record",
    message: "Failed to persist AI diagnostics usage metering",
    err,
    context,
  });
}

// ---------------------------------------------------------------------------
// Settle a roundtrip (release reservation + book actual cost + write event)
// ---------------------------------------------------------------------------

const EMPTY_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

export interface SettleDiagnosticsRoundtripInput {
  /**
   * The reservation to release, from `reserveDiagnosticsBudget`. `null` is
   * tolerated (nothing to release) but a paid roundtrip should always carry one.
   */
  reservationId: string | null;
  /** Acting admin — approved audit metadata (accountability). Plain string, no FK. */
  adminMemberId?: string | null;
  surface: string;
  model: string;
  /** 0-based roundtrip index within the session (<= DIAGNOSTICS_MAX_TOOL_ROUNDS). */
  roundIndex?: number | null;
  success: boolean;
  /** Present whenever the provider returned a usage object (even on refusal/max_tokens). */
  usage?: AiUsage;
  errorCode?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  /** Raw provider error message; redacted + truncated before it is stored. */
  errorMessage?: string | null;
  now?: Date;
}

function redactTruncateErrorMessage(message?: string | null): string | null {
  if (!message) return null;
  const redacted = redactSensitiveText(message);
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

/**
 * Settle one provider roundtrip (success OR failure): release its worst-case
 * reservation, write ONE approved-metadata event row, and roll the actual cost
 * into the month singleton — in ONE transaction. Releasing the reservation is
 * idempotent: if the crash-safety sweep already reclaimed it, the delete matches
 * zero rows and the actual cost is still booked. On any failure this reports
 * through the observability bridge AND trips the metering circuit breaker; on
 * success the breaker resets.
 *
 * CONCURRENCY: the transaction's FIRST statement takes the SAME per-month
 * advisory lock as `reserveDiagnosticsBudget`
 * (`pg_advisory_xact_lock(hashtext('diagnostics-budget-reserve'), hashtext(<month>))`),
 * so a settle's reservation-release + `settledCents` increment can never commit
 * BETWEEN a concurrent reserve's two reads (settled spend vs. live reservations).
 * Without it a settle that landed mid-reserve could be counted in NEITHER term —
 * its reservation already deleted, its settled increment not yet in the reserve's
 * READ COMMITTED snapshot — undercounting committed spend and admitting an
 * over-budget roundtrip. Reserve and settle are now mutually exclusive per month.
 * This is the ONLY lock settle takes — the same single key as reserve — so no
 * lock-ordering deadlock is possible, and the provider call has already happened
 * OUTSIDE this transaction. Different months do not contend.
 *
 * NO raw prompt/answer/tool arg/result/provider payload is written — only the
 * approved metadata on the input.
 */
export async function settleDiagnosticsRoundtrip(
  input: SettleDiagnosticsRoundtripInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const month = diagnosticsUsageMonthKey(now);
  const usage = input.usage ?? EMPTY_USAGE;
  const nzdCostCents = input.usage
    ? estimateDiagnosticsCostCents(input.model, input.usage)
    : 0;
  const isFirstRoundtrip = input.roundIndex == null || input.roundIndex === 0;
  const failureContext = {
    surface: input.surface,
    model: input.model,
    success: input.success,
  };

  const p = prisma as DiagnosticsPrisma;
  if (
    !p.diagnosticsUsageEvent?.create ||
    !p.diagnosticsUsageMonthly?.upsert ||
    !p.diagnosticsBudgetReservation?.deleteMany
  ) {
    recordMeteringFailure(new Error("Diagnostics usage delegates unavailable"), failureContext);
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Take the SAME per-month advisory lock as reserveDiagnosticsBudget as the
      // FIRST statement so this settle's reservation-release + settledCents
      // increment cannot commit BETWEEN a concurrent reserve's settled-vs-live
      // reservation reads (which would let the reserve under-count committed
      // spend and admit an over-budget roundtrip). Reserve and settle are thus
      // mutually exclusive per month. This is the ONLY lock settle takes (same
      // single key as reserve) — no lock-ordering deadlock — and the provider
      // call already happened OUTSIDE this transaction. Different months do not
      // contend; the lock releases on commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('diagnostics-budget-reserve'), hashtext(${month}))`;

      // Same snapshot and lock as the reserve's rate read (#3354): the settled
      // cost is booked in club cents at the rate in force now. A failed read
      // fails the settle, which trips the breaker — never books NZD cents.
      const currency = await loadAiSpendCurrency(tx);
      const costCents = convertNzdCentsToClubCents(
        nzdCostCents,
        currency.clubUnitsPerNzdMicros,
      );

      await tx.diagnosticsBudgetReservation.deleteMany({
        // A null reservation matches nothing (sentinel id); a real one is
        // released. Either way the settled cost below still lands.
        where: { id: input.reservationId ?? "__no_reservation__" },
      });
      await tx.diagnosticsUsageEvent.create({
        data: {
          month,
          adminMemberId: input.adminMemberId ?? null,
          surface: input.surface,
          model: input.model,
          roundIndex: input.roundIndex ?? null,
          success: input.success,
          errorCode: input.errorCode ?? null,
          statusCode: input.statusCode ?? null,
          durationMs: input.durationMs ?? null,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          costCents,
          errorMessage: redactTruncateErrorMessage(input.errorMessage),
          createdAt: now,
        },
      });
      await tx.diagnosticsUsageMonthly.upsert({
        where: { month },
        create: {
          month,
          requestCount: isFirstRoundtrip ? 1 : 0,
          roundtripCount: 1,
          failedCount: input.success ? 0 : 1,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          settledCents: costCents,
        },
        update: {
          requestCount: { increment: isFirstRoundtrip ? 1 : 0 },
          roundtripCount: { increment: 1 },
          failedCount: { increment: input.success ? 0 : 1 },
          inputTokens: { increment: usage.inputTokens },
          outputTokens: { increment: usage.outputTokens },
          cacheWriteTokens: { increment: usage.cacheWriteTokens },
          cacheReadTokens: { increment: usage.cacheReadTokens },
          settledCents: { increment: costCents },
        },
      });
    });
    // A successful write clears the breaker.
    consecutiveMeteringFailures = 0;
  } catch (err) {
    recordMeteringFailure(err, failureContext);
  }
}

// ---------------------------------------------------------------------------
// Summary (admin status/readiness panel)
// ---------------------------------------------------------------------------

export type DiagnosticsBudgetStatus = "healthy" | "warning" | "critical" | "exhausted";

function budgetStatusFor(usagePercent: number): DiagnosticsBudgetStatus {
  if (usagePercent >= WARNING_THRESHOLDS[2]) return "exhausted";
  if (usagePercent >= WARNING_THRESHOLDS[1]) return "critical";
  if (usagePercent >= WARNING_THRESHOLDS[0]) return "warning";
  return "healthy";
}

/**
 * Usage summary for the admin diagnostics status panel. Reads the current
 * month's rollup, budget, live reservations, and recent events. NEVER exposes a
 * prompt/answer/tool arg (they are not stored). A DB error propagates to the
 * caller (the admin route wraps it in a 500).
 */
export async function getDiagnosticsUsageSummary(now: Date = new Date()) {
  const month = diagnosticsUsageMonthKey(now);
  const [monthly, settings, reservedAgg, events, currency] = await Promise.all([
    prisma.diagnosticsUsageMonthly.findUnique({ where: { month } }),
    prisma.diagnosticsSettings.findUnique({ where: { id: DIAGNOSTICS_SETTINGS_ID } }),
    prisma.diagnosticsBudgetReservation.aggregate({
      _sum: { reservedCents: true },
      where: { month, expiresAt: { gt: now } },
    }),
    prisma.diagnosticsUsageEvent.findMany({
      where: { month },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
    loadAiSpendCurrency(),
  ]);

  const limitCents = settings?.monthlyBudgetCents ?? DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS;
  const settledCents = monthly?.settledCents ?? 0;
  const activeReservedCents = reservedAgg._sum.reservedCents ?? 0;
  const usagePercent = limitCents > 0 ? settledCents / limitCents : 0;

  return {
    budget: {
      limitCents,
      warningThresholds: [...WARNING_THRESHOLDS],
      // Club cents, like every other figure here (#3354) — the NZD constant
      // converted at the configured rate.
      worstCaseRoundtripCents: convertNzdCentsToClubCents(
        WORST_CASE_ROUNDTRIP_CENTS,
        currency.clubUnitsPerNzdMicros,
      ),
      maxToolRounds: DIAGNOSTICS_MAX_TOOL_ROUNDS,
    },
    month: {
      month,
      requestCount: monthly?.requestCount ?? 0,
      roundtripCount: monthly?.roundtripCount ?? 0,
      failedCount: monthly?.failedCount ?? 0,
      inputTokens: monthly?.inputTokens ?? 0,
      outputTokens: monthly?.outputTokens ?? 0,
      cacheWriteTokens: monthly?.cacheWriteTokens ?? 0,
      cacheReadTokens: monthly?.cacheReadTokens ?? 0,
      settledCents,
      activeReservedCents,
      usagePercent,
      budgetStatus: budgetStatusFor(usagePercent),
    },
    recentFailures: events
      .filter((event) => !event.success)
      .slice(0, 5)
      .map((event) => ({
        id: event.id,
        surface: event.surface,
        model: event.model,
        errorCode: event.errorCode,
        statusCode: event.statusCode,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
      })),
  };
}
