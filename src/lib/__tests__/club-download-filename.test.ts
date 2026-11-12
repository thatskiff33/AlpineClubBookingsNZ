import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CLUB_DOWNLOAD_FALLBACK_PREFIX,
  clubDownloadFilename,
  clubDownloadPrefix,
} from "@/lib/club-download-filename";
import { relativeSource, sourceFiles } from "./support/booking-guest-night-writer-scan";

describe("clubDownloadPrefix (#4932, INV-CONFIG-001)", () => {
  it("slugifies the club's short name to lowercase ASCII words joined by dashes", () => {
    expect(clubDownloadPrefix("MHSC")).toBe("mhsc");
    expect(clubDownloadPrefix("  Mt Hutt  Ski Club ")).toBe("mt-hutt-ski-club");
    expect(clubDownloadPrefix("Tūroa & Co.")).toBe("turoa-co");
  });

  it("falls back to a neutral prefix when nothing of the name survives", () => {
    expect(CLUB_DOWNLOAD_FALLBACK_PREFIX).toBe("club");
    expect(clubDownloadPrefix("")).toBe("club");
    expect(clubDownloadPrefix("---")).toBe("club");
    expect(clubDownloadPrefix("雪山")).toBe("club");
  });

  it("builds `<prefix>-<stem>.<extension>`", () => {
    expect(clubDownloadFilename("MHSC", "my-data-2026-07-01", "json")).toBe(
      "mhsc-my-data-2026-07-01.json",
    );
    expect(clubDownloadFilename("", "report-2026-07-01", "pdf")).toBe(
      "club-report-2026-07-01.pdf",
    );
  });
});

/**
 * Every string a source file under `src/` writes, comments excluded: literals,
 * and the fixed text of template literals around their `${…}` holes.
 */
function literalTexts(file: string, raw: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(
    file,
    raw,
    ts.ScriptTarget.Latest,
    true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      found.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: node.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("no club-visible name carries the reference club's initials (#4932)", () => {
  it("finds no `tac-` literal in executable source under src/", () => {
    // `tac-` at the start of a word: "contact-…" is not a hit. A download name
    // is built by `clubDownloadFilename` from the club's own short name; a
    // literal `tac-` anywhere is the reference club's name leaking to another.
    const TAC_WORD = /(?:^|[^a-z0-9])tac-/i;
    const hits: string[] = [];
    for (const file of sourceFiles()) {
      const relative = relativeSource(file);
      if (!relative.startsWith("src/")) continue;
      const raw = readFileSync(file, "utf8");
      // Parse only the files that could hold a hit; the AST pass then drops
      // the ones whose only mention is a comment.
      if (!TAC_WORD.test(raw)) continue;
      for (const { line, text } of literalTexts(relative, raw)) {
        if (TAC_WORD.test(text)) hits.push(`${relative}:${line}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
