import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { findStepUpClientGaps } from "@/lib/step-up-client-census";
import { runStepUpCensus } from "@/lib/step-up-route-census";
import { FACTOR_RESET_ROUTE, STEP_UP_ROUTES } from "@/lib/step-up-routes";

const RESTORE = "src/app/api/admin/backups/restore/route.ts";

describe("step-up route census (#4619)", () => {
  it("matches every admin handler that reaches a listed operation", () => {
    const result = runStepUpCensus();
    expect(result.missing).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.order).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.exportCsv).toBeNull();
    expect(result.factorReset).toBeNull();
    expect(findStepUpClientGaps()).toEqual([]);
  }, 20_000);

  it("fails when a listed route is dropped", () => {
    const result = runStepUpCensus({
      routes: STEP_UP_ROUTES.filter((route) => route.file !== RESTORE),
    });
    expect(result.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: RESTORE, method: "POST" }),
      ]),
    );
  });

  it("fails when an unlisted route reaches processRefund through a helper", () => {
    const route = "src/app/api/admin/step-up-probe/indirect/route.ts";
    const helper = "src/lib/step-up-probe-refund.ts";
    const result = runStepUpCensus({
      overlay: new Map([
        [
          helper,
          `import { processRefund } from "@/lib/stripe";
export async function billRefund() {
  return processRefund();
}
`,
        ],
        [
          route,
          `import { requireAdmin } from "@/lib/session-guards";
import { billRefund } from "@/lib/step-up-probe-refund";
export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return billRefund();
}
`,
        ],
      ]),
    });
    expect(result.unresolved).toEqual([]);
    expect(result.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: route,
          method: "POST",
          operations: expect.arrayContaining([expect.stringContaining("processRefund")]),
        }),
      ]),
    );
  });

  it("passes a handler whose only credential write is saveXeroTokens", () => {
    const route = "src/app/api/admin/step-up-probe/token/route.ts";
    const result = runStepUpCensus({
      overlay: new Map([
        [
          route,
          `import { requireAdmin } from "@/lib/session-guards";
import { saveXeroTokens } from "@/lib/xero-token-store";
export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return saveXeroTokens();
}
`,
        ],
      ]),
    });
    expect(result.missing.some((hit) => hit.file === route)).toBe(false);
    expect(result.stale.some((hit) => hit.file === route)).toBe(false);
    expect(result.unresolved).toEqual([]);
  });

  it("fails when an unlisted handler calls setIntegrationCredential", () => {
    const route = "src/app/api/admin/step-up-probe/credential/route.ts";
    const result = runStepUpCensus({
      overlay: new Map([
        [
          route,
          `import { requireAdmin } from "@/lib/session-guards";
import { setIntegrationCredential } from "@/lib/integration-credentials";
export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return setIntegrationCredential();
}
`,
        ],
      ]),
    });
    expect(result.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: route,
          method: "POST",
          operations: expect.arrayContaining([expect.stringContaining("setIntegrationCredential")]),
        }),
      ]),
    );
  });

  it("ignores a comment that only names requireRecentAuth", () => {
    const source = readFileSync(RESTORE, "utf8").replace(
      /const recent = await requireRecentAuth\(\);\s*if \(!recent\.ok\) return recent\.response;/,
      "/* requireRecentAuth() is named here and is not a call */",
    );
    const result = runStepUpCensus({ overlay: new Map([[RESTORE, source]]) });
    expect(result.order).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: RESTORE,
          method: "POST",
          reason: expect.stringContaining("missing"),
        }),
      ]),
    );
  });

  it("requires the factor-reset POST once that file exists", () => {
    const result = runStepUpCensus({
      overlay: new Map([[FACTOR_RESET_ROUTE.file, "export async function POST() { return null; }\n"]]),
    });
    expect(result.factorReset).toContain(FACTOR_RESET_ROUTE.file);
  });
});
