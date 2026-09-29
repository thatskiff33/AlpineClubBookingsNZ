import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Fails the build when a PRERENDERED page ships an inline `<script>` with no
 * `nonce` (issue #2356).
 *
 * Why this needs a guard at all: production CSP is nonce-only
 * (`script-src 'self' 'nonce-…'`, `src/lib/csp.ts`), and Next stamps its nonce
 * into the inline bootstrap/RSC scripts only during DYNAMIC rendering, reading
 * it from the request's own CSP header. A statically prerendered route was
 * rendered once with no request, so it ships unnonced inline scripts that the
 * browser then blocks — the page never hydrates. Nothing else in the repo
 * notices: the build succeeds, the HTML looks right, and the failure is visible
 * only in a browser console. `/display` (fork #54) and the global 404 (#2356)
 * have both hit this already.
 *
 * This runs against the real build output, after `pnpm run build`, because that
 * is the only place the property is observable. It fails LOUDLY when the build
 * output is absent rather than passing quietly.
 */

const DIST_DIR = ".next";

/** Build output directories this check refuses to run without. */
const SCAN_ROOTS = [
  ["server", "app"],
  ["server", "pages"],
];

/**
 * `<script type="…">` values the browser does NOT execute, so `script-src` does
 * not govern them and a missing nonce is not a finding.
 *
 * Deliberately a closed list of data types rather than "anything unrecognised":
 * `type="module"`, `type="importmap"`, `type="speculationrules"` and a missing
 * `type` are all enforced by `script-src`, and a typo in a type value must fail
 * this check rather than slip past it. Today's motivation is JSON-LD — a
 * `<script type="application/ld+json">` structured-data block on a prerendered
 * page would otherwise fail the build for no security reason at all.
 */
const NON_EXECUTABLE_SCRIPT_TYPES = new Set(["application/json", "application/ld+json"]);

/**
 * Prerendered artefacts that are KNOWN to ship unnonced inline scripts and
 * cannot be fixed from this repository. Closed list, keyed by the build-relative
 * posix path.
 *
 * Both entries are ONE artefact: Next's own built-in error shell, which it
 * prerenders itself and copies to `server/pages/500.html` (byte-identical). It
 * is *not* a render of `src/app/global-error.tsx` — its visible text is Next's
 * "This page couldn't load / A server error occurred. Reload to try again", and
 * none of our own copy appears in it. Nothing in this repository controls how
 * that shell is emitted, so it ships unnonced regardless of our route config.
 *
 * The practical consequence is the same either way: under the nonce-only CSP the
 * browser blocks those scripts, so whatever is served from these files never
 * hydrates. See docs/SECURITY-ATTACK-SURFACE.md -> "Prerendered Pages And The
 * Nonce-Only CSP".
 *
 * This is not a licence to add more. Each entry is asserted to still be an
 * offender below, so a Next release that starts nonce-ing its own shell fails
 * this check and the carve-out gets deleted rather than quietly outliving its
 * reason. Note what that means: these entries invalidate on a change to NEXT's
 * shell, not on anything we can do to our own pages.
 */
export const KNOWN_UNNONCED_PRERENDERS = new Map([
  [
    "server/app/_global-error.html",
    "Next's own built-in 500 shell, prerendered by the framework and not by any file in this repo (#2356)",
  ],
  [
    "server/pages/500.html",
    "byte-identical copy of _global-error.html, served by base-server for a 500 that escapes the app render (#2356)",
  ],
]);

/** The lower-cased `type` attribute of a `<script>` open tag, or `""`. */
function scriptType(attributes) {
  const match = attributes.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  if (!match) return "";
  return (match[1] ?? match[2] ?? match[3] ?? "").trim().toLowerCase();
}

/**
 * Every executable inline `<script>` open tag in `html` that carries no
 * non-empty `nonce`.
 *
 * A tag with `src=` is external and is covered by `script-src 'self'`, so it is
 * not an offender. A data block (`type="application/ld+json"` and friends) is
 * never executed, so `script-src` does not apply to it either. `nonce=""` does
 * NOT count as nonced: an empty attribute matches no `'nonce-…'` source
 * expression, so the browser blocks it just the same, and treating it as
 * satisfied would be the exact silent pass this guard exists to prevent.
 */
export function findUnnoncedInlineScripts(html) {
  const offenders = [];

  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (NON_EXECUTABLE_SCRIPT_TYPES.has(scriptType(attributes))) continue;
    if (/\bnonce\s*=\s*(?:"[^"]+"|'[^']+'|[^\s"'>]+)/i.test(attributes)) continue;
    offenders.push(match[0]);
  }

  return offenders;
}

/** Every `.html` file under `directory`, as build-relative posix paths. */
function collectHtmlFiles(directory, distRoot, found = []) {
  if (!fs.existsSync(directory)) return found;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectHtmlFiles(absolute, distRoot, found);
      continue;
    }
    if (entry.isFile() && path.extname(entry.name) === ".html") {
      found.push(path.relative(distRoot, absolute).split(path.sep).join("/"));
    }
  }

  return found;
}

/**
 * The pure half, so the rules are unit-testable without a build.
 *
 * `artefacts` is a map of build-relative posix path -> HTML string. Returns the
 * two ways this check can fail: `offenders` (an unexpected artefact shipping
 * unnonced inline scripts) and `staleAllowances` (an allowlisted artefact that
 * is missing or has stopped offending, so its carve-out should be removed).
 */
export function auditPrerenderedHtml(artefacts, allowlist = KNOWN_UNNONCED_PRERENDERS) {
  const offenders = [];
  const staleAllowances = [];

  for (const [file, html] of artefacts) {
    const unnonced = findUnnoncedInlineScripts(html);
    if (unnonced.length === 0) continue;
    if (allowlist.has(file)) continue;
    offenders.push({ file, count: unnonced.length, samples: unnonced.slice(0, 3) });
  }

  for (const [file, reason] of allowlist) {
    const html = artefacts.get(file);
    if (html === undefined) {
      staleAllowances.push(`${file} is allowlisted but was not emitted by the build (${reason})`);
      continue;
    }
    if (findUnnoncedInlineScripts(html).length === 0) {
      staleAllowances.push(
        `${file} is allowlisted but no longer ships unnonced inline scripts — delete the carve-out (${reason})`,
      );
    }
  }

  return { offenders, staleAllowances };
}

export function checkBuildOutput(distRoot) {
  if (!fs.existsSync(distRoot)) {
    throw new Error(
      `No build output at ${distRoot}. This check must run AFTER \`pnpm run build\` — it cannot pass without one.`,
    );
  }

  // A scan that finds nothing must fail, not pass. Today the allowlist happens
  // to keep this honest (its entries are asserted to exist), but if the
  // allowlist ever empties — the good outcome, when Next starts nonce-ing its
  // own shell — a renamed or relocated output directory would sail through with
  // zero files inspected and a green tick.
  const missingRoots = SCAN_ROOTS.map((segments) => path.join(distRoot, ...segments)).filter(
    (root) => !fs.existsSync(root),
  );
  if (missingRoots.length > 0) {
    throw new Error(
      `Expected build output directories are missing: ${missingRoots.join(", ")}. ` +
        "Either the build did not emit them or Next's output layout changed — " +
        "this check cannot pass without inspecting them.",
    );
  }

  const files = SCAN_ROOTS.flatMap((segments) =>
    collectHtmlFiles(path.join(distRoot, ...segments), distRoot),
  );

  if (files.length === 0) {
    throw new Error(
      `No prerendered HTML found under ${SCAN_ROOTS.map((s) => s.join("/")).join(" or ")} in ${distRoot}. ` +
        "A scan of nothing must not report success.",
    );
  }

  const artefacts = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(distRoot, file), "utf8")]),
  );

  const { offenders, staleAllowances } = auditPrerenderedHtml(artefacts);
  return { files, offenders, staleAllowances };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const distRoot = path.resolve(process.cwd(), DIST_DIR);
    const { files, offenders, staleAllowances } = checkBuildOutput(distRoot);

    const problems = [];

    if (offenders.length > 0) {
      problems.push(
        "Prerendered pages ship inline <script> tags with no nonce, which the production CSP blocks:",
        ...offenders.map(
          ({ file, count, samples }) =>
            `  - ${file}: ${count} unnonced inline script(s), e.g. ${samples.join(" ")}`,
        ),
        "",
        "Fix: force the route to render per-request (`export const dynamic = \"force-dynamic\"`),",
        "as src/app/not-found.tsx and src/app/display/page.tsx do. Next stamps the nonce only",
        "during dynamic rendering. See docs/SECURITY-ATTACK-SURFACE.md -> \"Prerendered Pages And",
        "The Nonce-Only CSP\".",
      );
    }

    if (staleAllowances.length > 0) {
      problems.push(
        "Allowlist in scripts/ci/check-prerendered-script-nonces.mjs is out of date:",
        ...staleAllowances.map((entry) => `  - ${entry}`),
      );
    }

    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(
        `Prerendered script-nonce check passed: ${files.length} prerendered HTML artefact(s), ` +
          `${KNOWN_UNNONCED_PRERENDERS.size} documented exception(s).`,
      );
    }
  } catch (error) {
    console.error(`Prerendered script-nonce check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
