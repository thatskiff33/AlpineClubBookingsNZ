import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ALLOWANCE_DIR, type SizeAllowance } from "../lib/file-size-allowances";
import { evaluateComputedRatchet } from "../lib/file-size-base";
import { budgetForFile, isProductionFile } from "../lib/file-size-budget";

/**
 * #2979 — the ratchet's decision, with the previous length read from the base.
 *
 * These cases build THROWAWAY GIT REPOSITORIES, like the resolver's own suite,
 * and for a reason worth stating: the decision depends on WHICH FILES ARE IN THE
 * DIFF, and a harness that injects sizes without controlling the diff can only
 * prove the empty case. A first version of this file did exactly that and looked
 * like coverage while exercising neither `new-over-budget` nor
 * `grown-beyond-base` — the two findings that are the whole point.
 *
 * `countLines` is still injected, because "how long is it now" is the one input
 * that is cheaper to state than to construct.
 */

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function newRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "acb-ratchet-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  const write = (file: string, lines: number) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n", "utf8");
  };
  const commit = (msg: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", msg);
    return git(root, "rev-parse", "HEAD").trim();
  };
  return { root, write, commit };
}

/** Judge a repo, treating every `src/` file as production with a 700 budget. */
function judge(root: string, baseRef: string, now: Record<string, number>) {
  return evaluateComputedRatchet({
    root,
    baseRef,
    unclassified: [],
    isProductionFile: (file) => file.startsWith("src/"),
    budgetForFile: () => ({ category: "domain module", limit: 700 }),
    countLines: (_r, file) => now[file] ?? 0,
  });
}

describe("evaluateComputedRatchet — a NEW file must meet its budget", () => {
  it("fails a new file over the budget", () => {
    const repo = newRepo();
    repo.write("src/existing.ts", 10);
    const base = repo.commit("base");
    repo.write("src/fresh.ts", 10);
    repo.commit("added");

    const result = judge(repo.root, base, { "src/fresh.ts": 900 });

    const finding = result.findings.find((f) => f.file === "src/fresh.ts");
    expect(finding?.kind).toBe("new-over-budget");
    expect(finding?.severity).toBe("regression");
    expect(finding?.current).toContain("over by 200");
    expect(finding?.previous).toBeNull();
  });

  it("passes a new file inside the budget", () => {
    const repo = newRepo();
    repo.write("src/existing.ts", 10);
    const base = repo.commit("base");
    repo.write("src/fresh.ts", 10);
    repo.commit("added");

    expect(judge(repo.root, base, { "src/fresh.ts": 699 }).findings).toEqual([]);
  });

  it("treats the budget as exclusive: exactly at the limit is not over", () => {
    const repo = newRepo();
    repo.write("src/existing.ts", 10);
    const base = repo.commit("base");
    repo.write("src/fresh.ts", 10);
    repo.commit("added");

    expect(judge(repo.root, base, { "src/fresh.ts": 700 }).findings).toEqual([]);
    expect(judge(repo.root, base, { "src/fresh.ts": 701 }).findings).toHaveLength(1);
  });
});

describe("evaluateComputedRatchet — existing debt may stay but may not grow", () => {
  it("passes an already-oversized file that is unchanged in length", () => {
    // The property that lets 283 over-budget files stay without a stored list.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/big.ts", 1200);
    writeFileSync(path.join(repo.root, "src/big.ts"), "x\n".repeat(1200), "utf8");
    repo.commit("touched, same length");

    expect(judge(repo.root, base, { "src/big.ts": 1200 }).findings).toEqual([]);
  });

  it("fails an already-oversized file that grew by one line", () => {
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/big.ts", 1201);
    repo.commit("grew");

    const finding = judge(repo.root, base, { "src/big.ts": 1201 }).findings[0];
    expect(finding?.kind).toBe("grown-beyond-base");
    expect(finding?.problem).toBe("an already-oversized file grew");
    expect(finding?.previous).toContain("1200 LOC on the base ref");
    expect(finding?.current).toContain("+1 beyond its ceiling");
  });

  it("passes an already-oversized file that SHRANK, and the smaller size becomes the ceiling", () => {
    // No ledger to re-record, and no drift: the next change is judged against
    // the shrunken length because the base ref will carry it.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/big.ts", 900);
    const shrunk = repo.commit("shrank");

    expect(judge(repo.root, base, { "src/big.ts": 900 }).findings).toEqual([]);

    // And from the shrunken base, growing back toward the old size now fails.
    repo.write("src/big.ts", 1000);
    repo.commit("grew back");
    const after = judge(repo.root, shrunk, { "src/big.ts": 1000 });
    expect(after.findings[0]?.kind).toBe("grown-beyond-base");
  });

  it("reports every regression at once rather than stopping at the first", () => {
    // A gate that names one problem per run costs a full CI cycle per problem.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/big.ts", 1300);
    repo.write("src/fresh.ts", 800);
    repo.commit("grew one and added another");

    const result = judge(repo.root, base, {
      "src/big.ts": 1300,
      "src/fresh.ts": 800,
    });

    expect(result.findings).toHaveLength(2);
    expect(new Set(result.findings.map((f) => f.kind))).toEqual(
      new Set(["grown-beyond-base", "new-over-budget"]),
    );
  });

  it("fails an under-budget file that crossed its budget", () => {
    const repo = newRepo();
    repo.write("src/mod.ts", 600);
    const base = repo.commit("base");
    repo.write("src/mod.ts", 800);
    repo.commit("crossed");

    const finding = judge(repo.root, base, { "src/mod.ts": 800 }).findings[0];
    expect(finding?.kind).toBe("grown-beyond-base");
    expect(finding?.problem).toBe("the file grew past its budget");
  });
});

describe("evaluateComputedRatchet — a rename cannot launder debt", () => {
  it("keeps the predecessor's ceiling and says where it came from", () => {
    // The old ledger was keyed by path, so a `.ts` to `.js` rename left its
    // entry behind and passed. Here the previous length is looked up under the
    // old path that git reports.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    git(repo.root, "mv", "src/big.ts", "src/big.js");
    repo.commit("renamed");

    const grown = judge(repo.root, base, { "src/big.js": 1300 });
    const finding = grown.findings[0];
    expect(finding?.kind).toBe("grown-beyond-base");
    expect(finding?.previous).toContain("renamed from src/big.ts");

    // And a rename with no growth is not a finding at all.
    expect(judge(repo.root, base, { "src/big.js": 1200 }).findings).toEqual([]);
  });

  it("gives a file moved IN from outside the scope no ceiling, so it must meet its budget", () => {
    // The regression this closes, and the reason it matters: following the
    // rename unconditionally made "move an oversized file into src/" a way to
    // arrive over budget with the gate green. The ledger caught it by scanning
    // the whole tree and finding an over-budget file with no entry.
    const repo = newRepo();
    repo.write("prisma/demo-seed.ts", 1324);
    repo.write("src/keep.ts", 10);
    const base = repo.commit("base");
    mkdirSync(path.join(repo.root, "src"), { recursive: true });
    git(repo.root, "mv", "prisma/demo-seed.ts", "src/demo-seed.ts");
    repo.commit("moved into src");

    const finding = judge(repo.root, base, { "src/demo-seed.ts": 1324 }).findings[0];
    expect(finding?.kind).toBe("new-over-budget");
    expect(finding?.severity).toBe("regression");
    expect(finding?.problem).toBe(
      "a file MOVED INTO the budgeted scope is over its budget",
    );
    expect(finding?.previous).toContain("prisma/demo-seed.ts");
    expect(finding?.current).toContain("over by 624");
  });

  it("passes the same move when the file is UNDER its budget", () => {
    // The rule is the budget, not the move. Moving a small module into src/ is
    // an ordinary thing to do and must not be a finding.
    const repo = newRepo();
    repo.write("prisma/small.ts", 300);
    repo.write("src/keep.ts", 10);
    const base = repo.commit("base");
    mkdirSync(path.join(repo.root, "src"), { recursive: true });
    git(repo.root, "mv", "prisma/small.ts", "src/small.ts");
    repo.commit("moved into src");

    expect(judge(repo.root, base, { "src/small.ts": 300 }).findings).toEqual([]);
  });

  it("closes the two-step launder: out of scope to grow, then back in", () => {
    // Both halves used to pass. PR1 moves `src/big.ts` somewhere this policy does
    // not look and grows it 1200 -> 5000 (nothing in scope changed, so: green).
    // PR2 moves it back, inheriting 5000 as its "previous length" (so: green
    // again). A 5000-line production module lands and no run ever went red.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base1 = repo.commit("base");

    mkdirSync(path.join(repo.root, "out-of-scope"), { recursive: true });
    git(repo.root, "mv", "src/big.ts", "out-of-scope/big.ts");
    repo.write("out-of-scope/big.ts", 5000);
    const base2 = repo.commit("PR1: moved out and grown");

    // PR1 itself is still green, and correctly so — nothing in scope changed.
    expect(judge(repo.root, base1, { "out-of-scope/big.ts": 5000 }).findings).toEqual([]);

    git(repo.root, "mv", "out-of-scope/big.ts", "src/big2.ts");
    repo.commit("PR2: moved back in");

    const finding = judge(repo.root, base2, { "src/big2.ts": 5000 }).findings[0];
    expect(finding?.kind).toBe("new-over-budget");
    expect(finding?.current).toContain("over by 4300");
  });
});

describe("evaluateComputedRatchet — the unusable cases fail rather than pass", () => {
  it("reports an unresolvable base ref and judges nothing", () => {
    const repo = newRepo();
    repo.write("src/a.ts", 3);
    repo.commit("first");

    const result = judge(repo.root, "refs/heads/definitely-not-a-ref-2979", { "src/a.ts": 5000 });

    expect(result.baseSha).toBeNull();
    expect(result.checkedFiles).toBe(0);
    expect(result.findings.map((f) => f.kind)).toContain("base-unresolvable");
    expect(result.findings.every((f) => f.severity === "unusable")).toBe(true);
  });

  it("reports an unclassifiable source file as a hole in the gate", () => {
    const repo = newRepo();
    repo.write("src/a.ts", 3);
    const base = repo.commit("first");

    const result = evaluateComputedRatchet({
      root: repo.root,
      baseRef: base,
      unclassified: [{ file: "src/weird.mts", reason: "no rule matched" }],
      isProductionFile: () => false,
      budgetForFile: () => ({ category: "domain module", limit: 700 }),
      countLines: () => 0,
    });

    const finding = result.findings.find((f) => f.kind === "unclassified-source-file");
    expect(finding?.severity).toBe("unusable");
    expect(finding?.file).toBe("src/weird.mts");
  });

  it("ignores a non-production file however large", () => {
    const repo = newRepo();
    repo.write("docs/notes.md", 10);
    const base = repo.commit("base");
    repo.write("docs/notes.md", 9000);
    repo.commit("huge doc");

    expect(judge(repo.root, base, { "docs/notes.md": 9000 }).findings).toEqual([]);
  });
});

/**
 * #4926 — the hard ceiling (owner decision, 11 Nov 2026): an allowance may let
 * an over-budget file grow, but never past three times its budget, and a file
 * already past that may only stay or shrink. Judged with the REAL budgets and
 * classifier, so the boundaries below are the published 2,100 / 750 / 1,500.
 */
describe("evaluateComputedRatchet — the hard ceiling an allowance cannot pass", () => {
  const REASON = "the branch sits inside an existing decision tree that is its own refactor.";

  /** Commit `files` as the base, then grow `file` to `lines` with or without an allowance. */
  function change(
    files: Record<string, number>,
    file: string,
    lines: number,
    options: { allowance?: number; renameTo?: string } = {},
  ) {
    const repo = newRepo();
    for (const [name, length] of Object.entries(files)) repo.write(name, length);
    const base = repo.commit("base");
    const target = options.renameTo ?? file;
    if (options.renameTo) {
      mkdirSync(path.dirname(path.join(repo.root, target)), { recursive: true });
      git(repo.root, "mv", file, target);
    }
    repo.write(target, lines);
    const allowances: SizeAllowance[] = [];
    if (options.allowance !== undefined) {
      const source = `${ALLOWANCE_DIR}/4926-grow.md`;
      mkdirSync(path.join(repo.root, ALLOWANCE_DIR), { recursive: true });
      writeFileSync(
        path.join(repo.root, source),
        `file: ${target}\nlines: ${options.allowance}\nreason: ${REASON}\n`,
        "utf8",
      );
      allowances.push({ source, file: target, lines: options.allowance, reason: REASON });
    }
    // Empty when the file stays the same length, which is one of the cases.
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "--quiet", "--allow-empty", "-m", "change");
    return evaluateComputedRatchet({
      root: repo.root,
      baseRef: base,
      unclassified: [],
      isProductionFile,
      budgetForFile,
      countLines: (_r, name) => (name === target ? lines : (files[name] ?? 0)),
      allowances,
    });
  }

  const kinds = (result: { findings: Array<{ kind: string }> }) =>
    result.findings.map((finding) => finding.kind);

  it.each([
    ["domain module", "src/lib/big.ts", 1200, 2100],
    ["route handler", "src/app/api/thing/route.ts", 300, 750],
    ["route page shell", "src/app/thing/page.tsx", 600, 1500],
  ])("lets an allowance take a %s exactly to its hard ceiling, and refuses one line more", (_label, file, base, ceiling) => {
    expect(change({ [file]: base }, file, ceiling, { allowance: ceiling }).findings).toEqual([]);

    const over = change({ [file]: base }, file, ceiling + 1, { allowance: ceiling + 1 });
    // One finding: the refusal marks the allowance used, so it is not ALSO unused.
    expect(kinds(over)).toEqual(["allowance-over-hard-ceiling"]);
    expect(over.findings[0]?.problem).toBe(
      "an allowance cannot take a file past 3 times its budget",
    );
    expect(over.findings[0]?.current).toContain("+1 beyond its hard ceiling");
    expect(over.findings[0]?.action).toContain("split a cohesive part out first");
  });

  it("lets a file already past its ceiling stay or shrink with no allowance, and refuses any growth", () => {
    const file = "src/lib/huge.ts";
    expect(change({ [file]: 2500 }, file, 2500).findings).toEqual([]);
    expect(change({ [file]: 2500 }, file, 2400).findings).toEqual([]);

    const allowed = change({ [file]: 2500 }, file, 2501, { allowance: 2501 });
    expect(kinds(allowed)).toEqual(["allowance-over-hard-ceiling"]);
    expect(allowed.findings[0]?.action).toContain("at or under 2500 LOC");
  });

  it("does not tell a file past its ceiling to write an allowance that would be refused", () => {
    const file = "src/lib/huge.ts";
    const finding = change({ [file]: 2500 }, file, 2501).findings[0];
    expect(finding?.kind).toBe("grown-beyond-base");
    expect(finding?.action).toContain("An allowance cannot help");
    expect(finding?.action).not.toContain(ALLOWANCE_DIR);

    // Below the ceiling, the allowance is still the advice it was.
    const under = change({ [file]: 1200 }, file, 1201).findings[0];
    expect(under?.action).toContain(`${ALLOWANCE_DIR}/<pr-number>-<slug>.md`);
  });

  it("judges a file renamed within scope against the same hard ceiling", () => {
    const from = "src/lib/huge.ts";
    const to = "src/lib/renamed.ts";
    expect(change({ [from]: 2500 }, from, 2500, { renameTo: to }).findings).toEqual([]);

    const grown = change({ [from]: 2500 }, from, 2501, { renameTo: to, allowance: 2501 });
    expect(kinds(grown)).toEqual(["allowance-over-hard-ceiling"]);
    expect(grown.findings[0]?.previous).toContain("renamed from src/lib/huge.ts");
  });

  it("exempts nothing: src/lib/bed-allocation.ts may shrink but not grow, even with an allowance", () => {
    const file = "src/lib/bed-allocation.ts";
    expect(change({ [file]: 3802 }, file, 3790).findings).toEqual([]);
    expect(kinds(change({ [file]: 3802 }, file, 3803, { allowance: 3803 }))).toEqual([
      "allowance-over-hard-ceiling",
    ]);
  });

  it("keeps the first-crossing and mismatched-length refusals under their own kinds", () => {
    const file = "src/lib/mod.ts";
    // A first crossing straight past the ceiling is still a first crossing.
    expect(kinds(change({ [file]: 600 }, file, 2200, { allowance: 2200 }))).toEqual([
      "allowance-not-permitted",
    ]);
    // Under the ceiling, a wrong number is still a wrong number.
    expect(kinds(change({ [file]: 1200 }, file, 1300, { allowance: 1250 }))).toEqual([
      "allowance-mismatched",
    ]);
  });
});

describe("evaluateComputedRatchet — the change's effect on tree-wide size debt", () => {
  function delta(build: (repo: ReturnType<typeof newRepo>) => void, now: Record<string, number>) {
    const repo = newRepo();
    repo.write("src/lib/big.ts", 1200);
    repo.write("src/lib/small.ts", 100);
    const base = repo.commit("base");
    build(repo);
    repo.commit("change");
    return evaluateComputedRatchet({
      root: repo.root,
      baseRef: base,
      unclassified: [],
      isProductionFile,
      budgetForFile,
      countLines: (_r, file) => now[file] ?? 0,
    }).debtDelta;
  }

  it("is the growth of an over-budget file", () => {
    expect(delta((repo) => repo.write("src/lib/big.ts", 1300), { "src/lib/big.ts": 1300 })).toBe(100);
  });

  it("is negative when a file shrinks, and counts only what is over budget", () => {
    expect(delta((repo) => repo.write("src/lib/big.ts", 600), { "src/lib/big.ts": 600 })).toBe(-500);
  });

  it("is zero when nothing over budget moves", () => {
    expect(delta((repo) => repo.write("src/lib/small.ts", 400), { "src/lib/small.ts": 400 })).toBe(0);
  });

  it("follows a file out of scope and counts a deleted one as gone", () => {
    expect(
      delta((repo) => {
        mkdirSync(path.join(repo.root, "src/lib/__tests__"), { recursive: true });
        git(repo.root, "mv", "src/lib/big.ts", "src/lib/__tests__/big.ts");
      }, { "src/lib/__tests__/big.ts": 1200 }),
    ).toBe(-500);
    expect(delta((repo) => git(repo.root, "rm", "--quiet", "src/lib/big.ts"), {})).toBe(-500);
  });

  it("is null when the base cannot be resolved, rather than a reassuring zero", () => {
    const repo = newRepo();
    repo.write("src/a.ts", 3);
    repo.commit("first");
    expect(judge(repo.root, "refs/heads/definitely-not-a-ref-4926", {}).debtDelta).toBeNull();
  });
});
