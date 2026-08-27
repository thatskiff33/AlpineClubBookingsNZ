import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../ci/check-file-size-budget";
import { evaluateComputedRatchet } from "../lib/file-size-base";
import { ALLOWANCE_DIR } from "../lib/file-size-allowances";

import {
  PRODUCTION_LIMIT,
  ROUTE_HANDLER_LIMIT,
  ROUTE_PAGE_LIMIT,
  budgetForFile,
  countLines,
  findOversizedProductionFiles,
  findUnclassifiedFiles,
  isProductionFile,
  isRatchetExcludedTestFile,
  scanRepository,
  summariseSizeDebt,
  type FileStat,
} from "../lib/file-size-budget";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** A small synthetic tree: one file per budget category, all within budget. */
const CLEAN_TREE: FileStat[] = [
  { file: "src/lib/small-module.ts", lines: PRODUCTION_LIMIT },
  { file: "src/app/api/example/route.ts", lines: ROUTE_HANDLER_LIMIT },
  { file: "src/app/(admin)/admin/example/page.tsx", lines: ROUTE_PAGE_LIMIT },
];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * A throwaway repository, because the decision now depends on the DIFF.
 *
 * #2979 moved the previous length out of a file we wrote ourselves and into
 * git, so a harness that injects sizes without controlling the diff can only
 * prove the empty case. Every case below therefore builds real commits and
 * drives the real entry point over them.
 *
 * `core.autocrlf false` plus an explicit `.gitattributes` keeps the blob and
 * the working tree byte-identical on Windows, so `git show` and `countLines`
 * cannot disagree about how many lines a file has (#2399).
 */
const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
  vi.restoreAllMocks();
});

function newRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "acb-file-size-budget-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  // Not `git init -b`: naming the branch through the symbolic ref works the
  // same way on every git this repository is built with.
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(
    path.join(root, ".gitattributes"),
    "* text eol=lf\n",
    "utf8",
  );

  const write = (file: string, lines: number) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "line\n".repeat(lines), "utf8");
  };
  const commit = (message: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", message);
    return git(root, "rev-parse", "HEAD").trim();
  };
  /** Declare a file-size allowance the way a pull request would. */
  const allow = (name: string, body: string) => {
    const full = path.join(root, ALLOWANCE_DIR, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  };

  return { root, write, commit, allow };
}

function captureRun(
  root: string,
  argv: readonly string[],
): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    });
  try {
    return {
      code: run(root, argv),
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function verifyJobSource(workflow: string): string {
  const start = workflow.search(/^  verify:\s*$/m);
  if (start === -1) return "";
  const afterStart = workflow.slice(start + "  verify:".length);
  const nextJob = afterStart.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return nextJob === -1 ? afterStart : afterStart.slice(0, nextJob);
}

describe("blocking CI wiring", () => {
  it("maps the public check command to the file-size ratchet entry point exactly", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["quality:budget"]).toBe(
      "tsx scripts/ci/check-file-size-budget.ts",
    );
  });

  it("offers no baseline-update command, because there is no baseline to update", () => {
    // #2979 acceptance criterion 8. The escape hatch existed to record an
    // accepted increase in a file that no longer exists; an accepted increase
    // is now explained in the pull request body.
    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(Object.keys(packageJson.scripts ?? {})).not.toContain(
      "quality:budget:update",
    );
  });

  it("tracks no file-size baseline, so no two branches can conflict over one", () => {
    // #2979 acceptance criterion 1. `--error-unmatch` exits non-zero for a path
    // git does not track, which is the assertion: the ledger is really gone from
    // the index, not merely deleted from someone's working tree.
    expect(() =>
      execFileSync(
        "git",
        ["ls-files", "--error-unmatch", "scripts/quality/file-size-baseline.txt"],
        { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toThrow();
  });

  it("runs the public check command exactly once in the blocking verify job", () => {
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    const verify = verifyJobSource(workflow);
    expect(verify, "ci.yml must contain a top-level verify job").not.toBe("");
    expect(
      verify.match(
        /^        run: npm run quality:budget -- --base "\$BUDGET_BASE"\s*$/gm,
      ) ?? [],
    ).toHaveLength(1);
  });

  it("passes an explicit base, because the default is vacuous on a push to main", () => {
    // `verify` runs on `push: branches: [main]` as well as on pull requests, and
    // there `origin/main` IS the commit under test: the merge base is HEAD, the
    // diff is empty, and the gate reports "0 production file(s) changed" and
    // exits 0 whatever the tree holds. Reproduced with two lanes that each add
    // 60 lines to a 600-line file: both pass their own PR gate, merge to 720
    // against a 700 budget, and the push gate says nothing.
    //
    // The event name is what selects the base, and that is the load-bearing
    // half. A `pull_request.synchronize` payload also carries a top-level
    // `before` — the previous PR head — so keying on the field instead of on
    // the event would judge only the newest push to a branch and let everything
    // earlier in it through.
    //
    // `github.event.created == false` is the other load-bearing half, and it is
    // newer (#3002). A ref-CREATING push carries `before = 0000…`, which this
    // gate refuses outright — correctly, there is no "before" to measure. That
    // was harmless while `push` only meant `main`, which cannot be created;
    // #3002 put `push: branches: [epic/**]` on this workflow and an epic branch
    // is created once per epic, so without the guard `verify` is red on the
    // first push of every epic branch.
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    const verify = verifyJobSource(workflow);
    expect(verify).toContain(
      "BUDGET_BASE: ${{ (github.event_name == 'push' && github.event.created == false" +
        " && !startsWith(github.ref, 'refs/heads/epic/'))" +
        " && github.event.before || 'origin/main' }}",
    );
  });

  it("routes a ref-creating push around the base it would refuse", () => {
    // The guard above, asserted as behaviour rather than as a string: the two
    // steps that compute a base from a push event must both key on
    // `github.event.created`, or the branch-creating push of every epic branch
    // reddens a required check. Named together on purpose — the migration
    // ledger step got the guard first and the ratchet did not, and a rule only
    // one of two identical expressions follows is a rule that drifts back.
    //
    // Scoped to `*_BASE`, which is a REF handed to a `--base` flag and where
    // `origin/main` is the sensible substitute. `PUSH_BASE_SHA` is deliberately
    // outside it: that one is an immutable event SHA, `origin/main` would be a
    // wrong answer rather than a fallback, and
    // scripts/ci/check-doc-index-integrity.mjs reads the all-zero itself and
    // takes the branch point.
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    const pushDerivedBases = workflow.match(/^ +[A-Z_]+_BASE: \$\{\{ .*github\.event\.before.*$/gm) ?? [];
    expect(pushDerivedBases.length).toBeGreaterThanOrEqual(2);
    for (const line of pushDerivedBases) {
      expect(line, `${line.trim()} must skip the all-zero base of a ref-creating push`).toContain(
        "github.event.created == false",
      );
      /*
        And the second half of the same rule (#2986). A NON-creating push to an
        integration branch carries `before = the previous epic commit`, against
        which a landed child's one-shot allowance reads as spent while it is
        still required against `main` — the base that branch's own pull request
        is judged on. Measured on epic #2986: 8 findings against the previous
        epic commit, OK against `origin/main`, identical tree. No allowance file
        can satisfy both, so an `epic/**` push is judged against `origin/main`.
        Asserted over every `*_BASE` line for the reason the guard above is:
        a rule only one of two identical expressions follows drifts back.
      */
      expect(
        line,
        `${line.trim()} must judge an epic integration branch against origin/main, ` +
          "not against the previous commit on that branch",
      ).toContain("!startsWith(github.ref, 'refs/heads/epic/')");
    }
  });

  it("checks out full history in that job, which the computed comparison needs", () => {
    // Load-bearing since #2979, for a quieter reason than it first said here: a
    // shallow clone does NOT fail. Measured — `git clone --depth 1` resolves
    // `origin/main`, the merge base comes back as HEAD, the diff is empty, and
    // the gate prints OK over a tree holding a 1300-line module. Truncated
    // history narrows the diff silently, so a switch to a shallow checkout would
    // turn this gate off rather than red.
    const workflow = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(verifyJobSource(workflow)).toMatch(/fetch-depth:\s*0/);
  });
});

describe("budget classification", () => {
  it("applies the documented budget for each kind of production file", () => {
    expect(budgetForFile("src/app/api/bookings/route.ts")).toMatchObject({
      slug: "route-handler",
      limit: ROUTE_HANDLER_LIMIT,
    });
    expect(
      budgetForFile("src/app/(admin)/admin/members/page.tsx"),
    ).toMatchObject({
      slug: "route-page-shell",
      limit: ROUTE_PAGE_LIMIT,
    });
    expect(budgetForFile("src/lib/email.ts")).toMatchObject({
      slug: "domain-module",
      limit: PRODUCTION_LIMIT,
    });
    // A co-located client component under app/ is a domain module, not a shell.
    expect(
      budgetForFile("src/app/(admin)/admin/members/members-client.tsx"),
    ).toMatchObject({
      slug: "domain-module",
      limit: PRODUCTION_LIMIT,
    });
  });

  it("covers every executable source extension, not just .ts/.tsx", () => {
    // The hole this closes: `git mv audit.ts audit.js` took a baselined file
    // out of scope entirely, and the tool reported it as a debt REDUCTION.
    for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
      expect(isProductionFile(`src/lib/audit.${ext}`)).toBe(true);
    }
    expect(budgetForFile("src/app/api/x/route.js")).toMatchObject({
      slug: "route-handler",
    });
    expect(budgetForFile("src/app/admin/x/page.jsx")).toMatchObject({
      slug: "route-page-shell",
    });
    expect(isProductionFile("src/lib/thing.test.js")).toBe(false);
    expect(isProductionFile("src/styles/app.css")).toBe(false);
  });

  it("shares one excluded test-path classifier across app and script roots", () => {
    for (const file of [
      "src/lib/thing.spec.mjs",
      "src/lib/__tests__/helper.cjs",
      "scripts/thing.test.ts",
      "scripts/__tests__/helper.js",
    ]) {
      expect(isRatchetExcludedTestFile(file), file).toBe(true);
    }
    expect(isRatchetExcludedTestFile("scripts/runtime.ts")).toBe(false);
    expect(isRatchetExcludedTestFile("e2e/example.spec.ts")).toBe(false);
    expect(isRatchetExcludedTestFile("scripts/example.test.md")).toBe(false);
  });

  it("gives root-level App Router files their real budget", () => {
    expect(budgetForFile("src/app/route.ts")).toMatchObject({
      slug: "route-handler",
      limit: ROUTE_HANDLER_LIMIT,
    });
    expect(budgetForFile("src/app/page.tsx")).toMatchObject({
      slug: "route-page-shell",
      limit: ROUTE_PAGE_LIMIT,
    });
  });

  it("treats the budget as exclusive: exactly at the limit is not over", () => {
    expect(findOversizedProductionFiles(CLEAN_TREE)).toEqual([]);
    expect(
      findOversizedProductionFiles([
        { file: "src/lib/x.ts", lines: PRODUCTION_LIMIT + 1 },
      ]),
    ).toHaveLength(1);
  });

  it("flags a tracked src/ file the classifier does not recognise", () => {
    const unclassified = findUnclassifiedFiles([
      "src/lib/big.ts",
      "src/styles/app.css",
      "src/lib/mystery.rs",
      "src/lib/no-extension",
      "scripts/outside-scope.rs",
    ]);
    expect(unclassified.map((entry) => entry.file)).toEqual([
      "src/lib/mystery.rs",
      "src/lib/no-extension",
    ]);
  });
});

describe("summariseSizeDebt", () => {
  it("is the whole tree's debt, and the same shape the report and the gate both read", () => {
    const summary = summariseSizeDebt([
      ...CLEAN_TREE,
      { file: "src/lib/big.ts", lines: 1200 },
      { file: "src/app/api/big/route.ts", lines: 400 },
    ]);
    expect(summary.scannedFiles).toBe(5);
    expect(summary.oversizedFiles).toBe(2);
    expect(summary.debt).toBe(
      1200 - PRODUCTION_LIMIT + (400 - ROUTE_HANDLER_LIMIT),
    );
    // Worst first, so the report's "largest" list needs no second sort key.
    expect(summary.oversized[0]?.file).toBe("src/lib/big.ts");
  });
});

describe("the gate, end to end, against real commits", () => {
  it("passes on a clean checkout of the base ref", () => {
    // #2979 acceptance criterion 2, in its most important form: a tree with 283
    // over-budget files and nothing changed since the base must be GREEN,
    // without a single line of accepted debt written down anywhere.
    const repo = newRepo();
    repo.write("src/lib/way-over.ts", 1200);
    repo.write("src/app/api/thing/route.ts", 900);
    const base = repo.commit("base");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("File-size budget ratchet: OK");
  });

  it("fails a NEW over-budget file, naming it, its length, its budget and the split", () => {
    // #2979 acceptance criterion 3.
    const repo = newRepo();
    repo.write("src/lib/existing.ts", 10);
    const base = repo.commit("base");
    repo.write("src/lib/brand-new.ts", 900);
    repo.commit("added a big new module");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/lib/brand-new.ts");
    expect(result.stderr).toContain("900 LOC");
    expect(result.stderr).toContain("domain module, <= 700 LOC");
    expect(result.stderr).toContain("over by 200");
    expect(result.stderr).toMatch(/split it/);
    expect(result.stderr).toContain("a NEW file is over its budget");
  });

  it("fails an UNTRACKED new over-budget file, which `git diff` cannot see", () => {
    // Found by probing, not by reading: the staged case failed correctly while
    // the untracked case printed nothing at all, because `git diff` lists
    // tracked changes only. The deleted ledger had the same blind spot through
    // `git ls-files`. Whoever runs the check before `git add` is exactly the
    // person who most needs the answer.
    const repo = newRepo();
    repo.write("src/lib/existing.ts", 10);
    const base = repo.commit("base");
    repo.write("src/lib/never-added.ts", 900);

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/lib/never-added.ts");
  });

  it("leaves an ignored file alone however large", () => {
    const repo = newRepo();
    repo.write("src/lib/existing.ts", 10);
    writeFileSync(path.join(repo.root, ".gitignore"), "src/generated/\n", "utf8");
    const base = repo.commit("base");
    repo.write("src/generated/huge.ts", 9000);

    expect(captureRun(repo.root, ["--base", base]).code).toBe(0);
  });

  it("fails an already-over-budget file that grew by one line", () => {
    // #2979 acceptance criterion 4, the growth half.
    const repo = newRepo();
    repo.write("src/lib/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/lib/big.ts", 1201);
    repo.commit("grew");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("1200 LOC on the base ref");
    expect(result.stderr).toContain("+1 beyond its ceiling");
    expect(result.stderr).toContain("an already-oversized file grew");
  });

  it("passes the same file unchanged, and passes it shrinking", () => {
    // #2979 acceptance criterion 4, the other two halves. Shrinking needs no
    // regeneration: the base ref carries the smaller number next time, so a
    // stale ceiling that would let those lines come back cannot exist.
    const repo = newRepo();
    repo.write("src/lib/big.ts", 1200);
    const base = repo.commit("base");

    expect(captureRun(repo.root, ["--base", base]).code).toBe(0);

    repo.write("src/lib/big.ts", 900);
    const shrunk = repo.commit("split some of it out");
    expect(captureRun(repo.root, ["--base", base]).code).toBe(0);

    // And the smaller number really is the new ceiling.
    repo.write("src/lib/big.ts", 901);
    repo.commit("crept back up");
    const crept = captureRun(repo.root, ["--base", shrunk]);
    expect(crept.code).toBe(1);
    expect(crept.stderr).toContain("900 LOC on the base ref");
  });

  it("lets a renamed over-budget file keep its predecessor's ceiling", () => {
    // #2979 acceptance criterion 5. Moving an oversized file must not read as
    // 900 lines of brand-new debt.
    const repo = newRepo();
    repo.write("src/lib/old-home.ts", 1200);
    const base = repo.commit("base");
    git(repo.root, "mv", "src/lib/old-home.ts", "src/lib/new-home.ts");
    repo.commit("moved it");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("no longer lets a .ts to .js rename launder an over-budget file", () => {
    // #2979 acceptance criterion 6, and the sharper half of it. The ledger was
    // keyed by PATH: renaming a 1200-line `.ts` to `.js` left the old entry
    // behind, the new path was unlisted, and the tool reported the vanished
    // record as a debt REDUCTION. Here the previous length is looked up under
    // the old path git reports, so the ceiling follows the file across the
    // rename and growth is caught in the same commit as the rename.
    const repo = newRepo();
    repo.write("src/lib/audit.ts", 1200);
    const base = repo.commit("base");
    git(repo.root, "mv", "src/lib/audit.ts", "src/lib/audit.js");
    repo.write("src/lib/audit.js", 1700);
    repo.commit("renamed to .js and grew 500 lines");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/lib/audit.js");
    expect(result.stderr).toContain("renamed from src/lib/audit.ts");
    expect(result.stderr).toContain("+500 beyond its ceiling");
  });

  it("fails a file MOVED INTO src/ from outside the policy, over its budget", () => {
    // A rename is followed only within the budgeted scope. `prisma/`, `scripts/`
    // and the rest have no ceiling to inherit, so a file arriving from one of
    // them is judged as new — which is what the deleted ledger did by scanning
    // the whole tree and finding an over-budget file with no entry. Following
    // the rename unconditionally made a 1324-line `prisma/demo-seed.ts` pass on
    // arrival at `src/lib/`, and `prisma/demo-seed.ts` is a real file here.
    const repo = newRepo();
    repo.write("prisma/demo-seed.ts", 1324);
    repo.write("src/lib/keep.ts", 10);
    const base = repo.commit("base");
    mkdirSync(path.join(repo.root, "src/lib"), { recursive: true });
    git(repo.root, "mv", "prisma/demo-seed.ts", "src/lib/demo-seed.ts");
    repo.commit("moved into src");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("src/lib/demo-seed.ts");
    expect(result.stderr).toContain(
      "a file MOVED INTO the budgeted scope is over its budget",
    );
    expect(result.stderr).toContain("prisma/demo-seed.ts");
    expect(result.stderr).toContain("over by 624");
  });

  it("passes the same move when the arriving file is under its budget", () => {
    const repo = newRepo();
    repo.write("prisma/small.ts", 300);
    repo.write("src/lib/keep.ts", 10);
    const base = repo.commit("base");
    mkdirSync(path.join(repo.root, "src/lib"), { recursive: true });
    git(repo.root, "mv", "prisma/small.ts", "src/lib/small.ts");
    repo.commit("moved into src");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("closes the two-step launder through a test path, on the return leg", () => {
    // Both legs used to pass. Move `src/lib/big.ts` into `src/lib/__tests__/`
    // (excluded from production debt) and grow it 1200 -> 5000: nothing in scope
    // changed, so green, and correctly so. Then move it back to
    // `src/lib/big2.ts`, inheriting 5000 as its previous length: green again. A
    // 5000-line production module lands with no run ever going red.
    const repo = newRepo();
    repo.write("src/lib/big.ts", 1200);
    // Something must stay in scope, or the empty-scan floor answers first and
    // this case stops being about the launder.
    repo.write("src/lib/keep.ts", 10);
    const base1 = repo.commit("base");

    mkdirSync(path.join(repo.root, "src/lib/__tests__"), { recursive: true });
    git(repo.root, "mv", "src/lib/big.ts", "src/lib/__tests__/big.ts");
    repo.write("src/lib/__tests__/big.ts", 5000);
    const base2 = repo.commit("leg one: out of scope and grown");

    expect(captureRun(repo.root, ["--base", base1]).code).toBe(0);

    git(repo.root, "mv", "src/lib/__tests__/big.ts", "src/lib/big2.ts");
    repo.commit("leg two: back into scope");

    const returned = captureRun(repo.root, ["--base", base2]);
    expect(returned.code).toBe(1);
    expect(returned.stderr).toContain("src/lib/big2.ts");
    expect(returned.stderr).toContain("over by 4300");
  });

  it("refuses to report clean when it scanned no production files at all", () => {
    // "Scanned and found nothing wrong" and "scanned nothing" produce the same
    // empty findings list. The ledger implementation floored on this and the
    // rewrite lost it, so a checkout with no `src/` tree printed OK and exited
    // 0. A sparse checkout, a partial clone or the wrong working directory all
    // land here, and a gate that scans nothing must say so.
    const repo = newRepo();
    repo.write("docs/notes.md", 5);
    const base = repo.commit("base");
    repo.write("docs/more.md", 5);
    repo.commit("more docs");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNUSABLE");
    expect(result.stderr).toContain("no production source files at all");
    expect(result.stderr).toContain("an empty scan is not a pass");
  });

  it("names the commit it compared against, not only the ref", () => {
    // The comparison is against the merge base of the ref and HEAD, which on a
    // stale branch is not where the ref points. Until now nothing the gate
    // printed said so in either direction, so a surprising result could not be
    // checked without re-deriving the base by hand.
    const repo = newRepo();
    repo.write("src/lib/a.ts", 10);
    const base = repo.commit("base");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`merge base \`${base.slice(0, 12)}\``);
  });

  it("judges a branch on what IT did, not on how far main has moved", () => {
    // The reason the previous length comes from the MERGE BASE rather than from
    // the ref's tip. Measured on the #2979 branch itself: `origin/main` had
    // moved ahead by one merged pull request and `git diff origin/main` reported
    // seven `src/` files as changed that the branch never touched.
    //
    // Here `main` SPLITS an oversized file after the branch point. Against the
    // tip, the untouched branch copy reads as +300 lines of growth it did not
    // cause; against the merge base it reads as what it is, unchanged.
    const repo = newRepo();
    repo.write("src/lib/big.ts", 1200);
    repo.commit("base");
    git(repo.root, "checkout", "--quiet", "-b", "feature");
    git(repo.root, "checkout", "--quiet", "main");
    repo.write("src/lib/big.ts", 900);
    repo.commit("main split it");
    git(repo.root, "checkout", "--quiet", "feature");

    const untouched = captureRun(repo.root, ["--base", "main"]);
    expect(untouched.stderr).toBe("");
    expect(untouched.code).toBe(0);

    // And the merge base is not a way to hide the branch's OWN growth.
    repo.write("src/lib/big.ts", 1250);
    repo.commit("feature grew it");
    const grown = captureRun(repo.root, ["--base", "main"]);
    expect(grown.code).toBe(1);
    expect(grown.stderr).toContain("1200 LOC on the base ref");
    expect(grown.stderr).toContain("+50 beyond its ceiling");
  });

  it("fails loudly when the base ref cannot be resolved, rather than passing", () => {
    // #2979 acceptance criterion 9. An empty diff and an unreadable base look
    // identical from the outside — both produce no findings — which is why this
    // one has to be an explicit refusal rather than an absence.
    const repo = newRepo();
    repo.write("src/lib/way-over.ts", 5000);
    repo.commit("base");

    const result = captureRun(repo.root, ["--base", "origin/main"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNUSABLE");
    expect(result.stderr).toContain("origin/main");
    expect(result.stderr).toContain("git fetch origin main");
    expect(result.stderr).toContain("Judged 0 production file(s)");
  });

  it("fails loudly when the base exists but shares no history with this checkout", () => {
    // The shallow-clone shape. A ref that resolves but has no merge base is the
    // one case where "resolved the ref" is not the same as "can compare".
    const repo = newRepo();
    repo.write("src/lib/a.ts", 5);
    repo.commit("base");
    git(repo.root, "checkout", "--quiet", "--orphan", "unrelated");
    git(repo.root, "rm", "-rq", "--cached", ".");
    repo.write("src/lib/b.ts", 5);
    repo.commit("unrelated root");

    const result = captureRun(repo.root, ["--base", "main"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("shares no commit");
    expect(result.stderr).toContain("git fetch --unshallow");
  });

  it("refuses to judge anything while a tracked src/ file is unclassifiable", () => {
    // A scope hole reads exactly like a clean pass, so it is `unusable` rather
    // than a finding to be weighed against the others.
    const repo = newRepo();
    repo.write("src/lib/mystery.rs", 5);
    const base = repo.commit("base");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNUSABLE");
    expect(result.stderr).toContain("src/lib/mystery.rs");
  });

  it("explains that --update is gone instead of silently doing nothing", () => {
    const repo = newRepo();
    repo.write("src/lib/a.ts", 5);
    repo.commit("base");

    const result = captureRun(repo.root, ["--update"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("`--update` no longer exists");
    expect(result.stderr).toContain("pull request body");
    // It must not have recreated the thing it used to write.
    expect(() =>
      readFileSync(
        path.join(repo.root, "scripts/quality/file-size-baseline.txt"),
        "utf8",
      ),
    ).toThrow();
  });

  it("prints the whole tree's debt on request, and never fails on it", () => {
    // #2979 acceptance criterion 8's other half: the debt figure survives as a
    // report generated on demand rather than as a checked-in number.
    const repo = newRepo();
    repo.write("src/lib/big.ts", 1200);
    repo.write("src/app/api/thing/route.ts", 400);
    repo.write("src/lib/fine.ts", 20);
    repo.commit("base");

    const result = captureRun(repo.root, ["--report"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 of 3 production files are over budget");
    // (1200 - 700) + (400 - 250)
    expect(result.stdout).toContain("carrying 650 lines of debt");
    expect(result.stdout).toContain("src/lib/big.ts");
  });

  it("says so instead of throwing when it is not run inside a checkout", () => {
    const result = captureRun(path.join(REPO_ROOT, "no-such-directory-2979"), []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not list tracked files");
  });
});

describe("the deliberate escape: a declared allowance", () => {
  /**
   * Owner decision, 21 Aug 2026. Deleting `quality:budget:update` left the 283
   * already-over-budget files unable to gain a line, ever, with no way to say
   * "yes, I mean it" — measured, PR #2980 grows eight of them by 463 lines and
   * PR #2985 hit the same wall on `src/proxy.ts`. The escape is per-pull-request
   * (the `changelog.d/` pattern, so no two branches conflict), it names the
   * file, the length and the reason, and it must never reopen either bypass
   * this pull request closed.
   */
  const REASON =
    "the branch is four lines of policy inside an existing decision tree, and " +
    "lifting that tree out is a refactor of its own.";

  function overBudgetRepo() {
    const repo = newRepo();
    repo.write("src/lib/big.ts", 1200);
    repo.write("src/lib/keep.ts", 10);
    return { repo, base: repo.commit("base") };
  }

  it("lets an already-over-budget file grow, and says out loud that it did", () => {
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/big.ts", 1300);
    repo.allow("2980-big.md", `file: src/lib/big.ts\nlines: 1300\nreason: ${REASON}\n`);
    repo.commit("grew, with an allowance");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    // Visible on SUCCESS, not only when something fails: an escape nobody can
    // see is the ledger again in another shape.
    expect(result.stdout).toContain("ALLOWED GROWTH");
    expect(result.stdout).toContain("src/lib/big.ts  ->  1300 LOC");
    expect(result.stdout).toContain(`${ALLOWANCE_DIR}/2980-big.md`);
    expect(result.stdout).toContain("lifting that tree out is a refactor of its own");
  });

  it("fails when the recorded length is not the file's real length", () => {
    // The rule that stops an allowance drifting from the tree the way the
    // ledger did, and stops one being written once and reached for later.
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/big.ts", 1300);
    repo.allow("2980-big.md", `file: src/lib/big.ts\nlines: 1250\nreason: ${REASON}\n`);
    repo.commit("grew, with a stale allowance");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not match the file");
    expect(result.stderr).toContain("records 1250 LOC");
    expect(result.stderr).toContain("1300 LOC — longer than the allowance says");
    expect(result.stderr).toContain("set `lines: 1300`");
  });

  it("CONSTRAINT: an allowance cannot cover a NEW file", () => {
    // Bypass one of the two this pull request closed. An allowance permits an
    // already-over-budget file to GROW; it is not a way to arrive over budget.
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/brand-new.ts", 900);
    repo.allow(
      "2980-new.md",
      `file: src/lib/brand-new.ts\nlines: 900\nreason: ${REASON}\n`,
    );
    repo.commit("a new oversized module, with an allowance");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("an allowance cannot cover a NEW file");
    expect(result.stderr).toContain("src/lib/brand-new.ts");
    expect(result.stderr).toContain("delete the allowance and split the file");
  });

  it("CONSTRAINT: an allowance cannot cover a file renamed INTO the scope", () => {
    // Bypass two. Without this, "move it into src/ and declare it" would walk
    // any out-of-scope file in at any size.
    const repo = newRepo();
    repo.write("prisma/demo-seed.ts", 1324);
    repo.write("src/lib/keep.ts", 10);
    const base = repo.commit("base");
    mkdirSync(path.join(repo.root, "src/lib"), { recursive: true });
    git(repo.root, "mv", "prisma/demo-seed.ts", "src/lib/demo-seed.ts");
    repo.allow(
      "2980-moved.md",
      `file: src/lib/demo-seed.ts\nlines: 1324\nreason: ${REASON}\n`,
    );
    repo.commit("moved into src, with an allowance");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "an allowance cannot cover a file MOVED INTO the budgeted scope",
    );
    expect(result.stderr).toContain("src/lib/demo-seed.ts");
  });

  it("cannot carry a file over its budget for the first time either", () => {
    // The owner decision permits growth of an existing OVER-BUDGET file. A
    // module still inside its budget has the cheapest split available to it.
    const repo = newRepo();
    repo.write("src/lib/mod.ts", 600);
    repo.write("src/lib/keep.ts", 10);
    const base = repo.commit("base");
    repo.write("src/lib/mod.ts", 800);
    repo.allow("2980-mod.md", `file: src/lib/mod.ts\nlines: 800\nreason: ${REASON}\n`);
    repo.commit("crossed its budget, with an allowance");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "an allowance cannot carry a file over its budget for the first time",
    );
  });

  it("says so when a change declares an allowance nothing needed", () => {
    // Either a mistake or a file that shrank, and both are worth seeing. It
    // FAILS rather than merely printing, because an allowance left lying around
    // is the seed of the shared ledger this whole change deletes.
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/keep.ts", 11);
    repo.allow("2980-big.md", `file: src/lib/big.ts\nlines: 1200\nreason: ${REASON}\n`);
    repo.commit("an unrelated change, with a spare allowance");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("declares an allowance the check did not need");
    expect(result.stderr).toContain(`delete the entry from ${ALLOWANCE_DIR}/2980-big.md`);
  });

  it("is one-shot: a merged allowance is inert for the next change", () => {
    // What makes this per-pull-request rather than a ledger by accretion. The
    // allowance only has effect on the change that introduces it, so it cannot
    // be reached for again — and after merge it can be swept up in bulk, like a
    // compiled changelog fragment.
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/big.ts", 1300);
    repo.allow("2980-big.md", `file: src/lib/big.ts\nlines: 1300\nreason: ${REASON}\n`);
    const merged = repo.commit("PR1: grew, with its allowance");

    expect(captureRun(repo.root, ["--base", base]).code).toBe(0);

    repo.write("src/lib/big.ts", 1400);
    repo.commit("PR2: grows it again, leaning on PR1's allowance");

    const second = captureRun(repo.root, ["--base", merged]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("an already-oversized file grew");
    expect(second.stderr).toContain("+100 beyond its ceiling");
  });

  it("and inert means inert: a merged allowance does not block a later one for the same file", () => {
    /*
      The other half of "one-shot", and the half that was broken. Two code paths
      disagreed about what a merged allowance is. The EFFECT path honoured the
      contract — an allowance applies only when its own file is in the diff — but
      the DUPLICATE check read every `.md` in the directory, merged ones
      included, so the second pull request to grow a file was told:

        src/app/api/admin/reports/route.ts already has an allowance in
        size-allowances.d/2870-admin-api-club-time.md; one file, one allowance

      naming a file the author does not have in their diff and cannot act on.
      Measured on the club-time epic branch: 22 files held an allowance and 15 of
      them came from three already-merged declarations, several on files the
      remaining groups were about to touch — and one lane had already escaped it
      by contorting a route back to its exact original line count. This is the
      case that has to work.
    */
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/big.ts", 1300);
    repo.allow("2980-big.md", `file: src/lib/big.ts\nlines: 1300\nreason: ${REASON}\n`);
    const merged = repo.commit("PR1: grew, with its allowance");
    expect(captureRun(repo.root, ["--base", base]).code).toBe(0);

    repo.write("src/lib/big.ts", 1400);
    repo.allow(
      "2981-big-again.md",
      `file: src/lib/big.ts\nlines: 1400\nreason: ${REASON}\n`,
    );
    repo.commit("PR2: grows it again, with an allowance of its own");

    const second = captureRun(repo.root, ["--base", merged]);
    expect(second.stderr).toBe("");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("src/lib/big.ts  ->  1400 LOC");
    expect(second.stdout).toContain(`${ALLOWANCE_DIR}/2981-big-again.md`);
  });

  it("but two allowances for one file in the SAME change still fail", () => {
    // The rule the duplicate check exists for, and the reason the fix is
    // liveness rather than deletion: two live declarations of one file's length
    // are ambiguous, and ambiguity in a gate's input is how the old ledger
    // shipped a ceiling the tree already violated.
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/big.ts", 1300);
    repo.allow("2980-a.md", `file: src/lib/big.ts\nlines: 1300\nreason: ${REASON}\n`);
    repo.allow("2980-b.md", `file: src/lib/big.ts\nlines: 1300\nreason: ${REASON}\n`);
    repo.commit("one change, two allowances for one file");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNUSABLE");
    expect(result.stderr).toContain("already has an allowance in");
    expect(result.stderr).toContain(`${ALLOWANCE_DIR}/2980-a.md`);
    expect(result.stderr).toContain(`${ALLOWANCE_DIR}/2980-b.md`);
  });

  it("survives into the push-to-main run, which judges the same merge", () => {
    // Load-bearing, and not obvious: `verify` also runs on a push to `main`,
    // against the push's own pre-push commit. If an allowance did not reach
    // that run, every merge of a pull request carrying one would redden `main`
    // for growth that was already declared and reviewed. It does reach it,
    // because the allowance file is part of the same merge and so is in that
    // run's diff too.
    const { repo, base } = overBudgetRepo();
    git(repo.root, "checkout", "--quiet", "-b", "lane");
    repo.write("src/lib/big.ts", 1300);
    repo.allow("2980-big.md", `file: src/lib/big.ts\nlines: 1300\nreason: ${REASON}\n`);
    repo.commit("lane grows it, with an allowance");
    expect(captureRun(repo.root, ["--base", base]).code).toBe(0);

    git(repo.root, "checkout", "--quiet", "main");
    const before = git(repo.root, "rev-parse", "HEAD").trim();
    git(repo.root, "merge", "--quiet", "--no-ff", "-m", "merge lane", "lane");

    const push = captureRun(repo.root, ["--base", before]);
    expect(push.stderr).toBe("");
    expect(push.code).toBe(0);
    expect(push.stdout).toContain("ALLOWED GROWTH");
  });

  it("refuses to judge anything on an allowance it cannot read", () => {
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/big.ts", 1300);
    repo.allow("2980-big.md", "file: src/lib/big.ts\nlines: 1300\nreason: needed\n");
    repo.commit("grew, with a bare marker for a reason");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNUSABLE");
    expect(result.stderr).toContain("6-character reason");
    // And the growth is still reported, rather than being swallowed by the
    // unreadable declaration.
    expect(result.stderr).toContain("an already-oversized file grew");
  });

  it("points at the escape in the failure it is the answer to", () => {
    const { repo, base } = overBudgetRepo();
    repo.write("src/lib/big.ts", 1300);
    repo.commit("grew, with nothing said about it");

    const result = captureRun(repo.root, ["--base", base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${ALLOWANCE_DIR}/<pr-number>-<slug>.md`);
    expect(result.stderr).toContain("one file per pull request");
    expect(result.stderr).toContain(
      "splitting the file is still the better answer",
    );
  });
});

describe("this repository", () => {
  it("produces a trustworthy comparison against its own HEAD", () => {
    // Deliberately asserts the absence of `unusable` rather than a clean exit:
    // a developer part-way through growing a file should see the GATE complain,
    // not this test as well. What is checked here is that the machinery reads
    // this repository correctly — the ref resolves, the diff parses, every
    // changed file classifies.
    const result = evaluateComputedRatchet({
      root: REPO_ROOT,
      baseRef: "HEAD",
      unclassified: scanRepository(REPO_ROOT).unclassified,
      isProductionFile,
      budgetForFile: (file) => {
        const budget = budgetForFile(file);
        return { category: budget.category, limit: budget.limit };
      },
      countLines,
    });
    expect(result.findings.filter((f) => f.severity === "unusable")).toEqual([]);
    expect(result.baseSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("carries files in every budget category, so no category is silently unenforced", () => {
    const scan = scanRepository(REPO_ROOT);
    const slugs = new Set(
      findOversizedProductionFiles(scan.productionStats).map(
        (stat) => stat.slug,
      ),
    );
    expect([...slugs].sort()).toEqual([
      "domain-module",
      "route-handler",
      "route-page-shell",
    ]);
  });

  it("classifies every tracked file under src/, leaving no scope hole", () => {
    const scan = scanRepository(REPO_ROOT);
    expect(scan.gitError).toBeNull();
    expect(scan.unclassified).toEqual([]);
    expect(
      scan.trackedFiles.filter((file) => file.startsWith("src/")).length,
    ).toBeGreaterThan(3000);
  });

  it("reports a git failure instead of throwing out of the scan", () => {
    const scan = scanRepository(path.join(REPO_ROOT, "no-such-directory-2687"));
    expect(scan.gitError).not.toBeNull();
    expect(scan.productionStats).toEqual([]);
  });
});
