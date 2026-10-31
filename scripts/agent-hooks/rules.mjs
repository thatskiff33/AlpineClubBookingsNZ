/**
 * The agent rules a machine can check, in one place (#4462).
 *
 * Each rule here is also stated in `AGENTS.md`, which binds every agent whether
 * or not a hook runs (Codex before `/hooks` trust, a session with hooks
 * disabled, a script that runs a command for you). Where they are installed,
 * these mechanisms enforce it:
 *
 * - `.claude/settings.json`: a PreToolUse hook on `Bash` and `Agent` that runs
 *   `dispatch.mjs`, which exits 2 with the rule's reason when a call breaks a
 *   rule, plus `permissions.deny` entries ({@link PERMISSION_DENY_RULES}) as a
 *   native backstop for the shapes a prefix pattern can express;
 * - `.claude/agents/implementor.md`: the same hook with `--role=implementor`,
 *   so an implementor subagent cannot `git push` or run `gh` (the settings hook
 *   also applies those rules when the input's `agent_type` is `implementor`,
 *   which covers `-p` and untrusted runs where frontmatter hooks are skipped);
 * - `.codex/hooks.json`: the same dispatcher for Codex's PreToolUse and Stop.
 *   The implementor rules apply there if Codex sends `agent_type` (its role
 *   file is named `implementor`); that is not verified against a live run.
 *
 * Everything the hook decides is in this module, so the dispatcher, the
 * settings file and the tests read one list (INV-SSOT).
 */
import { programName, simpleCommands } from "./shell-commands.mjs";

/** The `.claude/agents/` role whose push and GitHub access the hook removes. */
export const IMPLEMENTOR_ROLE = "implementor";

/** The effort an `Agent` call may never request; `xhigh` is the ceiling. */
export const FORBIDDEN_EFFORT = "max";

/**
 * Native `permissions.deny` entries for `.claude/settings.json`, which must
 * match this list exactly. Only shapes a prefix pattern expresses without
 * false positives belong here; flag order, short-flag clusters and refspecs are
 * the hook's job.
 */
export const PERMISSION_DENY_RULES = [
  `Agent(effort:${FORBIDDEN_EFFORT})`,
  "Bash(npx *)",
  "Bash(pnpx *)",
  "Bash(pnpm dlx *)",
  "Bash(prisma format *)",
  "Bash(pnpm exec prisma format *)",
  "Bash(gh issue view *)",
  "Bash(git push --force *)",
  "Bash(git push --force-with-lease *)",
  "Bash(git push -f *)",
];

/** `[subcommand, args]` for a git command, past git's own global options. */
function gitSubcommand(words) {
  const valued = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) i += valued.has(words[i]) ? 2 : 1;
  return [words[i], words.slice(i + 1)];
}

/** The words after `gh`, past any leading flag. */
function ghArgs(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) i += 1;
  return words.slice(i);
}

/** `[subcommand, rest]` for pnpm, past its global options. */
function pnpmSubcommand(words) {
  const valued = new Set(["-C", "--dir", "-F", "--filter", "--filter-prod", "--reporter", "--loglevel"]);
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) i += valued.has(words[i]) ? 2 : 1;
  return [words[i], words.slice(i + 1)];
}

/** A short-option cluster such as `-uf`, which git and gh both accept. */
function shortCluster(word, letter) {
  return /^-[A-Za-z]+$/.test(word) && word.includes(letter);
}

/**
 * The command pnpm runs on this command's behalf: `pnpm exec x`, or `pnpm x`,
 * since pnpm runs an installed binary by name. `pnpm run <script>` yields
 * `run <script>`, which no rule matches: a script name says nothing about its
 * body.
 */
function launched(words) {
  if (words[0] !== "pnpm") return [];
  const [sub, rest] = pnpmSubcommand(words);
  if (sub === undefined || sub === "dlx") return [];
  if (sub === "exec") {
    let i = 0;
    while (i < rest.length && rest[i].startsWith("-")) i += 1;
    return rest[i] === undefined ? [] : [[programName(rest[i]), ...rest.slice(i + 1)]];
  }
  return [[sub, ...rest]];
}

function isPrismaFormat(words) {
  if (words[0] !== "prisma") return false;
  return words.slice(1).find((word) => !word.startsWith("-")) === "format";
}

function isDownloadRunner(words) {
  const [program, first] = words;
  if (program === "npx" || program === "pnpx" || program === "bunx") return true;
  if (program === "pnpm") return pnpmSubcommand(words)[0] === "dlx";
  if (program === "yarn") return first === "dlx";
  if (program === "npm") {
    const sub = words.slice(1).find((word) => !word.startsWith("-"));
    return sub === "exec" || sub === "x";
  }
  return false;
}

function isGitPush(words) {
  return words[0] === "git" && gitSubcommand(words)[0] === "push";
}

/**
 * `{ endpoint, fields }` for a `gh api` call: the first positional argument,
 * and every `-f`/`-F`/`--field`/`--raw-field` value. Other options that take a
 * value are skipped, so a header or a jq filter is never read as a field.
 */
function ghApiCall(words) {
  const args = ghArgs(words);
  if (args[0] !== "api") return null;
  const fieldFlags = new Set(["-f", "-F", "--field", "--raw-field"]);
  const valued = new Set(["-X", "--method", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);
  let endpoint = null;
  const fields = [];
  for (let i = 1; i < args.length; i += 1) {
    const word = args[i];
    const inline = word.match(/^(--field|--raw-field)=(.*)$/s) ?? word.match(/^(-[fF])(.+)$/s);
    if (inline) fields.push(inline[2]);
    else if (fieldFlags.has(word)) fields.push(args[(i += 1)] ?? "");
    else if (valued.has(word)) i += 1;
    else if (!word.startsWith("-") && endpoint === null) endpoint = word;
  }
  return { endpoint: endpoint ?? "", fields };
}

/** A `gh api` call that force-updates a ref: `…/git/refs/… -f force=true`. */
function isForcedRefUpdate(words) {
  const call = words[0] === "gh" ? ghApiCall(words) : null;
  return call !== null && /(?:^|\/)git\/refs\//.test(call.endpoint) && call.fields.includes("force=true");
}

function isForcePush(words) {
  if (isForcedRefUpdate(words)) return true;
  if (!isGitPush(words)) return false;
  return gitSubcommand(words)[1].some(
    (word) =>
      word === "--force" ||
      word.startsWith("--force-with-lease") ||
      word === "--mirror" ||
      (!word.startsWith("--") && shortCluster(word, "f")) ||
      (word.startsWith("+") && word.length > 1),
  );
}

/** `gh pr merge` options that take the next word as their value. */
const GH_PR_MERGE_VALUED = new Set(["-b", "--body", "-t", "--subject", "-F", "--body-file", "-A", "--author-email", "-R", "--repo", "--match-head-commit"]);
const GH_PR_MERGE_VALUED_SHORT = "btFAR";

/** Whether `gh pr merge` arguments ask for a squash or a rebase. */
function mergeArgsSquashOrRebase(args) {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (GH_PR_MERGE_VALUED.has(word)) {
      i += 1;
    } else if (word === "--squash" || word === "--rebase") {
      return true;
    } else if (/^--(?:squash|rebase)=/.test(word)) {
      if (word.slice(word.indexOf("=") + 1).toLowerCase() !== "false") return true;
    } else if (/^-[A-Za-z]+$/.test(word)) {
      // A short cluster: a value-taking letter consumes the rest of the
      // cluster, or the next word when it is the last letter.
      for (let j = 1; j < word.length; j += 1) {
        if (word[j] === "s" || word[j] === "r") return true;
        if (GH_PR_MERGE_VALUED_SHORT.includes(word[j])) {
          if (j === word.length - 1) i += 1;
          break;
        }
      }
    }
  }
  return false;
}

function isSquashOrRebaseMerge(words) {
  if (words[0] !== "gh") return false;
  const args = ghArgs(words);
  if (args[0] === "pr" && args[1] === "merge") return mergeArgsSquashOrRebase(args.slice(2));
  const call = ghApiCall(words);
  return (
    call !== null &&
    /(?:^|\/)pulls\/\d+\/merge$/.test(call.endpoint) &&
    call.fields.some((field) => /^merge_method=(?:squash|rebase)$/.test(field))
  );
}

function isGhIssueView(words) {
  if (words[0] !== "gh") return false;
  const args = ghArgs(words);
  return args[0] === "issue" && args[1] === "view";
}

/**
 * Bash rules. `implementorOnly` rules apply only to the implementor role.
 * `reason` is what the agent reads when it is blocked, so it says what to do
 * instead; `source` is where the rule was decided.
 */
export const BASH_RULES = [
  {
    id: "prisma-format",
    implementorOnly: false,
    test: isPrismaFormat,
    reason: "`prisma format` rewrites the hand-edited schema. Edit `prisma/schema.prisma` by hand.",
    source: "AGENTS.md -> Safety (#1567)",
  },
  {
    id: "download-runner",
    implementorOnly: false,
    test: isDownloadRunner,
    reason:
      "`npx`, `pnpx`, `pnpm dlx` and `npm exec` can download and run an unreviewed package. " +
      "Run an installed tool with `pnpm exec <tool>`; the lane installs dependencies.",
    source: "AGENTS.md -> Safety",
  },
  {
    id: "force-push",
    implementorOnly: false,
    test: isForcePush,
    reason:
      "A pushed branch is never rewritten: no `--force`, `-f`, `--force-with-lease`, `--mirror`, " +
      "`+refspec` or forced ref update. Push a new commit, or merge rather than rebase.",
    source: "AGENTS.md -> Safety",
  },
  {
    id: "squash-or-rebase-merge",
    implementorOnly: false,
    test: isSquashOrRebaseMerge,
    reason: "A PR merges with a merge commit: `gh pr merge <n> --merge`, or `--auto --merge`.",
    source: "AGENTS.md -> Safety",
  },
  {
    id: "gh-issue-view",
    implementorOnly: false,
    test: isGhIssueView,
    reason:
      "Use `pnpm run issue <n>`: it reads the whole thread, where decisions often sit; " +
      "`gh issue view` prints only the body (#2777).",
    source: "AGENTS.md -> Pre-authorisation and attributability",
  },
  {
    id: "implementor-push",
    implementorOnly: true,
    test: isGitPush,
    reason: "An implementor commits locally and never pushes; the orchestrator pushes.",
    source: "AGENTS.md -> Orchestration Model -> Implementors",
  },
  {
    id: "implementor-gh",
    implementorOnly: true,
    test: (words) => words[0] === "gh",
    reason: "An implementor never touches GitHub; report back and the orchestrator acts.",
    source: "AGENTS.md -> Orchestration Model -> Implementors",
  },
];

/** The message an agent sees when a rule blocks its call. */
export function blockMessage(rule) {
  return `Blocked by agent rule "${rule.id}" (${rule.source}): ${rule.reason}`;
}

/** Whether the hook input comes from (or the flag names) the implementor role. */
export function isImplementor(input, role) {
  if (role === IMPLEMENTOR_ROLE) return true;
  const agentType = typeof input?.agent_type === "string" ? input.agent_type : "";
  return agentType === IMPLEMENTOR_ROLE || agentType.endsWith(`:${IMPLEMENTOR_ROLE}`);
}

/** The command text of a Bash call; Codex may send an argument vector. */
function commandText(toolInput) {
  const command = toolInput?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ");
  }
  return "";
}

/**
 * Decide a PreToolUse call. Returns the first rule it breaks, or null.
 * `role` is the dispatcher's `--role` flag, if any.
 */
export function findViolation(input, role = null) {
  const tool = input?.tool_name;
  if (tool === "Agent" || tool === "Task") {
    const effort = input?.tool_input?.effort;
    if (typeof effort === "string" && effort.trim().toLowerCase() === FORBIDDEN_EFFORT) {
      return {
        id: "effort-max",
        reason: `\`xhigh\` is the effort ceiling; launch the agent at \`xhigh\` or lower, never \`${FORBIDDEN_EFFORT}\`.`,
        source: "AGENTS.md -> Model selection",
      };
    }
    return null;
  }
  if (tool !== "Bash") return null;
  const implementor = isImplementor(input, role);
  const rules = BASH_RULES.filter((rule) => implementor || !rule.implementorOnly);
  for (const words of simpleCommands(commandText(input?.tool_input))) {
    for (const candidate of [words, ...launched(words)]) {
      const rule = rules.find((entry) => entry.test(candidate));
      if (rule) return rule;
    }
  }
  return null;
}
