import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "ci", "check-pr-body.mjs");

/**
 * A throwaway repo with a `base` branch and one commit on top of it, so the
 * script's `git merge-base HEAD <base>` has something real to resolve.
 * `extraFiles` is `{ relPath: contents }` added in that second commit.
 */
function makeRepo(extraFiles) {
  const root = mkdtempSync(join(tmpdir(), "pr-body-gate-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch", "base");
  git("config", "user.email", "gate-test@example.invalid");
  git("config", "user.name", "Gate Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  git("checkout", "--quiet", "-b", "work");
  for (const [relPath, contents] of Object.entries(extraFiles)) {
    mkdirSync(join(root, dirname(relPath)), { recursive: true });
    writeFileSync(join(root, relPath), contents);
  }
  git("add", "-A");
  git("commit", "--quiet", "-m", "work");
  return root;
}

function runGate(root, body) {
  const bodyPath = join(root, "body.md");
  writeFileSync(bodyPath, body);
  const result = spawnSync(process.execPath, [script, bodyPath, "--base", "base"], {
    cwd: root,
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * A body that satisfies the concurrency gate, so the exit code these tests
 * assert on is decided by the changelog gate alone rather than by a second
 * failure leaking into the same status. The fixtures below touch only
 * `src/lib/thing.ts`, which is not on a concurrency-sensitive path, so the
 * ticked `N/A` is the truthful declaration for them.
 *
 * The heading and the checkbox line are copied verbatim from
 * `.github/pull_request_template.md`; the gate matches them exactly. It answers
 * `## Plan Deviation` too (#4463), so these verdicts survive that gate's switch
 * from warning to failure.
 */
const BODY_WITHOUT_FRAGMENT = [
  "## Summary",
  "",
  "- adds a source file",
  "",
  "## Plan Deviation",
  "",
  "- None",
  "",
  "## Concurrency And Lock Impact",
  "",
  "- [x] N/A — no transaction, lifecycle, capacity, settlement, credit, webhook,",
  "      cron, or concurrency-sensitive writer changed.",
  "",
].join("\n");

describe("pr:check offline gate runner", () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  /**
   * The regression this file exists for. `validateChangelogFragment` reads
   * `change.path` off each element, so handing it bare `--name-only` strings
   * makes every path `undefined`: `isCodeBearing` sees nothing, the gate returns
   * `not-code-bearing`, and PASS is printed for a body that CI will reject.
   *
   * Dropping `parseNameStatus` from `changesAgainst` turns this assertion red,
   * which is the point — the previous shape reported a hollow PASS on every
   * local run.
   */
  it("fails a code-bearing diff that adds no fragment and carries no marker", () => {
    root = makeRepo({ "src/lib/thing.ts": "export const value = 1;\n" });
    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("FAIL  Changelog fragment");
    expect(status).toBe(1);
  });

  it("passes the same diff once it adds a fragment", () => {
    root = makeRepo({
      "src/lib/thing.ts": "export const value = 1;\n",
      "changelog.d/1234-thing.md": "Adds a thing.\n",
    });
    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("PASS  Changelog fragment");
    expect(status).toBe(0);
  });

  it("passes the same diff when the body carries the none marker instead", () => {
    root = makeRepo({ "src/lib/thing.ts": "export const value = 1;\n" });
    const { status, output } = runGate(
      root,
      `${BODY_WITHOUT_FRAGMENT}\nchangelog: none — internal refactor with no behaviour change\n`,
    );
    expect(output).toContain("PASS  Changelog fragment");
    expect(status).toBe(0);
  });

  /**
   * A deleted fragment must not be credited as an added one — one of the two
   * reasons the shared diff helper only ever runs `--name-status`. (The other is
   * that `--name-only` hides the source path of a rename.)
   */
  it("does not credit a code-bearing diff for deleting somebody else's fragment", () => {
    root = mkdtempSync(join(tmpdir(), "pr-body-gate-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--quiet", "--initial-branch", "base");
    git("config", "user.email", "gate-test@example.invalid");
    git("config", "user.name", "Gate Test");
    git("config", "commit.gpgsign", "false");
    git("config", "core.autocrlf", "false");
    mkdirSync(join(root, "changelog.d"), { recursive: true });
    writeFileSync(join(root, "changelog.d", "1111-existing.md"), "Someone else's entry.\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "seed");
    git("checkout", "--quiet", "-b", "work");
    rmSync(join(root, "changelog.d", "1111-existing.md"));
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "thing.ts"), "export const value = 1;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "work");

    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("FAIL  Changelog fragment");
    expect(status).toBe(1);
  });

  /** Test-only source changes are not code-bearing, so no fragment is owed. */
  it("passes a test-only change under src/ with no fragment", () => {
    root = makeRepo({
      "src/lib/__tests__/thing.test.ts": "it('works', () => {});\n",
    });
    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("PASS  Changelog fragment");
    expect(status).toBe(0);
  });

  /*
    #2726: this runner has to reach the SAME verdict as CI, and CI no longer
    fails a non-sensitive diff for a missing concurrency section. A Dependabot
    body — package table, none of the template headings — over a dependency-only
    diff is exactly that case, and it is the case that failed every bot PR.
  */
  const DEPENDABOT_BODY = [
    "Bumps [next](https://github.com/vercel/next.js) from 15.5.0 to 15.5.1.",
    "",
    "| Package | From | To |",
    "| --- | --- | --- |",
    "| next | 15.5.0 | 15.5.1 |",
    "",
  ].join("\n");

  it("passes a dependency-only diff whose body has no concurrency section", () => {
    root = makeRepo({ "package.json": '{ "name": "x" }\n' });
    const { status, output } = runGate(root, DEPENDABOT_BODY);
    expect(output).toContain("PASS  Concurrency declaration");
    expect(status).toBe(0);
  });

  it("fails the same sectionless body once the diff touches a sensitive path", () => {
    root = makeRepo({ "src/lib/booking-capacity.ts": "export const beds = 1;\n" });
    const { status, output } = runGate(root, DEPENDABOT_BODY);
    expect(output).toContain("FAIL  Concurrency declaration");
    expect(output).toContain("src/lib/booking-capacity.ts");
    expect(status).toBe(1);
  });

  /*
    No diff context at all. `--base` names a ref that does not exist, so
    `git merge-base` fails and the runner cannot see what changed. It must NOT
    read that as "changed nothing" and hand out the #2726 waiver — an unresolved
    base is the state a fresh clone with an unfetched `origin/main` is in, and a
    runner that printed PASS for any body there would be worse than useless.
  */
  function runGateWithUnresolvableBase(root, body) {
    const bodyPath = join(root, "body.md");
    writeFileSync(bodyPath, body);
    const result = spawnSync(
      process.execPath,
      [script, bodyPath, "--base", "refs/heads/no-such-branch"],
      { cwd: root, encoding: "utf8" },
    );
    return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  it("keeps the section required when it cannot resolve the diff at all", () => {
    root = makeRepo({ "package.json": '{ "name": "x" }\n' });
    const { status, output } = runGateWithUnresolvableBase(root, DEPENDABOT_BODY);
    expect(output).toContain("Could not diff against");
    expect(output).toContain("FAIL  Concurrency declaration");
    expect(output).toContain("no diff context");
    expect(status).toBe(1);
  });

  /*
    The same unresolved-diff state, with the body shape agents actually write:
    the template's ticked `N/A` and no fragment. Both gates decide from the diff,
    so with no diff neither can reach CI's verdict — and this runner used to
    print "PR body passes both gates" and exit 0 for exactly this input, because
    an empty sensitive-file list read as "nothing sensitive changed" and an empty
    change list read as "not code-bearing". A green here is worse than no answer:
    it is the answer CI will contradict.
  */
  it("refuses to green a ticked N/A and a missing fragment with no diff to check", () => {
    root = makeRepo({ "src/lib/booking-capacity.ts": "export const beds = 1;\n" });
    const { status, output } = runGateWithUnresolvableBase(root, BODY_WITHOUT_FRAGMENT);
    expect(output).toContain("FAIL  Concurrency declaration");
    expect(output).toContain("FAIL  Changelog fragment");
    expect(output).not.toContain("passes every enforced gate");
    expect(status).toBe(1);
  });

  /*
    An unresolved diff must not become an unpassable gate either: a body that
    carries a COMPLETE declaration needs no diff evidence, so that half still
    passes and only the undecidable changelog question fails.
  */
  it("still passes a complete declaration with no diff, failing only the changelog half", () => {
    root = makeRepo({ "src/lib/booking-capacity.ts": "export const beds = 1;\n" });
    const complete = [
      "## Concurrency And Lock Impact",
      "",
      "- Writer class(es), canonical lock key(s), and acquisition order: cancel; global -> lodge",
      "- Immutable pre-lock key source and mutable under-lock re-read: immutable lodgeId; full re-read",
      "- Status-guarded claim and proof that a lost claim runs no side effect: updateMany; count=0 exits",
      "- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #1911 shares the lodge helper",
      "- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None",
      "",
    ].join("\n");
    const { status, output } = runGateWithUnresolvableBase(root, complete);
    expect(output).toContain("PASS  Concurrency declaration");
    expect(output).toContain("FAIL  Changelog fragment");
    expect(status).toBe(1);
  });

  /*
    #4463: the plan-deviation section reports WARN, not FAIL, during its rollout
    week (the exit code is decided by the enforced gates alone), and PASS once
    answered; the soft size gate reports WARN for a large PR with no reason.
  */
  it("reports a missing plan-deviation section as WARN and still exits 0", () => {
    root = makeRepo({ "docs/note.md": "hello\n" });
    const { status, output } = runGate(root, BODY_WITHOUT_FRAGMENT.replace("## Plan Deviation\n\n- None\n", ""));
    expect(output).toContain("WARN  Plan deviation");
    expect(output).toContain("PASS  PR size");
    expect(output).toContain("passes every enforced gate, with 1 warning(s)");
    expect(status).toBe(0);
  });

  it("passes the plan-deviation section answered None, and warns on an unexplained large PR", () => {
    const big = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
    root = makeRepo({ "docs/note.md": `${big}\n` });
    const answered = BODY_WITHOUT_FRAGMENT;
    let result = runGate(root, answered);
    expect(result.output).toContain("PASS  Plan deviation");
    expect(result.output).toContain("WARN  PR size");
    expect(result.status).toBe(0);

    result = runGate(root, `${answered}\nlarge-pr: a generated docs table\n`);
    expect(result.output).toContain("PASS  PR size");
    expect(result.output).not.toContain("warning(s)");
    expect(result.status).toBe(0);
  });
});
