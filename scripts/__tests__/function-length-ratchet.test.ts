import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ALLOWANCE_DIR, readSizeAllowances } from "../lib/file-size-allowances";
import { evaluateFunctionLengthRatchet } from "../lib/function-length-ratchet";

/**
 * #4927 — the function-length ratchet's decision, judged against real commits
 * in throwaway repositories, as the file-size ratchet's suites are: which
 * functions are judged depends on which files are in the diff, and only a real
 * diff proves that.
 *
 * A limit of 10 keeps the fixtures readable; the rule does not depend on the
 * number.
 */

const LIMIT = 10;
const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A function `name` spanning exactly `lines` lines. */
function fn(name: string, lines: number): string {
  const body = Array.from({ length: lines - 2 }, () => "  n += 1;");
  return [`export function ${name}(n: number) {`, ...body, "}"].join("\n");
}

function newRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "acb-fn-ratchet-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  const write = (file: string, ...functions: string[]) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, functions.join("\n\n") + "\n", "utf8");
  };
  const allow = (name: string, body: string) => write(`${ALLOWANCE_DIR}/${name}`, body);
  const remove = (file: string) => unlinkSync(path.join(root, file));
  const commit = (msg: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", msg);
    return git(root, "rev-parse", "HEAD").trim();
  };
  const judge = (baseRef: string) => {
    const declared = readSizeAllowances(root);
    return evaluateFunctionLengthRatchet({
      root,
      baseRef,
      limit: LIMIT,
      isProductionFile: (file) => file.startsWith("src/") && file.endsWith(".ts"),
      allowances: declared.functionAllowances,
      allowanceProblems: declared.problems,
    });
  };
  return { root, write, allow, remove, commit, judge };
}

const kinds = (result: ReturnType<ReturnType<typeof newRepo>["judge"]>) =>
  result.findings.map((f) => `${f.kind} ${f.file}`);

describe("evaluateFunctionLengthRatchet — existing debt may stay, growth may not", () => {
  it("passes an over-limit function the change did not touch, and one it left the same length", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    repo.write("src/other.ts", fn("small", 3));
    const base = repo.commit("base");
    repo.write("src/other.ts", fn("small", 4));
    repo.write("src/door.ts", fn("cancel", 40), fn("helper", 5));
    repo.commit("touched both files");
    const result = repo.judge(base);
    expect(result.findings).toEqual([]);
    expect(result.checkedFiles).toBe(2);
  });

  it("fails an already-over-limit function that grew by one line, and passes it shrinking", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    const base = repo.commit("base");

    repo.write("src/door.ts", fn("cancel", 41));
    const grown = repo.judge(base);
    expect(kinds(grown)).toEqual(["grown-beyond-base src/door.ts#cancel"]);
    expect(grown.findings[0]?.previous).toBe("40 lines on the base ref");
    expect(grown.findings[0]?.current).toContain("+1");

    repo.write("src/door.ts", fn("cancel", 39));
    expect(repo.judge(base).findings).toEqual([]);
  });

  it("fails a function crossing the limit for the first time", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", LIMIT));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", LIMIT + 1));
    expect(kinds(repo.judge(base))).toEqual(["crossed-limit src/door.ts#cancel"]);
  });

  it("fails a NEW over-limit function, in an existing file and in an untracked one", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 3));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 3), fn("probe", LIMIT + 1));
    repo.write("src/fresh.ts", fn("fresh", LIMIT + 5));
    expect(kinds(repo.judge(base))).toEqual([
      "new-over-limit src/door.ts#probe",
      "new-over-limit src/fresh.ts#fresh",
    ]);
  });

  it("does not judge files outside the policy's scope", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 3));
    const base = repo.commit("base");
    repo.write("scripts/tool.ts", fn("tool", 100));
    expect(repo.judge(base).findings).toEqual([]);
  });
});

describe("evaluateFunctionLengthRatchet — moves and renames", () => {
  it("follows a git rename of the file, keeping each function's base length", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40), fn("a", 3), fn("b", 3), fn("c", 3));
    const base = repo.commit("base");
    git(repo.root, "mv", "src/door.ts", "src/cancel-door.ts");
    repo.commit("renamed");
    expect(repo.judge(base).findings).toEqual([]);

    repo.write("src/cancel-door.ts", fn("cancel", 41), fn("a", 3), fn("b", 3), fn("c", 3));
    expect(kinds(repo.judge(base))).toEqual(["grown-beyond-base src/cancel-door.ts#cancel"]);
  });

  it("follows a long function moved to its own module, so the move is not refused as new", () => {
    // The partner-sweep move #4927 plans is this shape.
    const repo = newRepo();
    repo.write("src/lifecycle.ts", fn("reconcile", 3), fn("sweep", 40));
    const base = repo.commit("base");
    repo.write("src/lifecycle.ts", fn("reconcile", 3));
    repo.write("src/sweep.ts", fn("sweep", 40));
    expect(repo.judge(base).findings).toEqual([]);

    repo.write("src/sweep.ts", fn("sweep", 41));
    const grown = repo.judge(base);
    expect(kinds(grown)).toEqual(["grown-beyond-base src/sweep.ts#sweep"]);
    expect(grown.findings[0]?.previous).toContain("(in src/lifecycle.ts)");
  });

  it("follows a function out of a file the change deleted", () => {
    const repo = newRepo();
    repo.write("src/old.ts", fn("sweep", 40));
    const base = repo.commit("base");
    repo.remove("src/old.ts");
    repo.write("src/new-home.ts", fn("other", 3), fn("sweep", 40), fn("more", 3), fn("yet", 3));
    expect(repo.judge(base).findings).toEqual([]);
  });

  it("does not guess when the name is ambiguous: two new homes are judged as new", () => {
    const repo = newRepo();
    repo.write("src/old.ts", fn("sweep", 40));
    const base = repo.commit("base");
    repo.write("src/old.ts", fn("kept", 3));
    repo.write("src/one.ts", fn("sweep", 40));
    repo.write("src/two.ts", fn("sweep", 40));
    expect(kinds(repo.judge(base))).toEqual([
      "new-over-limit src/one.ts#sweep",
      "new-over-limit src/two.ts#sweep",
    ]);
  });

  it("does not let a function moved in from outside the scope inherit a length", () => {
    const repo = newRepo();
    repo.write("scripts/big.ts", fn("tool", 40));
    repo.write("src/keep.ts", fn("keep", 3));
    const base = repo.commit("base");
    git(repo.root, "mv", "scripts/big.ts", "src/big.ts");
    repo.commit("moved into scope");
    expect(kinds(repo.judge(base))).toEqual(["new-over-limit src/big.ts#tool"]);
  });
});

describe("evaluateFunctionLengthRatchet — `function:` allowances", () => {
  const reason = "reason: the guard belongs inside the claim it protects, said out loud.\n";

  it("lets an already-over-limit function grow when this change declares its exact length", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 42));
    repo.allow("4927-door.md", `function: src/door.ts#cancel\nlines: 42\n${reason}`);
    const result = repo.judge(base);
    expect(result.findings).toEqual([]);
    expect(result.allowancesApplied.map((a) => a.key)).toEqual(["src/door.ts#cancel"]);
  });

  it("refuses an allowance whose length is not the function's real length", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 42));
    repo.allow("4927-door.md", `function: src/door.ts#cancel\nlines: 50\n${reason}`);
    expect(kinds(repo.judge(base))).toEqual(["allowance-mismatched src/door.ts#cancel"]);
  });

  it("refuses an allowance that would carry a function over the limit, or let a new one arrive over it", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 5));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 20), fn("fresh", 20));
    repo.allow(
      "4927-door.md",
      `function: src/door.ts#cancel\nlines: 20\n${reason}\nfunction: src/door.ts#fresh\nlines: 20\n${reason}`,
    );
    expect(kinds(repo.judge(base))).toEqual([
      "allowance-not-permitted src/door.ts#cancel",
      "allowance-not-permitted src/door.ts#fresh",
    ]);
  });

  it("fails an allowance this change did not need", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 40), fn("helper", 3));
    repo.allow("4927-door.md", `function: src/door.ts#cancel\nlines: 40\n${reason}`);
    expect(kinds(repo.judge(base))).toEqual(["allowance-unused src/door.ts#cancel"]);
  });

  it("ignores an allowance that merged earlier: it is inert, and the growth fails", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    repo.allow("4000-old.md", `function: src/door.ts#cancel\nlines: 41\n${reason}`);
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 41));
    expect(kinds(repo.judge(base))).toEqual(["grown-beyond-base src/door.ts#cancel"]);
  });
});

describe("evaluateFunctionLengthRatchet — fails closed", () => {
  it("fails when the base ref cannot be resolved, rather than reporting a pass", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 3));
    repo.commit("base");
    const result = repo.judge("origin/does-not-exist");
    expect(kinds(result)).toEqual(["base-unresolvable null"]);
    expect(result.baseSha).toBeNull();
  });
});
