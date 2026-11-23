/**
 * ALP-721 (`INV-MCP-006`): the AI app guide's action tables are what a club
 * reads to learn what an app can do, and whether it must confirm first. They
 * are written by hand, so this holds them to the catalogue: every action is
 * listed, with its kind, and nothing listed is missing from the code.
 *
 * A row names one or more action ids in its first cell and their kinds in
 * its third: one kind for all, or one per id in order.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MCP_ACTIONS, MCP_WEBSITE_ONLY_ACTIONS } from "@/lib/mcp/catalogue";

const GUIDE = "docs/guides/mcp-server.md";

function guideKinds(): { kinds: Map<string, string>; badRows: string[] } {
  const kinds = new Map<string, string>();
  const badRows: string[] = [];
  const rows = readFileSync(GUIDE, "utf8")
    .split("\n")
    .filter((line) => /^\| `[a-z_]+`/.test(line));
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim());
    const ids = [...cells[1].matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    const rowKinds = cells[3].split(",").map((kind) => kind.trim());
    if (rowKinds.length !== 1 && rowKinds.length !== ids.length) badRows.push(row);
    ids.forEach((id, index) => kinds.set(id, rowKinds.length === 1 ? rowKinds[0] : rowKinds[index]));
  }
  return { kinds, badRows };
}

describe(`${GUIDE} lists the catalogue`, () => {
  const { kinds, badRows } = guideKinds();

  it("reads a row's kinds as one for all or one per id", () => {
    expect(kinds.size).toBeGreaterThan(50);
    expect(badRows).toEqual([]);
  });

  it("lists every action with the kind the catalogue gives it", () => {
    const wrong = MCP_ACTIONS.filter((action) => kinds.get(action.id) !== action.kind).map(
      (action) => `${action.id}: guide says ${kinds.get(action.id) ?? "nothing"}, catalogue ${action.kind}`,
    );
    expect(wrong).toEqual([]);
  });

  it("lists nothing the catalogue does not have", () => {
    const known = new Set([...MCP_ACTIONS, ...MCP_WEBSITE_ONLY_ACTIONS].map((action) => action.id));
    expect([...kinds.keys()].filter((id) => !known.has(id))).toEqual([]);
  });
});
