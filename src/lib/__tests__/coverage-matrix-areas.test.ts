import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import { adminPagePaths } from "@/lib/__tests__/helpers/admin-route-enumeration";

// docs/COVERAGE_MATRIX.md keeps one row per admin route area (#4577). Its
// Summary count and rows drifted: it said 69 while the table had 81 rows and
// four areas had none, and four rows named a permission area the route map
// does not. The areas come from the shared admin page walk, never a second
// directory listing of our own (INV-SSOT).

const MATRIX = fs.readFileSync(
  path.join(process.cwd(), "docs/COVERAGE_MATRIX.md"),
  "utf8",
);

const ROW = /^\| `([a-z0-9-]+)` \| ([^|]+) \|/;

const rows = MATRIX.split("\n").flatMap((line) => {
  const match = ROW.exec(line);
  return match ? [{ area: match[1], permission: match[2].trim() }] : [];
});

const areasOnDisk = Array.from(
  new Set(
    adminPagePaths
      .map((pathname) => pathname.split("/")[2])
      .filter((segment): segment is string => Boolean(segment)),
  ),
).sort();

describe("COVERAGE_MATRIX.md admin areas (#4577)", () => {
  it("has exactly one row for every admin area directory, and no others", () => {
    const rowAreas = rows.map((row) => row.area);
    expect(new Set(rowAreas).size).toBe(rowAreas.length);
    expect([...rowAreas].sort()).toEqual(areasOnDisk);
  });

  it("states the area count the table actually has", () => {
    const stated = /- \*\*(\d+)\*\* admin route areas/.exec(MATRIX);
    expect(stated, "the Summary's area-count bullet").not.toBeNull();
    expect(Number(stated?.[1])).toBe(rows.length);
  });

  it("names the permission area the route map resolves for each row", () => {
    const mismatches = rows.flatMap(({ area, permission }) => {
      const resolved = getAdminRouteRequirement(`/admin/${area}`)?.area;
      return resolved && permission.startsWith(resolved)
        ? []
        : [`${area}: matrix says "${permission}", route map says ${resolved}`];
    });
    expect(mismatches).toEqual([]);
  });
});
