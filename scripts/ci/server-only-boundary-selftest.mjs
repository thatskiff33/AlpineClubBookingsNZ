#!/usr/bin/env node
/**
 * Failure injection for the server/client boundary (`INV-OPS-013`, #2850).
 *
 * ## What this proves, and why a source scan could not
 *
 * `src/lib/__tests__/client-server-boundary-census.test.ts` walks the import
 * graph with a regular expression and reports any `"use client"` module that
 * reaches server-only code. It is cheap, it runs in the required `verify`
 * check, and it is our own code — which is the whole problem. A source walk and
 * a bundler can disagree, and when they do the source walk is the one that says
 * everything is fine. #2850 asked for the gap to be closed by the bundler
 * itself: plant a client component that transitively reaches a protected server
 * root, run the REAL production build, and require it to refuse — for the
 * boundary reason, not for something incidental.
 *
 * That distinction is not academic here. Dragging `@/lib/auth` into the browser
 * layer also drags Prisma's `pg` driver, which fails to resolve `node:util` and
 * friends, so the seeded build reports sixteen errors of which most are
 * collateral. A check that only asserted "the build failed" would still pass
 * with Next's server-only rule switched off entirely. So this asserts the
 * SPECIFIC error: Next's server-only message, attributed to the protected root
 * itself, with an import trace in the browser layer that names the planted
 * fixture. Remove `import "server-only"` from `src/lib/auth.ts` and the build
 * still fails on `pg` — but that error block disappears and this fails.
 *
 * ## The other half of the proof
 *
 * A gate that always goes red is as useless as one that never does. The clean
 * direction is proved by the `verify` job's own `Build` step, which runs before
 * this one and must be green for the run to reach here at all. That is also why
 * this step runs LAST: it clobbers `.next`, and the two prerender checks that
 * read `.next` have finished by then. Running immediately after a successful
 * build is also what makes it cheap — Turbopack's cache is warm and
 * `--debug-build-paths` narrows the build to the planted route, which measured
 * 3.4s locally against 101s for a cold full build.
 *
 * ## Running it yourself, exactly as CI does
 *
 *   npm run build && node scripts/ci/server-only-boundary-selftest.mjs
 *
 * The fixture is written at start and deleted at exit. It is deliberately NOT
 * in `.gitignore`: if a run is killed mid-flight the leftover shows up in
 * `git status`, and the boundary census fails on it too, so it cannot sit there
 * unnoticed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * The planted route. A real segment, not an underscore-prefixed one: the App
 * Router treats `_name` as a PRIVATE folder and excludes it from routing
 * entirely, so a fixture named that way is never compiled and the build passes
 * — which is exactly the silent green this file exists to prevent. Measured the
 * hard way while writing it.
 */
export const FIXTURE_SEGMENT = "server-only-boundary-selftest";
export const FIXTURE_DIR = path.join("src", "app", FIXTURE_SEGMENT);
export const FIXTURE_PAGE = `./${FIXTURE_DIR.split(path.sep).join("/")}/page.tsx`;
export const FIXTURE_BRIDGE = `./${FIXTURE_DIR.split(path.sep).join("/")}/bridge.ts`;

/**
 * The protected root the fixture reaches. `@/lib/auth` carries
 * `import "server-only"`, and reaching it from the browser would ship NextAuth's
 * configuration, `bcrypt` and the database client to every visitor.
 *
 * `@/lib/prisma` is deliberately NOT used, and not because it would be a worse
 * proof: it does not carry `import "server-only"` at all, because fourteen
 * operator CLI entrypoints statically reach it and that marker throws at import
 * under plain Node. `cli-server-only-reach-census.test.ts` (CT-5, #2869) is the
 * invariant that says so. Prisma stays covered by the source census.
 */
export const PROTECTED_ROOT = "./src/lib/auth.ts";

/**
 * Next's own wording. Quoted rather than matched loosely so a version bump that
 * reworded or dropped the rule fails here instead of passing on a fuzzy match.
 * The "Pages Router" clause is Next's, and is wrong — this is the App Router —
 * but it is what the compiler prints, so it is what this looks for.
 */
export const BOUNDARY_MESSAGE =
  'You\'re importing a module that depends on "server-only".';

/** The browser layer's label in a Turbopack import trace. */
export const BROWSER_LAYER = "[Client Component Browser]";

/** Turbopack colours its output; the parsing below wants the plain text. */
export function stripAnsi(text) {
  // `\u001B`, spelled as an escape rather than written as a literal ESC
  // byte: a raw control character in a tracked file fails
  // `npm run docs:indexcheck` (#3072) and is invisible in review.
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

/**
 * Split Turbopack's error report into blocks. Each block starts on a line that
 * is just `./path/to/file.ts:LINE:COL`, which is how Turbopack heads every
 * error it reports.
 */
export function splitErrorBlocks(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const head = /^(\.\/[^\s:]+):(\d+):(\d+)$/.exec(line);
    if (head) {
      if (current) blocks.push(current);
      current = { file: head[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Everything that must be true for the seeded build to count as proof. Returns
 * the list of problems, so a failure names all of them at once rather than
 * making the reader re-run for each.
 */
export function problemsWithSeededBuild({ exitCode, output }) {
  const problems = [];
  if (exitCode === 0) {
    problems.push(
      "the production build SUCCEEDED with a client component reaching " +
        `${PROTECTED_ROOT}. Next's server-only boundary is not being enforced.`,
    );
  }

  const blocks = splitErrorBlocks(output);
  const rootBlocks = blocks.filter((block) => block.file === PROTECTED_ROOT);
  if (rootBlocks.length === 0) {
    problems.push(
      `no Turbopack error was attributed to ${PROTECTED_ROOT}. The build may ` +
        "have failed for an unrelated reason, which is not proof of anything.",
    );
    return problems;
  }

  const withMessage = rootBlocks.filter((block) =>
    block.lines.some((line) => line.includes(BOUNDARY_MESSAGE)),
  );
  if (withMessage.length === 0) {
    problems.push(
      `${PROTECTED_ROOT} was reported, but not with the server-only boundary ` +
        `message. Expected a line containing: ${BOUNDARY_MESSAGE}`,
    );
  }

  const attributed = withMessage.some((block) => {
    const browserTrace = block.lines.some(
      (line) => line.trim() === `${PROTECTED_ROOT} ${BROWSER_LAYER}`,
    );
    const namesFixture = block.lines.some(
      (line) => line.trim() === `${FIXTURE_PAGE} ${BROWSER_LAYER}`,
    );
    return browserTrace && namesFixture;
  });
  if (withMessage.length > 0 && !attributed) {
    problems.push(
      "the server-only error carries no browser-layer import trace running " +
        `from ${PROTECTED_ROOT} back to ${FIXTURE_PAGE}, so the failure is ` +
        "not attributable to the planted violation.",
    );
  }

  return problems;
}

const BRIDGE_SOURCE = `// Planted by scripts/ci/server-only-boundary-selftest.mjs. Delete it.
//
// No "use client" of its own: the transitive shape is the point. The page below
// is the client module, this is an ordinary module it imports, and the server
// root is one hop further on — which is exactly the chain a single-file lint
// rule cannot see.
import { auth } from "@/lib/auth";

export const seededBoundaryProbe = typeof auth;
`;

const PAGE_SOURCE = `// Planted by scripts/ci/server-only-boundary-selftest.mjs. Delete it.
"use client";

import { seededBoundaryProbe } from "./bridge";

export default function SeededServerOnlyBoundaryViolation() {
  return <div>{seededBoundaryProbe}</div>;
}
`;

function plantFixture(root) {
  const directory = path.join(root, FIXTURE_DIR);
  if (existsSync(directory)) {
    throw new Error(
      `${FIXTURE_DIR} already exists. A previous run was interrupted; delete ` +
        "it and try again rather than building against a fixture nobody wrote.",
    );
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "bridge.ts"), BRIDGE_SOURCE, "utf8");
  writeFileSync(path.join(directory, "page.tsx"), PAGE_SOURCE, "utf8");
  return directory;
}

function runSeededBuild(root) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules", "next", "dist", "bin", "next"),
      "build",
      "--debug-build-paths",
      `app/${FIXTURE_SEGMENT}/page.tsx`,
    ],
    { cwd: root, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function main() {
  const directory = plantFixture(REPO_ROOT);
  let build;
  try {
    build = runSeededBuild(REPO_ROOT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const problems = problemsWithSeededBuild(build);
  if (problems.length === 0) {
    console.log(
      "ok: the production build refused a client component reaching " +
        `${PROTECTED_ROOT}, and said so for the right reason.`,
    );
    return;
  }

  console.error(
    "FAIL: the seeded server-only violation did not produce the expected " +
      "build failure.\n",
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\n--- build output ---\n");
  console.error(stripAnsi(build.output));
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
