import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BYTE_ORDER_MARK,
  auditDefinitionHeadingShapes,
  auditDocReachability,
  auditDocs,
  auditEncoding,
  auditIndexRows,
  auditInvariantFilesLinkedFromIndex,
  auditInvariantIds,
  auditLineNumberCitations,
  auditNumberSequences,
  auditPermanentInvariantIds,
  auditRoutingTable,
  fencedLines,
  INVARIANT_SCHEME,
  literalAuditLines,
  loadTrackedFiles,
  loadInvariantFilesAtRef,
  resolveInvariantBaselineRef,
  routingTableRows,
  auditStableIndexHeadings,
  scanMarkdownFenceLines,
  scannableLines,
  STABLE_INDEX_HEADINGS,
} from "./check-doc-index-integrity.mjs";

/*
  HEADROOM FOR A WHOLE-REPOSITORY SCAN, not cover for a slow test.

  Thirteen cases here shell out to `git` or initialise a throwaway repository,
  and the heaviest call `loadTrackedFiles(REPO_ROOT)`, which lists and reads
  every tracked file — over 4,500 of them. That is the point: the real-repository
  CLI cases are the strongest thing in this suite, and they are what caught the
  `synchronize`-payload trap. They need the real tree, not a fixture.

  Under vitest's 5-second default that work does not reliably finish on a busy
  runner, and a *different* case loses each time. It failed exactly that way on
  PR #2922, whose diff is documentation and cannot reach the subject of the test
  that failed — 28.5s for the file against roughly 19s idle (#2923).

  The mechanism was seen before this suite merged and mis-read as Windows load
  sensitivity that "does not reproduce on CI's Linux runners". The first half was
  right; the second half was an assumption. Nothing here is Windows-specific —
  the runner only has to be busy.

  Same treatment, and the same reasoning, as the whole-tree parser scan in
  `src/lib/__tests__/jsx-text-escape-guard.test.ts`. If a case ever genuinely
  needs a minute, that is a real regression worth looking at; this only stops the
  clock deciding which assertion runs.
*/
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CHECKER_PATH = path.join(REPO_ROOT, "scripts", "ci", "check-doc-index-integrity.mjs");
const TEMP_ROOTS = new Set();

afterEach(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { force: true, recursive: true });
  TEMP_ROOTS.clear();
});

function git(repoRoot, ...args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitRepo(initialBranch = "main") {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "doc-index-integrity-"));
  TEMP_ROOTS.add(repoRoot);
  git(repoRoot, "init", `--initial-branch=${initialBranch}`);
  git(repoRoot, "config", "user.name", "Doc index tests");
  git(repoRoot, "config", "user.email", "doc-index@example.invalid");
  git(repoRoot, "config", "commit.gpgsign", "false");
  git(repoRoot, "config", "core.autocrlf", "false");
  return repoRoot;
}

function commitFiles(repoRoot, message, files) {
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(repoRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  }
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", message);
  return git(repoRoot, "rev-parse", "HEAD");
}

/**
 * Resolve a revision in THIS repository, failing with the reason rather than a
 * raw git error.
 *
 * The CLI tests below build a real `pull_request` payload out of this
 * repository's own commits, so they need history — `HEAD^1` and `origin/main`.
 * `ci.yml` checks out with `fetch-depth: 0` and has it; a default
 * `actions/checkout` is depth 1 and does not. That asymmetry once put `main`
 * red on the clock canary while `verify` stayed green, and the symptom was
 * `fatal: ambiguous argument 'HEAD^1'` four frames deep in a helper, which says
 * nothing about the cause (#2907).
 *
 * Deliberately throws rather than skipping. A test that quietly disappears in
 * one workflow is how this class of gap hides in the first place.
 */
function repoRevision(revision) {
  try {
    return git(REPO_ROOT, "rev-parse", revision);
  } catch (cause) {
    throw new Error(
      `Could not resolve ${revision} in this repository. This test drives the ` +
        "doc-index CLI against real commits, so it needs git history: a " +
        "shallow clone has neither HEAD^1 nor origin/main. Every workflow that " +
        "runs the unit suite must check out with `fetch-depth: 0` (ci.yml and " +
        "clock-rollover-canary.yml both do). Locally, run `git fetch --unshallow`.",
      { cause },
    );
  }
}

function checkerEnv(overrides = {}) {
  return {
    ...process.env,
    DOC_INDEX_BASE_REF: "",
    GITHUB_BASE_REF: "",
    GITHUB_EVENT_NAME: "",
    GITHUB_REF: "",
    GITHUB_REF_NAME: "",
    PR_BASE_SHA: "",
    PUSH_BASE_SHA: "",
    ...overrides,
  };
}

/**
 * Unit coverage for the pure half of the doc-index gate (#2691 phase 4).
 *
 * This file is the ONE entry in the checker's `CITATION_EXEMPT_FILES`, which
 * covers both the invariant-id scan and the line-number citation scan. Its
 * fixtures must contain unresolvable ids, unrecognised prefixes and line-number
 * citations, because that is what they assert the checker rejects. Every fixture
 * below is therefore a literal that would fail the real scan, which is the
 * point. Nothing else is exempt — not even the checker itself.
 *
 * It is NOT exempt from the encoding audit, so the mojibake fixtures are built
 * from code points rather than written out: this file stays ASCII and the check
 * it is testing stays green over it.
 *
 * Exempt from the scan is not exempt from the habit, though. Where a fixture
 * needs a well-formed id that resolves to NOTHING, it uses a real number under
 * the fixture's own prefix — `002`, which this repository defines — so a grep
 * for that prefix still lands on a real rule; the id is unresolved in the
 * fixture repository below, which defines only `001`, and that is what the
 * assertion is about. The fenced-width tests necessarily spell malformed
 * two- and four-digit forms under a live prefix: they are isolated in this sole
 * exempt fixture file and prove the production scanner rejects exactly those
 * forms. Where a fixture needs a well-formed number far out of range, it uses a
 * prefix this repository does not declare. No illustrative well-formed id
 * invents a number under a live prefix, which is the trap #2889 closed and the
 * rule `SCHEME.md` §1.4 states.
 */

/** An em dash after one UTF-8 -> cp1252 -> UTF-8 round-trip. */
const MOJIBAKE_EM_DASH = String.fromCharCode(0xe2, 0x20ac, 0x201d);

/** A non-breaking space after the same round-trip. */
const MOJIBAKE_NBSP = String.fromCharCode(0xc2, 0xa0);

/** A minimal repository that satisfies every rule, as a `Map` of path -> text. */
function repo(overrides = {}) {
  return new Map(
    Object.entries({
      "README.md": "# Repo\n\nSee [docs](docs/README.md).\n",
      "AGENTS.md": [
        "# Agent Guidelines",
        "",
        "### Routing table",
        "",
        "| About to change... | Invariants | Also read |",
        "| --- | --- |  --- |",
        "| Anything holding cents | `INV-MONEY` -> [`money.md`](docs/invariants/money.md) | [`hub`](docs/README.md) |",
        "",
        "### Something else",
        "",
        "| Not | A | Routing row |",
        "",
      ].join("\n"),
      "docs/README.md": "# Docs\n\n- [Domain invariants](DOMAIN_INVARIANTS.md)\n",
      "docs/DOMAIN_INVARIANTS.md": [
        "# Domain Invariants",
        "",
        "File: [`money.md`](invariants/money.md).",
        "",
        "| ID | Covers |",
        "| --- | --- |",
        "| `INV-MONEY-001` | Store and calculate money as integer cents |",
        "",
      ].join("\n"),
      "docs/invariants/money.md": [
        "# Money",
        "",
        "Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md).",
        "",
        "## INV-MONEY-001",
        "",
        "- Store and calculate money as integer cents.",
        "",
      ].join("\n"),
      ...overrides,
    }),
  );
}

/** A domain file defining every id given, in order, under one prefix. */
function family(prefix, numbers) {
  return [
    `# ${prefix}`,
    "",
    ...numbers.flatMap((n) => [`## INV-${prefix}-${n}`, "", "- A rule.", ""]),
  ].join("\n");
}

describe("scannableLines", () => {
  it("drops fenced blocks so a document can show an example id", () => {
    const lines = scannableLines("real\n```\nfenced\n```\nreal again\n");
    expect(lines.map((l) => l.text)).toEqual(["real", "real again", ""]);
  });

  it("keeps inline backticks, because that is how citations are written", () => {
    const lines = scannableLines("see `INV-MONEY-001` for the rule\n");
    expect(lines[0].text).toContain("INV-MONEY-001");
  });

  it("classifies a tab-heavy pseudo-tag in linear time, not exponential", () => {
    // The HTML-block tag pattern let an unquoted attribute value swallow TAB,
    // which overlaps the whitespace separating the next attribute, so the outer
    // repeat could re-split the same tabs exponentially many ways. Measured on
    // the pre-fix pattern: 22 repetitions took 337ms and every further
    // repetition doubled it, so a ~200-character line in any tracked Markdown
    // file would have hung this gate rather than failed it. 400 repetitions
    // would not have finished before the heat death of anything; if this ever
    // regresses the test does not fail slowly, it stops finishing.
    const pathological = `<a${"\t\t:=!".repeat(400)}\t\t:=!X\n`;

    const started = process.hrtime.bigint();
    scannableLines(pathological);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(1000);
  });

  it("has a separate view of fenced lines for the narrow live-prefix audit", () => {
    const lines = fencedLines("real\n```ts\nfenced\n```\nreal again\n");
    expect(lines).toEqual([{ number: 3, text: "fenced" }]);
  });

  it("keeps a triple-backtick run inside a four-backtick fence", () => {
    const source = [
      "outside",
      "````md",
      "```",
      "still fenced",
      "`````",
      "outside again",
      "",
    ].join("\n");

    expect(scanMarkdownFenceLines(source)).toEqual({
      fenced: [
        { number: 3, text: "```" },
        { number: 4, text: "still fenced" },
      ],
      scannable: [
        { number: 1, text: "outside" },
        { number: 6, text: "outside again" },
        { number: 7, text: "" },
      ],
    });
  });

  it("treats the other marker and a short same-marker run as fenced content", () => {
    const source = [
      "~~~text",
      "```",
      "~~",
      "inside",
      "~~~~",
      "outside",
      "",
    ].join("\n");

    expect(fencedLines(source).map((line) => line.text)).toEqual([
      "```",
      "~~",
      "inside",
    ]);
    expect(scannableLines(source).map((line) => line.text)).toEqual([
      "outside",
      "",
    ]);
  });

  it("treats an over-indented opener as code but rejects an invalid inline opener", () => {
    const source = "    ```\ncode\n```bad`info\ntext\n";

    expect(fencedLines(source)).toEqual([{ number: 1, text: "    ```" }]);
    expect(scannableLines(source).map((line) => line.text)).toEqual([
      "code",
      "```bad`info",
      "text",
      "",
    ]);
  });

  it("does not let a fence marker inside raw pre HTML hide later headings", () => {
    const source = [
      "<pre>",
      "```",
      "literal text",
      "</pre>",
      "## INV-DEMO-001",
      "",
    ].join("\n");

    expect(fencedLines(source).map((line) => line.text)).toEqual([
      "<pre>",
      "```",
      "literal text",
      "</pre>",
    ]);
    expect(scannableLines(source).map((line) => line.text)).toEqual([
      "## INV-DEMO-001",
      "",
    ]);
  });

  it.each([
    ["a standard block tag", ["<div>", "```", "</div>"]],
    ["a complete custom tag", ['<fixture data-kind="docs">', "```", "</fixture>"]],
  ])("ends raw HTML from %s at the following blank line", (_name, html) => {
    const source = [...html, "", "## INV-DEMO-001", ""].join("\n");

    expect(fencedLines(source).map((line) => line.text)).toEqual(html);
    expect(scannableLines(source).map((line) => line.text)).toEqual([
      "",
      "## INV-DEMO-001",
      "",
    ]);
  });

  it("lets type-6 HTML interrupt a paragraph but keeps type-7 HTML in it", () => {
    const typeSix = "paragraph\n<div>\ninside\n\nvisible\n";
    const typeSeven = "paragraph\n<fixture>\nvisible\n";

    expect(fencedLines(typeSix).map((line) => line.text)).toEqual(["<div>", "inside"]);
    expect(scannableLines(typeSeven).map((line) => line.text)).toEqual([
      "paragraph",
      "<fixture>",
      "visible",
      "",
    ]);
  });

  it("ends a type-1 HTML block only at the matching closing tag", () => {
    const source = "<pre>\nliteral\n</script>\nstill literal\n</pre>\nvisible\n";

    expect(fencedLines(source).map((line) => line.text)).toEqual([
      "<pre>",
      "literal",
      "</script>",
      "still literal",
      "</pre>",
    ]);
    expect(scannableLines(source).map((line) => line.text)).toEqual(["visible", ""]);
  });

  it("includes backtick and tilde fence openers in the narrow literal audit", () => {
    const source = "```lang INV-DEMO-002\nbody\n```\n~~~lang INV-DEMO-03\nbody\n~~~\n";

    expect(literalAuditLines(source).map((line) => line.text)).toEqual([
      "```lang INV-DEMO-002",
      "body",
      "~~~lang INV-DEMO-03",
      "body",
    ]);
  });

  it("does not let indented code interrupt an active paragraph", () => {
    const source = "paragraph\n    paragraph continuation\n";

    expect(fencedLines(source)).toEqual([]);
    expect(scannableLines(source).map((line) => line.text)).toEqual([
      "paragraph",
      "    paragraph continuation",
      "",
    ]);
  });

  it.each([
    ["blockquote", ["> ```text", "> INV-DEMO-999", "> ```"]],
    ["list", ["- ```text", "  INV-DEMO-999", "  ```"]],
  ])("recognises a fence owned by a %s container", (_name, lines) => {
    const source = ["outside", ...lines, "outside again", ""].join("\n");

    expect(fencedLines(source).map((line) => line.text)).toEqual([lines[1]]);
    expect(scannableLines(source).map((line) => line.text)).toEqual([
      "outside",
      "outside again",
      "",
    ]);
  });

  it("reprocesses the first non-container line after an unclosed container fence", () => {
    const source = [
      "- ```text",
      "  literal",
      "## INV-MONEY-001",
      "",
    ].join("\n");

    expect(scannableLines(source).map((line) => line.text)).toEqual([
      "## INV-MONEY-001",
      "",
    ]);
  });
});

describe("auditDefinitionHeadingShapes", () => {
  it("fails an id-only invariant heading whose case is non-canonical", () => {
    const problems = auditDefinitionHeadingShapes(
      repo({
        "docs/invariants/money.md":
          "# Money\n\n## INV-MONEY-001\n\n- A rule.\n\n## inv-money-002\n\n- Invisible.\n",
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/money.md:7");
    expect(problems[0]).toContain("definition heading");
    expect(problems[0]).toContain("exactly three digits");
  });

  it.each([
    ["a non-breaking hyphen", "## INV‑CAP-042", "U+2011"],
    ["an en dash", "## INV–CAP-042", "U+2013"],
    ["a Cyrillic A", "## INV-CАP-042", "U+0410"],
    ["a full-width digit", "## INV-CAP-04２", "U+FF12"],
  ])("fails %s hiding inside an invariant id", (_name, heading, codePoint) => {
    // The worst bypass this checker had. Every other defence works on ASCII
    // `INV-[A-Z]-\d`, so one lookalike codepoint walked past all of them at
    // once — definition scan, citation scan and index-row scan alike — while
    // GitHub rendered a perfectly ordinary `INV-CAP-042`. A reviewer saw a new
    // invariant that had skipped nine numbers, and CI was green.
    const problems = auditDefinitionHeadingShapes(
      repo({ "docs/invariants/money.md": `# Money\n\n${heading}\n\n- A rule.\n` }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/money.md:3");
    expect(problems[0]).toContain(codePoint);
  });

  it.each([
    ["an em dash in ordinary prose", "## Capacity — the whole-lodge rule"],
    ["a macron in ordinary prose", "## Whakatūpato about capacity"],
    ["a clean canonical definition", "## INV-MONEY-001"],
  ])("leaves %s alone", (_name, heading) => {
    const problems = auditDefinitionHeadingShapes(
      repo({ "docs/invariants/money.md": `# Money\n\n${heading}\n\n- A rule.\n` }),
    );

    expect(problems).toEqual([]);
  });

  it("sees through nested inline tags that one strip pass would leave behind", () => {
    // Stripping `<b>` out of `<s<b>pan>` splices its neighbours into a *new*
    // tag, so a single pass leaves markup a reader never sees. Left in, the
    // residue splits the id and the heading stops looking like a definition —
    // the rule would be live in the document and invisible to the catalogue,
    // which is precisely the failure this whole check exists to prevent.
    const problems = auditDefinitionHeadingShapes(
      repo({
        "docs/invariants/money.md": [
          "# Money",
          "",
          "## INV-MONEY-001",
          "",
          "- A rule.",
          "",
          "## <s<b>pan>inv-money-002</s<b>pan>",
          "",
          "- Invisible.",
          "",
        ].join("\n"),
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/money.md:7");
    expect(problems[0]).toContain("canonical");
  });

  it("fails a backticked id-only heading rather than silently ignoring it", () => {
    const problems = auditDefinitionHeadingShapes(
      repo({
        "docs/invariants/money.md":
          "# Money\n\n## INV-MONEY-001\n\n- A rule.\n\n## `INV-MONEY-002`\n\n- Invisible.\n",
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("canonical");
  });

  it("fails a decorated heading whose existing id would otherwise resolve as a citation", () => {
    const problems = auditDefinitionHeadingShapes(
      repo({
        "docs/invariants/money.md": [
          "# Money",
          "",
          "## INV-MONEY-001",
          "",
          "- A rule.",
          "",
          "## INV-MONEY-001 — another rule",
          "",
          "- This is not a second canonical definition.",
          "",
        ].join("\n"),
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/money.md:7");
    expect(problems[0]).toContain("definition heading");
  });

  it.each([
    "## INV-**MONEY**-001",
    "## INV-*MONEY*-001",
    "## INV-__MONEY__-001",
    "## INV-_MONEY_-001",
    "## **INV**-MONEY-001",
    "## INV-~~MONEY~~-001",
    "## INV-`MONEY`-001",
    "## INV-<em>MONEY</em>-001",
  ])("fails an invariant token split by inline decoration: %s", (heading) => {
    const problems = auditDefinitionHeadingShapes(
      repo({
        "docs/invariants/money.md": [
          "# Money",
          "",
          "## INV-MONEY-001",
          "",
          "- A rule.",
          "",
          heading,
          "",
          "- Invisible.",
          "",
        ].join("\n"),
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/money.md:7");
    expect(problems[0]).toContain("no decoration");
  });

  it.each([
    ["GFM inline link", "## INV-[MONEY](https://example.invalid)-002"],
    ["GFM full reference link", "## INV-[MONEY][money]-002"],
    ["GFM collapsed reference link", "## INV-[MONEY][]-002"],
    ["GFM shortcut reference link", "## INV-[MONEY]-002"],
    ["decimal character reference", "## INV-M&#79;NEY-002"],
    ["hexadecimal character reference", "## INV-M&#x4f;NEY-002"],
    [
      "emphasised GFM link label",
      "## INV-[**MONEY**](https://example.invalid/path_(one))-002",
    ],
  ])("fails an invariant token split by a %s", (_kind, heading) => {
    const problems = auditDefinitionHeadingShapes(
      repo({
        "docs/invariants/money.md": [
          "# Money",
          "",
          "## INV-MONEY-001",
          "",
          "- A rule.",
          "",
          heading,
          "",
          "- Invisible.",
          "",
        ].join("\n"),
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/money.md:7");
    expect(problems[0]).toContain("no decoration");
  });

  it("fails an invariant-shaped Setext heading rather than treating it as prose", () => {
    const problems = auditDefinitionHeadingShapes(
      repo({
        "docs/invariants/money.md":
          "# Money\n\n## INV-MONEY-001\n\n- A rule.\n\nINV-MONEY-001 — another rule\n---\n",
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/money.md:7");
    expect(problems[0]).toContain("canonical");
  });

  it("accepts canonical definitions, narrative headings and illustrative fenced headings", () => {
    const problems = auditDefinitionHeadingShapes(
      repo({
        "docs/invariants/money.md":
          "# Money\n\n## INV-MONEY-001\n\n- A rule.\n\n## Money examples\n\n```md\n## inv-money-002\n```\n",
      }),
    );

    expect(problems).toEqual([]);
  });
});

describe("auditDocs — the whole check", () => {
  it("passes a repository that satisfies every rule", () => {
    expect(auditDocs(repo())).toEqual([]);
  });

  it("fails a decorated heading even when its existing id resolves in the whole audit", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n## INV-MONEY-001 — another rule\n\n- Not a definition.\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/money.md:9");
    expect(problems[0]).toContain("canonical");
  });

  it.each([
    "## INV-**MONEY**-001",
    "## INV-*MONEY*-001",
    "## INV-__MONEY__-001",
    "## INV-_MONEY_-001",
  ])("fails an emphasis-split invariant heading in the whole audit: %s", (heading) => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n${heading}\n\n- Not a definition.\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });

  it.each([
    "## INV-[MONEY](https://example.invalid)-002",
    "## INV-[MONEY][money]-002",
    "## INV-[MONEY][]-002",
    "## INV-[MONEY]-002",
    "## INV-M&#79;NEY-002",
    "## INV-M&#x4f;NEY-002",
  ])("fails a link/entity-split invariant heading in the whole audit: %s", (heading) => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n${heading}\n\n- Not a definition.\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });

  it.each(["INV-MONEY-001a", "INV-MONEY-001_extra"])(
    "fails identifier-suffixed heading %s in the whole audit",
    (malformed) => {
      const files = repo();
      files.set(
        "docs/invariants/money.md",
        `${files.get("docs/invariants/money.md")}\n## ${malformed}\n\n- Not a definition.\n`,
      );

      const problems = auditDocs(files);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("docs/invariants/money.md:9");
      expect(problems[0]).toContain("no identifier suffix");
    },
  );

  it("does not let raw pre HTML hide a newly declared family", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n<pre>\n\`\`\`\n</pre>\n\n## INV-DEMO-001\n\n- A new family.\n`,
    );

    const problems = auditDocs(files);

    expect(problems.some((problem) => problem.includes("INV-DEMO-001 is defined at"))).toBe(
      true,
    );
    expect(problems.some((problem) => problem.includes("no routing table row in AGENTS.md"))).toBe(
      true,
    );
  });

  it("does not let type-7 HTML interrupt a paragraph and hide a malformed heading", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\nParagraph text\n<fixture data-kind="docs">\n## INV-MONEY-001 — another rule\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });

  it("fails a multiline Setext heading whose first line contains an invariant id", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\nINV-MONEY-001 — another rule\ncontinued heading text\n---\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });

  it.each([
    ["blockquote", "> ## INV-MONEY-001"],
    ["list", "- ## INV-MONEY-001"],
    ["list continuation", "- Item\n  ## INV-MONEY-001"],
  ])("fails a malformed invariant heading inside a %s", (_container, heading) => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n${heading}\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("canonical top-level");
  });

  it("treats four-space indented custom fixture ids as literal code", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n# Literal fixture\n\n    INV-FIXTURE-999\n`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it("keeps a decorated heading literal until the matching type-1 closing tag", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n<pre>\nliteral\n</script>\n## INV-MONEY-001 — illustrative\n</pre>\n`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it.each(["<fixture =bad>", "<fixture !>"])(
    "does not let invalid type-7 tag %s hide a decorated invariant heading",
    (invalidTag) => {
      const files = repo();
      files.set(
        "docs/invariants/money.md",
        `${files.get("docs/invariants/money.md")}\n${invalidTag}\n## INV-MONEY-001 — duplicate rule\n`,
      );

      const problems = auditDocs(files);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("looks like an invariant definition heading");
    },
  );

  it("does not let type-7 HTML interrupt a lazy blockquote paragraph continuation", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n> paragraph\n<fixture>\n## INV-MONEY-001 — duplicate rule\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });

  it("retains the original blockquote through a markerless lazy continuation", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n> paragraph\nlazy continuation\n> <fixture>\n> ## INV-MONEY-001 — duplicate rule\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });

  it("treats an unmarked dash thematic break as ending a blockquote paragraph", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n> INV-MONEY-001\n---\n`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it("keeps a marked dash underline as a blockquote Setext heading", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n> INV-MONEY-001\n> ---\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });

  it("keeps a markerless equals underline as lazy blockquote paragraph text", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n> INV-MONEY-001 narrative\n===\n`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it("recognises a marked equals underline as a blockquote Setext heading", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n> INV-MONEY-001 narrative\n> ===\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });

  it("resets container paragraph state at an asterisk thematic break", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n> paragraph\n***\n<fixture>\n## INV-MONEY-001 — literal duplicate\n`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it.each(["- - -", "* * *"])(
    "gives the spaced thematic break %s precedence over a list marker",
    (thematicBreak) => {
      const source = `${thematicBreak}\n      ## INV-MONEY-001 — literal example\n`;

      expect(fencedLines(source)).toEqual([
        { number: 2, text: "      ## INV-MONEY-001 — literal example" },
        { number: 3, text: "" },
      ]);
      expect(scannableLines(source).map((line) => line.text)).toEqual([thematicBreak]);

      const files = repo();
      files.set(
        "docs/invariants/money.md",
        `${files.get("docs/invariants/money.md")}\n${source}`,
      );
      expect(auditDocs(files)).toEqual([]);
    },
  );

  it.each([
    [
      "ordered marker digit width",
      "9. cites INV-MONEY-001 in ordinary prose\n10. ## INV-MONEY-001 — duplicate rule",
    ],
    [
      "ordered item padding width",
      "1. cites INV-MONEY-001 in ordinary prose\n2.   ## INV-MONEY-001 — duplicate rule",
    ],
    [
      "nested ordered marker digit width",
      "1. outer item\n\n   9. cites INV-MONEY-001 in ordinary prose\n   10. ## INV-MONEY-001 — duplicate rule",
    ],
  ])("recognises a %s change as a list sibling in the whole audit", (_kind, fixture) => {
    const files = repo({
      "docs/invariants/money.md": [
        "# Money",
        "",
        "## INV-MONEY-001",
        "",
        fixture,
        "",
      ].join("\n"),
    });

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("canonical top-level");
  });

  it("does not treat a changed ordered-list delimiter as the active list's sibling", () => {
    const files = repo({
      "docs/invariants/money.md": [
        "# Money",
        "",
        "## INV-MONEY-001",
        "",
        "9. cites INV-MONEY-001 in ordinary prose",
        "10) ## INV-MONEY-001 — still paragraph text",
        "",
      ].join("\n"),
    });

    expect(auditDocs(files)).toEqual([]);
  });

  it("does not treat an indented lazy blockquote paragraph continuation as code", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n> paragraph\n    INV-MONEY-002\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-002 is cited at");
  });

  it.each([
    [
      "type-7 HTML",
      "paragraph\n> <fixture>\n> ## INV-MONEY-001 — literal duplicate\n",
    ],
    ["indented code", "paragraph\n>     INV-DEMO-999\n"],
  ])("lets a fresh blockquote interrupt a paragraph with %s", (_kind, fixture) => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n${fixture}`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it("recognises five spaces after a list marker as list-owned indented code", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n-     INV-DEMO-999\n`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it("expands tabs when recognising list-owned indented code", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n-\t\tINV-DEMO-999\n`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it.each([
    ["list", "-\t  INV-DEMO-999"],
    ["blockquote", ">\t  INV-DEMO-999"],
    ["ordered list", "1.\t   INV-DEMO-999"],
  ])(
    "slices a partially consumed tab by expanded columns in a %s container",
    (_container, source) => {
      const files = repo();
      files.set(
        "docs/invariants/money.md",
        `${files.get("docs/invariants/money.md")}\n${source}\n`,
      );

      expect(auditDocs(files)).toEqual([]);
    },
  );

  it("keeps indented code inside an empty list item", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n-\n      INV-DEMO-999\n`,
    );

    expect(auditDocs(files)).toEqual([]);
  });

  it("retains a list container across a blank line before an indented heading", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\n- item\n\n    ## INV-MONEY-001 — duplicate rule\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("canonical top-level");
  });

  it.each([
    ["bullet", "- cites INV-MONEY-001 in ordinary prose\n- ordinary heading\n  ---"],
    ["ordered", "1. cites INV-MONEY-001 in ordinary prose\n2. ordinary heading\n   ---"],
  ])(
    "does not merge a same-width %s sibling Setext heading with the prior item's citation",
    (_kind, fixture) => {
      const files = repo({
        "docs/invariants/money.md": [
          "# Money",
          "",
          "## INV-MONEY-001",
          "",
          fixture,
          "",
        ].join("\n"),
      });

      expect(auditDocs(files)).toEqual([]);
    },
  );

  it.each([
    ["bullet", "- first item\n-\n      INV-DEMO-999"],
    ["ordered", "1. first item\n2.\n       INV-DEMO-999"],
  ])(
    "retains list-owned indented code after a fresh same-width %s sibling",
    (_kind, fixture) => {
      const files = repo();
      files.set(
        "docs/invariants/money.md",
        `${files.get("docs/invariants/money.md")}\n${fixture}\n`,
      );

      expect(auditDocs(files)).toEqual([]);
    },
  );

  it("allows a normal full stop immediately after a valid invariant citation", () => {
    expect(
      auditDocs(repo({ "src/lib/money.ts": "// See INV-MONEY-001. Then continue.\n" })),
    ).toEqual([]);
  });

  it("does not let an ordered list starting above one interrupt a paragraph", () => {
    const files = repo();
    files.set(
      "docs/invariants/money.md",
      `${files.get("docs/invariants/money.md")}\nParagraph text\n2. <fixture>\n   ## INV-MONEY-001 — another rule\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("looks like an invariant definition heading");
  });
});

describe("auditInvariantIds", () => {
  it("fails a duplicate definition, naming both places", () => {
    const problems = auditInvariantIds(
      repo({
        "docs/invariants/other.md": "# Other\n\n## INV-MONEY-001\n\n- A second one.\n",
      }),
    );

    expect(problems.some((p) => p.includes("INV-MONEY-001") && p.includes("2 times"))).toBe(
      true,
    );
  });

  it("fails a citation under a declared prefix that resolves to nothing", () => {
    const problems = auditInvariantIds(
      repo({
        "src/lib/money.ts": "// Enforces INV-MONEY-002.\n",
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-002");
    expect(problems[0]).toContain("src/lib/money.ts:1");
  });

  it("fails an unrecognised prefix rather than ignoring it (the typo case)", () => {
    // `MONYE` is the likelier mistake than a genuinely new area, and a blanket
    // whitelist of unknown prefixes would make it invisible.
    const problems = auditInvariantIds(
      repo({ "src/lib/money.ts": "// See INV-MONYE-001.\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONYE-");
    expect(problems[0]).toContain("reserved");
  });

  it.each([
    ["indented TypeScript", "src/lib/example.ts", "    // See INV-CPA-001.\n"],
    ["indented TSX", "src/components/Example.tsx", "    {/* See INV-CPA-001. */}\n"],
    ["indented YAML", ".semgrep/rules/example.yml", "    invariant: INV-CPA-001\n"],
    ["indented JSON", "fixtures/example.json", '    "invariant": "INV-CPA-001"\n'],
    [
      "JSX-shaped source",
      "src/components/Example.tsx",
      "export const Example = () => (\n  <div>\n    INV-CPA-001\n  </div>\n);\n",
    ],
  ])("does not apply Markdown literal suppression to %s", (_name, rel, source) => {
    const problems = auditInvariantIds(repo({ [rel]: source }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-CPA-");
    expect(problems[0]).toContain("reserved");
  });

  it("accepts the Xero invoice-number fixtures that share the shape", () => {
    const problems = auditInvariantIds(
      repo({
        "src/lib/__tests__/xero.test.ts":
          'const invoices = ["INV-IB-001", "INV-SETTLE-001", "INV-SETTLE-002", "INV-SUP-001"];\n',
      }),
    );

    expect(problems).toEqual([]);
  });

  it("ignores a custom-prefix fixture inside a fenced code block", () => {
    const problems = auditInvariantIds(
      repo({
        "docs/example.md": "# Example\n\n```\nINV-NOPE-001\n```\n",
      }),
    );

    expect(problems).toEqual([]);
  });

  it.each([
    ["blockquote", "> ```text\n> INV-DEMO-999\n> ```"],
    ["list", "- ```text\n  INV-DEMO-999\n  ```"],
  ])("ignores a custom-prefix fixture inside a %s fence", (_name, fixture) => {
    const problems = auditInvariantIds(
      repo({
        "docs/example.md": `# Example\n\n${fixture}\n`,
      }),
    );

    expect(problems).toEqual([]);
  });

  it("fails an unresolved id under a live prefix inside a fence", () => {
    const problems = auditInvariantIds(
      repo({
        "docs/example.md": "# Example\n\n```\nINV-MONEY-002\n```\n",
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-002");
    expect(problems[0]).toContain("Markdown literal block or fence opener");
    expect(problems[0]).toContain("docs/example.md:4");
  });

  it.each([
    ["INV-MONEY-002", "```", "no file under docs/invariants/ defines it"],
    ["INV-MONEY-002", "~~~", "no file under docs/invariants/ defines it"],
    ["INV-MONEY-42", "```", "2 digit(s)"],
    ["INV-MONEY-0042", "~~~", "4 digit(s)"],
  ])(
    "audits declared-prefix id %s in a %s opener info string",
    (id, marker, expected) => {
      const problems = auditInvariantIds(
        repo({
          "docs/example.md": `# Example\n\n${marker}lang ${id}\nbody\n${marker}\n`,
        }),
      );

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(id);
      expect(problems[0]).toContain(expected);
      expect(problems[0]).toContain("docs/example.md:3");
    },
  );

  it.each([
    ["INV-MONEY-42", 2],
    ["INV-MONEY-0042", 4],
  ])("fails fenced live-prefix numeric near-miss %s", (id, digitCount) => {
    const problems = auditInvariantIds(
      repo({ "docs/example.md": `# Example\n\n\`\`\`\n${id}\n\`\`\`\n` }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(id);
    expect(problems[0]).toContain(`${digitCount} digit(s)`);
    expect(problems[0]).toContain("Markdown literal block or fence opener");
    expect(problems[0]).toContain("docs/example.md:4");
  });

  it("allows placeholders, reserved invoices and custom prefixes in fences", () => {
    const problems = auditInvariantIds(
      repo({
        "docs/example.md": [
          "# Example",
          "",
          "```",
          "INV-<PREFIX>-<NNN>",
          "INV-XERO-999",
          "INV-XERO-42",
          "INV-DEMO-999",
          "INV-DEMO-0042",
          "```",
          "",
        ].join("\n"),
      }),
    );

    expect(problems).toEqual([]);
  });

  it("rejects a live id in an illustrative SCHEME fence even when it resolves", () => {
    const problems = auditInvariantIds(
      repo({
        [INVARIANT_SCHEME]: "# Scheme\n\n```text\nINV-MONEY-001\n```\n",
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("live invariant id inside an illustrative literal block");
    expect(problems[0]).toContain(`${INVARIANT_SCHEME}:4`);
  });

  it("keeps every real SCHEME literal free of live-prefix ids", () => {
    const scheme = readFileSync(path.join(REPO_ROOT, INVARIANT_SCHEME), "utf8");
    const index = readFileSync(
      path.join(REPO_ROOT, "docs", "DOMAIN_INVARIANTS.md"),
      "utf8",
    );
    const livePrefixes = [
      ...new Set([...index.matchAll(/\bINV-([A-Z][A-Z0-9]*)-\d{3}\b/g)].map((match) => match[1])),
    ].sort();
    const liveId = new RegExp(`\\bINV-(?:${livePrefixes.join("|")})-\\d+\\b`);

    expect(
      literalAuditLines(scheme)
        .filter((line) => liveId.test(line.text))
        .map((line) => `${INVARIANT_SCHEME}:${line.number}`),
    ).toEqual([]);
  });

  it.each([
    "INV-MONEY-001a",
    "INV-MONEY-001_extra",
    "INV-MONEY-001-extra",
    "INV-MONEY-001.1",
  ])(
    "rejects identifier continuation %s in ordinary source",
    (malformed) => {
      const problems = auditDocs(
        repo({ "src/lib/money.ts": `// Malformed citation ${malformed}.\n` }),
      );

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(malformed);
      expect(problems[0]).toContain("identifier continuation");
    },
  );

  it.each([
    ["backtick opener", "```lang INV-MONEY-001a\nbody\n```", "INV-MONEY-001a", 3],
    ["tilde opener", "~~~lang INV-MONEY-001_extra\nbody\n~~~", "INV-MONEY-001_extra", 3],
    ["hyphenated opener", "```lang INV-MONEY-001-extra\nbody\n```", "INV-MONEY-001-extra", 3],
    ["dotted opener", "```lang INV-MONEY-001.1\nbody\n```", "INV-MONEY-001.1", 3],
    ["fenced body", "```text\nINV-MONEY-001a\n```", "INV-MONEY-001a", 4],
    ["dotted fenced body", "```text\nINV-MONEY-001.1\n```", "INV-MONEY-001.1", 4],
    ["dotted raw-HTML body", "<pre>\nINV-MONEY-001.1\n</pre>", "INV-MONEY-001.1", 4],
    ["dotted indented code", "    INV-MONEY-001.1", "INV-MONEY-001.1", 3],
  ])(
    "rejects identifier continuation in a %s",
    (_location, fixture, malformed, lineNumber) => {
      const problems = auditInvariantIds(
        repo({ "docs/example.md": `# Example\n\n${fixture}\n` }),
      );

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(malformed);
      expect(problems[0]).toContain("identifier continuation");
      expect(problems[0]).toContain(`docs/example.md:${lineNumber}`);
    },
  );

  it("catches a two-digit near-miss under a real prefix", () => {
    // It slips past the strict citation pattern and would otherwise resolve to
    // nothing while being reported as nothing.
    const problems = auditInvariantIds(
      repo({ "src/lib/money.ts": "// See INV-MONEY-01.\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-01");
    expect(problems[0]).toContain("2 digit(s)");
  });

  it("does not apply the shape guard to a reserved invoice prefix", () => {
    const problems = auditInvariantIds(
      repo({ "src/lib/__tests__/xero.test.ts": 'const n = "INV-XERO-9";\n' }),
    );

    expect(problems).toEqual([]);
  });

  it("only takes definitions from docs/invariants", () => {
    const problems = auditInvariantIds(
      repo({ "docs/elsewhere.md": "# Elsewhere\n\n## INV-MONEY-002\n" }),
    );

    // The heading did not define anything, so the id in it is an unresolved
    // citation — which is the loud outcome, not a silent second definition.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no file under docs/invariants/ defines it");
  });
});

describe("tracked citation source extensions", () => {
  it("loads every tracked text form by Git classification and excludes binary/untracked files", () => {
    const repoRoot = initGitRepo();
    const trackedText = {
      "src/fixture.mts": "// See INV-MONEY-001.\n",
      "src/fixture.cts": "// See INV-MONEY-001.\n",
      "scripts/fixture.sh": "# See INV-MONEY-001.\n",
      "config/fixture.toml": "rule = \"INV-MONEY-001\"\n",
      "config/fixture.jsonc": "{ \"rule\": \"INV-MONEY-001\" }\n",
      "fixtures/fixture.txt": "See INV-MONEY-001.\n",
      "fixtures/fixture.html": "<p>See INV-MONEY-001.</p>\n",
      Dockerfile: "# See INV-MONEY-001.\n",
    };
    commitFiles(repoRoot, "tracked text forms", {
      ...Object.fromEntries(repo()),
      ...trackedText,
    });

    const binaryPath = path.join(repoRoot, "fixtures", "fixture.bin");
    writeFileSync(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    git(repoRoot, "add", "fixtures/fixture.bin");
    git(repoRoot, "commit", "-m", "tracked binary");
    writeFileSync(
      path.join(repoRoot, "fixtures", "untracked.txt"),
      "See INV-MONEY-001.\n",
      "utf8",
    );

    const files = loadTrackedFiles(repoRoot);

    expect([...Object.keys(trackedText)].every((file) => files.has(file))).toBe(true);
    expect(files.has("fixtures/fixture.bin")).toBe(false);
    expect(files.has("fixtures/untracked.txt")).toBe(false);
    expect(auditInvariantIds(files)).toEqual([]);
  });

  it("loads and audits the invariant citations in the migration safety TSV", () => {
    const files = loadTrackedFiles(REPO_ROOT);
    const safetyLedger = files.get("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv");

    expect(safetyLedger).toContain("INV-MOD-026");
    expect(safetyLedger).toContain("INV-MOD-006");
    expect(safetyLedger).toContain("INV-MOD-005");
    expect(safetyLedger).toContain("INV-INT-017");
    expect(auditInvariantIds(files)).toEqual([]);
  });

  it("fails a bad id planted in the tracked migration safety TSV", () => {
    const files = loadTrackedFiles(REPO_ROOT);
    const ledger = "docs/BLUE_GREEN_MIGRATION_SAFETY.tsv";
    // One above the real INV-MOD maximum, not a far-out-of-range number: this
    // fixture is greppable, and #2889 is the issue about a repo-wide grep
    // returning an illustrative id and sending the next invariant to the wrong
    // number. Misleading a grep by one — which density then catches — is the
    // smallest lie this test can tell. See this file's fixture rule above.
    //
    // THEREFORE THIS NUMBER MOVES UP WHENEVER AN INV-MOD INVARIANT SHIPS, and
    // whoever ships one has to move it. Being one above the maximum is the whole
    // fixture: the moment the planted id becomes a real invariant it RESOLVES,
    // the audit reports nothing, and this case fails with a bare "expected 1,
    // got 0" that says nothing about why. The assertion below turns that into a
    // readable failure, and it was earned — INV-MOD-027 shipped and this case
    // went red on a branch whose author had no reason to look here.
    const planted = "INV-MOD-028";
    // The precondition the fixture rests on. When this fails, `planted` has been
    // taken by a real invariant: move it up one, and no further.
    expect(files.get("docs/DOMAIN_INVARIANTS.md")).not.toContain(planted);
    files.set(ledger, files.get(ledger).replace("INV-MOD-026", planted));

    // Derived, not pinned: any row inserted above it by an unrelated PR would
    // otherwise turn this into a red `verify` on a file this test does not own.
    const expectedLine =
      files.get(ledger).split("\n").findIndex((l) => l.includes(planted)) + 1;

    const problems = auditInvariantIds(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(planted);
    expect(problems[0]).toContain(`${ledger}:${expectedLine}`);
  });
});

describe("auditNumberSequences", () => {
  it("passes the clean fixture repository", () => {
    expect(auditNumberSequences(repo())).toEqual([]);
  });

  it("passes a prefix whose numbers run 001 upwards with no gaps", () => {
    const problems = auditNumberSequences(
      repo({ "docs/invariants/money.md": family("MONEY", ["001", "002", "003"]) }),
    );

    expect(problems).toEqual([]);
  });

  it("fails the #2889 case: a new id that skipped to the number a grep suggested", () => {
    // The incident, to scale: a family ran 001-032 and a branch took 042,
    // because the only place 041 appeared in the repository was a fenced example
    // in SCHEME.md and the maximum was read off a repo-wide grep rather than off
    // the index.
    //
    // The fixture uses a prefix this repository does not declare, deliberately.
    // Writing the real one here would put an invented number under a live prefix
    // back into the tree, where the next grep would find it and read it as the
    // maximum — which is the whole mistake. SCHEME.md §1.4 states the rule.
    const numbers = Array.from({ length: 32 }, (_, i) => String(i + 1).padStart(3, "0"));
    const problems = auditNumberSequences(
      repo({ "docs/invariants/demo.md": family("DEMO", [...numbers, "042"]) }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-DEMO is missing 033-041");
    expect(problems[0]).toContain("its highest is INV-DEMO-042 (docs/invariants/demo.md:");
    expect(problems[0]).toContain("renumber it to INV-DEMO-033");
    // The diagnosis, not just the verdict: this is the mistake that made it.
    expect(problems[0]).toContain("grep");
  });

  it("reports several gaps as compressed runs rather than a wall of numbers", () => {
    const problems = auditNumberSequences(
      repo({
        "docs/invariants/money.md": family("MONEY", ["001", "005", "006", "009"]),
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing 002-004, 007-008");
  });

  it("fails a prefix that does not start at 001", () => {
    const problems = auditNumberSequences(
      repo({ "docs/invariants/money.md": family("MONEY", ["003", "004"]) }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY starts at INV-MONEY-003");
    expect(problems[0]).toContain("not 001");
  });

  it("reports a bad start and an interior hole separately, so both get fixed", () => {
    const problems = auditNumberSequences(
      repo({ "docs/invariants/money.md": family("MONEY", ["002", "004"]) }),
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("starts at INV-MONEY-002");
    expect(problems[1]).toContain("missing 003");
  });

  it("checks each prefix on its own, not the numbers across all of them", () => {
    // A prefix is a namespace: INV-CAP-001 existing says nothing about INV-MONEY.
    const problems = auditNumberSequences(
      repo({ "docs/invariants/beds.md": family("CAP", ["001", "002"]) }),
    );

    expect(problems).toEqual([]);
  });

  it("ignores an id in a fenced example, which is what a document shows one in", () => {
    // Far out of range on purpose: were the fence scanned, the family would run
    // 001 then 742 and this would report a 740-number hole. The prefix is one
    // this repository does not declare, so the fixture cannot itself become the
    // bait — which is the whole subject of #2889.
    const problems = auditNumberSequences(
      repo({
        "docs/invariants/demo.md": `${family("DEMO", ["001"])}\n\`\`\`\n## INV-DEMO-742\n\`\`\`\n`,
      }),
    );

    expect(problems).toEqual([]);
  });

  it("fails the whole check, not just this assertion in isolation", () => {
    const files = repo({
      "docs/invariants/money.md": family("MONEY", ["001", "004"]),
    });
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-MONEY-004\` | A rule |\n`,
    );

    expect(auditDocs(files).some((p) => p.includes("INV-MONEY is missing 002-003"))).toBe(
      true,
    );
  });
});

describe("auditPermanentInvariantIds", () => {
  it("fails deletion of the highest id even though the current sequence stays dense", () => {
    const baseline = repo({
      "docs/invariants/money.md": family("MONEY", ["001", "002", "003"]),
    });
    const current = repo({
      "docs/invariants/money.md": family("MONEY", ["001", "002"]),
    });

    expect(auditNumberSequences(current)).toEqual([]);
    const problems = auditPermanentInvariantIds(current, baseline, "base123");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-003 disappeared relative to base123");
    expect(problems[0]).toContain("highest number");
  });

  it("fails deletion of a whole prefix, which a current-tree census cannot see", () => {
    const baseline = repo({
      "docs/invariants/beds.md": family("CAP", ["001", "002"]),
    });
    const current = repo();

    const problems = auditPermanentInvariantIds(current, baseline, "base123");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("entire INV-CAP prefix disappeared");
    expect(problems[0]).toContain("INV-CAP-001, INV-CAP-002");
  });

  it("accepts a retained heading whose rule is retired in place", () => {
    const baseline = repo({
      "docs/invariants/money.md": family("MONEY", ["001", "002"]),
    });
    const current = repo({
      "docs/invariants/money.md":
        `${family("MONEY", ["001"])}\n## INV-MONEY-002\n\n**Retired: no longer applies.**\n`,
    });

    expect(auditPermanentInvariantIds(current, baseline)).toEqual([]);
  });

  it("is wired into the whole audit", () => {
    const baseline = repo({
      "docs/invariants/money.md": family("MONEY", ["001", "002"]),
    });
    const current = repo();

    const problems = auditDocs(current, { baselineFiles: baseline, baselineLabel: "base123" });
    expect(problems.some((problem) => problem.includes("INV-MONEY-002 disappeared"))).toBe(
      true,
    );
  });
});

describe("invariant baseline resolution and loading", () => {
  it("uses the exact pull-request event base SHA instead of a moving main ref", () => {
    const repoRoot = initGitRepo();
    const base = commitFiles(repoRoot, "base", {
      "docs/invariants/money.md": "# Money\n\n## INV-MONEY-001\n",
    });
    git(repoRoot, "checkout", "-b", "feature");
    commitFiles(repoRoot, "feature", { "feature.txt": "feature\n" });
    git(repoRoot, "checkout", "main");
    const movedMain = commitFiles(repoRoot, "main moved", { "main.txt": "later\n" });
    git(repoRoot, "checkout", "feature");

    const resolved = resolveInvariantBaselineRef(
      repoRoot,
      checkerEnv({
        GITHUB_BASE_REF: "main",
        GITHUB_EVENT_NAME: "pull_request",
        PR_BASE_SHA: base,
      }),
    );

    expect(resolved).toBe(base);
    expect(resolved).not.toBe(movedMain);
  });

  it("uses pull-request identity when synchronize also supplies webhook.before", () => {
    const repoRoot = initGitRepo();
    const base = commitFiles(repoRoot, "base", { "README.md": "base\n" });
    const previousHead = commitFiles(repoRoot, "previous PR head", {
      "feature.txt": "one\n",
    });
    commitFiles(repoRoot, "synchronized PR head", { "feature.txt": "two\n" });

    expect(
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({
          GITHUB_BASE_REF: "main",
          GITHUB_EVENT_NAME: "pull_request",
          PR_BASE_SHA: base,
          PUSH_BASE_SHA: previousHead,
        }),
      ),
    ).toBe(base);
  });

  it("fails closed when event identity is absent and both exact SHA fields are set", () => {
    const repoRoot = initGitRepo();
    const base = commitFiles(repoRoot, "base", { "README.md": "base\n" });

    expect(() =>
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({ PR_BASE_SHA: base, PUSH_BASE_SHA: base }),
      ),
    ).toThrow("Conflicting pull-request and push baseline identity");
  });

  it("fails closed when a pull-request event omits or names a missing base SHA", () => {
    const repoRoot = initGitRepo();
    commitFiles(repoRoot, "base", { "README.md": "# Repo\n" });

    expect(() =>
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({ GITHUB_BASE_REF: "main", GITHUB_EVENT_NAME: "pull_request" }),
      ),
    ).toThrow("PR_BASE_SHA is required");
    expect(() =>
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({
          GITHUB_BASE_REF: "main",
          GITHUB_EVENT_NAME: "pull_request",
          PR_BASE_SHA: "refs/heads/not-fetched",
        }),
      ),
    ).toThrow("PR_BASE_SHA refs/heads/not-fetched does not resolve to a commit");
  });

  it("fails an invalid explicit diagnostic baseline instead of falling back", () => {
    const repoRoot = initGitRepo();
    commitFiles(repoRoot, "base", { "README.md": "# Repo\n" });

    expect(() =>
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({ DOC_INDEX_BASE_REF: "refs/heads/not-fetched" }),
      ),
    ).toThrow("DOC_INDEX_BASE_REF refs/heads/not-fetched does not resolve to a commit");
  });

  it("fails closed rather than letting a diagnostic override replace an event base", () => {
    const repoRoot = initGitRepo();
    const base = commitFiles(repoRoot, "base", { "README.md": "base\n" });
    commitFiles(repoRoot, "head", { "README.md": "head\n" });

    expect(() =>
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({
          DOC_INDEX_BASE_REF: "HEAD",
          GITHUB_BASE_REF: "main",
          GITHUB_EVENT_NAME: "pull_request",
          PR_BASE_SHA: base,
        }),
      ),
    ).toThrow("DOC_INDEX_BASE_REF cannot be set for a pull-request event");
    expect(() =>
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({
          DOC_INDEX_BASE_REF: "HEAD",
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          PUSH_BASE_SHA: base,
        }),
      ),
    ).toThrow("DOC_INDEX_BASE_REF cannot be set for a main-push event");
  });

  it("fails when an exact event SHA is absent from a shallow checkout", () => {
    const source = initGitRepo();
    const base = commitFiles(source, "base", { "README.md": "base\n" });
    commitFiles(source, "tip", { "README.md": "tip\n" });
    const cloneParent = mkdtempSync(path.join(tmpdir(), "doc-index-shallow-"));
    TEMP_ROOTS.add(cloneParent);
    const shallow = path.join(cloneParent, "repo");
    execFileSync(
      "git",
      ["clone", "--depth", "1", pathToFileURL(source).href, shallow],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(() =>
      resolveInvariantBaselineRef(
        shallow,
        checkerEnv({ GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: base }),
      ),
    ).toThrow(`PR_BASE_SHA ${base} does not resolve to a commit`);
  });

  it("uses a local feature branch's merge-base, never its first parent", () => {
    const repoRoot = initGitRepo();
    const base = commitFiles(repoRoot, "base", { "README.md": "base\n" });
    git(repoRoot, "checkout", "-b", "feature");
    const featureParent = commitFiles(repoRoot, "feature one", {
      "feature.txt": "one\n",
    });
    commitFiles(repoRoot, "feature two", { "feature.txt": "two\n" });
    git(repoRoot, "checkout", "main");
    commitFiles(repoRoot, "main moved", { "main.txt": "later\n" });
    git(repoRoot, "checkout", "feature");

    const resolved = resolveInvariantBaselineRef(repoRoot, checkerEnv());

    expect(resolved).toBe(base);
    expect(resolved).not.toBe(featureParent);
  });

  it("does not use HEAD^1 when no main ref exists on a feature branch", () => {
    const repoRoot = initGitRepo("feature");
    commitFiles(repoRoot, "one", { "README.md": "one\n" });
    commitFiles(repoRoot, "two", { "README.md": "two\n" });

    expect(() => resolveInvariantBaselineRef(repoRoot, checkerEnv())).toThrow(
      "HEAD^1 is deliberately not a feature-branch fallback",
    );
  });

  it("uses the exact main-push before SHA and fails when that event SHA is absent", () => {
    const repoRoot = initGitRepo();
    const before = commitFiles(repoRoot, "before", { "README.md": "before\n" });
    commitFiles(repoRoot, "after", { "README.md": "after\n" });
    const pushEnv = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
    };

    expect(
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({ ...pushEnv, PUSH_BASE_SHA: before }),
      ),
    ).toBe(before);
    expect(() =>
      resolveInvariantBaselineRef(repoRoot, checkerEnv(pushEnv)),
    ).toThrow("PUSH_BASE_SHA is required");
  });

  it("uses the exact before SHA for a push to an epic/** integration branch", () => {
    // #3002 put `push: branches: [epic/**]` on ci.yml, which made this path
    // reachable for the first time. Before the widening this threw, so `verify`
    // — a required check — died about twenty seconds in on EVERY epic-branch
    // push, every time.
    const repoRoot = initGitRepo();
    const before = commitFiles(repoRoot, "before", { "README.md": "before\n" });
    git(repoRoot, "checkout", "-b", "epic/2988-club-time");
    commitFiles(repoRoot, "a child merged", { "README.md": "after\n" });

    expect(
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/epic/2988-club-time",
          GITHUB_REF_NAME: "epic/2988-club-time",
          PUSH_BASE_SHA: before,
        }),
      ),
    ).toBe(before);
  });

  it("takes the branch point when the push CREATED the epic branch", () => {
    // A ref-creating push carries an all-zero `before`, and epic branches are
    // created routinely now. Resolving that as a commit fails, so the branch
    // point against main is used instead — which is exactly the set of ids the
    // branch is answerable for retaining. It must NOT be HEAD^1, which can
    // postdate a deletion made earlier in the same push.
    const repoRoot = initGitRepo();
    const branchPoint = commitFiles(repoRoot, "main tip", { "README.md": "main\n" });
    git(repoRoot, "checkout", "-b", "epic/2988-club-time");
    const firstChild = commitFiles(repoRoot, "child one", { "child.txt": "one\n" });
    commitFiles(repoRoot, "child two", { "child.txt": "two\n" });

    const epicPush = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/epic/2988-club-time",
      GITHUB_REF_NAME: "epic/2988-club-time",
    };

    const fromAllZero = resolveInvariantBaselineRef(
      repoRoot,
      checkerEnv({ ...epicPush, PUSH_BASE_SHA: "0".repeat(40) }),
    );
    expect(fromAllZero).toBe(branchPoint);
    expect(fromAllZero).not.toBe(firstChild);
    // Same answer when the workflow supplies no before at all.
    expect(resolveInvariantBaselineRef(repoRoot, checkerEnv(epicPush))).toBe(branchPoint);
  });

  it("still refuses a push to a ref that is neither main nor epic/**", () => {
    // The widening is precise, not an opening. A feature branch's push carries a
    // `before` this check cannot interpret as an invariant-retention baseline,
    // so it fails closed exactly as it did.
    const repoRoot = initGitRepo();
    const before = commitFiles(repoRoot, "before", { "README.md": "before\n" });
    git(repoRoot, "checkout", "-b", "feature/x");
    commitFiles(repoRoot, "work", { "README.md": "after\n" });

    expect(() =>
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/feature/x",
          GITHUB_REF_NAME: "feature/x",
          PUSH_BASE_SHA: before,
        }),
      ),
    ).toThrow("supported only for pushes to main or an epic/** integration branch");
  });

  it("refuses an all-zero before on main, which a push cannot create", () => {
    const repoRoot = initGitRepo();
    commitFiles(repoRoot, "before", { "README.md": "before\n" });
    commitFiles(repoRoot, "after", { "README.md": "after\n" });

    expect(() =>
      resolveInvariantBaselineRef(
        repoRoot,
        checkerEnv({
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REF_NAME: "main",
          PUSH_BASE_SHA: "0".repeat(40),
        }),
      ),
    ).toThrow("PUSH_BASE_SHA is the all-zero object id");
  });

  it("loads invariant files from the resolved revision and rejects a missing ref", () => {
    const repoRoot = initGitRepo();
    const base = commitFiles(repoRoot, "base", {
      "docs/invariants/money.md": "# Money\n\nbase text\n",
    });
    commitFiles(repoRoot, "head", {
      "docs/invariants/money.md": "# Money\n\nhead text\n",
    });

    const loaded = loadInvariantFilesAtRef(repoRoot, base);

    expect(loaded.get("docs/invariants/money.md")).toContain("base text");
    expect(loaded.get("docs/invariants/money.md")).not.toContain("head text");
    expect(() => loadInvariantFilesAtRef(repoRoot, "refs/heads/not-fetched")).toThrow(
      "Invariant baseline ref refs/heads/not-fetched does not resolve to a commit",
    );
  });
});

describe("doc-index CLI baseline wiring", () => {
  it(
    "passes a real pull-request synchronize shape whose webhook.before is populated",
    () => {
      const eventRoot = mkdtempSync(path.join(tmpdir(), "doc-index-event-"));
      TEMP_ROOTS.add(eventRoot);
      const eventPath = path.join(eventRoot, "event.json");
      const event = {
        action: "synchronize",
        after: repoRevision("HEAD"),
        before: repoRevision("HEAD^1"),
        number: 2891,
        pull_request: {
          base: { ref: "main", sha: repoRevision("origin/main") },
          head: { sha: repoRevision("HEAD") },
        },
      };
      writeFileSync(eventPath, `${JSON.stringify(event)}\n`, "utf8");
      const synchronize = JSON.parse(readFileSync(eventPath, "utf8"));

      const result = spawnSync(process.execPath, [CHECKER_PATH], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: checkerEnv({
          GITHUB_BASE_REF: synchronize.pull_request.base.ref,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          PR_BASE_SHA: synchronize.pull_request.base.sha,
          // This is exactly what the workflow's github.event.before mapping
          // receives for a synchronize payload. It is a previous PR head, not
          // evidence that this is also a push event.
          PUSH_BASE_SHA: synchronize.before,
        }),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("every id present at base");
    },
    15_000,
  );

  it("fails closed at the CLI when an event base SHA is missing", () => {
    const result = spawnSync(process.execPath, [CHECKER_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: checkerEnv({
        GITHUB_BASE_REF: "main",
        GITHUB_EVENT_NAME: "pull_request",
        PR_BASE_SHA: "refs/heads/not-fetched",
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "PR_BASE_SHA refs/heads/not-fetched does not resolve to a commit",
    );
  });

  it(
    "passes through the CLI with a valid explicit exact baseline",
    () => {
      const result = spawnSync(process.execPath, [CHECKER_PATH], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: checkerEnv({ DOC_INDEX_BASE_REF: "HEAD" }),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("every id present at base");
    },
    15_000,
  );

  it("fails closed at the CLI when a process override collides with PR identity", () => {
    const result = spawnSync(process.execPath, [CHECKER_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: checkerEnv({
        DOC_INDEX_BASE_REF: "HEAD",
        GITHUB_BASE_REF: "main",
        GITHUB_EVENT_NAME: "pull_request",
        PR_BASE_SHA: repoRevision("origin/main"),
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "DOC_INDEX_BASE_REF cannot be set for a pull-request event",
    );
  });

  it("wires both immutable event SHAs into the CI doc-index step", () => {
    const workflow = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const start = workflow.indexOf(
      "- name: Check doc index integrity (reachability + invariant ids)",
    );
    const end = workflow.indexOf("- name: Install dependencies", start);
    const step = workflow.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(step.match(/^ {10}PR_BASE_SHA:.*$/gm)).toEqual([
      "          PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}",
    ]);
    expect(step.match(/^ {10}PUSH_BASE_SHA:.*$/gm)).toEqual([
      "          PUSH_BASE_SHA: ${{ github.event.before }}",
    ]);
    expect(step.match(/^ {8}env:\s*$/gm)).toHaveLength(1);
    expect(step.match(/^ {8}run:.*$/gm)).toEqual([
      "        run: node scripts/ci/check-doc-index-integrity.mjs",
    ]);
    expect(workflow).not.toContain("DOC_INDEX_BASE_REF");
  });
});

describe("auditInvariantFilesLinkedFromIndex", () => {
  it("fails an invariant file the index does not name", () => {
    const files = repo({
      "docs/invariants/orphan.md": "# Orphan\n\n## INV-MONEY-002\n\n- A rule.\n",
    });
    // Keep the index catalogue honest so this test isolates the link rule.
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-MONEY-002\` | A rule |\n`,
    );

    const problems = auditInvariantFilesLinkedFromIndex(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/invariants/orphan.md");
  });

  it("fails loudly when the index itself is gone", () => {
    const files = repo();
    files.delete("docs/DOMAIN_INVARIANTS.md");

    expect(auditInvariantFilesLinkedFromIndex(files)[0]).toContain("is missing");
  });
});

describe("auditIndexRows", () => {
  it.each(["", " ", "  ", "   "])(
    "accepts a valid GFM index row with %s leading spaces",
    (indent) => {
      const files = repo();
      files.set(
        "docs/DOMAIN_INVARIANTS.md",
        files
          .get("docs/DOMAIN_INVARIANTS.md")
          .replace("| `INV-MONEY-001`", `${indent}| \`INV-MONEY-001\``),
      );

      expect(auditIndexRows(files)).toEqual([]);
    },
  );

  it("fails a defined id with no catalogue row", () => {
    const files = repo({
      "docs/invariants/money.md": [
        "# Money",
        "",
        "## INV-MONEY-001",
        "",
        "- Cents.",
        "",
        "## INV-MONEY-002",
        "",
        "- Also cents.",
        "",
      ].join("\n"),
    });

    const problems = auditIndexRows(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-002");
    expect(problems[0]).toContain("no row");
  });

  it("fails a catalogue row whose definition does not exist", () => {
    const files = repo();
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-MONEY-002\` | Vanished |\n`,
    );

    const problems = auditIndexRows(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-MONEY-002");
    expect(problems[0]).toContain("nothing under docs/invariants/ defines it");
  });

  it("fails a duplicated catalogue row", () => {
    const files = repo();
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-MONEY-001\` | Listed twice |\n`,
    );

    const problems = auditIndexRows(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2 rows");
  });

  it("fails a three-space-indented duplicate row through the whole audit", () => {
    const files = repo();
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}   | \`INV-MONEY-001\` | Listed twice |\n`,
    );

    const problems = auditDocs(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2 rows");
  });

  it("does not count an id used as an illustration in the index's own prose", () => {
    const files = repo();
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}\nCite ids, never line numbers: \`INV-MONEY-001\` stays valid.\n`,
    );

    expect(auditIndexRows(files)).toEqual([]);
  });
});

describe("auditDocReachability", () => {
  it("fails a docs page nothing links to", () => {
    const problems = auditDocReachability(
      repo({ "docs/lonely/notes.md": "# Notes\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/lonely/notes.md");
  });

  it("accepts a page reached through a chain of hubs", () => {
    const problems = auditDocReachability(
      repo({
        "docs/README.md":
          "# Docs\n\n- [Domain invariants](DOMAIN_INVARIANTS.md)\n- [Lobby](lobby/README.md)\n",
        "docs/lobby/README.md": "# Lobby\n\n- [ADR-1](decisions/ADR-001.md)\n",
        "docs/lobby/decisions/ADR-001.md": "# ADR-001\n",
      }),
    );

    expect(problems).toEqual([]);
  });

  it("ignores Markdown outside docs/", () => {
    expect(auditDocReachability(repo({ "notes/scratch.md": "# Scratch\n" }))).toEqual([]);
  });
});

describe("routingTableRows", () => {
  it("takes the rows under the heading and stops at the next heading", () => {
    const rows = routingTableRows(repo().get("AGENTS.md")).map((row) => row.text);

    // Header row plus the one content row; the separator and the table under the
    // NEXT heading are both left out.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("INV-MONEY");
    expect(rows.join("\n")).not.toContain("Routing row");
  });
});

describe("auditRoutingTable", () => {
  it("passes a table whose prefixes and documents all resolve", () => {
    expect(auditRoutingTable(repo())).toEqual([]);
  });

  it("fails a row that links to a document nobody tracks", () => {
    const files = repo();
    files.set(
      "AGENTS.md",
      files.get("AGENTS.md").replace("](docs/README.md)", "](docs/gone.md)"),
    );

    const problems = auditRoutingTable(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/gone.md");
    expect(problems[0]).toContain("is not a tracked file");
  });

  it("fails a routed prefix that nothing declares (the typo case)", () => {
    const files = repo();
    files.set(
      "AGENTS.md",
      files.get("AGENTS.md").replace("`INV-MONEY`", "`INV-MONYE`"),
    );

    const problems = auditRoutingTable(files);

    // Routed-but-undeclared, and declared-but-unrouted: both directions fire.
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("routes INV-MONYE");
    expect(problems[1]).toContain("INV-MONEY is declared");
  });

  it("fails a declared invariant family that no row sends anybody to", () => {
    const files = repo({
      "docs/invariants/beds.md": "# Beds\n\n## INV-CAP-001\n\n- A rule.\n",
    });
    files.set(
      "docs/DOMAIN_INVARIANTS.md",
      `${files.get("docs/DOMAIN_INVARIANTS.md")}| \`INV-CAP-001\` | A rule |\n`,
    );

    const problems = auditRoutingTable(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INV-CAP is declared");
    expect(problems[0]).toContain("no routing table row");
  });

  it("fails loudly if the heading it anchors on is renamed away", () => {
    const files = repo();
    files.set(
      "AGENTS.md",
      files.get("AGENTS.md").replace("### Routing table", "### Where to look"),
    );

    const problems = auditRoutingTable(files);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("No routing table found");
  });
});

describe("auditStableIndexHeadings", () => {
  /** An index carrying two pinned sections and one that is not pinned. */
  function indexWith(headings) {
    return repo({
      "docs/DOMAIN_INVARIANTS.md": [
        "# Domain Invariants",
        "",
        "File: [`money.md`](invariants/money.md).",
        "",
        ...headings.flatMap((heading) => [`## ${heading}`, "", "Text.", ""]),
        "| ID | Covers |",
        "| --- | --- |",
        "| `INV-MONEY-001` | Store and calculate money as integer cents |",
        "",
      ].join("\n"),
    });
  }

  it("passes when every pinned heading is present, verbatim", () => {
    expect(
      auditStableIndexHeadings(indexWith(["Money", "Operations"]), [
        "Money",
        "Operations",
      ]),
    ).toEqual([]);
  });

  it("lets the index add new sections that are not pinned", () => {
    expect(
      auditStableIndexHeadings(
        indexWith(["Money", "Operations", "Product Configuration"]),
        ["Money", "Operations"],
      ),
    ).toEqual([]);
  });

  it("fails a renamed heading, which is what silently breaks an outside anchor", () => {
    const problems = auditStableIndexHeadings(
      indexWith(["Money and cents", "Operations"]),
      ["Money", "Operations"],
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"## Money"');
    expect(problems[0]).toContain("pre-split domain headings");
  });

  it("fails a heading whose only change is its capitalisation", () => {
    // GitHub's anchor slugs are case-folded, so `#money` still resolves here —
    // but `Member-Guest Consent` -> `Member-guest consent` does move the slug,
    // and no rule distinguishes the two safely. Byte-identical is the promise.
    const problems = auditStableIndexHeadings(indexWith(["money"]), ["Money"]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"## Money"');
  });

  it("refuses an empty pin list rather than reporting a pass it has not earned", () => {
    const problems = auditStableIndexHeadings(indexWith(["Money"]), []);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("vacuous");
  });

  it("is opt-in through auditDocs, and fires when the option is supplied", () => {
    // Both directions, because a conditional audit that main() forgets to wire
    // is exactly as useless as no audit.
    expect(auditDocs(indexWith(["Money and cents"]))).toEqual([]);
    expect(
      auditDocs(indexWith(["Money and cents"]), {
        stableIndexHeadings: ["Money"],
      }),
    ).toHaveLength(1);
  });

  it("pins ten headings that the real index really has", () => {
    // The constant is only worth anything while it describes the tree. A
    // heading dropped from the list AND from the index would otherwise agree
    // with itself.
    const files = loadTrackedFiles(REPO_ROOT);

    expect(STABLE_INDEX_HEADINGS).toHaveLength(10);
    expect(auditStableIndexHeadings(files, STABLE_INDEX_HEADINGS)).toEqual([]);
  });

  it("wires the pin into the CLI, not just into the exported audit", () => {
    // The CLI is the only caller that runs in `verify`. Asserted against the
    // source because `main()` resolves its own repo root and cannot be pointed
    // at a fixture; a planted rename was run through the real CLI by hand and
    // failed with the message above (#2720).
    const checker = readFileSync(CHECKER_PATH, "utf8");

    expect(checker).toContain("stableIndexHeadings: STABLE_INDEX_HEADINGS");
  });
});

describe("auditLineNumberCitations", () => {
  it("fails a line-number citation into the invariants index", () => {
    const problems = auditLineNumberCitations(
      repo({ "src/lib/money.ts": "// See docs/DOMAIN_INVARIANTS.md:120.\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/lib/money.ts:1");
    expect(problems[0]).toContain("docs/DOMAIN_INVARIANTS.md:120");
    expect(problems[0]).toContain("LINE");
  });

  it("fails a line-RANGE citation into a domain file", () => {
    const problems = auditLineNumberCitations(
      repo({ "src/lib/money.ts": "// invariants/money.md:35-40 says so.\n" }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("invariants/money.md:35-40");
  });

  it("fails in the files that used to be grandfathered, like anywhere else", () => {
    // These three carried the five pre-existing citations. They were fixed
    // rather than registered, and the register was deleted, so a fresh citation
    // here is now caught exactly like a fresh citation anywhere — this is the
    // case an allowlist would have masked.
    const problems = auditLineNumberCitations(
      repo({
        "src/lib/booking-request-quotes.ts": "// DOMAIN_INVARIANTS.md:35-40\n",
        "src/lib/booking-request-shared.ts": "// DOMAIN_INVARIANTS.md:35-40\n",
        "src/lib/ib-hold-clearing-audit.ts": "// DOMAIN_INVARIANTS.md:124-128\n",
      }),
    );

    expect(problems).toHaveLength(3);
    expect(problems.map((p) => p.split(" ")[0])).toEqual([
      "src/lib/booking-request-quotes.ts:1",
      "src/lib/booking-request-shared.ts:1",
      "src/lib/ib-hold-clearing-audit.ts:1",
    ]);
  });

  it("fails every citation on a line, not just the first", () => {
    const problems = auditLineNumberCitations(
      repo({
        "src/lib/money.ts":
          "// DOMAIN_INVARIANTS.md:120 and invariants/money.md:900 disagree.\n",
      }),
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("DOMAIN_INVARIANTS.md:120");
    expect(problems[1]).toContain("invariants/money.md:900");
  });

  it("points the reader at the id scheme rather than just refusing", () => {
    const [problem] = auditLineNumberCitations(
      repo({ "src/lib/money.ts": "// DOMAIN_INVARIANTS.md:120\n" }),
    );

    expect(problem).toContain("INV-CAP-021 style");
    expect(problem).toContain("docs/DOMAIN_INVARIANTS.md");
  });

  it("ignores a fenced example", () => {
    expect(
      auditLineNumberCitations(
        repo({ "docs/example.md": "# Example\n\n```\nDOMAIN_INVARIANTS.md:35-40\n```\n" }),
      ),
    ).toEqual([]);
  });

  it("ignores a line reference into a document that is not an invariants file", () => {
    expect(
      auditLineNumberCitations(
        repo({ "src/lib/money.ts": "// See docs/ARCHITECTURE.md:120.\n" }),
      ),
    ).toEqual([]);
  });
});

describe("auditEncoding", () => {
  it("passes the clean fixture repository", () => {
    expect(auditEncoding(repo())).toEqual([]);
  });

  it("fails a file that starts with a UTF-8 byte-order mark", () => {
    const problems = auditEncoding(
      repo({ "docs/example.md": `${BYTE_ORDER_MARK}# Example\n` }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/example.md");
    expect(problems[0]).toContain("byte-order mark");
    expect(problems[0]).toContain("UTF-8 without a BOM");
  });

  it("fails double-encoded text and explains where it comes from", () => {
    const problems = auditEncoding(
      repo({
        "docs/example.md": `# Example\n\nOne rule ${MOJIBAKE_EM_DASH} and no more.\n`,
      }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/example.md:3");
    expect(problems[0]).toContain("mojibake");
    expect(problems[0]).toContain("cp1252");
  });

  it("catches the non-breaking-space signature too", () => {
    const problems = auditEncoding(
      repo({ "docs/example.md": `# Example\n\n$10${MOJIBAKE_NBSP}per night.\n` }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("docs/example.md:3");
  });

  it("stays quiet on legitimate non-ASCII text", () => {
    // Real prose in this repository: em dashes, curly quotes, te reo macrons and
    // the odd accented name. None of them forms a lead+trail pair.
    const prose = [
      "# Example",
      "",
      "Tokoroa Alpine Club — the club's “house style” uses em dashes.",
      "Māori place names carry macrons: Whakatāne, Tūrangi.",
      "A café in Zürich costs £5 – or €6.",
      "",
    ].join("\n");

    expect(auditEncoding(repo({ "docs/example.md": prose }))).toEqual([]);
  });
});
