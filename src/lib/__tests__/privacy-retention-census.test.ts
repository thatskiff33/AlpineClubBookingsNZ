import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PRIVACY_RETENTION_CLASSIFICATION } from "@/lib/privacy-retention-classification";

const root = process.cwd();
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const schedule = readFileSync(path.join(root, "docs/PRIVACY_RETENTION.md"), "utf8");
// Anchor at the declaration, excluding commented examples and enum blocks.
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
const rows = [...schedule.matchAll(/^\| `([A-Za-z]\w*)` \| ([^\n]+)\|$/gm)].map(
  (match) => ({ model: match[1], cells: match[2]!.split("|").map((cell) => cell.trim()) })
);

describe("personal-data retention census", () => {
  it("classifies exactly the models derived from the actual Prisma schema", () => {
    expect(models.length).toBeGreaterThan(0);
    expect(Object.keys(PRIVACY_RETENTION_CLASSIFICATION).sort()).toEqual([...models].sort());
    expect(new Set(Object.values(PRIVACY_RETENTION_CLASSIFICATION))).toEqual(
      new Set(["personal", "non-personal"])
    );
  });

  it("schedules every personal model once, with purpose, retention and end action", () => {
    const personalModels = Object.entries(PRIVACY_RETENTION_CLASSIFICATION)
      .filter(([, classification]) => classification === "personal")
      .map(([model]) => model);
    expect(rows.map((row) => row.model).sort()).toEqual(personalModels.sort());
    for (const row of rows) {
      expect(row.cells, row.model).toHaveLength(3);
      expect(row.cells.every((cell) => cell.length > 0), row.model).toBe(true);
      expect(row.cells[2], row.model).toMatch(/^(Delete|Anonymise|Keep)\b/);
    }
  });
});
