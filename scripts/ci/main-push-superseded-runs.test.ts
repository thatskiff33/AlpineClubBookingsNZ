import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";

/*
  INV-OPS-021 (owner decision, #5356; replaces #4989's every-run-completes
  rule): a newer merge may replace `main`'s QUEUED run of these workflows, but
  never one that has started, so the newest `main` commit always gets its full
  set. GitHub keeps one running and one pending run per concurrency group and
  drops the older pending run when a newer one joins, so every push to `main`
  must land in ONE group (no commit in it) with `cancel-in-progress` false.
  Pushes to `epic/**` keep a group per commit, apart from `main`'s. Pull-request
  runs keep one group per ref and cancel superseded runs.

  The check evaluates each top-level `concurrency` block for each event rather
  than pinning its text, so an equivalent rewrite passes and a wrong group
  fails. The evaluator knows only the expression shapes a concurrency block
  needs; anything else throws, so an unreadable block fails instead of passing.
*/

const REPO_ROOT = path.resolve(__dirname, "..", "..");
/** The workflows whose superseded main runs GitHub may drop, and whether each also runs on `epic/**` pushes. */
const WORKFLOWS = [
  { file: "ci.yml", epic: true },
  { file: "e2e.yml", epic: true },
  { file: "money-coverage.yml", epic: false },
  { file: "docs-link-check.yml", epic: false },
];

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** The `github` context values a concurrency expression may read. */
type GithubContext = Record<string, string>;
type Token = { kind: "string" | "op" | "name"; value: string };
type ExpressionValue = string | boolean;
type ConcurrencyBlock = Record<string, unknown>;

function pushContext(branch: string, sha: string): GithubContext {
  return { event_name: "push", ref: `refs/heads/${branch}`, sha, workflow: "Workflow" };
}

function pullRequestContext(number: number, sha: string): GithubContext {
  return { event_name: "pull_request", ref: `refs/pull/${number}/merge`, sha, workflow: "Workflow" };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:('(?:[^']|'')*')|(&&|\|\||==|!=)|([A-Za-z_][\w.-]*))/y;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Unsupported expression syntax at "${source.slice(index)}"`);
    if (match[1]) tokens.push({ kind: "string", value: match[1].slice(1, -1).replaceAll("''", "'") });
    else if (match[2]) tokens.push({ kind: "op", value: match[2] });
    else tokens.push({ kind: "name", value: match[3] ?? "" });
    index = pattern.lastIndex;
  }
  return tokens;
}

/** A GitHub Actions expression over `github.*`: literals, ==, !=, && and ||, with their short-circuit values. */
function evaluateExpression(source: string, github: GithubContext): ExpressionValue {
  const tokens = tokenize(source);
  let position = 0;
  const peekOp = (op: string): boolean => tokens[position]?.kind === "op" && tokens[position]?.value === op;
  const primary = (): ExpressionValue => {
    const token = tokens[position++];
    if (!token) throw new Error(`Expression ended early: ${source}`);
    if (token.kind === "string") return token.value;
    if (token.kind === "name" && token.value === "true") return true;
    if (token.kind === "name" && token.value === "false") return false;
    if (token.kind === "name" && token.value.startsWith("github.")) {
      const key = token.value.slice("github.".length);
      if (!(key in github)) throw new Error(`The census has no value for ${token.value}`);
      return github[key] as string;
    }
    throw new Error(`Unsupported token "${token.value}" in ${source}`);
  };
  const equality = (): ExpressionValue => {
    const left = primary();
    for (const op of ["==", "!="]) {
      if (peekOp(op)) {
        position += 1;
        const same = String(left).toLowerCase() === String(primary()).toLowerCase();
        return op === "==" ? same : !same;
      }
    }
    return left;
  };
  const and = (): ExpressionValue => {
    let value = equality();
    while (peekOp("&&")) {
      position += 1;
      const right = equality();
      value = value ? right : value;
    }
    return value;
  };
  const or = (): ExpressionValue => {
    let value = and();
    while (peekOp("||")) {
      position += 1;
      const right = and();
      value = value ? value : right;
    }
    return value;
  };
  const value = or();
  if (position !== tokens.length) throw new Error(`Unparsed tail in ${source}`);
  return value;
}

/** A workflow value with its `${{ … }}` parts evaluated; a value that is one expression keeps its type. */
function evaluateValue(value: unknown, github: GithubContext): ExpressionValue {
  const text = String(value);
  const whole = /^\$\{\{(.*)\}\}$/s.exec(text.trim());
  if (whole?.[1] !== undefined && !whole[1].includes("}}")) return evaluateExpression(whole[1], github);
  return text.replace(/\$\{\{(.*?)\}\}/gs, (_, expression: string) => String(evaluateExpression(expression, github)));
}

function cancels(concurrency: ConcurrencyBlock, github: GithubContext): boolean {
  const value = evaluateValue(concurrency["cancel-in-progress"] ?? "false", github);
  return value === true || value === "true";
}

/**
 * Every way a top-level `concurrency` block breaks INV-OPS-021: two `main`
 * pushes that cannot replace each other's queued run, a push that cancels a
 * started run, epic pushes that replace each other or join `main`'s group, or
 * a pull request whose newer run cannot cancel its older one. Empty when the
 * block keeps the rule.
 */
function concurrencyProblems(concurrency: unknown, { epic = true }: { epic?: boolean } = {}): string[] {
  if (!concurrency || typeof concurrency !== "object" || typeof (concurrency as ConcurrencyBlock).group !== "string") {
    return ["has no top-level concurrency block with a group"];
  }
  const block = concurrency as ConcurrencyBlock & { group: string };
  const problems: string[] = [];

  const mainFirst = String(evaluateValue(block.group, pushContext("main", SHA_A)));
  const mainSecond = String(evaluateValue(block.group, pushContext("main", SHA_B)));
  if (mainFirst !== mainSecond) {
    problems.push(`two pushes to main fall in different groups ("${mainFirst}", "${mainSecond}"), so a newer merge cannot replace the older queued run`);
  }
  if (mainFirst.includes(SHA_A) || mainSecond.includes(SHA_B)) problems.push(`a push to main has the group "${mainFirst}", which names its commit`);
  if (cancels(block, pushContext("main", SHA_B))) problems.push("a push to main cancels a run in progress in its group");

  if (epic) {
    const first = evaluateValue(block.group, pushContext("epic/example", SHA_A));
    const second = evaluateValue(block.group, pushContext("epic/example", SHA_B));
    if (first === second) problems.push(`two pushes to epic/example share the group "${first}", so one run replaces the other`);
    if (!String(first).includes(SHA_A)) problems.push(`a push to epic/example has the group "${first}", which does not name its commit`);
    if (cancels(block, pushContext("epic/example", SHA_B))) problems.push("a push to epic/example cancels a run in progress in its group");
    // An epic branch is usually cut at main's tip, so both push the same commit.
    if (first === mainFirst) problems.push(`a push to main and a push to epic/example of one commit share the group "${mainFirst}"`);
  }

  const older = evaluateValue(block.group, pullRequestContext(7, SHA_A));
  const newer = evaluateValue(block.group, pullRequestContext(7, SHA_B));
  if (older !== newer) problems.push(`a pull request's two runs fall in different groups ("${older}", "${newer}"), so the newer cannot cancel the older`);
  if (older === evaluateValue(block.group, pullRequestContext(8, SHA_A))) {
    problems.push(`two pull requests share the group "${older}"`);
  }
  if (older === mainFirst) problems.push(`a pull request shares main's push group "${mainFirst}"`);
  if (!cancels(block, pullRequestContext(7, SHA_B))) problems.push("a pull request's newer run does not cancel its older one");
  return problems;
}

/** The group text this repository's CI used for each event before #5356, kept so the census proves it now fails. */
const PER_COMMIT_GROUP = "ci-${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'push' && github.sha || 'shared' }}";
const NEW_GROUP = "ci-${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'push' && github.ref != 'refs/heads/main' && github.sha || github.event_name }}";
const PR_ONLY_CANCEL = "${{ github.event_name == 'pull_request' }}";

describe("INV-OPS-021: a newer merge replaces main's queued run, never a started one", () => {
  for (const { file, epic } of WORKFLOWS) {
    it(`${file} shares one main push group without cancelling, and still cancels superseded pull-request runs`, () => {
      const workflow = parseWorkflowYaml(readFileSync(path.join(REPO_ROOT, ".github", "workflows", file), "utf8"));
      // The census is vacuous unless the workflow really runs on these events.
      const on = workflow.on as { push?: { branches?: string[] }; pull_request?: unknown };
      expect(on.push?.branches).toContain("main");
      expect(on).toHaveProperty("pull_request");
      expect(on.push?.branches?.includes("epic/**") ?? false, `${file}'s epic/** push trigger`).toBe(epic);
      expect(concurrencyProblems(workflow.concurrency, { epic }), `${file} breaks INV-OPS-021`).toEqual([]);
    });
  }

  it("accepts the main-push group and refuses the per-commit one it replaced (#4989)", () => {
    expect(concurrencyProblems({ group: NEW_GROUP, "cancel-in-progress": PR_ONLY_CANCEL })).toEqual([]);
    expect(concurrencyProblems({ group: PER_COMMIT_GROUP, "cancel-in-progress": PR_ONLY_CANCEL })).toEqual([
      `two pushes to main fall in different groups ("ci-Workflow-refs/heads/main-${SHA_A}", "ci-Workflow-refs/heads/main-${SHA_B}"), so a newer merge cannot replace the older queued run`,
      `a push to main has the group "ci-Workflow-refs/heads/main-${SHA_A}", which names its commit`,
    ]);
  });

  it("refuses a group that cancels a started main run", () => {
    // docs-link-check.yml before #5356: one group per ref, always cancelling.
    expect(concurrencyProblems({ group: "docs-${{ github.ref }}", "cancel-in-progress": "true" }, { epic: false })).toEqual([
      "a push to main cancels a run in progress in its group",
    ]);
  });

  it("refuses a group that drops the commit for epic pushes too", () => {
    expect(
      concurrencyProblems({ group: "ci-${{ github.workflow }}-${{ github.ref }}-${{ github.event_name }}", "cancel-in-progress": PR_ONLY_CANCEL }),
    ).toEqual([
      'two pushes to epic/example share the group "ci-Workflow-refs/heads/epic/example-push", so one run replaces the other',
      'a push to epic/example has the group "ci-Workflow-refs/heads/epic/example-push", which does not name its commit',
    ]);
  });

  it("refuses a group without the ref, which puts every pull request in one group", () => {
    expect(
      concurrencyProblems({
        group: "ci-${{ github.event_name == 'push' && github.ref != 'refs/heads/main' && github.sha || github.event_name }}",
        "cancel-in-progress": PR_ONLY_CANCEL,
      }),
    ).toEqual(['two pull requests share the group "ci-pull_request"']);
  });

  it("refuses a fix that stops pull requests cancelling", () => {
    expect(concurrencyProblems({ group: NEW_GROUP, "cancel-in-progress": "false" })).toEqual([
      "a pull request's newer run does not cancel its older one",
    ]);
  });

  it("refuses an expression it cannot evaluate rather than passing it", () => {
    expect(() => concurrencyProblems({ group: "ci-${{ format('{0}', github.ref) }}" })).toThrow(/Unsupported/);
    expect(() => concurrencyProblems({ group: "ci-${{ github.head_ref }}" })).toThrow(/no value for github.head_ref/);
  });
});
