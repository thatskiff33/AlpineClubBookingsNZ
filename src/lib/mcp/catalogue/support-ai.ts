/**
 * The Support area's AI settings: the page-help assistant's spend cap and
 * usage, AI Diagnostics' readiness and budget, and the conversion rate both
 * are counted in. Part of the Support & System officer actions (ALP-724):
 * spread into `MCP_ACTIONS`.
 *
 * Kinds: every change here is `destructive`. Each is club-wide configuration
 * that decides how much the club may spend on AI, which an officer's app may
 * change only after asking the officer first (owner decision, #5305 comment
 * 7093303964). Asking AI Diagnostics a question is website-only
 * (`site-helper` in `exclusions.ts`): the connected app answers itself.
 */
import { AI_ASSISTANT_MAX_MONTHLY_BUDGET_CENTS } from "@/config/ai-spend";
import {
  aiSpendCurrencyUpdateSchema,
  diagnosticsBudgetUpdateSchema,
  helpAssistantBudgetUpdateSchema,
} from "@/lib/admin-support-api/ai-settings";
import {
  AI_SPEND_CURRENCY_CONNECTION_SHAPE,
  DIAGNOSTICS_READINESS_CONNECTION_SHAPE,
  DIAGNOSTICS_SETTINGS_CONNECTION_SHAPE,
  DIAGNOSTICS_SETTINGS_SAVED_CONNECTION_SHAPE,
  HELP_ASSISTANT_SETTINGS_CONNECTION_SHAPE,
  HELP_ASSISTANT_USAGE_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/support-ai";

import type { McpAction } from "../catalogue";

export const SUPPORT_AI_MCP_ACTIONS: readonly McpAction[] = [
  // --- Page-help assistant -------------------------------------------------
  {
    id: "get_help_assistant_budget",
    title: "Read the help assistant's spend cap",
    summary:
      "Officer: the website help assistant's monthly spend cap, in cents of the club's currency (0 means paid answers are off), and when it was last changed.",
    method: "GET",
    path: "/api/admin/ai-assistant/settings",
    kind: "read",
    returns: HELP_ASSISTANT_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_help_assistant_budget",
    title: "Change the help assistant's spend cap",
    summary:
      `Officer: sets the website help assistant's monthly spend cap in cents of the club's currency (0 turns paid answers off; at most ${AI_ASSISTANT_MAX_MONTHLY_BUDGET_CENTS}). Answers the saved cap.`,
    method: "PUT",
    path: "/api/admin/ai-assistant/settings",
    body: helpAssistantBudgetUpdateSchema,
    kind: "destructive",
    returns: HELP_ASSISTANT_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_help_assistant_usage",
    title: "Read the help assistant's usage",
    summary:
      "Officer: this month's website help assistant use: requests, failures, tokens and cost in cents against the cap (`usagePercent` from 0 to 1, `budgetStatus`), the five latest failures, and use by surface. The questions asked are never stored.",
    method: "GET",
    path: "/api/admin/ai-assistant/usage",
    kind: "read",
    returns: HELP_ASSISTANT_USAGE_CONNECTION_SHAPE,
    core: false,
  },

  // --- AI Diagnostics -------------------------------------------------------
  {
    id: "get_ai_diagnostics_readiness",
    title: "Check whether AI Diagnostics is ready",
    summary:
      "Officer: whether the AI Diagnostics module can answer questions (`ready`), and if not, why (`blockers`): the module switch (null when it could not be read), the dedicated key's state, the monthly budget, and the database role's state. Never sends a key or connection detail.",
    method: "GET",
    path: "/api/admin/ai-diagnostics/readiness",
    kind: "read",
    returns: DIAGNOSTICS_READINESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_ai_diagnostics_budget",
    title: "Read AI Diagnostics' budget and usage",
    summary:
      "Officer: AI Diagnostics' monthly budget and its ceiling, in cents of the club's currency, when it was last changed, and this month's usage: requests, round trips, tokens, settled and reserved cents, `usagePercent` (0 to 1), `budgetStatus` and the five latest failures. Answers 404 while the module is off.",
    method: "GET",
    path: "/api/admin/ai-diagnostics/settings",
    kind: "read",
    returns: DIAGNOSTICS_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_ai_diagnostics_budget",
    title: "Change AI Diagnostics' budget",
    summary:
      "Officer: sets AI Diagnostics' monthly budget in cents of the club's currency (0 turns paid calls off; the ceiling is in `get_ai_diagnostics_budget`). Answers the saved budget. Answers 404 while the module is off.",
    method: "PUT",
    path: "/api/admin/ai-diagnostics/settings",
    body: diagnosticsBudgetUpdateSchema,
    kind: "destructive",
    returns: DIAGNOSTICS_SETTINGS_SAVED_CONNECTION_SHAPE,
    core: false,
  },

  // --- The AI spend conversion rate ----------------------------------------
  {
    id: "get_ai_spend_rate",
    title: "Read the AI spend conversion rate",
    summary:
      "Officer: the club's currency, whether it is New Zealand dollars (then no rate applies), and how many club units one NZD buys (`clubUnitsPerNzd`; `isConfigured` false means none is set and 1 is assumed). Both AI caps count spend at this rate.",
    method: "GET",
    path: "/api/admin/ai-spend-currency",
    kind: "read",
    returns: AI_SPEND_CURRENCY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_ai_spend_rate",
    title: "Set the AI spend conversion rate",
    summary:
      "Officer: sets how many units of the club's currency one New Zealand dollar buys, as a decimal such as \"0.92\". Refused for a club that charges in NZD, and if the club's currency changed while saving. Answers the saved rate.",
    method: "PUT",
    path: "/api/admin/ai-spend-currency",
    body: aiSpendCurrencyUpdateSchema,
    kind: "destructive",
    returns: AI_SPEND_CURRENCY_CONNECTION_SHAPE,
    core: false,
  },
];
