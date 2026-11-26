/**
 * The request schemas of the Support area's AI settings routes: the page-help
 * assistant's monthly spend cap, AI Diagnostics' monthly budget, and the
 * NZD-to-club-currency rate both are counted in (ALP-724, `INV-MCP-006`).
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). No database or server
 * imports, so the catalogue can load it.
 */
import { z } from "zod";

import {
  AI_ASSISTANT_MAX_MONTHLY_BUDGET_CENTS,
  AI_DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS,
} from "@/config/ai-spend";

/**
 * `PUT /api/admin/ai-assistant/settings`. Integer cents of the club's
 * configured currency (#3354); 0 turns paid answers off.
 */
export const helpAssistantBudgetUpdateSchema = z
  .object({
    monthlyBudgetCents: z
      .number()
      .int()
      .min(0)
      .max(AI_ASSISTANT_MAX_MONTHLY_BUDGET_CENTS)
      .describe("The page-help assistant's monthly spend cap in cents of the club's currency. 0 turns paid answers off."),
  })
  .strict();

/**
 * `PUT /api/admin/ai-diagnostics/settings`. Integer cents of the club's
 * configured currency (#3354); 0 turns paid diagnostics calls off (the ship
 * default).
 */
export const diagnosticsBudgetUpdateSchema = z
  .object({
    monthlyBudgetCents: z
      .number()
      .int()
      .min(0)
      .max(AI_DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS)
      .describe("AI Diagnostics' monthly budget in cents of the club's currency. 0 turns paid calls off."),
  })
  .strict();

/**
 * `PUT /api/admin/ai-spend-currency`. The decimal as typed ("0.92"): the
 * route's canonical parser is what rejects zero, a sign, a symbol,
 * over-precision and anything above the bound.
 */
export const aiSpendCurrencyUpdateSchema = z
  .object({
    clubUnitsPerNzd: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .describe("How many units of the club's currency one New Zealand dollar buys, as a decimal such as \"0.92\"."),
  })
  .strict();
