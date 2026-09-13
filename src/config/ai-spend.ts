/**
 * The two AI modules' default monthly spend caps, in integer cents of the
 * club's configured currency (#3354, INV-CONFIG-001, INV-SSOT-001).
 *
 * ONE home, and a client-safe one: the module descriptions in
 * `src/config/modules.ts` render these defaults through `formatCents` in the
 * admin UI, and the two metering libraries (`ai-assistant-usage.ts`,
 * `ai-diagnostics-usage.ts`) fall back to them when no settings row is stored.
 * Neither library can be imported by a client component (both reach Prisma), so
 * the values live here rather than being restated in the descriptions as prose.
 *
 * Each mirrors its Prisma column default (`AiAssistantSettings.monthlyBudgetCents`
 * `@default(1000)`, `DiagnosticsSettings.monthlyBudgetCents` `@default(0)`);
 * change both together.
 */

/**
 * Page-help AI assistant: 10.00 in the club's currency (NZ$10 for a New Zealand
 * club) so the assistant works out of the box once a key is stored.
 */
export const AI_ASSISTANT_DEFAULT_MONTHLY_BUDGET_CENTS = 1000;

/**
 * AI Diagnostics: 0 = hard-off. A paid, admin-only product ships with NO budget
 * so enabling the module can never, by itself, authorise spend.
 */
export const AI_DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS = 0;
