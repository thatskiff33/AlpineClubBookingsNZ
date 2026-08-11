import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/*
  Half 4 reads every file under src/, docs/, scripts/ and changelog.d/ that could
  cite either issue. That is a few thousand small reads with no I/O wait worth
  measuring, but it is enough work to trip vitest's 5s default on a loaded box
  while other workers compete for the machine — a red suite with no defect behind
  it. Same reasoning and same remedy as `view-only-banner-contract.test.ts`.
*/
vi.setConfig({ testTimeout: 30_000 });

/**
 * #2773 / #2774 — the provenance guard.
 *
 * WHY A TEST AND NOT A REVIEW NOTE. Two independent review lenses found the same
 * defect on this branch: **eighteen** places in code and in **permanent invariant
 * documents** recorded the #2773 / #2774 directions as a settled "owner decision
 * 11 Aug 2026", while both issues carried `needs-decision`, one comment (the owner
 * holding the branch over exactly this), zero ticked options and no assignee. That
 * is not a wording nicety. `CLAUDE.md` makes the issue thread the audit trail,
 * `docs/DOMAIN_INVARIANTS.md` is mandatory reading, and `INV-ADDPAY-039`
 * **withholds a member's refund** — so a false "owner decided" clause in it would
 * tell every future agent that the semantics are settled and must not be revisited.
 * The attribution outlives the branch; prose alone would let it come back on the
 * next edit. The authority line under `INV-ADDPAY-039` is the single source for the
 * count and for the incident itself; if the two ever disagree, that one is right.
 *
 * WHAT IT PINS, in both directions:
 *
 * 1. **No source or document claims an owner decision for #2773 or #2774.** The
 *    scan is over every file listed below, which half 4 proves is every file in the
 *    tree that cites either issue — so re-adding a claim fails here by name rather
 *    than in a reviewer's head.
 * 2. **The true attribution is actually stated** where a reader lands: the
 *    authority line under `INV-ADDPAY-039`, the index rows in
 *    `docs/DOMAIN_INVARIANTS.md` for all three affected invariants, and the shared
 *    epilogue's module docblock. A silent strip would satisfy (1) while leaving the
 *    next reader to assume the same thing, so both halves are required.
 * 3. **The TRUE #2700 / #2750 / #2760 / #2761 citations are still there.** Deleting
 *    a real owner decision to make a scan pass is the same failure pointing the
 *    other way, and it is the obvious wrong way to fix a failure of (1). Those four
 *    threads each carry the owner's own dated comment; #2773 and #2774 do not.
 * 4. **The file list cannot fall behind the tree.** The gap that survived the first
 *    correction pass was not a missing pattern — it was five files nobody added to
 *    the list, including a routed document that still said "#2774 D1 settled". So
 *    the list is checked for completeness rather than trusted.
 *
 * MUTATION PROOF, re-run after every change here. Restore an "owner decision 11 Aug
 * 2026" clause — on one line OR wrapped across two, in a source file or a test
 * comment — and (1) fails naming the file and the sentence. Delete an authority
 * line, an index row's attribution, or the module docblock and (2) fails. Strip any
 * real 10 Aug citation and (3) fails. Add a new file citing either issue without
 * listing it and (4) fails.
 *
 * WHY THE SCAN IS WHITESPACE-COLLAPSED. It used to be per line, and these sentences
 * wrap: the branch's own TRUE citations already wrap ("(#2761, owner\ndecision 10
 * Aug 2026"), because at 80 columns an eight-word citation lands on a line break as
 * a matter of course. A per-line scan therefore missed the ordinary outcome of a
 * future author re-adding a claim and reflowing the paragraph — not an attack, just
 * the next edit. Matching a collapsed copy of the file and mapping the offset back
 * to a line number costs nothing and removes the whole class.
 *
 * IT DOES NOT ASSERT THE DECISION IS ABSENT FOREVER. When the owner rules on #2773
 * and #2774 and the answer is on the issue threads, this test is what has to be
 * updated deliberately — pointing at the recorded comment — which is the intended
 * cost of claiming owner authority. Note that the fabricated date, 11 Aug 2026, is
 * a real date on which a real ruling could land: a genuine one still means editing
 * this file on purpose, with the comment link in hand.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/**
 * Every file that cites #2773 or #2774, plus the guides most likely to grow a
 * citation next. Listed explicitly rather than globbed, because the CLAIM patterns
 * below would trip on legitimate citations of the #2700 / #2750 / #2760 / #2761
 * decisions, which ARE on the record — and half 4 checks the list is complete, so
 * "explicit" does not mean "allowed to fall behind".
 */
const PROVENANCE_SCANNED_FILES = [
  "docs/invariants/additional-payment-chasing.md",
  "docs/DOMAIN_INVARIANTS.md",
  "docs/END_TO_END_TEST_MATRIX.md",
  "docs/STATE_MACHINES.md",
  "docs/UX_FLOW_MAP.md",
  "docs/CONCURRENCY_AND_LOCKING.md",
  "docs/guides/payments.md",
  "docs/guides/notification-recipients.md",
  // Cites #2773/#2774 only in its census lineage ("432 -> 434"), added when the
  // two late-capture writers landed. No decision language, but the scan is by
  // CITATION not by content — a file that names either issue must be checked,
  // or the next author adds a claim here and nothing looks.
  "docs/ai-diagnostics/audit-admin-category-review.md",
  "scripts/audit/audit-writer-census-manifest.ts",
  "src/app/api/admin/email-templates/route.ts",
  "src/lib/cancelled-booking-late-capture.ts",
  "src/lib/deleted-booking-modification-payment.ts",
  "src/lib/stripe-webhook-service.ts",
  "src/lib/email-message-registry.ts",
  "src/lib/email-message-renderer.ts",
  "src/lib/email-message-audit-defaults.ts",
  "src/lib/email-message-notes.ts",
  "src/lib/email-templates.ts",
  "src/lib/email/admin-alerts-finance.ts",
  "src/components/admin/manual-refund-task-queue.tsx",
  // The test files matter as much as the sources. A test docblock is what the next
  // implementor reads before touching this money path, and four of them carried the
  // fabricated "the owner chose to keep it" sentence.
  "src/lib/__tests__/cancelled-booking-late-capture.test.ts",
  "src/lib/__tests__/deleted-booking-modification-payment.test.ts",
  "src/lib/__tests__/deleted-booking-refund-visibility.test.ts",
  "src/lib/__tests__/stripe-webhook-alerts.test.ts",
  "src/lib/__tests__/audit-writer-census.test.ts",
  "src/lib/__tests__/email-message-registry.test.ts",
  "src/lib/__tests__/email-sender-composed-note-binding.test.ts",
  "src/lib/email/__tests__/admin-late-capture-auto-refund-alert.test.ts",
  "src/lib/email/__tests__/admin-late-capture-hand-back-conflict-alert.test.ts",
  "src/components/admin/__tests__/manual-refund-task-queue-auto-refunded.test.tsx",
  "changelog.d/2773-late-capture-both-paths-and-hand-back-fence.md",
  "changelog.d/2760-auto-refund-record-and-alert.md",
] as const;

/**
 * The one file allowed to cite either issue without being scanned: this one. It
 * describes the fabricated clause in order to forbid it, and the authority line
 * deliberately describes rather than quotes it precisely so the date pattern below
 * can stay exemption-free everywhere else.
 */
const PROVENANCE_SCAN_EXEMPT_FILES = [
  "src/lib/__tests__/late-capture-decision-provenance.test.ts",
] as const;

/** Where a citation of either issue could plausibly live. */
const PROVENANCE_SEARCH_ROOTS = ["src", "docs", "scripts", "changelog.d"];
const PROVENANCE_SEARCH_EXTENSIONS = [".ts", ".tsx", ".md", ".mdx"];
const PROVENANCE_SEARCH_SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "coverage",
]);

/**
 * The shapes an "it was decided" claim takes in this repository. Deliberately
 * matched on the CLAIM rather than on the date: back-dating or re-dating the same
 * sentence is the obvious way round a date-only guard.
 */
const SETTLED_DECISION_CLAIMS = [
  // The date the fabricated clause carried. No owner decision bears it, so it has no
  // legitimate use in these files at all — not even inside a warning about itself,
  // which is why the authority line describes the incident rather than quoting it.
  /11\s+Aug\s+2026/i,
  /owner\s+decisions?\s+(?:10\s+and\s+)?11\b/i,
  // The claims, independent of any date, because re-dating the same sentence is the
  // obvious way round a date-only guard. Each of these is a sentence this branch
  // actually shipped.
  /OWNER\s+DECIDED\s+TO\s+KEEP/i,
  /owner\s+(?:chose|decided)\s+to\s+keep/i,
  /owner\s+settled\s+the\s+carve/i,
  /decided\s+by\s+the\s+owner/i,
  /settled\s+by\s+the\s+owner/i,
  // "The owner has ruled on #2774" — the negated form ("has NOT ruled"), which the
  // authority line and several correct citations use, does not match.
  /owner\s+(?:has\s+)?(?:ruled|decided)\s+on\s+#277[34]/i,
  // And the citation form, in both word orders, scoped to these two issues so the
  // real #2700 / #2750 / #2760 / #2761 citations in the same paragraphs are
  // untouched. The 60-character window is measured on the COLLAPSED copy, so it now
  // reaches across a line break — which is what the per-line version could not do —
  // and `[^.]` still stops it crossing a sentence boundary. It is deliberately not
  // wider: at 80 it starts matching two correctly-attributed sentences on this
  // branch, where a TRUE "#2760 — owner decision 10 Aug 2026" is followed in the
  // same sentence by "and by #2773, an orchestrator decision the owner has not
  // ruled on" (`additional-payment-chasing.md` under INV-ADDPAY-037, and the
  // matching paragraph in `STATE_MACHINES.md`). A pattern that fires on the exact
  // wording this guard exists to encourage is worse than one that needs the claim
  // to sit near its issue number.
  /#277[34][^.]{0,60}owner\s+decision/i,
  /owner\s+decision[^.]{0,60}#277[34]/i,
  // The verb this repository uses for "ratified", with the option label optional:
  // "#2774 D1 settled" is the citation the first correction pass left behind, and
  // the un-suffixed pattern did not match it.
  /#277[34](?:\s+D[12])?\s+(?:settled|ratified)\b/i,
];

/**
 * The true citations these files must KEEP, each on a thread that really does carry
 * the owner's own dated comment. The fastest wrong way to satisfy the scan above is
 * to delete every "owner decision" in sight; asserting the true ones stay makes that
 * fix fail instead of passing quietly.
 *
 * The patterns tolerate reflow — `[\s\S]{0,40}` rather than one exact spelling of a
 * dash — because a test that fails when an author rewraps a paragraph without
 * touching its meaning is a false alarm, and a false alarm here trains the next agent
 * to weaken the assertion.
 */
const TRUE_OWNER_CITATIONS = [
  { path: "docs/invariants/additional-payment-chasing.md", issue: "#2700" },
  { path: "docs/invariants/additional-payment-chasing.md", issue: "#2750" },
  { path: "docs/invariants/additional-payment-chasing.md", issue: "#2760" },
  { path: "src/lib/deleted-booking-modification-payment.ts", issue: "#2760" },
  { path: "src/lib/email-message-registry.ts", issue: "#2761" },
  { path: "src/lib/email/admin-alerts-finance.ts", issue: "#2761" },
] as const;

function trueCitationPattern(issue: string): RegExp {
  return new RegExp(
    `${issue}[\\s\\S]{0,40}owner\\s+decision\\s+10\\s+Aug\\s+2026`,
    "i",
  );
}

/**
 * A copy of `content` with every run of whitespace flattened to one space, plus the
 * line number each offset came from. Both are needed: the patterns have to be able
 * to cross a line break, and the failure message has to name a line an author can
 * open.
 */
function collapseWithLineMap(content: string): {
  text: string;
  lineForIndex: (index: number) => number;
} {
  const lineStarts: number[] = [];
  let text = "";
  for (const line of content.split(/\r?\n/)) {
    lineStarts.push(text.length);
    text += `${line.replace(/\s+/g, " ").trim()} `;
  }
  return {
    text,
    lineForIndex(index: number) {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (lineStarts[mid] <= index) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    },
  };
}

function globalise(pattern: RegExp): RegExp {
  return pattern.flags.includes("g")
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

function filesCitingEitherIssue(): string[] {
  const found: string[] = [];
  for (const root of PROVENANCE_SEARCH_ROOTS) {
    const entries = readdirSync(path.join(repoRoot, root), {
      withFileTypes: true,
      recursive: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!PROVENANCE_SEARCH_EXTENSIONS.includes(path.extname(entry.name))) {
        continue;
      }
      const absolute = path.join(entry.parentPath, entry.name);
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
      if (
        relative
          .split("/")
          .some((segment) => PROVENANCE_SEARCH_SKIPPED_DIRECTORIES.has(segment))
      ) {
        continue;
      }
      if (/#277[34]\b/.test(readFileSync(absolute, "utf8"))) found.push(relative);
    }
  }
  return found.sort();
}

describe("#2773 / #2774 decision provenance", () => {
  it("no source or document claims an owner decision for #2773 or #2774", () => {
    // Keyed by file and line, because several patterns deliberately overlap on the
    // sentences this branch actually shipped — reporting one line three times reads
    // as three defects.
    const offenders = new Map<string, string>();
    for (const relativePath of PROVENANCE_SCANNED_FILES) {
      const file = collapseWithLineMap(read(relativePath));
      for (const claim of SETTLED_DECISION_CLAIMS) {
        for (const match of file.text.matchAll(globalise(claim))) {
          const index = match.index ?? 0;
          const key = `${relativePath}:${file.lineForIndex(index)}`;
          if (!offenders.has(key)) {
            offenders.set(
              key,
              `${key} …${file.text.slice(index, index + 140).trim()}`,
            );
          }
        }
      }
    }
    // Named rather than counted, so a failure says which file and which sentence.
    expect([...offenders.values()]).toEqual([]);
  });

  it("INV-ADDPAY-039 carries the authority line, naming the orchestrator", () => {
    const invariants = read("docs/invariants/additional-payment-chasing.md");
    const section = invariants.slice(invariants.indexOf("### INV-ADDPAY-039"));
    expect(section).toContain(
      "WHO DECIDED THIS — THE ORCHESTRATOR, NOT THE OWNER",
    );
    // The three facts every other site is allowed to compress into a clause, so the
    // one place holding the full statement must actually hold all three.
    expect(section).toMatch(/\*\*The owner has not ruled on #2773\s*\n?>?\s*or #2774\.\*\*/);
    expect(section).toMatch(/Recommended\*\* option/);
    expect(section).toMatch(/reversible/i);
  });

  it("keeps every real owner citation it sits next to", () => {
    for (const citation of TRUE_OWNER_CITATIONS) {
      expect(
        collapseWithLineMap(read(citation.path)).text,
        `${citation.path} must keep its ${citation.issue} owner citation`,
      ).toMatch(trueCitationPattern(citation.issue));
    }
  });

  it("every invariant index row an unruled decision moved names the orchestrator", () => {
    // The index is mandatory reading and is where an agent in a hurry stops, so the
    // one-line row has to carry the attribution rather than only the detail page.
    // That applies to a row whose SCOPE an unruled decision widened exactly as much
    // as to the new rule: reversing #2773 re-narrows -037 and -038.
    const rows = read("docs/DOMAIN_INVARIANTS.md").split(/\r?\n/);
    const rowFor = (id: string) =>
      rows.find((line) => line.includes(`| \`${id}\` |`));

    const newRule = rowFor("INV-ADDPAY-039");
    expect(newRule).toBeDefined();
    expect(newRule).toContain("orchestrator decision");
    expect(newRule).toContain("owner has not ruled");

    for (const id of ["INV-ADDPAY-037", "INV-ADDPAY-038"] as const) {
      const row = rowFor(id);
      expect(row, `${id} index row`).toBeDefined();
      expect(row, `${id} index row`).toContain("#2773");
      expect(row, `${id} index row`).toContain("orchestrator decision");
      expect(row, `${id} index row`).toContain("owner has not ruled");
      expect(row, `${id} index row`).toContain("INV-ADDPAY-039");
    }
  });

  it("the shared epilogue's docblock states the provenance where an implementor reads it", () => {
    const epilogue = read("src/lib/cancelled-booking-late-capture.ts");
    expect(epilogue).toContain("WHO DECIDED THIS: THE ORCHESTRATOR");
    expect(epilogue).toMatch(/owner has NOT ruled/);
  });

  it("scans every file in the tree that cites either issue", () => {
    // The defect this closes is not a missing pattern. The first correction pass
    // fixed seventeen sites and left one, in a file simply absent from the list —
    // and four test files that had carried the clause were absent too, so
    // re-fabricating it in any of them passed CI. A list that is checked cannot
    // drift; one that is trusted already did.
    const listed = new Set<string>([
      ...PROVENANCE_SCANNED_FILES,
      ...PROVENANCE_SCAN_EXEMPT_FILES,
    ]);
    expect(filesCitingEitherIssue().filter((file) => !listed.has(file))).toEqual(
      [],
    );
    // And nothing is listed that does not exist, which is how a rename would
    // otherwise silently empty the scan.
    for (const relativePath of PROVENANCE_SCANNED_FILES) {
      expect(() => read(relativePath), relativePath).not.toThrow();
    }
  });
});
