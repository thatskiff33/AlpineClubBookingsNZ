// @vitest-environment jsdom

/**
 * The AI Diagnostics page states where Diagnostics sends data (ADR-006 §2, #5243)
 * to every administrator who reaches it, in both readiness tiers — clubs that
 * switched it on before the Modules page asked for a tick see it here.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { DiagnosticsReadiness } from "@/lib/ai-diagnostics-config";
import { AI_DIAGNOSTICS_DISCLOSURE } from "@/lib/ai-diagnostics-disclosure";
import { PRIVACY_RECIPIENTS } from "@/lib/privacy-recipient-classification";

const mocks = vi.hoisted(() => ({
  support: "edit" as "edit" | "none",
}));

vi.mock("@/lib/admin-layout-guard", () => ({
  guardAdminLayout: async () => ({
    outcome: "admitted" as const,
    permissionMatrix: {
      overview: "edit",
      bookings: "edit",
      membership: "edit",
      finance: "edit",
      lodge: "edit",
      settings: "edit",
      support: mocks.support,
    } as unknown as AdminPermissionMatrix,
  }),
}));

vi.mock("@/lib/ai-diagnostics-config", () => ({
  readDiagnosticsModuleFlag: async () => true,
  getDiagnosticsReadiness: async (): Promise<DiagnosticsReadiness> => ({
    ready: true,
    moduleEnabled: true,
    keyState: "configured",
    monthlyBudgetCents: 1000,
    databaseState: "configured",
    blockers: [],
  }) as unknown as DiagnosticsReadiness,
}));

vi.mock("@/components/admin/ai-spend-currency-card", () => ({
  AiSpendCurrencyCard: () => null,
}));
vi.mock("../_components/diagnostics-budget-card", () => ({
  DiagnosticsBudgetCard: () => null,
}));

import DiagnosticsPage from "../page";

async function disclosureFor(support: "edit" | "none") {
  mocks.support = support;
  render(await DiagnosticsPage());
  return screen.getByRole("region", { name: AI_DIAGNOSTICS_DISCLOSURE.heading });
}

describe("AI Diagnostics page — where your data goes", () => {
  afterEach(() => cleanup());

  it.each([
    ["detailed", "edit"],
    ["coarse", "none"],
  ] as const)("states the provider, place, data and retention in the %s tier", async (_tier, support) => {
    const section = await disclosureFor(support);
    const text = section.textContent ?? "";

    expect(text).toContain("Anthropic");
    expect(text).toContain("which may process them outside New Zealand");
    // What kinds of data go.
    expect(text).toContain("the question, and the admin screen it was asked from");
    expect(text).toContain("earlier questions and answers in the same conversation");
    expect(text).toContain(
      "excerpts of this application's code, its built-in guides, and any private notes this deployment adds",
    );
    expect(text).toContain("records looked up to answer it");
    expect(text).toContain("personal details held in member records only when the administrator ticks");
    expect(text).toContain("including a name, is sent as typed");
    // Retention is the club's arrangement, not a setting here.
    expect(text).toContain("no instruction about how long to keep the excerpts");
    expect(text).toContain("zero retention, is arranged between the club and Anthropic");

    const link = within(section).getByRole("link", { name: /privacy notice/ });
    expect(link.getAttribute("href")).toBe(PRIVACY_RECIPIENTS.anthropic.privacyUrl);
    // Read-only here: the tick belongs to the Modules switch.
    expect(within(section).queryByRole("checkbox")).toBeNull();
  });
});
