import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Fails when a workflow job runs this repository's unit suite without checking
 * out the git history that suite needs (#2909).
 *
 * ## Why this gate exists
 *
 * Part of the unit suite shells out to `git` against THIS repository's own
 * commits. `scripts/ci/check-doc-index-integrity.test.mjs` is the clearest case:
 * it builds a real `pull_request` payload out of `HEAD^1` and `origin/main` so
 * the doc-index CLI is exercised against commits that exist rather than against
 * a fixture. `actions/checkout` clones at depth 1 by default, and a depth-1
 * clone has neither — no second commit, and no remote-tracking `origin/main`.
 *
 * When that happens the tests fail with a raw
 * `fatal: ambiguous argument 'HEAD^1': unknown revision or path not in the
 * working tree`, several frames inside a helper, naming nothing that points at
 * the checkout.
 *
 * That is not hypothetical. `clock-rollover-canary.yml` ran the whole suite on a
 * depth-1 clone while `verify` checked out in full, so the failure passed all
 * eight required checks, merged, and reddened `main` — once per clock offset in
 * the matrix (#2907). Nothing then stopped the two diverging again, and the
 * divergence is invisible everywhere anyone would look: the canary has no
 * `pull_request` trigger so no PR check sees it, and a developer's clone has
 * full history exactly like `ci.yml` so a local run cannot see it either.
 *
 * ## What it checks
 *
 * 1. **Every job that runs the WHOLE unit suite must have an `actions/checkout`
 *    step with `fetch-depth: 0`.** "Runs the whole suite" is decided from the
 *    parsed shell command, not from a literal string: `pnpm test`, `pnpm run
 *    test`, `pnpm exec vitest run` and bare `vitest` all count (and so do the npm,
 *    `npx` and yarn spellings), wrapped or prefixed or not. The canary's real line
 *    is `faketime -f '${{ matrix.offset }}' pnpm test --testTimeout=30000 …`, and
 *    a check that misses that one line is worse than no check at all.
 * 2. **A job that only runs TARGETED files** (`pnpm exec vitest run <path>`) needs full
 *    history only when one of those files reads the repository's own history.
 *    `ci.yml`'s `migration-drift` and `data-migration-verification` jobs are
 *    exactly this shape and are correct as they stand — they run one realdb file
 *    each against a service Postgres and touch no git — so the rule must leave
 *    them passing. Detection here is deliberately conservative: when it cannot
 *    tell, it does not fail. Rule 1 is the load-bearing half.
 *
 * ## What it deliberately does not do
 *
 * It does not offer any way for a test to skip when history is missing. #2907
 * rejected that on purpose: a test that quietly disappears in one workflow is
 * how this class of gap hides in the first place, and the surviving workflow's
 * green then certifies nothing about it. The fix is that the environments match.
 *
 * Source-only by design — it reads `.github/workflows/*.yml` plus any test file a
 * targeted invocation names, and needs no install, no database and no network.
 * That is why `ci.yml` runs it before the install, where it fails in under a second.
 */

/** Where the workflows live, relative to the repository root. */
export const WORKFLOW_DIR = path.join(".github", "workflows");

/**
 * The prose every failure carries. It is a named export because the reason is
 * the point: the symptom is an unrelated-looking git error deep inside a helper,
 * and without the explanation the next person deletes the assertion instead of
 * fixing the `fetch-depth`.
 */
export const SUITE_HISTORY_EXPLANATION = [
  "Why, before you consider deleting the assertion instead of fixing the workflow:",
  "",
  "  Part of this repository's unit suite shells out to `git` against THIS",
  "  repository's own commits — scripts/ci/check-doc-index-integrity.test.mjs",
  "  builds a real `pull_request` payload out of `HEAD^1` and `origin/main`.",
  "  `actions/checkout` clones at depth 1 by default, and a depth-1 clone has",
  "  neither: there is no second commit and no remote-tracking `origin/main`.",
  "",
  "  Those tests then fail with a raw",
  "    fatal: ambiguous argument 'HEAD^1': unknown revision or path not in the working tree",
  "  several frames inside a helper, which names nothing that points at the",
  "  checkout — so the failure reads as a bug in whatever commit triggered it.",
  "",
  "  That already happened: clock-rollover-canary.yml ran the suite on a depth-1",
  "  clone while `verify` checked out in full, so the breakage passed all eight",
  "  required checks, merged, and reddened `main` (#2907). The canary has no",
  "  `pull_request` trigger and a developer's clone has full history, so neither",
  "  a PR check nor a local run can see the divergence.",
  "",
  "  The fix is `fetch-depth: 0` on the job's checkout step:",
  "",
  "        - name: Check out repository",
  "          uses: actions/checkout@v7",
  "          with:",
  "            fetch-depth: 0",
  "",
  "  It is NOT making the test skip when history is missing. #2907 rejected that",
  "  deliberately — a test that quietly disappears in one workflow is how this",
  "  whole class of gap hides.",
].join("\n");

/* -------------------------------------------------------------------------- */
/* A minimal YAML reader for workflow files                                    */
/* -------------------------------------------------------------------------- */

/**
 * This repository declares no YAML parser (`yaml` is present only as a
 * transitive dependency of something else), and this gate runs before
 * the install precisely so it costs a second rather than an install. So it reads
 * the subset of YAML that GitHub workflow files actually use: block mappings,
 * block sequences, block scalars, and single-line plain/quoted scalars.
 *
 * It THROWS on a construct it does not understand rather than returning a
 * partial tree. A parser that silently skipped a job would reintroduce exactly
 * the failure mode this gate exists to close — a green that certifies nothing.
 * If a future workflow trips it, widen the reader; do not delete the gate.
 */
export function parseWorkflowYaml(source) {
  const state = { lines: source.split(/\r?\n/), cursor: 0 };
  const document = parseNode(state, 0);
  return document ?? {};
}

function isBlankLine(line) {
  return line.trim().length === 0;
}

function isCommentLine(line) {
  return line.trimStart().startsWith("#");
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function peekSignificant(state) {
  let index = state.cursor;
  while (
    index < state.lines.length &&
    (isBlankLine(state.lines[index]) || isCommentLine(state.lines[index]))
  ) {
    index += 1;
  }
  if (index >= state.lines.length) return null;
  return {
    index,
    indent: indentOf(state.lines[index]),
    content: state.lines[index].trim(),
  };
}

function startsSequenceItem(content) {
  return content === "-" || content.startsWith("- ");
}

function parseNode(state, indent) {
  const next = peekSignificant(state);
  if (!next || next.indent < indent) return null;
  if (startsSequenceItem(next.content)) return parseSequence(state, next.indent);
  return parseMapping(state, next.indent);
}

/**
 * Split `key: value`, `key:` or `key: | …` at the first colon that is followed by
 * whitespace or by end of line. Anything else is a value, which is what keeps
 * `NEXTAUTH_URL: http://localhost:3000` and `run: psql "$X" -c "…"` intact.
 */
function splitKey(content) {
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== ":") continue;
    const following = content[index + 1];
    if (following === undefined || following === " " || following === "\t") {
      const key = content.slice(0, index).trim();
      if (key.length === 0) return null;
      return { key: unquote(key), rest: content.slice(index + 1).trim() };
    }
  }
  return null;
}

const BLOCK_SCALAR_HEADER = /^[|>][-+]?\d*$/;

function parseMapping(state, indent) {
  const map = {};
  for (;;) {
    const next = peekSignificant(state);
    if (!next || next.indent < indent) break;
    if (next.indent > indent) {
      throw new Error(
        `unexpected indentation at line ${next.index + 1}: ${next.content}`,
      );
    }
    if (startsSequenceItem(next.content)) break;

    const entry = splitKey(next.content);
    if (!entry) {
      throw new Error(
        `cannot read line ${next.index + 1} as a mapping entry: ${next.content}`,
      );
    }
    state.cursor = next.index + 1;

    if (entry.rest === "") {
      const child = peekSignificant(state);
      if (child && child.indent === indent && startsSequenceItem(child.content)) {
        // A sequence may sit at the same column as its key.
        map[entry.key] = parseSequence(state, indent);
      } else {
        map[entry.key] = parseNode(state, indent + 1);
      }
    } else if (BLOCK_SCALAR_HEADER.test(entry.rest)) {
      map[entry.key] = readBlockScalar(state, indent, entry.rest);
    } else {
      map[entry.key] = parseScalar(entry.rest);
    }
  }
  return map;
}

function parseSequence(state, indent) {
  const items = [];
  for (;;) {
    const next = peekSignificant(state);
    if (!next || next.indent !== indent) break;
    if (!startsSequenceItem(next.content)) break;

    if (next.content === "-") {
      state.cursor = next.index + 1;
      items.push(parseNode(state, indent + 1));
      continue;
    }

    const raw = state.lines[next.index];
    let contentAt = indent + 1;
    while (contentAt < raw.length && raw[contentAt] === " ") contentAt += 1;
    const rest = raw.slice(contentAt).trim();

    // Rewrite the dash away so the item body parses as an ordinary node whose
    // indentation is the column its first character already sits at.
    state.lines[next.index] = " ".repeat(contentAt) + raw.slice(contentAt);
    state.cursor = next.index;

    if (splitKey(rest)) {
      items.push(parseMapping(state, contentAt));
    } else {
      state.cursor = next.index + 1;
      items.push(parseScalar(rest));
    }
  }
  return items;
}

function readBlockScalar(state, keyIndent, header) {
  const folded = header.startsWith(">");
  const explicitIndent = /(\d+)/.exec(header);
  let contentIndent = explicitIndent
    ? keyIndent + Number(explicitIndent[1])
    : null;

  const collected = [];
  let index = state.cursor;
  while (index < state.lines.length) {
    const line = state.lines[index];
    if (isBlankLine(line)) {
      collected.push("");
      index += 1;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent <= keyIndent) break;
    if (contentIndent === null) contentIndent = lineIndent;
    if (lineIndent < contentIndent) break;
    collected.push(line.slice(contentIndent));
    index += 1;
  }
  state.cursor = index;

  while (collected.length > 0 && collected.at(-1) === "") collected.pop();
  if (!folded) return collected.join("\n");

  let foldedText = "";
  for (const line of collected) {
    if (line === "") {
      foldedText += "\n";
      continue;
    }
    foldedText +=
      foldedText === "" || foldedText.endsWith("\n") ? line : ` ${line}`;
  }
  return foldedText;
}

/** Strip an unquoted trailing `# comment`, then unquote. */
function parseScalar(rest) {
  let quote = null;
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(rest[index - 1]))) {
      return unquote(rest.slice(0, index).trim());
    }
  }
  return unquote(rest.trim());
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Reading the shell in a `run:` block                                         */
/* -------------------------------------------------------------------------- */

/**
 * Split a `run:` script into commands, and each command into tokens.
 *
 * Quoting is tracked, and a token that came out of quotes is marked as such. The
 * canary's "Explain a red canary" step echoes the literal string
 * `pnpm test --testTimeout=30000 …` into the job summary, and a check that
 * counted that as an invocation would be reporting on its own documentation.
 */
export function tokenizeShellCommands(script) {
  const commands = [];
  let tokens = [];
  let current = null;

  const endToken = () => {
    if (current) {
      tokens.push(current);
      current = null;
    }
  };
  const endCommand = () => {
    endToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };
  const append = (text, quoted) => {
    if (!current) current = { text: "", quoted: false };
    current.text += text;
    if (quoted) current.quoted = true;
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];

    if (character === "\\" && script[index + 1] === "\n") {
      index += 1;
      continue;
    }
    if (character === "\\" && current === null && script[index + 1] === undefined) {
      continue;
    }
    if (character === "#" && current === null) {
      while (index < script.length && script[index] !== "\n") index += 1;
      endCommand();
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const closing = character;
      let index2 = index + 1;
      let text = "";
      while (index2 < script.length && script[index2] !== closing) {
        if (closing !== "'" && script[index2] === "\\") {
          text += script[index2 + 1] ?? "";
          index2 += 2;
          continue;
        }
        text += script[index2];
        index2 += 1;
      }
      append(text, true);
      index = index2;
      continue;
    }
    if (character === "\n" || character === ";" || character === "&" || character === "|") {
      endCommand();
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      endToken();
      continue;
    }
    append(character, false);
  }
  endCommand();
  return commands;
}

/**
 * A positional argument only counts as a file selector when it looks like one: a
 * path separator, a glob character, or a test-file suffix. That keeps the value
 * of a space-separated flag (`--retry 2`) from reading as a file and quietly
 * demoting a whole-suite run to a targeted one — the direction that would make
 * this gate miss the job it exists for.
 */
const FILE_SELECTOR = /[\\/]|[*?]|\.(test|spec)\.[cm]?[jt]sx?$/;

function positionalSelectors(texts) {
  const selectors = [];
  for (const text of texts) {
    if (text === "--") continue;
    if (text.startsWith("-")) continue;
    if (FILE_SELECTOR.test(text)) selectors.push(text);
  }
  return selectors;
}

function baseName(text) {
  return text.split(/[\\/]/).at(-1) ?? text;
}

/** `npm`/`pnpm`/`yarn` script names that mean "the whole unit suite". */
const FULL_SUITE_SCRIPTS = new Set(["test"]);

function classifyInvocation(texts, index) {
  const head = texts[index];

  if (
    head === "npx" ||
    ((head === "npm" || head === "pnpm") && texts[index + 1] === "exec") ||
    (head === "yarn" && texts[index + 1] === "dlx")
  ) {
    let next = index + (head === "npx" ? 1 : 2);
    while (next < texts.length && texts[next].startsWith("-")) next += 1;
    if (next >= texts.length) return null;
    return classifyInvocation(texts, next);
  }

  if (head === "npm" || head === "pnpm" || head === "yarn") {
    let next = index + 1;
    let script = null;
    if (texts[next] === "run" || texts[next] === "run-script") {
      script = texts[next + 1];
      next += 2;
    } else if (texts[next] === "test" || texts[next] === "t" || texts[next] === "tst") {
      script = "test";
      next += 1;
    } else {
      return null;
    }
    if (!FULL_SUITE_SCRIPTS.has(script)) return null;
    const selectors = positionalSelectors(texts.slice(next));
    return {
      command: texts.slice(index).join(" "),
      selectors,
      kind: selectors.length > 0 ? "targeted" : "full-suite",
    };
  }

  if (baseName(head) === "vitest") {
    let next = index + 1;
    let subcommand = null;
    if (["run", "watch", "related", "bench", "list"].includes(texts[next])) {
      subcommand = texts[next];
      next += 1;
    }
    // `vitest related` selects by module graph from a file list that is usually
    // a shell expansion, so it is never the whole suite.
    if (subcommand === "related") {
      return { command: texts.slice(index).join(" "), selectors: [], kind: "targeted" };
    }
    if (subcommand === "list" || subcommand === "bench") return null;
    const selectors = positionalSelectors(texts.slice(next));
    return {
      command: texts.slice(index).join(" "),
      selectors,
      kind: selectors.length > 0 ? "targeted" : "full-suite",
    };
  }

  return null;
}

const RUNNER_HEADS = new Set(["npm", "pnpm", "yarn", "npx"]);

/**
 * Classify every unit-suite invocation in a `run:` script.
 *
 * The runner token is looked for ANYWHERE in the command rather than only at its
 * head, which is what makes wrappers and env prefixes work without modelling
 * each one: `faketime -f '…' pnpm test`, `env CI=1 pnpm test`, `time pnpm test` and
 * `xvfb-run -a pnpm exec vitest run` all classify from the same rule.
 */
export function classifyRunScript(script) {
  const invocations = [];
  for (const tokens of tokenizeShellCommands(script)) {
    const texts = tokens.map((token) => token.text);
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].quoted) continue;
      const text = texts[index];
      if (!RUNNER_HEADS.has(text) && baseName(text) !== "vitest") continue;
      const invocation = classifyInvocation(texts, index);
      if (invocation) {
        invocations.push(invocation);
        break;
      }
    }
  }
  return invocations;
}

/* -------------------------------------------------------------------------- */
/* Does a targeted test file read THIS repository's history?                   */
/* -------------------------------------------------------------------------- */

/** A git command literal, or a call of a local `git(...)` helper. */
const GIT_CALL = /(["'`])git\1|\bgit\s*\(/;

/**
 * A repository-root anchor. Tests that `git init` a throwaway repository in a
 * temp directory pass that temp path instead, which is the distinction the rule
 * turns on — a throwaway repo needs no history of ours and must not trigger this.
 */
const REPO_ROOT_TARGET = /\b(REPO_ROOT|REPOSITORY_ROOT|PROJECT_ROOT)\b|process\.cwd\(\)/;

/** Revision arguments that only resolve in a repository with real history. */
const HISTORY_REVISION =
  /HEAD\^|HEAD~|origin\/|\bmerge-base\b|\brev-list\b|\brev-parse\b|(["'])log\1/;

/**
 * True when a source file demonstrably drives git against THIS repository's own
 * commits.
 *
 * Deliberately conservative, and the docstring is the contract: it requires a git
 * call whose target is a repository-root anchor ON THE SAME LINE, plus a
 * history-bearing revision somewhere in the file. When it cannot tell, it says
 * no — rule 1 (the whole suite always needs full history) is what carries this
 * gate, and a false positive here would fail `migration-drift`, which is correct
 * as it stands.
 */
export function readsRepositoryHistory(source) {
  if (!HISTORY_REVISION.test(source)) return false;
  return source
    .split(/\r?\n/)
    .some((line) => GIT_CALL.test(line) && REPO_ROOT_TARGET.test(line));
}

/* -------------------------------------------------------------------------- */
/* The audit                                                                   */
/* -------------------------------------------------------------------------- */

function isCheckoutStep(step) {
  return (
    step !== null &&
    typeof step === "object" &&
    typeof step.uses === "string" &&
    /^actions\/checkout(@|$)/.test(step.uses.trim())
  );
}

function checkoutTakesFullHistory(step) {
  const inputs = step.with;
  if (!inputs || typeof inputs !== "object") return false;
  return String(inputs["fetch-depth"] ?? "").trim() === "0";
}

function describeStep(step, index) {
  const name = typeof step?.name === "string" ? step.name : null;
  return name ? `step ${index + 1} "${name}"` : `step ${index + 1}`;
}

/**
 * Audit already-parsed workflows.
 *
 * @param {object} options
 * @param {Array<{path: string, source: string}>} options.workflows
 * @param {(relativePath: string) => string | undefined} options.readSourceFile
 *   Reads a file a targeted invocation names, or returns undefined when it is
 *   not a readable file (a glob, a directory, a deleted path). Unreadable means
 *   "cannot tell", which means no failure.
 */
export function auditWorkflows({ workflows, readSourceFile }) {
  const problems = [];
  let jobsInspected = 0;
  let fullSuiteJobs = 0;

  for (const workflow of workflows) {
    let document;
    try {
      document = parseWorkflowYaml(workflow.source);
    } catch (error) {
      problems.push(
        `${workflow.path}: could not be parsed — ${error.message}. This gate reads ` +
          "the YAML subset GitHub workflows use; widen the reader in " +
          "scripts/ci/check-workflow-suite-checkout-depth.mjs rather than removing " +
          "the gate, because a workflow it cannot read is a workflow it cannot check.",
      );
      continue;
    }

    const jobs = document?.jobs;
    if (!jobs || typeof jobs !== "object") continue;

    for (const [jobId, job] of Object.entries(jobs)) {
      if (!job || typeof job !== "object") continue;
      const steps = Array.isArray(job.steps) ? job.steps : [];
      jobsInspected += 1;

      const hasFullHistory = steps.some(
        (step) => isCheckoutStep(step) && checkoutTakesFullHistory(step),
      );

      const fullSuiteSites = [];
      const targetedSelectors = [];

      steps.forEach((step, index) => {
        if (!step || typeof step !== "object") return;
        if (typeof step.run !== "string") return;
        for (const invocation of classifyRunScript(step.run)) {
          if (invocation.kind === "full-suite") {
            fullSuiteSites.push({ step, index, invocation });
          } else {
            for (const selector of invocation.selectors) {
              targetedSelectors.push({ step, index, selector });
            }
          }
        }
      });

      if (fullSuiteSites.length > 0) fullSuiteJobs += 1;
      if (hasFullHistory) continue;

      if (fullSuiteSites.length > 0) {
        for (const site of fullSuiteSites) {
          problems.push(
            `${workflow.path}: job \`${jobId}\`, ${describeStep(site.step, site.index)} ` +
              `runs the whole unit suite (\`${site.invocation.command}\`), but the job ` +
              "has no `actions/checkout` step with `fetch-depth: 0`.",
          );
        }
        continue;
      }

      for (const site of targetedSelectors) {
        const source = readSourceFile(site.selector);
        if (typeof source !== "string") continue;
        if (!readsRepositoryHistory(source)) continue;
        problems.push(
          `${workflow.path}: job \`${jobId}\`, ${describeStep(site.step, site.index)} ` +
            `runs \`${site.selector}\`, which drives git against this repository's own ` +
            "commits, but the job has no `actions/checkout` step with `fetch-depth: 0`.",
        );
      }
    }
  }

  return { problems, jobsInspected, fullSuiteJobs };
}

export function checkWorkingTree(repoRoot) {
  const workflowDir = path.join(repoRoot, WORKFLOW_DIR);
  if (!fs.existsSync(workflowDir)) {
    throw new Error(
      `No ${WORKFLOW_DIR} directory. There is nothing to check, which is not the ` +
        "same as a pass — run this from the repository root.",
    );
  }

  const workflows = fs
    .readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => ({
      path: path.posix.join(".github", "workflows", name),
      source: fs.readFileSync(path.join(workflowDir, name), "utf8"),
    }));

  const readSourceFile = (relativePath) => {
    const absolute = path.resolve(repoRoot, relativePath);
    // Never read outside the repository, and never treat a directory as a file.
    if (!absolute.startsWith(path.resolve(repoRoot))) return undefined;
    try {
      if (!fs.statSync(absolute).isFile()) return undefined;
      return fs.readFileSync(absolute, "utf8");
    } catch {
      return undefined;
    }
  };

  return { workflowCount: workflows.length, ...auditWorkflows({ workflows, readSourceFile }) };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { problems, workflowCount, jobsInspected, fullSuiteJobs } =
      checkWorkingTree(process.cwd());

    if (problems.length > 0) {
      console.error(
        "A workflow runs the unit suite without full git history (#2909):",
      );
      console.error("");
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error("");
      console.error(SUITE_HISTORY_EXPLANATION);
      process.exitCode = 1;
    } else {
      console.log(
        `Workflow checkout-depth check passed: ${workflowCount} workflow(s), ` +
          `${jobsInspected} job(s), ${fullSuiteJobs} of them running the whole unit suite.`,
      );
    }
  } catch (error) {
    console.error(`Workflow checkout-depth check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
