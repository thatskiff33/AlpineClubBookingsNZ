// @vitest-environment jsdom

/**
 * THE MODULE FLAG IS TRI-STATE ON THIS PAGE, AND `null` IS NOT "OFF" (#2803).
 *
 * This file exists because THREE versions of the same bug shipped into this branch:
 *
 *   1. `{!readiness.moduleEnabled && <Link href="/admin/modules">}` offered "Open
 *      Feature modules" — sending an administrator to switch on a module that may
 *      already be on, while the real fault went unmentioned.
 *   2. `{readiness.moduleEnabled ? "On" : "Off"}` reported the module as **Off** on
 *      the strength of a failed read.
 *   3. The first version of THIS TEST then "fixed" 1 and 2 while mocking
 *      `getDiagnosticsReadiness` wholesale and injecting `moduleEnabled: null`
 *      directly — proving the markup could render `null` while the page itself read
 *      the flag through `loadEffectiveModuleFlags()`, the lenient route-gating
 *      loader whose read failure is `false`, so `null` could never actually arrive
 *      and every branch this file "pinned" was dead code. The correctness review
 *      (13 Aug 2026) caught it.
 *
 * So this file now holds BOTH halves. The markup half: `null` renders as unknown,
 * `false` as Off, and neither borrows the other's copy. And the wiring half: the
 * flag flows from `readDiagnosticsModuleFlag()` — the strict reader #2803 added,
 * whose failure IS `null` — and the lenient loader is mocked to throw, so a
 * regression back to it fails every case here loudly instead of quietly re-deadening
 * the branches.
 *
 * The readiness contract states the rule in as many words — "a consumer must render
 * `null` as 'unknown', never as 'off': the two send an operator to different places".
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { DiagnosticsReadiness } from "@/lib/ai-diagnostics-config";

const mocks = vi.hoisted(() => ({
  moduleFlag: null as boolean | null,
}));

vi.mock("@/lib/admin-layout-guard", () => ({
  guardAdminLayout: async () => ({
    outcome: "admitted" as const,
    // Full support access, so the DETAILED tier renders — the tier that carries the
    // Module row at all.
    permissionMatrix: {
      overview: "edit",
      bookings: "edit",
      membership: "edit",
      finance: "edit",
      lodge: "edit",
      support: "edit",
      settings: "edit",
    } as unknown as AdminPermissionMatrix,
  }),
}));

// The lenient loader treats a read failure as "modules off", which on this evidence
// surface is the #2803 misreport itself. The page must not touch it; a regression
// that does fails every test in this file with this sentence.
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => {
    throw new Error(
      "wrong loader: this page must read the flag via readDiagnosticsModuleFlag (#2803)",
    );
  },
}));

vi.mock("@/lib/ai-diagnostics-config", () => ({
  // The strict tri-state reader — the seam `null` genuinely arrives through.
  readDiagnosticsModuleFlag: async () => mocks.moduleFlag,
  // Mirrors the real function's documented behaviour of PRESERVING its input's
  // tri-state rather than collapsing it (#2803), so the value the page passes in is
  // the value the markup sees. Everything else is a fixed unready verdict.
  getDiagnosticsReadiness: async (modules: {
    aiDiagnostics: boolean | null;
  }): Promise<DiagnosticsReadiness> => ({
    ready: false,
    moduleEnabled: modules.aiDiagnostics,
    keyState: "not_configured",
    monthlyBudgetCents: 0,
    databaseState: "not_configured",
    blockers: [
      modules.aiDiagnostics === null ? "module_flags_unreadable" : "module_off",
    ] as DiagnosticsReadiness["blockers"],
  }),
}));

// The budget card fetches on mount and is covered by its own suite; this file is
// about the readiness section's treatment of the flag.
vi.mock("@/components/admin/ai-spend-currency-card", () => ({
  AiSpendCurrencyCard: () => null,
}));
vi.mock("../_components/diagnostics-budget-card", () => ({
  DiagnosticsBudgetCard: () => null,
}));

import DiagnosticsPage from "../page";

async function renderPage(moduleFlag: boolean | null) {
  mocks.moduleFlag = moduleFlag;
  render(await DiagnosticsPage());
}

describe("an unreadable module flag (#2803)", () => {
  it("is never reported as Off", async () => {
    await renderPage(null);
    expect(screen.getByText("Could not be read")).toBeTruthy();
    expect(screen.queryByText("Off")).toBeNull();
  });

  it("does not send the operator to switch on a module", async () => {
    await renderPage(null);
    // The old markup's exact offer. It was wrong 100% of the times it appeared.
    expect(screen.queryByText("Open Feature modules")).toBeNull();
    expect(
      screen.getByText(/could not be established/).textContent,
    ).toContain("switching it on will not help");
  });
});

describe("a module that really is on", () => {
  it("says so, with no unknown-state notice", async () => {
    await renderPage(true);
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByText(/could not be established/)).toBeNull();
    expect(screen.queryByText("Could not be read")).toBeNull();
  });
});

describe("a module that really is off", () => {
  /**
   * NEARLY unreachable in production — the feature-route rule 404s the page when the
   * module is off, so `false` shows only in a flip race between the proxy's read and
   * the page's own. It is here because it is the case that holds the CONDITION
   * rather than the wording: swapping `=== null` back to `!` still renders the
   * corrected copy under the null cases, and only this one fails. Mutation-verified
   * against exactly that swap.
   */
  it("says Off, and does NOT claim the state could not be established", async () => {
    await renderPage(false);
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByText(/could not be established/)).toBeNull();
    expect(screen.queryByText("Could not be read")).toBeNull();
  });
});
