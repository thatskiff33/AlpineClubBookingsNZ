/**
 * Language detection, symbol extraction, and bounded excerpting for the
 * knowledge bundle (AID-3). All pure and deterministic: the same normalized
 * content always yields the same symbols and the same excerpt line ranges,
 * regardless of platform.
 *
 * Excerpts are the retrievable unit — retrieval sends only a bounded, cited set
 * to Anthropic — so they are split on natural structure (markdown headings,
 * Prisma blocks, top-level TS declarations) and then hard-capped in size, and
 * each carries its own hash for tamper detection and citation verification.
 */

import { normalizeContent, sha256Hex } from "./hash";
import type { KnowledgeExcerpt } from "./types";
import { must } from "@/lib/indexed-access";

/** Max lines per excerpt; larger sections are split into consecutive windows. */
export const MAX_EXCERPT_LINES = 200;

/** Hard char ceiling per excerpt, guarding a pathological single long line. */
export const MAX_EXCERPT_CHARS = 20_000;

export interface ExcerptedFile {
  language: string;
  symbols: string[];
  excerpts: KnowledgeExcerpt[];
}

interface Boundary {
  /** 0-based line index where a labelled section begins. */
  index: number;
  label: string;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  ".md": "markdown",
  ".prisma": "prisma",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".sql": "sql",
  ".css": "css",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".txt": "text",
};

export function detectLanguage(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const ext = dot > slash ? path.slice(dot).toLowerCase() : "";
  return EXTENSION_LANGUAGE[ext] ?? "text";
}

const MARKDOWN_HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const PRISMA_BLOCK = /^\s*(model|enum|generator|datasource|type|view)\s+([A-Za-z0-9_]+)/;
const TS_TOP_LEVEL_EXPORT =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

function findBoundaries(language: string, lines: string[]): Boundary[] {
  const boundaries: Boundary[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = must(lines[i], `findBoundaries: no line at index ${i} within lines.length`);
    if (language === "markdown") {
      const m = MARKDOWN_HEADING.exec(line);
      // Group 1 is mandatory (no trailing `?`), so a match always captures it.
      if (m) boundaries.push({ index: i, label: must(m[1], "findBoundaries: markdown heading match has no capture group").trim() });
    } else if (language === "prisma") {
      const m = PRISMA_BLOCK.exec(line);
      if (m) boundaries.push({ index: i, label: `${m[1]} ${m[2]}` });
    } else if (language === "typescript" || language === "javascript") {
      const m = TS_TOP_LEVEL_EXPORT.exec(line);
      // Group 1 is mandatory, so a match always captures it.
      if (m) boundaries.push({ index: i, label: must(m[1], "findBoundaries: TS export match has no capture group") });
    }
  }
  return boundaries;
}

/** Split content into lines, dropping a single phantom trailing empty line. */
function toLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function makeExcerpt(
  path: string,
  label: string | null,
  startLine: number,
  endLine: number,
  lines: string[],
): KnowledgeExcerpt {
  let text = lines.slice(startLine - 1, endLine).join("\n");
  if (text.length > MAX_EXCERPT_CHARS) text = text.slice(0, MAX_EXCERPT_CHARS);
  return {
    id: `${path}#L${startLine}-L${endLine}`,
    label,
    startLine,
    endLine,
    hash: sha256Hex(text),
    text,
  };
}

/**
 * Emit excerpts for one section [start, end] (1-based inclusive), splitting into
 * consecutive `MAX_EXCERPT_LINES` windows when the section is too large.
 */
function excerptSection(
  path: string,
  label: string | null,
  start: number,
  end: number,
  lines: string[],
  out: KnowledgeExcerpt[],
): void {
  for (let s = start; s <= end; s += MAX_EXCERPT_LINES) {
    const e = Math.min(s + MAX_EXCERPT_LINES - 1, end);
    out.push(makeExcerpt(path, label, s, e, lines));
  }
}

/**
 * Build the language tag, symbol list, and excerpt index for a file. `content`
 * MUST already be normalized (LF, no BOM) by the caller — `normalizeContent` is
 * applied defensively here too so a direct caller cannot skew a hash.
 */
export function buildExcerpts(path: string, rawContent: string): ExcerptedFile {
  const content = normalizeContent(rawContent);
  const language = detectLanguage(path);
  const lines = toLines(content);

  if (lines.length === 0) {
    return { language, symbols: [], excerpts: [] };
  }

  const boundaries = findBoundaries(language, lines);
  const symbols = [...new Set(boundaries.map((b) => b.label))].sort();
  const excerpts: KnowledgeExcerpt[] = [];

  if (boundaries.length === 0) {
    excerptSection(path, null, 1, lines.length, lines, excerpts);
    return { language, symbols, excerpts };
  }

  // Content before the first boundary is its own unlabelled leading section.
  // `boundaries.length === 0` was handled above, so element 0 exists here.
  const firstBoundary = must(boundaries[0], "buildExcerpts: boundaries is non-empty but has no element 0");
  if (firstBoundary.index > 0) {
    excerptSection(path, null, 1, firstBoundary.index, lines, excerpts);
  }

  for (let b = 0; b < boundaries.length; b += 1) {
    const boundary = must(boundaries[b], `buildExcerpts: no boundary at index ${b} within boundaries.length`);
    const start = boundary.index + 1; // 1-based
    const end =
      b + 1 < boundaries.length
        ? must(boundaries[b + 1], `buildExcerpts: no boundary at index ${b + 1} within boundaries.length`).index
        : lines.length;
    excerptSection(path, boundary.label, start, end, lines, excerpts);
  }

  excerpts.sort((a, b) => a.startLine - b.startLine);
  return { language, symbols, excerpts };
}
