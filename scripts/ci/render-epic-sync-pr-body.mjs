#!/usr/bin/env node
/**
 * Render the pull-request description for a `main` -> `epic/**` sync pull
 * request (#3142).
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES OF SHELL. The description has to
 * satisfy the `## Concurrency And Lock Impact` gate in `verify`, whose five
 * field labels are matched EXACTLY against `.github/pull_request_template.md`.
 * While the description lived inside the sync workflow's heredoc there was no
 * way to run it through that gate offline, so the cost of a mistyped label was
 * a red pull request opened by a 06:20 UTC scheduled job — the least-watched
 * thing in the repository. With the text in a template file and the
 * substitution in a function, `render-epic-sync-pr-body.test.mjs` feeds the
 * real rendered body to the real gate and a typo fails `pnpm test` instead.
 *
 * Runs from the sync workflow before any install, so Node built-ins only.
 *
 * TWO MODES, ONE TEMPLATE (#3721). The workflow opens its sync pull requests
 * with `main` itself as the head. A person resolving or pre-checking a sync
 * opens one by hand from a merge branch instead, because `epic/**` takes no
 * direct push, and until #3721 had no body to give it: #3718 went red at the
 * gate for exactly the reason #3142 fixed for the workflow.
 * `renderHandSyncPrBody` renders the same template for that case, and
 * `epic-sync-body.mjs` reads its inputs from the merge commit. The template
 * marks the sentences that differ, so every field label stays written once.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isConcurrencySensitivePath } from "./check-pr-concurrency-declaration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const TEMPLATE_PATH = path.join(HERE, "..", "..", ".github", "epic-branch-sync-pr-body.md");

/**
 * The template opens with an HTML comment addressed to whoever maintains it.
 * That is documentation for this repository, not for the pull request, so it is
 * removed rather than shipped: GitHub would hide it from the rendered
 * description while leaving it in the raw body, where the next person to read
 * the body with `gh pr view --json body` finds instructions that are not about
 * the pull request they are looking at.
 *
 * Anchored at the very start and non-greedy, so a comment anywhere else in the
 * template survives and a `-->` inside the body cannot extend the match.
 */
const LEADING_COMMENT = /^\s*<!--[\s\S]*?-->\s*/;

/**
 * Any placeholder shape at all, checked against the TEMPLATE rather than
 * against the rendered body. Checking afterwards reads as the stricter option
 * and is actually wrong: a branch name may legally contain `__` (git allows it,
 * and so does the branch pattern below), so an epic branch called
 * `epic/3021__lodge__info` would substitute in cleanly and then be reported as
 * an unsubstituted placeholder — aborting a sync over its own output. Checking
 * the template asks the question that was actually meant: does this file hold a
 * placeholder nobody taught the renderer to fill?
 */
const ANY_PLACEHOLDER = /__[A-Z][A-Z0-9_]*__/g;

/** Every placeholder each mode knows how to substitute. */
const KNOWN_PLACEHOLDERS = {
  workflow: new Set(["__BRANCH__", "__RUN_URL__"]),
  "by-hand": new Set(["__BRANCH__", "__HEAD_SHA__", "__EPIC_SHA__", "__MAIN_SHA__", "__RESOLUTIONS__"]),
};

const MODES = Object.keys(KNOWN_PLACEHOLDERS);

const BRANCH_NAME = /^[\w.\-/]+$/;
/** A full commit or tree id, as git prints it. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Keep one mode's blocks and drop every other mode's. A block that spans whole
 * lines goes with its own line breaks; one inside a line goes alone, so a
 * sentence that differs by mode keeps its paragraph intact. The run of blank
 * lines a dropped block can leave behind is folded to one.
 */
function selectMode(text, mode) {
  let out = text;
  for (const tag of MODES) {
    const keep = (_, inner) => (tag === mode ? inner : "");
    out = out.replace(new RegExp(`^<!-- ${tag} -->\\r?\\n([\\s\\S]*?)^<!-- /${tag} -->\\r?\\n`, "gm"), keep);
    out = out.replace(new RegExp(`<!-- ${tag} -->([\\s\\S]*?)<!-- /${tag} -->`, "g"), keep);
  }
  const stray = out.match(/<!-- \/?[a-z-]+ -->/);
  if (stray) {
    throw new Error(`renderEpicSyncPrBody: unbalanced or unknown mode marker ${stray[0]} in the template.`);
  }
  return out.replace(/\n{3,}/g, "\n\n");
}

/**
 * Select the mode, check the template holds no placeholder that mode cannot
 * fill, then substitute literally. The placeholder check reads the selected
 * TEMPLATE text, never the finished body (see ANY_PLACEHOLDER).
 */
function substitute(template, mode, values) {
  const body = selectMode(template.replace(LEADING_COMMENT, ""), mode);
  const unknown = [...new Set(body.match(ANY_PLACEHOLDER) ?? [])].filter(
    (placeholder) => !KNOWN_PLACEHOLDERS[mode].has(placeholder),
  );
  if (unknown.length > 0) {
    throw new Error(
      `renderEpicSyncPrBody: the template holds placeholder(s) this renderer cannot fill: ${unknown.join(", ")}. ` +
        "Add the substitution here, or remove the placeholder from .github/epic-branch-sync-pr-body.md.",
    );
  }
  // A replacer FUNCTION, not a string: a string replacement reads `$&`, `$'`,
  // `` $` `` and `$$` as patterns, and a hand-resolved path may contain them.
  let out = body;
  for (const [placeholder, value] of Object.entries(values)) {
    out = out.replaceAll(placeholder, () => value);
  }
  return out;
}

export function readTemplate() {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

/**
 * Substitute `__BRANCH__` and `__RUN_URL__` and return the finished body.
 *
 * Substitution is literal `replaceAll` on a fixed string, never a regex and
 * never a shell expansion: an epic branch name contains a `/`, which is exactly
 * the character that turns a `sed` substitution into a syntax error, and the
 * first draft of the sync workflow lost a whole run to a similar quoting
 * accident. `$&`-style replacement patterns cannot bite here either, because
 * `replaceAll` with a string searchValue treats the replacement's `$` as
 * special only for a handful of sequences — none of which appear in a branch
 * name or in a GitHub Actions run URL, both of which this function validates.
 *
 * Throws rather than returning a half-substituted body: a description missing
 * its branch name would still pass the gates and would be silently wrong on the
 * one artifact a human reads when the sync conflicts.
 */
export function renderEpicSyncPrBody({ branch, runUrl, template = readTemplate() }) {
  if (typeof branch !== "string" || !BRANCH_NAME.test(branch)) {
    throw new Error(`renderEpicSyncPrBody: branch must be a git branch name, got ${JSON.stringify(branch)}`);
  }
  if (typeof runUrl !== "string" || !/^https:\/\/\S+$/.test(runUrl)) {
    throw new Error(`renderEpicSyncPrBody: runUrl must be an https URL, got ${JSON.stringify(runUrl)}`);
  }
  return substitute(template, "workflow", { __BRANCH__: branch, __RUN_URL__: runUrl });
}

/**
 * The body for a sync opened by hand from a merge branch (#3721).
 *
 * `resolvedFiles` is every path git reported as conflicted, plus every path
 * whose content in the merge commit differs from git's automatic merge of its
 * two parents: the hand resolutions, measured rather than declared. The template's declaration says no hand resolution
 * touches a concurrency-sensitive path, so when one does this refuses instead
 * of printing a structural claim that is false. That pull request needs a
 * person's declaration over the resolution.
 */
export function renderHandSyncPrBody({
  branch,
  headSha,
  epicSha,
  mainSha,
  resolvedFiles,
  template = readTemplate(),
}) {
  if (typeof branch !== "string" || !BRANCH_NAME.test(branch)) {
    throw new Error(`renderHandSyncPrBody: branch must be a git branch name, got ${JSON.stringify(branch)}`);
  }
  for (const [name, sha] of Object.entries({ headSha, epicSha, mainSha })) {
    if (typeof sha !== "string" || !FULL_SHA.test(sha)) {
      throw new Error(`renderHandSyncPrBody: ${name} must be a full 40-character commit SHA, got ${JSON.stringify(sha)}`);
    }
  }
  if (!Array.isArray(resolvedFiles)) {
    throw new Error("renderHandSyncPrBody: resolvedFiles must list the hand-resolved paths (empty for none).");
  }
  const sensitive = resolvedFiles.filter(isConcurrencySensitivePath);
  if (sensitive.length > 0) {
    throw new Error(
      `renderHandSyncPrBody: the merge hand-resolves concurrency-sensitive path(s): ${sensitive.join(", ")}. ` +
        "A generated declaration would be false here. Write this pull request's " +
        "## Concurrency And Lock Impact yourself, over the resolution, starting from " +
        ".github/pull_request_template.md.",
    );
  }
  const resolutions =
    resolvedFiles.length === 0
      ? "none. The merge commit's tree is exactly git's automatic merge of its two parents."
      : `${resolvedFiles.map((file) => `\`${file}\``).join(", ")}. These differ from git's automatic merge of the two parents; review each one.`;
  return substitute(template, "by-hand", {
    __BRANCH__: branch,
    __HEAD_SHA__: headSha,
    __EPIC_SHA__: epicSha,
    __MAIN_SHA__: mainSha,
    __RESOLUTIONS__: resolutions,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(
      renderEpicSyncPrBody({ branch: process.env.BRANCH ?? "", runUrl: process.env.RUN_URL ?? "" }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
