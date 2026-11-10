import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const EXPECTED_DIRECT_CONSUMERS = [
  "src/app/(admin)/admin/display/builder/page.tsx",
  "src/app/(admin)/admin/display/devices/page.tsx",
  "src/app/(admin)/admin/display/reference/page.tsx",
  "src/app/(admin)/admin/display/setup/use-display-wizard-context.ts",
  "src/app/(admin)/admin/display/templates/page.tsx",
  "src/app/(admin)/admin/lodges/[id]/page.tsx",
  "src/app/(admin)/admin/lodges/[id]/setup/page.tsx",
  "src/app/(admin)/admin/lodges/page.tsx",
  "src/app/(authenticated)/book/whole-lodge/_components/whole-lodge-request-form.tsx",
  "src/components/admin/lodge-details-panel.tsx",
  "src/components/admin/notice-audience-picker.tsx",
] as const;

const EXPECTED_HOOK_CONSUMERS = [
  "src/app/(admin)/admin/bed-allocation/page.tsx",
  "src/app/(admin)/admin/book/page.tsx",
  "src/app/(admin)/admin/chores/page.tsx",
  "src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx",
  "src/app/(admin)/admin/hut-leaders/page.tsx",
  "src/app/(admin)/admin/lockers/page.tsx",
  "src/app/(admin)/admin/lodge/page.tsx",
  "src/app/(admin)/admin/members/[id]/_components/member-lodge-access-card.tsx",
  "src/app/(admin)/admin/rules/promo-codes/promo-codes-page-client.tsx",
  "src/app/(admin)/admin/rules/promo-codes/promo-redemptions-panel.tsx",
  "src/app/(admin)/admin/finance/reports/page.tsx",
  "src/app/(admin)/admin/roster/page.tsx",
  "src/app/(admin)/admin/rules/seasons/page.tsx",
  "src/app/(admin)/admin/work-parties/page.tsx",
  "src/app/(authenticated)/book/_hooks/use-booking-wizard.ts",
  "src/components/admin/booking-policies/policy-scope-select.tsx",
  "src/components/admin/lodge-capacity-card.tsx",
  "src/components/admin/rooms-beds-manager.tsx",
] as const;

/*
  #2887: this used to match three hardcoded literal spellings
  (`fetch("/api/admin/lodges"`, `fetch("/api/lodges"`, and one exact endpoint
  constant), so the next consumer writing a template literal or adding a query
  string was invisible to a census whose entire job is to be exhaustive.

  Both patterns stay anchored to a CALL or a named endpoint, deliberately: a
  bare search for the path also hits the permission matrix, the proxy route
  table and prose, none of which fetch anything.
*/
const LODGE_LIST_FETCH = /fetch\(\s*[`'"][^`'"]*\/api\/(?:admin\/)?lodges/;
const LODGE_LIST_ENDPOINT_CONST =
  /(?:const|let|var)\s+\w*(?:ENDPOINT|URL|PATH)\w*\s*=\s*[`'"][^`'"]*\/api\/(?:admin\/)?lodges/i;

function productionSources(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...productionSources(path));
    } else if (
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function repoPath(path: string): string {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

describe("production lodge-option consumers stay in the fail-closed census (#2887)", () => {
  const sources = productionSources(join(process.cwd(), "src"));

  it("counts every direct lodge-list consumer", () => {
    const actual = sources
      .filter((path) => {
        if (repoPath(path) === "src/components/lodge-select.tsx") return false;
        const body = readFileSync(path, "utf8");
        return LODGE_LIST_FETCH.test(body) || LODGE_LIST_ENDPOINT_CONST.test(body);
      })
      .map(repoPath)
      .sort();

    expect(actual).toEqual([...EXPECTED_DIRECT_CONSUMERS].sort());
  });

  it("counts every useLodgeOptions consumer outside the hook implementation", () => {
    const actual = sources
      .filter((path) => {
        const body = readFileSync(path, "utf8");
        return body.includes("useLodgeOptions(") && !body.includes("function useLodgeOptions(");
      })
      .map(repoPath)
      .sort();

    expect(actual).toEqual([...EXPECTED_HOOK_CONSUMERS].sort());
  });
});
