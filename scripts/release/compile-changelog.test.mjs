import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  compareFragmentNames,
  compileChangelog,
  parseArgs,
  POINTER_NOTE_END,
  POINTER_NOTE_START,
  readFragments,
  retiredAllowancePaths,
  todayInNewZealand,
} from "./compile-changelog.mjs";

const NOTE_BODY = "Entries for the next release live in `changelog.d/` — one file per PR.";
/** The note exactly as CHANGELOG.md carries it: prose inside its sentinels. */
const NOTE = [POINTER_NOTE_START, "", NOTE_BODY, "", POINTER_NOTE_END].join("\n");

const HISTORY = [
  "## 0.13.2 - 2026-07-23",
  "",
  "- **An older, already released entry (#1234).** Historical text that must be",
  "  copied through untouched.",
  "",
].join("\n");

function changelogWith(unreleasedBody) {
  return [
    "# Changelog",
    "",
    "All notable public reference-release changes should be recorded here.",
    "",
    "## Unreleased",
    "",
    NOTE,
    ...(unreleasedBody ? ["", unreleasedBody] : []),
    "",
    HISTORY,
  ].join("\n");
}

const tempRoots = [];

/** Build a throwaway repo root with a CHANGELOG.md and a changelog.d/ dir. */
function makeRepo({ changelog = changelogWith(""), fragments = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compile-changelog-"));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  const dir = path.join(root, "changelog.d");
  fs.mkdirSync(dir);
  for (const [name, body] of Object.entries(fragments)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return root;
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function makeTrackedAllowanceRepo({ fragments = {}, allowances = {} } = {}) {
  const root = makeRepo({ fragments });
  const dir = path.join(root, "size-allowances.d");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# Allowance convention\n");
  for (const [name, body] of Object.entries(allowances)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "add", "--all");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "merged fixtures");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

function allowanceFiles(root) {
  return fs.readdirSync(path.join(root, "size-allowances.d")).sort();
}

function read(root) {
  return fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
}

function fragmentFiles(root) {
  return fs.readdirSync(path.join(root, "changelog.d")).sort();
}

function silentLog() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.lines = lines;
  log.text = () => lines.join("\n");
  return log;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("compile-changelog", () => {
  it("compiles fragments into a new release section and deletes them", () => {
    const root = makeRepo({
      fragments: {
        "2448-tolerant-reads.md": "- **Booking requests tolerate a slow read (#2448).** Body.\n",
        "2452-changelog-fragments.md": "- **Changelog entries move to fragments (#2452).** Body.\n",
        "README.md": "# How to write a fragment\n",
        ".gitkeep": "",
      },
    });
    const log = silentLog();

    const result = compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log });

    expect(result.written).toBe(true);
    expect(result.fragments).toEqual([
      "2448-tolerant-reads.md",
      "2452-changelog-fragments.md",
    ]);
    const compiled = read(root);
    expect(compiled).toContain("## 0.14.0 - 2026-08-04");
    expect(compiled).toContain("- **Booking requests tolerate a slow read (#2448).** Body.");
    expect(compiled).toContain("- **Changelog entries move to fragments (#2452).** Body.");
    // The Unreleased heading and its pointer note survive, with no entries left.
    expect(compiled).toContain(`## Unreleased\n\n${NOTE}\n\n## 0.14.0 - 2026-08-04`);
    // History is copied through byte-for-byte.
    expect(compiled.slice(compiled.indexOf("## 0.13.2"))).toBe(`${HISTORY.trimEnd()}\n`);
    // Consumed fragments are gone; the convention files stay.
    expect(fragmentFiles(root)).toEqual([".gitkeep", "README.md"]);
    expect(log.text()).toContain("Compiled and deleted 2 fragment(s)");
  });

  it("orders fragments by PR number, not by string comparison", () => {
    const root = makeRepo({
      fragments: {
        "2448-later.md": "- **Later PR (#2448).**\n",
        "999-earlier.md": "- **Earlier PR (#999).**\n",
      },
    });

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    const compiled = read(root);
    expect(compiled.indexOf("(#999)")).toBeLessThan(compiled.indexOf("(#2448)"));
  });

  it("folds legacy entries written directly under Unreleased into the same section", () => {
    const legacy = [
      "- **A legacy entry written before fragments (#2400).** First paragraph.",
      "",
      "  A continuation paragraph that belongs to the same entry.",
      "- **A second legacy entry (#2401).** Body.",
    ].join("\n");
    const root = makeRepo({
      changelog: changelogWith(legacy),
      fragments: { "2452-fragments.md": "- **A fragment entry (#2452).** Body.\n" },
    });
    const log = silentLog();

    const result = compileChangelog({
      repoRoot: root,
      version: "0.14.0",
      date: "2026-08-04",
      log,
    });

    expect(result.foldedLegacyEntries).toBe(true);
    const compiled = read(root);
    const section = compiled.slice(
      compiled.indexOf("## 0.14.0"),
      compiled.indexOf("## 0.13.2"),
    );
    expect(section).toContain("(#2400)");
    expect(section).toContain("A continuation paragraph that belongs to the same entry.");
    expect(section).toContain("(#2401)");
    expect(section).toContain("(#2452)");
    // Legacy entries lead the section; fragments follow in filename order.
    expect(section.indexOf("(#2400)")).toBeLessThan(section.indexOf("(#2452)"));
    // Nothing is left under Unreleased except the pointer note.
    expect(compiled).toContain(`## Unreleased\n\n${NOTE}\n\n## 0.14.0`);
    expect(log.text()).toContain("Folded in the entries");
  });

  /*
    THE INVERTED-ORDER CASE, and the reason the note is sentinel-anchored.

    `CHANGELOG.md` is `merge=union` (#2451). Merging a branch that still writes
    its entry directly under `## Unreleased` can therefore put that entry ABOVE
    the pointer note — reproduced with real git: the branch side of a union
    merge wins the position. A compiler that split the section positionally
    ("everything above the first bullet is the note") would then read the note
    as part of the entries: it would be published inside the release section AND
    deleted from `## Unreleased` for good, with no error and nothing to notice.
  */
  it("keeps the pointer note in place when an entry sits above it (union-merge order)", () => {
    const inverted = [
      "# Changelog",
      "",
      "All notable public reference-release changes should be recorded here.",
      "",
      "## Unreleased",
      "",
      "- **An entry a union merge landed above the note (#2400).** First paragraph.",
      "",
      "  A continuation paragraph that belongs to the same entry.",
      "",
      NOTE,
      "",
      HISTORY,
    ].join("\n");
    const root = makeRepo({
      changelog: inverted,
      fragments: { "2452-fragments.md": "- **A fragment entry (#2452).** Body.\n" },
    });

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    const compiled = read(root);
    // 1. The note survives, re-emitted canonically directly under Unreleased.
    expect(compiled).toContain(`## Unreleased\n\n${NOTE}\n\n## 0.14.0 - 2026-08-04`);
    // 2. It never enters the release section.
    const section = compiled.slice(compiled.indexOf("## 0.14.0"), compiled.indexOf("## 0.13.2"));
    expect(section).not.toContain(POINTER_NOTE_START);
    expect(section).not.toContain(NOTE_BODY);
    // The entry that was above it is released, continuation and all.
    expect(section).toContain("(#2400)");
    expect(section).toContain("A continuation paragraph that belongs to the same entry.");
    expect(section).toContain("(#2452)");
    // And the note exists exactly once in the whole file — not duplicated.
    expect(compiled.split(POINTER_NOTE_START).length - 1).toBe(1);
  });

  it("restores the pointer note when Unreleased has lost it", () => {
    const root = makeRepo({
      changelog: [
        "# Changelog",
        "",
        "## Unreleased",
        "",
        "- **An entry with no pointer note above it (#2400).** Body.",
        "",
        HISTORY,
      ].join("\n"),
    });
    const log = silentLog();

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log });

    const compiled = read(root);
    expect(compiled).toContain(`## Unreleased\n\n${POINTER_NOTE_START}\n`);
    expect(compiled).toContain("changelog.d/README.md");
    expect(compiled.indexOf(POINTER_NOTE_END)).toBeLessThan(compiled.indexOf("## 0.14.0"));
    expect(log.text()).toContain("Restored the changelog.d pointer note");
  });

  it("warns loudly about unrecognised content under Unreleased instead of silently keeping it", () => {
    const stray = "TODO: someone please turn the refund fix into a proper entry.";
    const root = makeRepo({
      changelog: changelogWith(`${stray}\n\n- **A real entry (#2400).** Body.`),
    });
    const log = silentLog();

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log });

    expect(log.text()).toContain('WARNING: unrecognised content left under "## Unreleased"');
    expect(log.text()).toContain(stray);
    const compiled = read(root);
    // Neither released...
    const section = compiled.slice(compiled.indexOf("## 0.14.0"), compiled.indexOf("## 0.13.2"));
    expect(section).not.toContain(stray);
    expect(section).toContain("(#2400)");
    // ...nor deleted: it stays under Unreleased, below the note.
    expect(compiled).toContain(`${NOTE}\n\n${stray}\n\n## 0.14.0 - 2026-08-04`);
  });

  it("refuses to guess when the pointer-note sentinel is malformed", () => {
    const unterminated = makeRepo({
      changelog: [
        "# Changelog",
        "",
        "## Unreleased",
        "",
        POINTER_NOTE_START,
        "",
        NOTE_BODY,
        "",
        HISTORY,
      ].join("\n"),
      fragments: { "2452-fragments.md": "- **Entry (#2452).**\n" },
    });
    expect(() =>
      compileChangelog({
        repoRoot: unterminated,
        version: "0.14.0",
        date: "2026-08-04",
        log: silentLog(),
      }),
    ).toThrow(/unterminated/);

    const duplicated = makeRepo({
      changelog: changelogWith(NOTE),
      fragments: { "2452-fragments.md": "- **Entry (#2452).**\n" },
    });
    expect(() =>
      compileChangelog({
        repoRoot: duplicated,
        version: "0.14.0",
        date: "2026-08-04",
        log: silentLog(),
      }),
    ).toThrow(/more than one/);
  });

  it("keeps the real CHANGELOG.md pointer note inside its sentinels", () => {
    const real = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "CHANGELOG.md"),
      "utf8",
    );
    const unreleased = real.slice(
      real.indexOf("## Unreleased"),
      real.indexOf("\n## ", real.indexOf("## Unreleased") + 1),
    );
    expect(unreleased).toContain(POINTER_NOTE_START);
    expect(unreleased).toContain(POINTER_NOTE_END);
    expect(unreleased.indexOf(POINTER_NOTE_START)).toBeLessThan(
      unreleased.indexOf("changelog.d/README.md"),
    );
    expect(unreleased.indexOf("changelog.d/README.md")).toBeLessThan(
      unreleased.indexOf(POINTER_NOTE_END),
    );
  });

  it("is a no-op with a clear message when there is nothing to compile", () => {
    const root = makeRepo({ fragments: { "README.md": "# How to write a fragment\n" } });
    const before = read(root);
    const log = silentLog();

    const result = compileChangelog({
      repoRoot: root,
      version: "0.14.0",
      date: "2026-08-04",
      log,
    });

    expect(result.written).toBe(false);
    expect(read(root)).toBe(before);
    expect(log.text()).toContain("Nothing to compile");
    expect(log.text()).toContain("CHANGELOG.md was left unchanged");
  });

  it("retires committed allowance fragments with a real release, preserving README and untracked drafts", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: {
        "2991-old.md": "file: src/lib/waitlist.ts\n",
        "3031-new.md": "file: src/lib/waitlist.ts\n",
      },
    });
    fs.writeFileSync(path.join(root, "size-allowances.d", "next-local.md"), "draft\n");
    const log = silentLog();

    const result = compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log });

    expect(result.written).toBe(true);
    expect(result.retiredAllowances).toEqual([
      "size-allowances.d/2991-old.md",
      "size-allowances.d/3031-new.md",
    ]);
    expect(allowanceFiles(root)).toEqual(["README.md", "next-local.md"]);
    expect(read(root)).toContain("## 0.14.0 - 2026-08-04");
    expect(log.text()).toContain("Retired 2 committed size-allowance fragment(s)");
  });

  it("shows allowance retirement in dry-run without changing any files", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-old.md": "file: src/lib/waitlist.ts\n" },
    });
    const before = read(root);
    const log = silentLog();

    const result = compileChangelog({
      repoRoot: root,
      version: "0.14.0",
      date: "2026-08-04",
      dryRun: true,
      log,
    });

    expect(result.written).toBe(false);
    expect(result.retiredAllowances).toEqual(["size-allowances.d/2991-old.md"]);
    expect(read(root)).toBe(before);
    expect(fragmentFiles(root)).toEqual(["2452-release.md"]);
    expect(allowanceFiles(root)).toEqual(["2991-old.md", "README.md"]);
    expect(log.text()).toContain("size-allowances.d/2991-old.md (spent allowance; would be deleted)");
    expect(log.text()).toContain("Source is local origin/main; refresh it before release prep");
  });

  it("restores all release inputs after a later unlink failure, then retries safely", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: {
        "2991-old.md": "first allowance\n",
        "3031-new.md": "second allowance\n",
      },
    });
    const before = read(root);
    const fragment = path.join(root, "changelog.d", "2452-release.md");
    const allowance = path.join(root, "size-allowances.d", "3031-new.md");

    expect(() =>
      compileChangelog({
        repoRoot: root,
        version: "0.14.0",
        date: "2026-08-04",
        log: silentLog(),
        removeFile(file) {
          fs.rmSync(file);
          if (file === allowance) throw new Error("injected unlink failure after deletion");
        },
      }),
    ).toThrow(/original files restored.*retried/);
    expect(read(root)).toBe(before);
    expect(fs.readFileSync(fragment, "utf8")).toBe("- **Release entry (#2452).**\n");
    expect(allowanceFiles(root)).toEqual(["2991-old.md", "3031-new.md", "README.md"]);

    const retry = compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });
    expect(retry.written).toBe(true);
    expect(read(root)).toContain("## 0.14.0 - 2026-08-04");
    expect(allowanceFiles(root)).toEqual(["README.md"]);
  });

  it("does not overwrite a concurrent edit while reporting incomplete rollback", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-old.md": "original allowance\n" },
    });
    const before = read(root);
    const allowance = path.join(root, "size-allowances.d", "2991-old.md");

    expect(() =>
      compileChangelog({
        repoRoot: root,
        version: "0.14.0",
        date: "2026-08-04",
        log: silentLog(),
        removeFile(file) {
          if (file === allowance) {
            fs.writeFileSync(file, "concurrent edit\n");
            throw new Error("injected conflict");
          }
          fs.rmSync(file);
        },
      }),
    ).toThrow(/automatic restoration was incomplete/);
    expect(read(root)).toBe(before);
    expect(fs.readFileSync(path.join(root, "changelog.d", "2452-release.md"), "utf8"))
      .toBe("- **Release entry (#2452).**\n");
    expect(fs.readFileSync(allowance, "utf8")).toBe("concurrent edit\n");
  });

  it("keeps an allowance committed only on the release-prep branch", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-merged.md": "file: src/lib/waitlist.ts\n" },
    });
    fs.writeFileSync(path.join(root, "size-allowances.d", "9999-branch-only.md"), "branch note\n");
    git(root, "add", "size-allowances.d/9999-branch-only.md");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "branch-only allowance");

    const result = compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    expect(result.retiredAllowances).toEqual(["size-allowances.d/2991-merged.md"]);
    expect(allowanceFiles(root)).toEqual(["9999-branch-only.md", "README.md"]);
  });

  it("refuses to discard a merged allowance edited on the release-prep branch", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-merged.md": "original\n" },
    });
    fs.writeFileSync(path.join(root, "size-allowances.d", "2991-merged.md"), "branch revision\n");
    git(root, "add", "size-allowances.d/2991-merged.md");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "branch revision");
    const before = read(root);

    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() }),
    ).toThrow(/branch edits/);
    expect(read(root)).toBe(before);
    expect(allowanceFiles(root)).toEqual(["2991-merged.md", "README.md"]);
  });

  it("refuses a stale base ref before changing a release", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-old.md": "file: src/lib/waitlist.ts\n" },
    });
    fs.writeFileSync(path.join(root, "size-allowances.d", "2992-new.md"), "merged later\n");
    git(root, "add", "size-allowances.d/2992-new.md");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "new main");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "checkout", "-q", "HEAD~1");
    const before = read(root);

    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() }),
    ).toThrow(/start release-prep from it/);
    expect(read(root)).toBe(before);
    expect(allowanceFiles(root)).toEqual(["2991-old.md", "README.md"]);
  });

  it("does not retire allowances when there is no changelog release to compile", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "README.md": "# Changelog convention\n" },
      allowances: { "2991-old.md": "file: src/lib/waitlist.ts\n" },
    });
    const before = read(root);
    const log = silentLog();

    const result = compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log });

    expect(result.written).toBe(false);
    expect(result.retiredAllowances).toEqual([]);
    expect(read(root)).toBe(before);
    expect(allowanceFiles(root)).toEqual(["2991-old.md", "README.md"]);
    expect(log.text()).toContain("remain until a release is compiled");
  });

  it("fails before writing the changelog if a committed allowance has local edits", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-old.md": "file: src/lib/waitlist.ts\n" },
    });
    fs.appendFileSync(path.join(root, "size-allowances.d", "2991-old.md"), "local edit\n");
    const before = read(root);

    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() }),
    ).toThrow(/local edits/);
    expect(read(root)).toBe(before);
    expect(allowanceFiles(root)).toEqual(["2991-old.md", "README.md"]);
  });

  it("retires a valid spaced allowance filename accepted by the budget reader", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991 old allowance.md": "file: src/lib/waitlist.ts\n" },
    });
    expect(retiredAllowancePaths(root)).toEqual(["size-allowances.d/2991 old allowance.md"]);

    const result = compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    expect(result.retiredAllowances).toEqual(["size-allowances.d/2991 old allowance.md"]);
    expect(allowanceFiles(root)).toEqual(["README.md"]);
  });

  it("fails closed on a nested Git path before writing the changelog", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-old.md": "file: src/lib/waitlist.ts\n" },
    });
    const nested = path.join(root, "size-allowances.d", "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "wrong.md"), "not a direct child\n");
    git(root, "add", "size-allowances.d/nested/wrong.md");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "nested path");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const before = read(root);

    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() }),
    ).toThrow(/Unsafe allowance path/);
    expect(read(root)).toBe(before);
    expect(allowanceFiles(root)).toEqual(["2991-old.md", "README.md", "nested"]);
  });

  it("refuses a linked allowance directory before writing the changelog", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-old.md": "file: src/lib/waitlist.ts\n" },
    });
    const dir = path.join(root, "size-allowances.d");
    const realDir = path.join(root, "held-allowances");
    fs.renameSync(dir, realDir);
    fs.symlinkSync(realDir, dir, process.platform === "win32" ? "junction" : "dir");
    const before = read(root);

    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() }),
    ).toThrow(/must be a real directory/);
    expect(read(root)).toBe(before);
    expect(fs.existsSync(path.join(realDir, "2991-old.md"))).toBe(true);
  });

  it("refuses a symlink recorded in the merged Git tree even if the checkout materialises a file", () => {
    const root = makeTrackedAllowanceRepo({
      fragments: { "2452-release.md": "- **Release entry (#2452).**\n" },
      allowances: { "2991-old.md": "file: src/lib/waitlist.ts\n" },
    });
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      encoding: "utf8",
      input: "README.md",
    }).trim();
    git(root, "update-index", "--add", "--cacheinfo", "120000", blob, "size-allowances.d/2991-old.md");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "merged link");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const before = read(root);

    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() }),
    ).toThrow(/must not be a symlink/);
    expect(read(root)).toBe(before);
    expect(allowanceFiles(root)).toEqual(["2991-old.md", "README.md"]);
  });

  it("leaves every file untouched in --dry-run and reports the plan", () => {
    const root = makeRepo({
      fragments: { "2452-fragments.md": "- **A fragment entry (#2452).** Body.\n" },
      changelog: changelogWith("- **A legacy entry (#2400).** Body."),
    });
    const before = read(root);
    const log = silentLog();

    const result = compileChangelog({
      repoRoot: root,
      version: "0.14.0",
      date: "2026-08-04",
      dryRun: true,
      log,
    });

    expect(result.written).toBe(false);
    expect(read(root)).toBe(before);
    expect(fragmentFiles(root)).toEqual(["2452-fragments.md"]);
    expect(log.text()).toContain('[dry run] Would add "## 0.14.0 - 2026-08-04"');
    expect(log.text()).toContain("changelog.d/2452-fragments.md (would be deleted)");
    expect(log.text()).toContain('the entries currently written directly under "## Unreleased"');
    expect(log.text()).toContain("No files were changed");
  });

  it("normalises a CRLF fragment written by a Windows editor", () => {
    const root = makeRepo({
      fragments: { "2452-fragments.md": "- **CRLF entry (#2452).**\r\n\r\n  Second paragraph.\r\n" },
    });

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    expect(read(root)).not.toContain("\r");
  });

  it("refuses to compile a version that is already released", () => {
    const root = makeRepo({
      fragments: { "2452-fragments.md": "- **Entry (#2452).**\n" },
    });
    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.13.2", date: "2026-08-04", log: silentLog() }),
    ).toThrow(/already has a "## 0.13.2" section/);
  });

  it("rejects a malformed version or date", () => {
    const root = makeRepo();
    expect(() => compileChangelog({ repoRoot: root, version: "v0.14", log: silentLog() })).toThrow(
      /Version must look like/,
    );
    expect(() =>
      compileChangelog({ repoRoot: root, version: "0.14.0", date: "4 Aug 2026", log: silentLog() }),
    ).toThrow(/Date must be YYYY-MM-DD/);
  });

  it("inserts above the newest release when there is no Unreleased heading", () => {
    const root = makeRepo({
      changelog: `# Changelog\n\nAll notable changes.\n\n${HISTORY}`,
      fragments: { "2452-fragments.md": "- **Entry (#2452).**\n" },
    });

    compileChangelog({ repoRoot: root, version: "0.14.0", date: "2026-08-04", log: silentLog() });

    const compiled = read(root);
    expect(compiled.indexOf("## 0.14.0")).toBeLessThan(compiled.indexOf("## 0.13.2"));
    expect(compiled.endsWith("\n")).toBe(true);
  });

  it("reads only compilable fragments, in order", () => {
    const root = makeRepo({
      fragments: {
        "b.md": "- b\n",
        "a.md": "- a\n",
        "README.md": "# readme\n",
        ".gitkeep": "",
        "notes.txt": "ignored",
      },
    });
    expect(readFragments(path.join(root, "changelog.d")).map((f) => f.name)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(readFragments(path.join(root, "no-such-dir"))).toEqual([]);
  });

  it("sorts numeric filename chunks numerically and everything else stably", () => {
    expect(["2448-b.md", "999-a.md", "10-c.md"].sort(compareFragmentNames)).toEqual([
      "10-c.md",
      "999-a.md",
      "2448-b.md",
    ]);
    expect(["b.md", "a.md"].sort(compareFragmentNames)).toEqual(["a.md", "b.md"]);
    expect(compareFragmentNames("2452-a.md", "2452-a.md")).toBe(0);
  });

  it("parses CLI arguments", () => {
    expect(parseArgs(["0.14.0", "2026-08-04"])).toEqual({
      version: "0.14.0",
      date: "2026-08-04",
      dryRun: false,
    });
    expect(parseArgs(["--dry-run", "0.14.0"])).toEqual({
      version: "0.14.0",
      date: undefined,
      dryRun: true,
    });
  });

  it("formats today's date as an NZ date-only value", () => {
    expect(todayInNewZealand(new Date("2026-08-03T20:00:00Z"))).toBe("2026-08-04");
    expect(todayInNewZealand()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
