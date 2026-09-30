/**
 * The hand-opened epic sync's description (#3721): the renderer's by-hand mode
 * through the REAL gates, and the merge-commit reader against a REAL git
 * repository, including a conflict resolved by hand.
 *
 * The reader is the part that must not be taken on trust. Its one job is to
 * stop a body saying "no hand resolutions" over a merge that has them, so the
 * conflict case below is the test that matters: it fails if the measurement
 * ever stops seeing a resolved conflict.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateChangelogFragment } from "./check-pr-changelog-fragment.mjs";
import { validateConcurrencyDeclaration } from "./check-pr-concurrency-declaration.mjs";
import { parseArgs, readSyncMerge } from "./epic-sync-body.mjs";
import { COMMENT_OPEN, renderEpicSyncPrBody, renderHandSyncPrBody } from "./render-epic-sync-pr-body.mjs";

const BRANCH = "epic/2943-group-trip-hosting";
const HEAD = "1".repeat(40);
const EPIC = "2".repeat(40);
const MAIN = "3".repeat(40);

const renderHand = (resolvedFiles = []) =>
  renderHandSyncPrBody({ branch: BRANCH, headSha: HEAD, epicSha: EPIC, mainSha: MAIN, resolvedFiles });

const HOSTILE_CHANGES = [
  { status: "M", path: "prisma/schema.prisma" },
  { status: "A", path: "prisma/migrations/20260825010000_narrow_calendar_date_columns/migration.sql" },
  { status: "M", path: "src/lib/booking-create.ts" },
  { status: "M", path: "src/app/api/webhooks/stripe/route.ts" },
  { status: "M", path: "src/components/SomethingOrdinary.tsx" },
];

describe("the hand-opened sync description", () => {
  it("passes both gates against a diff full of sensitive paths, with the declaration completed", () => {
    const body = renderHand();
    const files = HOSTILE_CHANGES.map((change) => change.path);
    expect(validateConcurrencyDeclaration(body, files)).toEqual({ outcome: "complete" });
    expect(validateChangelogFragment(body, HOSTILE_CHANGES)).toEqual({ outcome: "none-marker" });
    expect(body).not.toMatch(/^\s*-\s*\[[xX]\]\s*N\/A\b/m);
  });

  it("names the merge and both parents, and says what wrote it", () => {
    const body = renderHand();
    for (const sha of [HEAD, EPIC, MAIN]) expect(body).toContain(sha);
    expect(body).toContain("`pnpm run epic:sync-body` wrote this section");
    expect(body).toContain("Hand resolutions: none.");
  });

  it("never carries the workflow's claims, and the workflow never carries its", () => {
    // "head IS main" is true of the workflow's pull requests and false of a
    // merge branch; the auto-merge promise is the workflow's alone.
    const hand = renderHand();
    expect(hand).not.toContain("head IS `main`");
    expect(hand).not.toContain("merges itself");
    expect(hand).not.toContain("The sync workflow wrote");

    const workflow = renderEpicSyncPrBody({ branch: BRANCH, runUrl: "https://example.test/run/1" });
    expect(workflow).not.toContain("`pnpm run epic:sync-body` wrote");
    // It does name the command once, as where a conflicted sync goes next.
    expect(workflow).toContain("open that as a hand sync with `pnpm run epic:sync-body`");
    expect(workflow).not.toContain("Hand resolutions");

    for (const body of [hand, workflow]) {
      expect(body).not.toContain(COMMENT_OPEN);
      expect(body).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
      expect(body).not.toMatch(/\n{3,}/);
    }
  });

  it("lists hand resolutions outside the sensitive paths", () => {
    const body = renderHand(["docs/TESTING.md", "src/lib/__tests__/booking-create.test.ts"]);
    expect(body).toContain("`docs/TESTING.md`, `src/lib/__tests__/booking-create.test.ts`. These differ");
  });

  it("writes a path holding replacement patterns literally", () => {
    expect(renderHand(["docs/$&-$$-$'.md"])).toContain("`docs/$&-$$-$'.md`");
  });

  it("refuses to write a structural declaration over a sensitive hand resolution", () => {
    expect(() => renderHand(["docs/TESTING.md", "src/lib/booking-create.ts"])).toThrow(
      /hand-resolves concurrency-sensitive path\(s\): src\/lib\/booking-create\.ts/,
    );
    expect(() => renderHand(["prisma/schema.prisma"])).toThrow(/prisma\/schema\.prisma/);
  });

  it("refuses inputs it cannot vouch for", () => {
    expect(() => renderHandSyncPrBody({ branch: BRANCH, headSha: "abc", epicSha: EPIC, mainSha: MAIN, resolvedFiles: [] })).toThrow(/headSha/);
    expect(() => renderHandSyncPrBody({ branch: "", headSha: HEAD, epicSha: EPIC, mainSha: MAIN, resolvedFiles: [] })).toThrow(/branch/);
    expect(() => renderHandSyncPrBody({ branch: BRANCH, headSha: HEAD, epicSha: EPIC, mainSha: MAIN })).toThrow(/resolvedFiles/);
  });

  it("refuses a template whose mode markers do not balance", () => {
    const template = "intro\n<!-- by-hand -->\nnever closed\n";
    expect(() =>
      renderHandSyncPrBody({ branch: BRANCH, headSha: HEAD, epicSha: EPIC, mainSha: MAIN, resolvedFiles: [], template }),
    ).toThrow(/unbalanced or unknown mode marker/);
  });
});

describe("parseArgs", () => {
  it("requires --branch and tolerates pnpm's `--` separator", () => {
    expect(parseArgs(["--", "--branch", BRANCH])).toEqual({ branch: BRANCH, main: "origin/main", out: null });
    expect(() => parseArgs([])).toThrow(/Usage/);
    expect(() => parseArgs(["--branch", BRANCH, "--nope"])).toThrow(/Unknown argument/);
  });
});

// Each case spawns a dozen or more git processes, which on Windows under a
// parallel run can exceed the 5-second default without anything being wrong.
describe("readSyncMerge against a real repository", { timeout: 60_000 }, () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const commitFile = (file, text, message) => {
    writeFileSync(path.join(dir, file), text);
    git("add", file);
    git("commit", "-q", "-m", message);
  };

  /** An epic and a main that both changed `shared.md`, plus one clean file each. */
  function forkedRepo({ conflicting }) {
    dir = mkdtempSync(path.join(tmpdir(), "epic-sync-body-"));
    git("init", "-q", "-b", "main");
    commitFile("shared.md", "one\ntwo\nthree\n", "base");
    git("switch", "-q", "-c", "epic");
    commitFile("epic.md", "epic\n", "epic work");
    if (conflicting) commitFile("shared.md", "one\nEPIC\nthree\n", "epic edits shared");
    git("switch", "-q", "main");
    commitFile("main.md", "main\n", "main work");
    if (conflicting) commitFile("shared.md", "one\nMAIN\nthree\n", "main edits shared");
    git("update-ref", `refs/remotes/origin/${BRANCH}`, "epic");
    git("update-ref", "refs/remotes/origin/main", "main");
    git("switch", "-q", "-c", "sync", "epic");
  }

  it("reads a clean merge as having no hand resolutions", () => {
    forkedRepo({ conflicting: false });
    git("merge", "-q", "--no-edit", "origin/main");
    const merge = readSyncMerge({ branch: BRANCH, cwd: dir });
    expect(merge.resolvedFiles).toEqual([]);
    expect(merge.epicSha).toBe(git("rev-parse", "epic"));
    expect(merge.mainSha).toBe(git("rev-parse", "main"));
    expect(merge.headSha).toBe(git("rev-parse", "HEAD"));
  });

  it("measures a conflict resolved by hand, whatever the author would say", () => {
    forkedRepo({ conflicting: true });
    expect(() => git("merge", "-q", "--no-edit", "origin/main")).toThrow();
    writeFileSync(path.join(dir, "shared.md"), "one\nEPIC and MAIN\nthree\n");
    git("add", "shared.md");
    git("commit", "-q", "--no-edit");
    expect(readSyncMerge({ branch: BRANCH, cwd: dir }).resolvedFiles).toEqual(["shared.md"]);
  });

  it("measures an edit slipped into an otherwise clean merge commit", () => {
    forkedRepo({ conflicting: false });
    git("merge", "-q", "--no-commit", "origin/main");
    writeFileSync(path.join(dir, "epic.md"), "epic, quietly changed\n");
    git("add", "epic.md");
    git("commit", "-q", "--no-edit");
    expect(readSyncMerge({ branch: BRANCH, cwd: dir }).resolvedFiles).toEqual(["epic.md"]);
  });

  it("counts a conflict resolved by keeping the side git left, which leaves no diff", () => {
    // modify/delete: git leaves the epic's modified file in its automatic tree
    // with no markers, so restoring it makes HEAD identical to that tree. Only
    // merge-tree's conflicted list sees it — and on a booking module the
    // generated declaration must then be refused, not written.
    dir = mkdtempSync(path.join(tmpdir(), "epic-sync-body-"));
    git("init", "-q", "-b", "main");
    mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
    commitFile("src/lib/booking-x.ts", "a\n", "base");
    git("switch", "-q", "-c", "epic");
    commitFile("src/lib/booking-x.ts", "b\n", "epic edits");
    git("switch", "-q", "main");
    git("rm", "-q", "src/lib/booking-x.ts");
    git("commit", "-q", "-m", "main deletes");
    git("update-ref", `refs/remotes/origin/${BRANCH}`, "epic");
    git("update-ref", "refs/remotes/origin/main", "main");
    git("switch", "-q", "-c", "sync", "epic");
    expect(() => git("merge", "-q", "--no-edit", "origin/main")).toThrow();
    git("add", "src/lib/booking-x.ts");
    git("commit", "-q", "--no-edit");

    const merge = readSyncMerge({ branch: BRANCH, cwd: dir });
    expect(merge.resolvedFiles).toEqual(["src/lib/booking-x.ts"]);
    expect(() => renderHandSyncPrBody(merge)).toThrow(/hand-resolves concurrency-sensitive path/);
  });

  it("refuses a HEAD that is not a merge, and a merge made the wrong way round", () => {
    forkedRepo({ conflicting: false });
    expect(() => readSyncMerge({ branch: BRANCH, cwd: dir })).toThrow(/1 parent\(s\)/);

    git("switch", "-q", "-c", "backwards", "main");
    git("merge", "-q", "--no-edit", "epic");
    expect(() => readSyncMerge({ branch: BRANCH, cwd: dir })).toThrow(/first parent .* is not on origin\//);
  });
});
