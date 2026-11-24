/**
 * After-deploy steps as `changelog.d/<pr-number>-<slug>.deploy.md` fragments
 * (#5379, owner decisions D1–D4, 22 Nov 2026).
 *
 * A pull request whose change needs someone to do something once a release is
 * deployed — run a report, map a setting, check a page — writes that step here
 * in the same pull request, rather than in its description, where it used to
 * be lost until someone collected it by hand (#5378). At release time
 * `release:cut prepare` files the steps under "After deploying this release" in
 * the upgrade guide and the notes page, and `release:cut publish` opens the
 * release's post-deploy checklist issue from them.
 *
 * The one definition of the format, read by the compiler, the release cutter,
 * the `verify` gate (`scripts/ci/check-pr-deploy-fragment.mjs`), `pr:check` and
 * the tree-wide census (`INV-SSOT`). Node built-ins only: the gate runs before
 * `pnpm install` in `verify`.
 */
import { scanMarkdownBlocks, scannableLines } from "./markdown-blocks.mjs";
import { inlineLinkTargets, maskCode, refDefTargets } from "./markdown-links.mjs";

/** The suffix that marks a `changelog.d/` fragment as an after-deploy step. */
export const DEPLOY_FRAGMENT_SUFFIX = ".deploy.md";

/**
 * A deploy fragment's name: lower-case words joined by hyphens, normally
 * `<pr-number>-<slug>`. A name that opens with a number takes it as its pull
 * request; any other (a lane that names its files before the pull request
 * exists) has it read from the merge that brought the file to main.
 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.deploy\.md$/;
const NAME_PR = /^(\d+)-/;

/** The three headings every deploy fragment has, once each and in this order. */
export const DEPLOY_HEADINGS = Object.freeze(["## Who", "## What to do", "## How to check it worked"]);

/** Who does a step: the club's owner, the person who runs its servers, or an officer with admin access. */
export const DEPLOY_ROLES = Object.freeze(["owner", "operator", "officer"]);

/** The title of the section the steps are filed under, in the upgrade guide and the notes page. */
export const AFTER_DEPLOY_TITLE = "After deploying this release";

/** The markers around the rendered steps, so a later fold can add to them and `publish` can read them. */
export const DEPLOY_STEPS_START = "<!-- deploy-steps:start -->";
export const DEPLOY_STEPS_END = "<!-- deploy-steps:end -->";

/** The sentences placed above the rendered steps wherever they are filed. */
export const DEPLOY_STEPS_INTRO =
  "Do these once the release is deployed, except a step marked \"before or during the deploy\": that one cannot " +
  "wait, so do it before you deploy. Each was written by the pull request that needs it, and " +
  "`release:cut publish` opens a checklist issue with the same steps.";

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
/** A first line that cannot follow `**Who:** ` on one line: a list item, fence, quote, table or indented code. */
const NOT_PROSE = /^(?:[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|`{3}|~{3}|>|\|)|[ \t]{4})/;
const MARKER_TEXT = /<!-{2}\s*deploy-steps:/;
/** An `https:` or `mailto:` target, the only kinds that mean the same thing, and are safe, in every copy of a step. */
const ALLOWED_TARGET = /^<?(?:https|mailto):/i;
/** An HTML start tag, to its `>` (one inside a quoted value does not end it) or the text's end. */
const HTML_TAG = /<[a-z][a-z0-9-]*\b(?:[^>"']|"[^"]*"|'[^']*'|["'])*>?/gi;
/** One attribute of an HTML tag and its value, quoted or not: the name is group 1, the value group 2, 3 or 4. */
const HTML_ATTRIBUTE = /\s([^\s"'>/=]+)(?:[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
/** The attributes whose value is a link: `<a href="…">`, `<img src='…'>`. */
const HTML_LINK_NAME = /^(?:href|src)$/i;

/**
 * Every `href` and `src` value in the HTML tags of `text`, each attribute of a
 * tag and not only its first link. `masked` is `text` with its code blanked
 * (`maskCode`); a raw HTML block, such as an `<img …>` alone on its line, is
 * read as written, since it is rendered as HTML rather than shown as code.
 */
function htmlLinkTargets(text, masked) {
  const rawHtml = new Map(scanMarkdownBlocks(text).html.map(({ number, text: line }) => [number, line]));
  const readable = masked
    .split("\n")
    .map((line, index) => rawHtml.get(index + 1) ?? line)
    .join("\n");
  return [...readable.matchAll(HTML_TAG)].flatMap(([tag]) =>
    [...tag.matchAll(HTML_ATTRIBUTE)]
      .filter((match) => HTML_LINK_NAME.test(match[1]))
      .map((match) => match[2] ?? match[3] ?? match[4])
      .filter((target) => target !== undefined),
  );
}

/** A Markdown autolink, `<scheme:…>`. */
const AUTOLINK = /<([a-z][a-z0-9+.-]{1,31}:[^<>\s]*)>/gi;

/**
 * The link targets in `text` a step may not carry: every inline or reference
 * link, autolink and HTML `href` or `src` (every one in a tag, and in a raw
 * HTML block too) whose target is not `https:` or `mailto:`. A step is copied
 * into the upgrade guide, the release notes page and a GitHub issue, where a
 * relative or same-page link points somewhere different in each, and another
 * scheme (`http:`, `javascript:`, `file:`) is insecure or meaningless there,
 * so none is allowed. Code is not read.
 */
function refusedLinkTargets(text) {
  const masked = maskCode(text);
  const html = htmlLinkTargets(text, masked);
  const autolinks = [...masked.matchAll(AUTOLINK)].map((match) => match[1]);
  return [...inlineLinkTargets(masked).map(({ target }) => target), ...refDefTargets(masked).map(({ target }) => target), ...autolinks, ...html].filter(
    (target) => !ALLOWED_TARGET.test(target.trim()),
  );
}

/** Whether a `changelog.d/` filename is an after-deploy step rather than a changelog entry. */
export function isDeployFragmentName(name) {
  return String(name).toLowerCase().endsWith(DEPLOY_FRAGMENT_SUFFIX);
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

/** `text`'s headings outside fenced code, as `{ line, index }`. */
function headingsOf(text) {
  const headings = [];
  for (const { number, text: raw } of scannableLines(text)) {
    const match = HEADING.exec(raw);
    if (match) headings.push({ line: `${match[1]} ${match[2] ?? ""}`.trimEnd(), index: number - 1 });
  }
  return headings;
}

/**
 * Split a fragment into its three sections, or report why it cannot be:
 * `{ sections: { who, what, check } | null, problems }`. Each section is its
 * lines without blank edges.
 */
function splitFragment(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headings = headingsOf(lines.join("\n"));
  const found = headings.map((heading) => heading.line);
  const problems = [];
  for (const expected of DEPLOY_HEADINGS) {
    const count = found.filter((line) => line === expected).length;
    if (count === 0) problems.push(`it has no "${expected}" heading`);
    if (count > 1) problems.push(`it has "${expected}" ${count} times`);
  }
  const others = found.filter((line) => !DEPLOY_HEADINGS.includes(line));
  if (others.length > 0) {
    problems.push(`it has heading(s) other than the three: ${others.map((line) => `"${line}"`).join(", ")}`);
  }
  if (problems.length > 0) return { sections: null, problems };
  if (JSON.stringify(found) !== JSON.stringify(DEPLOY_HEADINGS)) {
    return { sections: null, problems: [`its headings must be in the order ${DEPLOY_HEADINGS.map((line) => `"${line}"`).join(", ")}`] };
  }
  if (lines.slice(0, headings[0].index).some((line) => line.trim() !== "")) {
    problems.push(`it has text above "${DEPLOY_HEADINGS[0]}"`);
  }
  const [who, what, check] = headings.map((heading, at) =>
    trimBlankEdges(lines.slice(heading.index + 1, headings[at + 1]?.index ?? lines.length)),
  );
  return { sections: { who, what, check }, problems };
}

/**
 * What is wrong with deploy fragment `name` holding `text`, one phrase each;
 * empty when it is well formed. The rules: the name is lower-case words joined
 * by hyphens ending `.deploy.md`; the file is the three `DEPLOY_HEADINGS`, once
 * each, in order, with no other heading and nothing above the first; no section
 * is empty; "Who" is one of `DEPLOY_ROLES` on one line; "What to do" and "How
 * to check it worked" each open with a line of prose (it follows the role, or
 * the words "How to check it worked:", on one line); nothing names the
 * rendered block's markers; every link, Markdown or HTML, is `https:` or
 * `mailto:`, since a relative one breaks once the step is copied out of
 * `changelog.d/` and another scheme is unsafe in an issue.
 */
export function deployFragmentProblems(name, text) {
  const problems = [];
  if (!NAME_PATTERN.test(name)) {
    problems.push(`its name must be <pr-number>-<slug>${DEPLOY_FRAGMENT_SUFFIX}, in lower-case letters, digits and hyphens`);
  }
  const { sections, problems: shape } = splitFragment(String(text ?? ""));
  problems.push(...shape);
  if (sections === null) return problems;
  const labelled = [
    [DEPLOY_HEADINGS[0], sections.who],
    [DEPLOY_HEADINGS[1], sections.what],
    [DEPLOY_HEADINGS[2], sections.check],
  ];
  for (const [heading, lines] of labelled) {
    if (lines.length === 0) problems.push(`"${heading}" is empty`);
  }
  if (sections.who.length > 1 || (sections.who.length === 1 && !DEPLOY_ROLES.includes(sections.who[0].trim().toLowerCase()))) {
    problems.push(`"${DEPLOY_HEADINGS[0]}" must be one line naming one of ${DEPLOY_ROLES.join(", ")}`);
  }
  for (const [heading, lines] of labelled.slice(1)) {
    if (lines.length > 0 && NOT_PROSE.test(lines[0])) {
      problems.push(`"${heading}" must open with a sentence, not a list, quote, table or code block`);
    }
  }
  if (labelled.some(([, lines]) => lines.some((line) => MARKER_TEXT.test(line)))) {
    problems.push(`it must not contain the "${DEPLOY_STEPS_START}" or "${DEPLOY_STEPS_END}" markers`);
  }
  const refused = refusedLinkTargets(String(text ?? ""));
  if (refused.length > 0) {
    problems.push(
      `it links ${refused.map((target) => `"${target}"`).join(", ")}: a step is copied into the upgrade guide, the notes page ` +
        "and an issue, where a relative link breaks, so write a path in backticks or link an absolute https:// URL " +
        "(or a mailto: address)",
    );
  }
  return problems;
}

/**
 * The step in a well-formed deploy fragment: `{ name, pr, who, what, check }`.
 * `pr` is the number the name opens with, or `null`; `what` and `check` are
 * the sections' text. Throws, naming every problem, on a malformed one.
 */
export function parseDeployFragment(name, text) {
  const problems = deployFragmentProblems(name, text);
  if (problems.length > 0) throw new Error(`changelog.d/${name}: ${problems.join("; ")}.`);
  const { sections } = splitFragment(String(text));
  const pr = NAME_PR.exec(name);
  return {
    name,
    pr: pr ? Number(pr[1]) : null,
    who: sections.who[0].trim().toLowerCase(),
    what: sections.what.join("\n"),
    check: sections.check.join("\n"),
  };
}

const indent = (text) => text.split("\n").map((line) => (line.trim() === "" ? "" : `  ${line}`));

/**
 * One Markdown task-list item per step, as lines: the role in bold before what
 * to do, then how to check it, then the pull request it came from — linked
 * when `repo` (`{ host, owner, name }`) is known. A step whose pull request is
 * unknown names its fragment instead.
 */
export function renderDeployStepItems(steps, repo = null) {
  const lines = [];
  for (const step of steps) {
    const [first, ...rest] = indent(step.what);
    const [checkFirst, ...checkRest] = indent(step.check);
    const who = `${step.who[0].toUpperCase()}${step.who.slice(1)}`;
    const source =
      step.pr === null
        ? `From \`changelog.d/${step.name}\`.`
        : repo
          ? `From [#${step.pr}](https://${repo.host}/${repo.owner}/${repo.name}/pull/${step.pr}).`
          : `From #${step.pr}.`;
    if (lines.length > 0) lines.push("");
    lines.push(`- [ ] **${who}:** ${first.trimStart()}`, ...rest, "", `  How to check it worked: ${checkFirst.trimStart()}`, ...checkRest, "", `  ${source}`);
  }
  return lines;
}

/** `items` (task-list lines) between the start and end markers. */
export function deployStepsBlock(items) {
  return [DEPLOY_STEPS_START, ...items, DEPLOY_STEPS_END];
}

/**
 * The marked block in `text` as `{ start, end, items }`: the marker line
 * numbers and the item lines between them without blank edges. `null` when
 * there is none; throws when the markers are unpaired or repeated, because a
 * guess could drop or duplicate steps.
 */
export function findDeploySteps(text) {
  const lines = String(text).split("\n");
  const starts = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (line.trim() === DEPLOY_STEPS_START) starts.push(index);
    if (line.trim() === DEPLOY_STEPS_END) ends.push(index);
  });
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error(`expected one "${DEPLOY_STEPS_START}" followed by one "${DEPLOY_STEPS_END}"`);
  }
  return { start: starts[0], end: ends[0], items: trimBlankEdges(lines.slice(starts[0] + 1, ends[0])) };
}

/** How many steps `items` (task-list lines) holds. */
export function countDeploySteps(items) {
  return items.filter((line) => /^- \[[ xX]\] /.test(line)).length;
}

/** `text` with `items` added at the end of its marked block. Throws when it has none. */
export function appendDeploySteps(text, items) {
  const found = findDeploySteps(text);
  if (found === null) throw new Error(`there is no "${DEPLOY_STEPS_START}" block to add to`);
  const lines = String(text).split("\n");
  const merged = found.items.length > 0 ? [...found.items, "", ...items] : items;
  return [...lines.slice(0, found.start + 1), ...merged, ...lines.slice(found.end)].join("\n");
}
