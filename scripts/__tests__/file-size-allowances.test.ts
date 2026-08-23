import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOWANCE_DIR,
  readSizeAllowances,
} from "../lib/file-size-allowances";

/**
 * The reader for the deliberate escape from the ratchet (owner decision,
 * 21 Aug 2026), driven over real directories rather than mocks — the same
 * choice the rest of this gate's suites make, and for the same reason: what is
 * being tested is how it reads what somebody really typed into a file.
 */

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function newTree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "acb-allow-"));
  ROOTS.push(root);
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, ALLOWANCE_DIR, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

describe("readSizeAllowances", () => {
  it("reads file, length and reason, and ignores the prose around them", () => {
    const root = newTree({
      "2980-policy.md": [
        "# File-size allowances for #2980",
        "",
        "Some prose a reviewer reads and the gate does not.",
        "",
        "file: src/lib/membership-type-policy.ts",
        "lines: 1509",
        "reason: the school-teacher discriminator has to sit beside the policy",
        "  it guards; splitting it would put the rule and its exception in",
        "  different files.",
        "",
      ].join("\n"),
    });

    const { allowances, problems } = readSizeAllowances(root);

    expect(problems).toEqual([]);
    expect(allowances).toEqual([
      {
        source: `${ALLOWANCE_DIR}/2980-policy.md`,
        file: "src/lib/membership-type-policy.ts",
        lines: 1509,
        reason:
          "the school-teacher discriminator has to sit beside the policy it guards; " +
          "splitting it would put the rule and its exception in different files.",
      },
    ]);
  });

  it("reads several entries from one pull request's file", () => {
    // PR #2980, the change that produced this decision, grows eight files.
    const root = newTree({
      "2980-many.md": [
        "file: src/lib/a.ts",
        "lines: 1200",
        "reason: the first of the eight files this change has to grow.",
        "",
        "file: src/lib/b.ts",
        "lines: 900",
        "reason: the second of the eight files this change has to grow.",
      ].join("\n"),
    });

    const { allowances, problems } = readSizeAllowances(root);

    expect(problems).toEqual([]);
    expect(allowances.map((a) => [a.file, a.lines])).toEqual([
      ["src/lib/a.ts", 1200],
      ["src/lib/b.ts", 900],
    ]);
  });

  it("has nothing to say when no pull request needed one", () => {
    // The ordinary case, and it must not be an error: a missing directory is
    // not the same as an unreadable one.
    expect(readSizeAllowances(newTree())).toEqual({
      allowances: [],
      problems: [],
    });
  });

  it("does not read its own README as an allowance", () => {
    const root = newTree({
      "README.md": "file: src/lib/not-real.ts\nlines: 1\nreason: documentation, not a declaration at all.",
    });
    expect(readSizeAllowances(root).allowances).toEqual([]);
  });

  it("refuses an entry missing any of the three fields", () => {
    const root = newTree({
      "2980-short.md": "file: src/lib/a.ts\nlines: 1200\n",
    });
    const { allowances, problems } = readSizeAllowances(root);
    expect(allowances).toEqual([]);
    expect(problems[0]?.problem).toContain("missing reason");
  });

  it("refuses a bare marker of a reason, because a reviewer cannot weigh one", () => {
    // The owner decision is explicit that "allow growth" is not visible enough.
    const root = newTree({
      "2980-bare.md": "file: src/lib/a.ts\nlines: 1200\nreason: needed\n",
    });
    const { allowances, problems } = readSizeAllowances(root);
    expect(allowances).toEqual([]);
    expect(problems[0]?.problem).toContain("6-character reason");
  });

  it("refuses a length that is not a whole number of lines", () => {
    const root = newTree({
      "2980-odd.md":
        "file: src/lib/a.ts\nlines: about 1200\nreason: a number is the whole point of recording it.\n",
    });
    expect(readSizeAllowances(root).problems[0]?.problem).toContain(
      "not a whole number",
    );
  });

  it("refuses a path that is not repo-relative with forward slashes", () => {
    const root = newTree({
      "2980-path.md":
        "file: ..\\src\\lib\\a.ts\nlines: 1200\nreason: a path shape the rest of this gate cannot match on.\n",
    });
    expect(readSizeAllowances(root).problems[0]?.problem).toContain(
      "repo-relative path with forward slashes",
    );
  });

  it("refuses two entries for one file in ONE allowance file, because ambiguity is how the ledger shipped a wrong ceiling", () => {
    const root = newTree({
      "2980-a.md":
        "file: src/lib/a.ts\nlines: 1200\nreason: the first entry's view of this file's length.\n" +
        "file: src/lib/a.ts\nlines: 1300\nreason: the second entry's view of this file's length.\n",
    });
    const { problems } = readSizeAllowances(root);
    expect(problems.map((p) => p.problem).join("\n")).toContain(
      "already has an allowance in",
    );
  });

  it("does NOT refuse two allowance FILES naming one file, because only the diff knows which are live", () => {
    /*
      The reader sees the whole directory, merged declarations included, and a
      merged allowance is inert — `evaluateComputedRatchet` applies one only when
      its own file is in the change's diff. Refusing the pair here contradicted
      that and blocked the SECOND pull request ever to grow a file, with an error
      naming a path the author did not have in their diff.

      So "one file, one allowance" is asked where liveness is known. The
      same-change case is still refused, end to end, in
      `file-size-budget.test.ts` → "two allowances for one file in the SAME
      change still fail"; this asserts only that the READER no longer pre-empts
      that judgement.
    */
    const root = newTree({
      "2870-merged.md": "file: src/lib/a.ts\nlines: 1200\nreason: a declaration that merged a month ago.\n",
      "2981-new.md": "file: src/lib/a.ts\nlines: 1300\nreason: this change's own view of the same file.\n",
    });
    const { allowances, problems } = readSizeAllowances(root);
    expect(problems).toEqual([]);
    expect(allowances.map((a) => `${a.source} ${a.file} ${a.lines}`)).toEqual([
      `${ALLOWANCE_DIR}/2870-merged.md src/lib/a.ts 1200`,
      `${ALLOWANCE_DIR}/2981-new.md src/lib/a.ts 1300`,
    ]);
  });

  it("refuses a field that appears before any file, rather than guessing which file it meant", () => {
    const root = newTree({
      "2980-loose.md": "lines: 1200\nreason: a length with nothing to attach it to at all.\n",
    });
    expect(readSizeAllowances(root).problems[0]?.problem).toContain(
      "before any `file:`",
    );
  });

  it("reads a CRLF file the same as an LF one", () => {
    // `.gitattributes` pins `*.md` to LF, but a file written by a Windows editor
    // before it is committed can still arrive as CRLF, and a `\r` on the end of
    // a path would match no file in the tree (#2399 is this repository's long
    // memory of that class).
    const root = newTree({
      "2980-crlf.md":
        "file: src/lib/a.ts\r\nlines: 1200\r\nreason: written by an editor that had not read .gitattributes.\r\n",
    });
    const { allowances, problems } = readSizeAllowances(root);
    expect(problems).toEqual([]);
    expect(allowances[0]?.file).toBe("src/lib/a.ts");
    expect(allowances[0]?.lines).toBe(1200);
  });
});
