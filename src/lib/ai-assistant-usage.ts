/**
 * AI help assistant metering, cost estimation, and the hard monthly spend cap
 * (#2211, epic #2094 C3). Cloned from the Xero API-usage metering pattern
 * (`xero-api-usage.ts`), with the money-safety gaps closed:
 *  - every read/write FAILS CLOSED (a metering fault must never let paid spend
 *    continue unmetered);
 *  - cost is deliberately OVER-counted (conservative NZD FX, ceil, fail-expensive
 *    for an unknown model), so the cap trips early rather than late;
 *  - a circuit breaker stops the route spending once metering can no longer be
 *    written ("can't-meter ⇒ don't-spend").
 *
 * All money is club-currency integer cents (#3354, `INV-CONFIG-001`): the price
 * table below is in NZD cents, and every estimate is converted ONCE through the
 * administrator-set NZD -> club-currency rate (`ai-spend-currency.ts`) before
 * it is booked to the ledger or compared with the cap, so the cap an admin
 * enters in the club's own money is compared with spend in that money. Usage
 * rows record the club-currency cost at the rate in force when they were
 * written and are never rescaled. The question text is NEVER stored — only its
 * character count.
 */

import { prisma } from "@/lib/prisma";
import { APP_TIME_ZONE } from "@/config/operational";
import { AI_ASSISTANT_DEFAULT_MONTHLY_BUDGET_CENTS } from "@/config/ai-spend";
import { convertNzdCentsToClubCents } from "@/lib/ai-spend-currency";
import { loadAiSpendCurrency } from "@/lib/ai-spend-currency-settings";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { reportAiError } from "@/lib/observability-bridge";
import type { AiUsage } from "@/lib/anthropic-client";

/**
 * Default monthly budget when no AiAssistantSettings row is stored: 10.00 in
 * the club's currency (NZ$10 for a New Zealand club). The value's one home is
 * `src/config/ai-spend.ts`, which the module descriptions also render.
 */
export const DEFAULT_MONTHLY_BUDGET_CENTS = AI_ASSISTANT_DEFAULT_MONTHLY_BUDGET_CENTS;

const WARNING_THRESHOLDS = [0.7, 0.85, 0.95] as const;

/**
 * NZD integer cents per MILLION tokens, per model. Derived from Anthropic's USD
 * list prices multiplied by a deliberately conservative FX of 1.8 NZD/USD, so
 * the estimate over-counts the true bill and the cap trips early. UPDATE THIS
 * TABLE whenever Anthropic changes prices (or the FX drifts materially).
 *
 * claude-haiku-4-5 USD list: input $1.00, output $5.00, cache-write $1.25
 * (1.25x input), cache-read $0.10 (0.1x input) per MTok.
 */
export const AI_PRICE_TABLE_NZ_CENTS_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-haiku-4-5": { input: 180, output: 900, cacheWrite: 225, cacheRead: 18 },
};

/**
 * A conservative worst-case cost for a single call, in NZD cents (the price
 * table's currency; `checkAiBudget` converts it to club cents at the configured
 * rate before comparing). The pre-call budget gate reserves this so a call that
 * would push spend over the cap is denied BEFORE it is made (we cannot know the
 * real cost until the call returns). A typical Latin-text call costs ~2c; an
 * adversarial dense-Unicode question (CJK/emoji at ~1.8-2 tokens/char) hitting
 * the zod input caps and the 512-output ceiling can reach ~10c, so 16c restores
 * true worst-case headroom. Post-call metering reconciles the actual cost
 * regardless — this constant only bounds the pre-call reservation, never what
 * is charged to the ledger.
 */
export const WORST_CASE_CALL_CENTS = 16;

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
export function aiUsageMonthKey(date: Date = new Date()): string {
  const parts = monthKeyFormatter.formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${year}-${month}`;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** Per-field max across all known rows — used for an unknown model (fail-expensive). */
function highestPriceRow() {
  const rows = Object.values(AI_PRICE_TABLE_NZ_CENTS_PER_MTOK);
  return {
    input: Math.max(...rows.map((r) => r.input)),
    output: Math.max(...rows.map((r) => r.output)),
    cacheWrite: Math.max(...rows.map((r) => r.cacheWrite)),
    cacheRead: Math.max(...rows.map((r) => r.cacheRead)),
  };
}

/**
 * Estimated NZD cents for one call — the price table's currency, before the
 * club-currency conversion `recordAiUsage` applies. Math.ceil of the summed
 * per-token cost; a minimum of 1 cent whenever ANY usage is present (so a real
 * call is never free in the ledger); 0 only when every token count is zero. An
 * unknown model is priced at the highest known row — fail-expensive, so a model
 * swap never silently under-counts.
 */
export function estimateAiCostCents(model: string, usage: AiUsage): number {
  const row = AI_PRICE_TABLE_NZ_CENTS_PER_MTOK[model] ?? highestPriceRow();
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

// ---------------------------------------------------------------------------
// Prisma delegate guard (blue/green: the client may predate the models)
// ---------------------------------------------------------------------------

type AiUsagePrisma = typeof prisma & {
  aiAssistantUsageEvent?: {
    create: (args: unknown) => unknown;
    findMany?: (args: unknown) => unknown;
  };
  aiAssistantUsageMonthly?: {
    upsert: (args: unknown) => unknown;
    findUnique?: (args: unknown) => unknown;
  };
  aiAssistantSettings?: {
    findUnique?: (args: unknown) => unknown;
  };
  // aiSpendCurrencySettings is NOT guarded here: `loadAiSpendCurrency` falls
  // back to the identity rate itself when its delegate is missing (#3354).
};

// ---------------------------------------------------------------------------
// Budget gate (FAILS CLOSED)
// ---------------------------------------------------------------------------

export interface AiBudgetState {
  allowed: boolean;
  spentCents: number;
  budgetCents: number;
}

/**
 * Whether another paid call is within the monthly budget. FAILS CLOSED — a
 * missing delegate, a DB error, or any unexpected fault returns
 * `{ allowed: false }` (mirrors `loadEffectiveModuleFlags`'s disable-on-error).
 * Denies when `spentCents + worstCase > budgetCents`, reserving the worst-case
 * cost of the in-flight call — `WORST_CASE_CALL_CENTS` converted to club cents
 * at the configured rate, read once here alongside the settings (#3354). Both
 * `spentCents` (booked at conversion time) and `budgetCents` (entered by the
 * admin) are already club cents.
 *
 * SOFT CAP: this is a read-then-spend gate, not a lock. N concurrent in-flight
 * calls can each pass here before any of their metering lands, so spend can
 * overshoot the cap — but only by cents: each overshoot is bounded by the
 * per-call WORST_CASE reserve, and N is bounded by the per-member/IP/global rate
 * limiters. The Anthropic console spend limit is the hard backstop.
 */
export async function checkAiBudget(
  now: Date = new Date(),
): Promise<AiBudgetState> {
  const p = prisma as AiUsagePrisma;
  if (!p.aiAssistantUsageMonthly?.findUnique || !p.aiAssistantSettings?.findUnique) {
    return { allowed: false, spentCents: 0, budgetCents: DEFAULT_MONTHLY_BUDGET_CENTS };
  }
  try {
    const [monthly, settings, currency] = await Promise.all([
      prisma.aiAssistantUsageMonthly.findUnique({
        where: { month: aiUsageMonthKey(now) },
      }),
      prisma.aiAssistantSettings.findUnique({ where: { id: "default" } }),
      loadAiSpendCurrency(),
    ]);
    const budgetCents = settings?.monthlyBudgetCents ?? DEFAULT_MONTHLY_BUDGET_CENTS;
    const spentCents = monthly?.costCents ?? 0;
    const worstCaseClubCents = convertNzdCentsToClubCents(
      WORST_CASE_CALL_CENTS,
      currency.clubUnitsPerNzdMicros,
    );
    return {
      allowed: spentCents + worstCaseClubCents <= budgetCents,
      spentCents,
      budgetCents,
    };
  } catch {
    // Fail closed: if we cannot read the ledger we cannot prove we are under
    // budget, so we do not spend.
    return {
      allowed: false,
      spentCents: 0,
      budgetCents: DEFAULT_MONTHLY_BUDGET_CENTS,
    };
  }
}

// ---------------------------------------------------------------------------
// Metering circuit breaker
// ---------------------------------------------------------------------------

const AI_METERING_FAILURE_THRESHOLD = 3;
// Per-process counter: each blue/green replica trips its breaker independently.
// The cross-process spend control is the shared-DB budget gate (checkAiBudget).
let consecutiveMeteringFailures = 0;

/**
 * Whether AI usage can currently be recorded. Flips to false after
 * AI_METERING_FAILURE_THRESHOLD consecutive `recordAiUsage` failures and stays
 * false until one write succeeds. The route checks this BEFORE spending:
 * can't-meter ⇒ don't-spend.
 */
export function isAiMeteringHealthy(): boolean {
  return consecutiveMeteringFailures < AI_METERING_FAILURE_THRESHOLD;
}

/** Test seam — reset the circuit-breaker state between tests. */
export function resetAiMeteringHealthForTests(): void {
  consecutiveMeteringFailures = 0;
}

function recordMeteringFailure(err: unknown, context: Record<string, unknown>): void {
  consecutiveMeteringFailures += 1;
  reportAiError({
    tag: "ai-usage-record",
    message: "Failed to persist AI assistant usage metering",
    err,
    context,
  });
}

// ---------------------------------------------------------------------------
// Record usage
// ---------------------------------------------------------------------------

const EMPTY_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

export interface RecordAiUsageInput {
  memberId?: string | null;
  surface: string;
  pathname: string;
  model: string;
  success: boolean;
  /** Present whenever the provider returned a usage object (even on refusal/max_tokens). */
  usage?: AiUsage;
  errorCode?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  /** question.length — the question text itself is never stored. */
  questionChars?: number | null;
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
 * Persist one AI call (success OR failure) as an event row and roll it into the
 * month singleton, in ONE transaction. Cost is recorded whenever a usage object
 * is present (a refusal or a max_tokens truncation still billed input) and 0
 * only for a token-free error. The NZD estimate is converted to club cents at
 * the configured rate, read once per call (#3354); a failure to read the rate
 * is a metering failure like any other, so it trips the breaker rather than
 * booking an unconverted figure. On any failure this reports through the
 * observability bridge AND trips the metering circuit breaker; on success the
 * breaker resets.
 */
export async function recordAiUsage(input: RecordAiUsageInput): Promise<void> {
  const now = input.now ?? new Date();
  const month = aiUsageMonthKey(now);
  const usage = input.usage ?? EMPTY_USAGE;
  const nzdCostCents = input.usage ? estimateAiCostCents(input.model, input.usage) : 0;
  const failureContext = {
    surface: input.surface,
    model: input.model,
    success: input.success,
  };

  const p = prisma as AiUsagePrisma;
  if (!p.aiAssistantUsageEvent?.create || !p.aiAssistantUsageMonthly?.upsert) {
    recordMeteringFailure(new Error("AI usage delegates unavailable"), failureContext);
    return;
  }

  try {
    const currency = await loadAiSpendCurrency();
    const costCents = convertNzdCentsToClubCents(
      nzdCostCents,
      currency.clubUnitsPerNzdMicros,
    );
    await prisma.$transaction([
      prisma.aiAssistantUsageEvent.create({
        data: {
          month,
          memberId: input.memberId ?? null,
          surface: input.surface,
          pathname: input.pathname,
          model: input.model,
          success: input.success,
          errorCode: input.errorCode ?? null,
          statusCode: input.statusCode ?? null,
          durationMs: input.durationMs ?? null,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          costCents,
          questionChars: input.questionChars ?? null,
          errorMessage: redactTruncateErrorMessage(input.errorMessage),
          createdAt: now,
        },
      }),
      prisma.aiAssistantUsageMonthly.upsert({
        where: { month },
        create: {
          month,
          requestCount: 1,
          failedCount: input.success ? 0 : 1,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          costCents,
        },
        update: {
          requestCount: { increment: 1 },
          failedCount: { increment: input.success ? 0 : 1 },
          inputTokens: { increment: usage.inputTokens },
          outputTokens: { increment: usage.outputTokens },
          cacheWriteTokens: { increment: usage.cacheWriteTokens },
          cacheReadTokens: { increment: usage.cacheReadTokens },
          costCents: { increment: costCents },
        },
      }),
    ]);
    // A successful write clears the breaker.
    consecutiveMeteringFailures = 0;
  } catch (err) {
    recordMeteringFailure(err, failureContext);
  }
}

// ---------------------------------------------------------------------------
// Summary (admin usage panel — C4)
// ---------------------------------------------------------------------------

export type AiBudgetStatus = "healthy" | "warning" | "critical" | "exhausted";

function budgetStatusFor(usagePercent: number): AiBudgetStatus {
  if (usagePercent >= WARNING_THRESHOLDS[2]) return "exhausted";
  if (usagePercent >= WARNING_THRESHOLDS[1]) return "critical";
  if (usagePercent >= WARNING_THRESHOLDS[0]) return "warning";
  return "healthy";
}

interface SurfaceBucket {
  surface: string;
  count: number;
  successCount: number;
  failureCount: number;
}

function buildSurfaceBuckets(
  events: Array<{ surface: string; success: boolean }>,
): SurfaceBucket[] {
  const buckets = new Map<string, SurfaceBucket>();
  for (const event of events) {
    const bucket = buckets.get(event.surface) ?? {
      surface: event.surface,
      count: 0,
      successCount: 0,
      failureCount: 0,
    };
    bucket.count += 1;
    if (event.success) bucket.successCount += 1;
    else bucket.failureCount += 1;
    buckets.set(event.surface, bucket);
  }
  return Array.from(buckets.values()).sort(
    (a, b) => b.count - a.count || a.surface.localeCompare(b.surface),
  );
}

/**
 * Usage summary for the admin AI panel (C4). Reads the current month's rollup,
 * budget, and recent events. NEVER exposes question text (it is not stored).
 * A DB error propagates to the caller (the admin route wraps it in a 500).
 */
export async function getAiUsageSummary(now: Date = new Date()) {
  const month = aiUsageMonthKey(now);
  const [monthly, settings, events] = await Promise.all([
    prisma.aiAssistantUsageMonthly.findUnique({ where: { month } }),
    prisma.aiAssistantSettings.findUnique({ where: { id: "default" } }),
    prisma.aiAssistantUsageEvent.findMany({
      where: { month },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
  ]);

  const limitCents = settings?.monthlyBudgetCents ?? DEFAULT_MONTHLY_BUDGET_CENTS;
  const costCents = monthly?.costCents ?? 0;
  const usagePercent = limitCents > 0 ? costCents / limitCents : 0;

  return {
    budget: {
      limitCents,
      warningThresholds: [...WARNING_THRESHOLDS],
    },
    month: {
      month,
      requestCount: monthly?.requestCount ?? 0,
      failedCount: monthly?.failedCount ?? 0,
      inputTokens: monthly?.inputTokens ?? 0,
      outputTokens: monthly?.outputTokens ?? 0,
      cacheWriteTokens: monthly?.cacheWriteTokens ?? 0,
      cacheReadTokens: monthly?.cacheReadTokens ?? 0,
      costCents,
      usagePercent,
      budgetStatus: budgetStatusFor(usagePercent),
    },
    recentFailures: events
      .filter((event) => !event.success)
      .slice(0, 5)
      .map((event) => ({
        id: event.id,
        surface: event.surface,
        pathname: event.pathname,
        model: event.model,
        errorCode: event.errorCode,
        statusCode: event.statusCode,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
      })),
    bySurface: buildSurfaceBuckets(events),
  };
}
