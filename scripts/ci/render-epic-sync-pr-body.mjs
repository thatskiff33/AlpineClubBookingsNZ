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
 * real rendered body to the real gate and a typo fails `npm test` instead.
 *
 * Runs from the sync workflow before any install, so Node built-ins only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Every placeholder this renderer knows how to substitute. */
const KNOWN_PLACEHOLDERS = new Set(["__BRANCH__", "__RUN_URL__"]);

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
  if (typeof branch !== "string" || !/^[\w.\-/]+$/.test(branch)) {
    throw new Error(`renderEpicSyncPrBody: branch must be a git branch name, got ${JSON.stringify(branch)}`);
  }
  if (typeof runUrl !== "string" || !/^https:\/\/\S+$/.test(runUrl)) {
    throw new Error(`renderEpicSyncPrBody: runUrl must be an https URL, got ${JSON.stringify(runUrl)}`);
  }

  const withoutComment = template.replace(LEADING_COMMENT, "");

  const unknown = [...new Set(withoutComment.match(ANY_PLACEHOLDER) ?? [])].filter(
    (placeholder) => !KNOWN_PLACEHOLDERS.has(placeholder),
  );
  if (unknown.length > 0) {
    throw new Error(
      `renderEpicSyncPrBody: the template holds placeholder(s) this renderer cannot fill: ${unknown.join(", ")}. ` +
        "Add the substitution here, or remove the placeholder from .github/epic-branch-sync-pr-body.md.",
    );
  }

  return withoutComment.replaceAll("__BRANCH__", branch).replaceAll("__RUN_URL__", runUrl);
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
