/**
 * What the Support area's AI settings officer actions return (ALP-724,
 * `INV-MCP-006`): the page-help assistant's spend cap and usage, AI
 * Diagnostics' readiness and budget, and the NZD-to-club-currency rate both
 * are counted in. The catalogue entry and the route's `connectionJson` both
 * read these (`INV-SSOT`).
 *
 * Kept: the figures an officer reads on the two settings pages. Dropped: the
 * id of the member who last saved a setting, and each failed page-help
 * question's page address (the questions themselves are never stored).
 *
 * Types only from the lib modules: nothing here reaches the database.
 */
import type { getAiUsageSummary } from "@/lib/ai-assistant-usage";
import type { DiagnosticsReadiness } from "@/lib/ai-diagnostics-config";
import type { getDiagnosticsUsageSummary } from "@/lib/ai-diagnostics-usage";
import {
  completeConnectionShapeFor,
  connectionShapeFor,
  type ConnectionShapeFor,
} from "@/lib/connection-projection";

// ---------------------------------------------------------------------------
// Page-help assistant
// ---------------------------------------------------------------------------

/** The page-help assistant's spend cap, as its settings route answers it. */
export interface HelpAssistantSettingsAnswer {
  monthlyBudgetCents: number;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

export const HELP_ASSISTANT_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<HelpAssistantSettingsAnswer>({
  monthlyBudgetCents: true,
  updatedAt: true,
});

type HelpAssistantUsage = Awaited<ReturnType<typeof getAiUsageSummary>>;

export const HELP_ASSISTANT_USAGE_CONNECTION_SHAPE = connectionShapeFor<HelpAssistantUsage>({
  budget: { limitCents: true, warningThresholds: true },
  month: {
    month: true,
    requestCount: true,
    failedCount: true,
    inputTokens: true,
    outputTokens: true,
    cacheWriteTokens: true,
    cacheReadTokens: true,
    costCents: true,
    usagePercent: true,
    budgetStatus: true,
  },
  recentFailures: {
    id: true,
    surface: true,
    model: true,
    errorCode: true,
    statusCode: true,
    errorMessage: true,
    createdAt: true,
  },
  bySurface: { surface: true, count: true, successCount: true, failureCount: true },
});

// ---------------------------------------------------------------------------
// AI Diagnostics
// ---------------------------------------------------------------------------

/** Every field: the readiness answer carries states, never a secret or role name. */
export const DIAGNOSTICS_READINESS_CONNECTION_SHAPE = completeConnectionShapeFor<DiagnosticsReadiness>({
  ready: true,
  moduleEnabled: true,
  keyState: true,
  monthlyBudgetCents: true,
  databaseState: true,
  blockers: true,
});

type DiagnosticsUsage = Awaited<ReturnType<typeof getDiagnosticsUsageSummary>>;

/** AI Diagnostics' budget as its settings route answers it; the read adds `usage`. */
export interface DiagnosticsSettingsAnswer {
  monthlyBudgetCents: number;
  maxMonthlyBudgetCents?: number;
  updatedAt: string | null;
  updatedByMemberId: string | null;
  usage?: DiagnosticsUsage;
}

const DIAGNOSTICS_USAGE_SHAPE = {
  budget: { limitCents: true, warningThresholds: true, worstCaseRoundtripCents: true, maxToolRounds: true },
  month: {
    month: true,
    requestCount: true,
    roundtripCount: true,
    failedCount: true,
    inputTokens: true,
    outputTokens: true,
    cacheWriteTokens: true,
    cacheReadTokens: true,
    settledCents: true,
    activeReservedCents: true,
    usagePercent: true,
    budgetStatus: true,
  },
  recentFailures: {
    id: true,
    surface: true,
    model: true,
    errorCode: true,
    statusCode: true,
    errorMessage: true,
    createdAt: true,
  },
} as const satisfies ConnectionShapeFor<DiagnosticsUsage>;

export const DIAGNOSTICS_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<DiagnosticsSettingsAnswer>({
  monthlyBudgetCents: true,
  maxMonthlyBudgetCents: true,
  updatedAt: true,
  usage: DIAGNOSTICS_USAGE_SHAPE,
});

export const DIAGNOSTICS_SETTINGS_SAVED_CONNECTION_SHAPE = connectionShapeFor<DiagnosticsSettingsAnswer>({
  monthlyBudgetCents: true,
  updatedAt: true,
});

// ---------------------------------------------------------------------------
// The AI spend conversion rate
// ---------------------------------------------------------------------------

/** The rate as the route answers it, read or saved. */
export interface AiSpendCurrencyAnswer {
  clubCurrency: string;
  isNzd: boolean;
  isConfigured: boolean;
  clubUnitsPerNzdMicros: number;
  clubUnitsPerNzd: string;
  rateSetAt: string | null;
  rateSetByMemberId: string | null;
}

export const AI_SPEND_CURRENCY_CONNECTION_SHAPE = connectionShapeFor<AiSpendCurrencyAnswer>({
  clubCurrency: true,
  isNzd: true,
  isConfigured: true,
  clubUnitsPerNzdMicros: true,
  clubUnitsPerNzd: true,
  rateSetAt: true,
});
