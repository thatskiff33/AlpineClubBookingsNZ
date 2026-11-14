import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";

/*
  INV-OPS-019 (#4989): every push run of these workflows completes. `ci.yml`
  publishes a commit's `:<sha>` images and judges its push from
  `github.event.before`; `e2e.yml` and `money-coverage.yml` give each merge its
  own verdict. A shared concurrency group loses runs even with
  `cancel-in-progress: false`, because GitHub replaces an older PENDING run
  when a newer one joins the group — so a push's group must be unique to its
  branch and commit. Pull-request runs keep sharing one group per ref and cancelling.

  The check evaluates each top-level `concurrency` block for a push and a
  pull-request event rather than pinning its text, so an equivalent rewrite
  passes and a group that collapses two pushes fails. The evaluator knows only
  the expression shapes a concurrency block needs; anything else throws, so an
  unreadable block fails instead of passing.
*/

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOWS = ["ci.yml", "e2e.yml", "money-coverage.yml"];

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
 * Every way a top-level `concurrency` block lets one push run cancel or
 * replace another, or stops a pull request's newer run cancelling its older
 * one. Empty when the block keeps INV-OPS-019.
 */
function concurrencyProblems(concurrency: unknown): string[] {
  if (!concurrency || typeof concurrency !== "object" || typeof (concurrency as ConcurrencyBlock).group !== "string") {
    return ["has no top-level concurrency block with a group"];
  }
  const block = concurrency as ConcurrencyBlock & { group: string };
  const problems: string[] = [];
  for (const branch of ["main", "epic/example"]) {
    const first = evaluateValue(block.group, pushContext(branch, SHA_A));
    const second = evaluateValue(block.group, pushContext(branch, SHA_B));
    if (first === second) problems.push(`two pushes to ${branch} share the group "${first}", so one run replaces the other`);
    if (!String(first).includes(SHA_A)) problems.push(`a push to ${branch} has the group "${first}", which does not name its commit`);
    if (cancels(block, pushContext(branch, SHA_B))) problems.push(`a push to ${branch} cancels an in-progress run in its group`);
  }
  // An epic branch is usually cut at main's tip, so both push the same commit.
  const mainPush = evaluateValue(block.group, pushContext("main", SHA_A));
  if (mainPush === evaluateValue(block.group, pushContext("epic/example", SHA_A))) {
    problems.push(`a push to main and a push to epic/example of one commit share the group "${mainPush}"`);
  }
  const older = evaluateValue(block.group, pullRequestContext(7, SHA_A));
  const newer = evaluateValue(block.group, pullRequestContext(7, SHA_B));
  if (older !== newer) problems.push(`a pull request's two runs fall in different groups ("${older}", "${newer}"), so the newer cannot cancel the older`);
  if (older === evaluateValue(block.group, pullRequestContext(8, SHA_A))) {
    problems.push(`two pull requests share the group "${older}"`);
  }
  if (!cancels(block, pullRequestContext(7, SHA_B))) problems.push("a pull request's newer run does not cancel its older one");
  return problems;
}

describe("INV-OPS-019: push runs never cancel or replace each other", () => {
  for (const file of WORKFLOWS) {
    it(`${file} gives each push its own group and still cancels superseded pull-request runs`, () => {
      const workflow = parseWorkflowYaml(readFileSync(path.join(REPO_ROOT, ".github", "workflows", file), "utf8"));
      // The census is vacuous unless the workflow really runs on push.
      expect(workflow.on).toHaveProperty("push");
      expect(workflow.on).toHaveProperty("pull_request");
      expect(concurrencyProblems(workflow.concurrency), `${file} breaks INV-OPS-019`).toEqual([]);
    });
  }

  it("catches the shapes that lost main runs before #4989", () => {
    // ci.yml and money-coverage.yml: one group per ref, always cancelling.
    expect(concurrencyProblems({ group: "ci-${{ github.workflow }}-${{ github.ref }}", "cancel-in-progress": "true" })).toContain(
      'two pushes to main share the group "ci-Workflow-refs/heads/main", so one run replaces the other',
    );
    // e2e.yml: no cancel on push, but the shared group still replaced a pending run.
    expect(
      concurrencyProblems({
        group: "e2e-${{ github.workflow }}-${{ github.ref }}",
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      }),
    ).toContain('two pushes to main share the group "e2e-Workflow-refs/heads/main", so one run replaces the other');
  });

  it("catches a per-commit group that ignores the branch or still cancels pushes", () => {
    expect(
      concurrencyProblems({
        group: "ci-${{ github.workflow }}-${{ github.event_name == 'push' && github.sha || github.ref }}",
        "cancel-in-progress": "true",
      }),
    ).toEqual([
      "a push to main cancels an in-progress run in its group",
      "a push to epic/example cancels an in-progress run in its group",
      `a push to main and a push to epic/example of one commit share the group "ci-Workflow-${SHA_A}"`,
    ]);
  });

  it("catches a fix that stops pull requests cancelling", () => {
    expect(
      concurrencyProblems({
        group: "ci-${{ github.workflow }}-${{ github.sha }}",
        "cancel-in-progress": "false",
      }),
    ).toEqual(
      expect.arrayContaining([
        'a pull request\'s two runs fall in different groups ("ci-Workflow-' + SHA_A + '", "ci-Workflow-' + SHA_B + '"), so the newer cannot cancel the older',
        "a pull request's newer run does not cancel its older one",
      ]),
    );
  });

  it("refuses an expression it cannot evaluate rather than passing it", () => {
    expect(() => concurrencyProblems({ group: "ci-${{ format('{0}', github.ref) }}" })).toThrow(/Unsupported/);
    expect(() => concurrencyProblems({ group: "ci-${{ github.head_ref }}" })).toThrow(/no value for github.head_ref/);
  });
});
