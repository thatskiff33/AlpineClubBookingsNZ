import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * AN OPERATOR SCRIPT MAY REACH A `server-only` MODULE ONLY IF EVERY PUBLISHED
 * WAY OF RUNNING IT PASSES `--conditions=react-server`
 * (CT-5, #2869; epic #2988; premise inverted by #2850).
 *
 * ## What changed, and why the old rule had to go
 *
 * `server-only` throws on import under anything but the `react-server`
 * condition:
 *
 *     npx tsx -e "import('./src/lib/prisma.ts')"
 *     -> This module cannot be imported from a Client Component module.
 *
 * A `tsx` operator script is not a client component and `server-only` cannot
 * tell the two apart, so the throw lands at IMPORT time — before the script
 * prints anything, before it parses its arguments, and with an error message
 * about React that names nothing the operator did.
 *
 * This census used to answer that by forbidding the reach outright, which had
 * a price nobody had priced: `@/lib/prisma`, `@/lib/audit`, `@/lib/email`,
 * `@/lib/xero` and `@/lib/stripe` could not carry `import "server-only"`, so
 * the one boundary check that is NOT our own regular expression — the
 * production build — did not cover the database client. #2850 closed that by
 * paying for it properly: `server-only`'s own `exports` map resolves the
 * `react-server` condition to an EMPTY module, so
 *
 *     npx tsx --conditions=react-server -e "import('./src/lib/prisma.ts')"
 *
 * loads cleanly, and every operator command that reaches one of those modules
 * now carries that flag. Measured on this tree when the change landed: 14 of
 * 33 CLI roots reach `server-only`, all 14 through `@/lib/prisma`, and each was
 * started under the flag far enough to reach its first real work.
 *
 * ## What this census enforces now
 *
 * The hazard did not disappear; it moved. It is no longer "a script reaches a
 * marked module" but "a script reaches a marked module and is published
 * WITHOUT the flag" — a runbook line an operator copies during an incident, a
 * seed step in a shell script, a workflow step. That is the exact shape that
 * killed the required `E2E multi-lodge` check on #3056, where a `server-only`
 * edge added for a route's benefit reached a seed nobody had thought about.
 *
 * So this walks the import graph from every CLI root, and separately sweeps
 * every place in the repository where a `tsx` entrypoint is NAMED — package
 * scripts, `prisma.config.ts`, shell scripts, workflows, the documentation
 * an operator copies from, and (since #2850) the scripts' own sources, where
 * the `--help` text and the shebang publish a command too. A root that reaches
 * `server-only` must ask for the `react-server` condition at EVERY one of
 * those sites, or be published as an `npm run` script that carries it. The
 * repository
 * publishes one spelling, `--conditions=react-server`, because one form is
 * greppable — but the check accepts Node's space form and comma lists too,
 * since refusing a command that is genuinely safe would be a false positive in
 * the one place people go to find out what is really broken.
 *
 * `next/headers` is judged by the OLD, absolute rule and the condition does not
 * excuse it. Measured: `next/headers` imports fine under `tsx` either way, so
 * the sentence this file used to carry — "it throws outside a request the same
 * way" — was wrong about the mechanism. It throws when one of its functions is
 * CALLED outside a request, which no resolution condition can repair, so a CLI
 * root reaching it is a defect however the CLI is started.
 *
 * ## Static AND dynamic edges, which is also new
 *
 * The old census counted static edges only, on the grounds that a lazy
 * `await import(…)` never runs at module load and so cannot break a CLI's
 * startup. That reasoning held while the rule was "remove the edge", where a
 * false positive cost a refactor. It does not hold now: the remedy is a flag
 * that is free to add and safe everywhere, so the cheap and honest choice is to
 * count every edge and be sound. It is not hypothetical either —
 * `scripts/induction-baseline.ts` reaches `@/lib/prisma` through
 * `await import("../src/lib/prisma")` and nothing else, so under the old rule
 * this census could not see the one CLI that would have failed at its first
 * write rather than at startup. Counting dynamic edges found it, and
 * `prisma/seed.ts`, and nothing else;
 * `client-server-boundary-census.test.ts` has always counted them.
 */

const REPO_ROOT = path.resolve(process.cwd());
const SRC = path.join(REPO_ROOT, "src");
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * Every entrypoint a person runs directly under `tsx`. Directories rather than
 * a hand-list, so a new script joins the census by existing.
 *
 * `e2e/setup` was NOT here when this census was written, and that omission cost
 * a full CI cycle on #3056: `scripts/e2e-stack.sh` runs
 * `npx tsx e2e/setup/seed-second-lodge.ts`, a shared `src/lib` module on its
 * graph gained a `club-time/server` import, and `E2E multi-lodge` died at that
 * import with the bare `server-only` throw — while this census, whose entire
 * job is to prevent exactly that, stayed green because it was not looking.
 *
 * The lesson is the list, not the entry. A directory here is only as good as
 * whoever remembered to add it, so `covers every tsx invocation in the
 * repository` below derives the answer from the invocation sweep instead, and
 * fails when a `tsx` entrypoint is published that no root covers.
 */
const CLI_ROOT_DIRECTORIES = ["scripts", "e2e/tools", "e2e/setup"] as const;
/** Seed entrypoints, which `prisma db seed` also runs under `tsx`. */
const CLI_ROOT_FILES = ["prisma/seed.ts", "prisma/demo-seed.ts"] as const;

/**
 * Reaching this is fine PROVIDED every published invocation passes
 * `--conditions=react-server`, under which it resolves to an empty module.
 */
const CONDITION_EXCUSED_SPECIFIERS = new Set(["server-only"]);

/**
 * Reaching this is a defect whatever the invocation does. `next/headers`
 * resolves and imports happily under plain Node; it throws when `headers()` or
 * `cookies()` is called outside a request, which is a request-scoped API in a
 * batch script and not something a resolution condition can repair.
 */
const ALWAYS_FORBIDDEN_SPECIFIERS = new Set(["next/headers"]);

/** The one spelling of the flag this repository publishes. */
const REACT_SERVER_CONDITION = "--conditions=react-server";

/**
 * Runtime module specifiers, static and dynamic.
 *
 * `import type` / `export type` are erased before anything executes. The
 * negative lookahead is `type[\s{]` rather than `type\s` because TypeScript
 * accepts `import type{ Session } from …` with no space — the same spelling
 * `client-server-boundary-census.test.ts` and the matching Semgrep rule use.
 */
const STATIC_IMPORT =
  /^[ \t]*(?:import|export)\s+(?!type[\s{])(?:[^;'"]*?\bfrom\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /(?:\bimport|\brequire)\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * The `tsx` binary, and NOTHING ELSE — the arguments are read from the text
 * after it rather than captured here, and that is the whole point.
 *
 * An earlier version encoded the flag shape in the regex, and
 * `tsx --conditions react-server foo.ts` (the space spelling, equally safe)
 * then matched NOTHING and vanished from the census instead of being judged.
 * The version after that captured `((?:[ \t]+\S+)+)` — every argument to the
 * end of the line — which was greedy: the FIRST `tsx` on a line swallowed a
 * SECOND one, `matchAll` resumed past it, and only the first command was ever
 * judged. Measured: appending `; npx tsx scripts/xero-booking-repair.ts` to the
 * seed line in `scripts/e2e-stack.sh` — a swept file — left this census green,
 * an unflagged publication of the money-repair CLI that reaches `@/lib/prisma`,
 * `@/lib/audit`, `@/lib/email`, `@/lib/stripe` and `@/lib/xero`.
 *
 * Matching the binary alone fixes that by construction: every occurrence gets
 * its own scan, so two commands on one line are two invocations with two
 * independent answers about the flag. A sweep that silently drops the
 * invocation it cannot parse is worse than no sweep, because it reads as a
 * pass.
 *
 * The lookbehind lets `./node_modules/.bin/tsx scripts/x.ts` match — the
 * induction runbook's spelling, which runs inside the Compose `migrate` service
 * where the npm wrapper is not the published form — while excluding a filename
 * that merely ends in `.tsx`, and excluding `--loader:.tsx=tsx`, where the
 * esbuild transpile script names the loader rather than the runner. The
 * lookahead requires whitespace after the binary, which is what makes it a
 * COMMAND WORD rather than a substring: without it the scan below latched onto
 * `['tsx','ts']` in a docblock and reported the next file named after it.
 */
const TSX_BINARY = /(?<![\w.=:-])tsx(?=[ \t])/g;

/**
 * Where one command ends and the next begins.
 *
 * Splitting on these before matching is belt to the lookahead's braces: it
 * stops one command's argument scan running on into the next command's tokens,
 * which would let `tsx --conditions=react-server && npx tsx seed.ts` read the
 * FIRST command's flag as excusing the second. Newlines are here for the same
 * reason, and a Markdown table's `|` cell separator happens to fall out of it.
 */
const COMMAND_SEPARATOR = /\r?\n|&&|\|\||;|\|/;

/**
 * The quoting a token arrives wrapped in, which is not part of the argument.
 *
 * `package.json` is the case that matters and the one a probe caught: an npm
 * script's last token arrives as `scripts/xero-booking-repair.ts",` — trailing
 * quote and comma — so without this the sweep saw NO invocation in
 * `package.json` at all, and a script that had lost its flag passed. Markdown
 * back-ticks and a trailing `;` or `)` in prose do the same thing.
 */
const TOKEN_EDGE_PUNCTUATION = /^[`"'(]+|[`"',;)]+$/g;

/** A token that names a file `tsx` could execute. */
const TSX_ENTRYPOINT_TOKEN = /^[\w./-]+\.[cm]?tsx?$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walk(full, out);
    } else if (EXTENSIONS.includes(path.extname(name))) {
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) continue;
      out.push(full);
    }
  }
  return out;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

const specifierCache = new Map<string, string[]>();
function specifiersOf(file: string): string[] {
  const cached = specifierCache.get(file);
  if (cached) return cached;
  const text = readFileSync(file, "utf8");
  const value = [
    ...[...text.matchAll(STATIC_IMPORT)].map((match) => match[1]),
    ...[...text.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]),
  ];
  specifierCache.set(file, value);
  return value;
}

/** Resolve a specifier to a file inside this repository, or `null`. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }
  for (const extension of ["", ...EXTENSIONS]) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.join(base, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Breadth-first, so the reported path is the shortest one that exists. */
function findReach(entry: string, targets: Set<string>): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: Array<{ file: string; trail: string[] }> = [
    { file: entry, trail: [entry] },
  ];
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    for (const specifier of specifiersOf(file)) {
      if (targets.has(specifier)) return [...trail, specifier];
      const next = resolveSpecifier(file, specifier);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push({ file: next, trail: [...trail, next] });
      }
    }
  }
  return null;
}

function describeTrail(trail: string[]): string {
  return trail
    .map((step) => (step.startsWith(REPO_ROOT) ? relative(step) : step))
    .join("\n    -> ");
}

/** Files under one directory with one extension, recursively. */
function filesUnder(directory: string, extension: string): string[] {
  const absolute = path.join(REPO_ROOT, directory);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        visit(full);
      } else if (entry.name.endsWith(extension)) {
        out.push(full);
      }
    }
  };
  visit(absolute);
  return out.sort();
}

/** Files directly inside one directory, by extension. */
function filesIn(directory: string, extension: string): string[] {
  const absolute = path.join(REPO_ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(absolute, entry.name))
    .sort();
}

/** Files anywhere under one directory whose NAME matches, recursively. */
function filesNamed(directory: string, pattern: RegExp): string[] {
  const absolute = path.join(REPO_ROOT, directory);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        visit(full);
      } else if (pattern.test(entry.name)) {
        out.push(full);
      }
    }
  };
  visit(absolute);
  return out.sort();
}

/**
 * A container definition. Both kinds run commands, and a `tsx` line in one is
 * as published as a line in a shell script: `docker-compose.yml` is what a new
 * contributor brings the stack up with, and the Compose `migrate` service is
 * where the induction runbook's own commands are executed.
 */
const CONTAINER_FILE = /^(Dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml)$/;

/**
 * A Vitest file, which is not a published command.
 *
 * This census's own fixtures spell out the raw `npx tsx …` form on purpose —
 * proving the extractor still sees it is the point of them — so sweeping test
 * files would make the census fail on its own evidence. `walk()` above excludes
 * them from the CLI roots for the same reason.
 */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function cliRoots(): string[] {
  const roots: string[] = [];
  for (const directory of CLI_ROOT_DIRECTORIES) {
    const absolute = path.join(REPO_ROOT, directory);
    if (existsSync(absolute)) roots.push(...walk(absolute));
  }
  for (const file of CLI_ROOT_FILES) {
    const absolute = path.join(REPO_ROOT, file);
    if (existsSync(absolute)) roots.push(absolute);
  }
  return roots
    .filter((file) => file.endsWith(".ts") || file.endsWith(".mts"))
    .sort();
}

const CLI_ROOTS = cliRoots();

/**
 * Every file in this repository that NAMES a `tsx` entrypoint: the npm scripts
 * and the Prisma seed hook an operator runs, the shell scripts and workflows CI
 * runs, and the documentation an operator copies a command out of. The last of
 * those is the reason the sweep exists at all — the acceptance bar for #2850
 * was that a runbook line copied during a money-repair incident must work.
 *
 * `measurement/**` is swept for its shell runners even though it is
 * deliberately outside CI: it seeds a real database the same way `scripts/`
 * does, so a broken command there costs the same diagnosis.
 *
 * **The CLI roots themselves are swept too, and that half is new (#2850).** A
 * script publishes commands in its own source: the `--help` text it prints at
 * runtime, and the worked examples in its docblock. Those are the lines an
 * operator reads FIRST — `--help` is what you run when you have forgotten the
 * flags mid-incident — and they were the last place still handing out the bare
 * form after every runbook, npm script and workflow around them had been
 * corrected. Measured on this tree: `npx tsx scripts/xero-booking-repair.ts`,
 * printed by that money-repair script's own usage text, died at import with the
 * React "Client Component" throw. A script that publishes a command it cannot
 * survive is worse than one that publishes none, because the operator has no
 * reason to doubt it.
 */
function invocationSources(): string[] {
  return [
    ...CLI_ROOTS,
    ...filesUnder("scripts", ".sh"),
    ...filesUnder("measurement", ".sh"),
    // `.mjs`, which publishes commands exactly as a shell script does and was
    // NOT swept until #3186. The proof it needed to be: this pull request
    // hand-corrected `npx tsx prisma/seed.ts` to the flagged form in
    // `measurement/phase2/bin/self-test.mjs`, and a reviewer put that one line
    // back with the census staying green.
    ...filesUnder("scripts", ".mjs").filter((file) => !TEST_FILE.test(file)),
    ...filesUnder("measurement", ".mjs").filter((file) => !TEST_FILE.test(file)),
    // Recursively, and both spellings of the extension. The workflows are flat
    // and all `.yml` today; a composite action lives under `.github/actions`,
    // and a `.yaml` file or a nested directory would otherwise join the tree
    // unswept and nobody would notice, which is how `e2e/setup` was missed.
    ...filesUnder(".github/workflows", ".yml"),
    ...filesUnder(".github/workflows", ".yaml"),
    ...filesUnder(".github/actions", ".yml"),
    ...filesUnder(".github/actions", ".yaml"),
    ...filesNamed(".", CONTAINER_FILE),
    ...filesNamed("measurement", CONTAINER_FILE),
    ...filesIn(".", ".md"),
    ...filesIn(".github", ".md"),
    ...filesUnder("docs", ".md"),
    // Changelog fragments are read by operators at release time and describe
    // the commands a release changed, so a raw one here is a published raw one.
    ...filesUnder("changelog.d", ".md"),
    path.join(REPO_ROOT, "package.json"),
    path.join(REPO_ROOT, "prisma.config.ts"),
  ].filter((file) => existsSync(file));
}

type Invocation = {
  /** Repo-relative file the command was found in. */
  source: string;
  /** Repo-relative entrypoint, as written. */
  entry: string;
  /** Whether the flag sits between `tsx` and the entrypoint. */
  hasCondition: boolean;
};

/**
 * Does this argument list ask Node for the `react-server` condition?
 *
 * Both spellings count, because both are safe: Node accepts
 * `--conditions=react-server` and `--conditions react-server`, and a
 * comma-separated list containing it. The repository PUBLISHES the `=` form —
 * one spelling is greppable — but refusing a correct command would be a false
 * positive, and this census is the thing people trust to tell them what is
 * really broken.
 */
function tokensRequestReactServer(tokens: string[]): boolean {
  return tokens.some((token, index) => {
    const value = token.startsWith("--conditions=")
      ? token.slice("--conditions=".length)
      : token === "--conditions"
        ? (tokens[index + 1] ?? "")
        : null;
    return value !== null && value.split(",").includes("react-server");
  });
}

/**
 * Every `tsx` command named in one file's text.
 *
 * Split out from the sweep so a test can drive it over a synthetic source
 * directly. The extractor is the half that goes quietly blind — it already did
 * once, on `package.json`'s JSON quoting — and a sweep that finds nothing reads
 * exactly like a sweep that finds nothing wrong.
 */
function extractInvocations(source: string, raw: string): Invocation[] {
  const found: Invocation[] = [];
  // Join shell line continuations first, so a command wrapped across lines is
  // read as the one command it is rather than losing its entrypoint. Then split
  // into one segment per command, so no scan can run past a separator.
  const text = raw.replace(/\\\r?\n[ \t]*/g, " ");
  for (const segment of text.split(COMMAND_SEPARATOR)) {
    // Every occurrence of the binary, each scanned independently from where it
    // sits. Two `tsx` commands in one segment are two invocations; the greedy
    // single-capture version this replaced reported only the first.
    for (const match of segment.matchAll(TSX_BINARY)) {
      const tokens = segment
        .slice(match.index + match[0].length)
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(TOKEN_EDGE_PUNCTUATION, ""))
        .filter((token) => token.length > 0);
      const entryIndex = tokens.findIndex((token) =>
        TSX_ENTRYPOINT_TOKEN.test(token),
      );
      // No file argument at all: prose about `tsx`, or a flag-only command.
      // Nothing to judge, and nothing this census can say about it.
      if (entryIndex === -1) continue;
      found.push({
        source,
        entry: tokens[entryIndex].replace(/^\.\//, ""),
        hasCondition: tokensRequestReactServer(tokens.slice(0, entryIndex)),
      });
    }
  }
  return found;
}

function sweepInvocations(): Invocation[] {
  return invocationSources().flatMap((file) =>
    extractInvocations(relative(file), readFileSync(file, "utf8")),
  );
}

const INVOCATIONS = sweepInvocations();

/**
 * The shebang line, if the file opens with one.
 *
 * A shebang is a published invocation like any other — it is this file's own
 * answer to "how do I run me?" — but `sweepInvocations` cannot see it, because
 * `#!/usr/bin/env npx tsx` names no entrypoint argument: the entrypoint is the
 * file the line sits in. So it is judged separately, below.
 */
function shebangOf(file: string): string | null {
  const [first = ""] = readFileSync(file, "utf8").split(/\r?\n/, 1);
  return first.startsWith("#!") ? first : null;
}

/** Does this shebang name `tsx` as the runner (`env tsx`, `env npx tsx`, …)? */
function shebangRunsTsx(shebang: string): boolean {
  return shebang
    .trim()
    .split(/\s+/)
    .some((token) => token === "tsx" || token.endsWith("/tsx"));
}

/** The roots whose graph reaches `server-only`, by any edge. */
const ROOTS_REACHING_SERVER_ONLY = new Map<string, string[]>(
  CLI_ROOTS.map(
    (entry) =>
      [
        relative(entry),
        findReach(entry, CONDITION_EXCUSED_SPECIFIERS),
      ] as const,
  ).filter((pair): pair is [string, string[]] => pair[1] !== null),
);

describe("CLI entrypoints and the `server-only` boundary", () => {
  it("found the entrypoints, so an empty census is not a silent pass", () => {
    // A moved directory or a changed extension filter would otherwise make this
    // whole file pass by checking nothing at all.
    expect(CLI_ROOTS.length).toBeGreaterThan(20);
  });

  it("found the places a tsx entrypoint is published", () => {
    // The same non-vacuity floor for the other half of the join: if the sweep
    // stops finding commands, "every command carries the flag" is trivially
    // true and this file protects nothing.
    expect(INVOCATIONS.length).toBeGreaterThan(10);
    expect(INVOCATIONS.some((invocation) => invocation.hasCondition)).toBe(true);
    // Per KIND of source, because a sweep can go blind to one and stay green on
    // the others. It did: `package.json` hands every argument back with its
    // JSON quoting attached, so before `TOKEN_EDGE_PUNCTUATION` the npm scripts
    // — the commands this whole change publishes — contributed nothing and a
    // script stripped of its flag passed.
    // No `.yml` here: every workflow runs its tooling through `npm run`, so
    // there is genuinely no direct `tsx` line in one today. Same for the
    // container definitions and the changelog fragments. They are all still
    // swept, so the day one appears it is judged like any other.
    //
    // `.mjs` IS here (#3186). It is the class this sweep was blind to while a
    // hand-corrected line in `measurement/phase2/bin/self-test.mjs` was the
    // only thing keeping a raw seed command out of the tree, and a reviewer
    // reverted that line with this census staying green.
    for (const suffix of [
      "package.json",
      "prisma.config.ts",
      ".sh",
      ".md",
      ".mjs",
    ]) {
      expect(
        INVOCATIONS.filter((invocation) => invocation.source.endsWith(suffix)),
        `the sweep found no tsx invocation in any \`${suffix}\` file, so that ` +
          "whole class of published command is invisible to this census",
      ).not.toEqual([]);
    }
  });

  it("has roots that DO reach `server-only`, which is what the flag is for", () => {
    // If this ever drops to zero the marker has come off the protected modules
    // and the rule below is checking nothing. It is the inverse of the
    // assertion this census used to make, and it is the load-bearing one now.
    expect(ROOTS_REACHING_SERVER_ONLY.size).toBeGreaterThan(0);
  });

  it("has no static or dynamic path from any of them to `next/headers`", () => {
    // Absolute, and NOT excused by `--conditions=react-server`: this one
    // resolves fine and throws when called, so no invocation flag repairs it.
    const violations: string[] = [];
    for (const entry of CLI_ROOTS) {
      const trail = findReach(entry, ALWAYS_FORBIDDEN_SPECIFIERS);
      if (trail !== null) violations.push(describeTrail(trail));
    }

    expect(
      violations,
      "An operator script reaches `next/headers`, whose `headers()` and " +
        "`cookies()` throw outside a request. `--conditions=react-server` " +
        "does not excuse this one — move the request-scoped read behind the " +
        "caller that has a request (CT-5, #2869).\n\n" +
        violations.join("\n\n"),
    ).toEqual([]);
  });

  it("publishes every `server-only`-reaching command with the condition", () => {
    const violations: string[] = [];
    for (const invocation of INVOCATIONS) {
      const trail = ROOTS_REACHING_SERVER_ONLY.get(invocation.entry);
      if (trail === undefined || invocation.hasCondition) continue;
      violations.push(
        `${invocation.source}: tsx ${invocation.entry}\n    ${describeTrail(trail)}`,
      );
    }

    expect(
      violations,
      "An operator command reaches a `server-only` module but is published " +
        `without \`${REACT_SERVER_CONDITION}\`, so it THROWS the moment it ` +
        "starts — before it prints anything, with an error about React Server " +
        "Components that names nothing the operator did. Add the flag between " +
        "`tsx` and the entrypoint, or publish the command as an `npm run` " +
        "script that carries it (CT-5, #2869; #2850).\n\n" +
        violations.join("\n\n"),
    ).toEqual([]);
  });

  it("carries no `tsx` shebang a `server-only`-reaching root cannot survive", () => {
    // The shebang is the one published invocation the sweep above structurally
    // cannot see, because it names no entrypoint argument — and it is the most
    // authoritative-looking of the lot, sitting on line 1 of the file it runs.
    // Every one of these scripts is mode 644, so the line was never executable
    // in the first place; it was pure instruction, and the instruction was to
    // run a command that aborts at import. The remedy chosen here is to DELETE
    // it and let the `npm run` script be the single published form, but a
    // shebang that genuinely carries the condition is safe and passes.
    const violations: string[] = [];
    for (const entry of ROOTS_REACHING_SERVER_ONLY.keys()) {
      const shebang = shebangOf(path.join(REPO_ROOT, entry));
      if (shebang === null || !shebangRunsTsx(shebang)) continue;
      if (tokensRequestReactServer(shebang.trim().split(/\s+/))) continue;
      violations.push(`${entry}: ${shebang}`);
    }

    expect(
      violations,
      "A CLI root that reaches a `server-only` module opens with a `tsx` " +
        `shebang that does not ask for \`${REACT_SERVER_CONDITION}\`, so the ` +
        "command its own first line publishes throws at import. Delete the " +
        "shebang and publish the `npm run` script instead, or spell it " +
        "`#!/usr/bin/env -S npx tsx --conditions=react-server` (#2850).\n\n" +
        violations.join("\n"),
    ).toEqual([]);
  });

  it("sweeps the CLI scripts' own sources, where the usage text lives", () => {
    // Structural non-vacuity for the half added by #2850. `extractInvocations`
    // can be proved to work (below) and the rule above can be proved to judge
    // what it is handed, and BOTH stay green if the roots quietly drop out of
    // `invocationSources()` — the sweep would simply never look at a `--help`
    // string again. So assert the join explicitly.
    const swept = new Set(invocationSources().map(relative));
    const unswept = [...ROOTS_REACHING_SERVER_ONLY.keys()]
      .filter((entry) => !swept.has(entry))
      .sort();

    expect(
      unswept,
      "A CLI root that reaches a `server-only` module is not itself in the " +
        "invocation sweep, so nothing reads the commands it prints in its own " +
        "`--help` text and docblock (#2850).\n\n" +
        unswept.join("\n"),
    ).toEqual([]);
  });

  it("would see a raw invocation printed in a script's own usage text", () => {
    // The mutation this guard exists to catch, run as a fixture rather than
    // left to whoever remembers to re-introduce it by hand: the exact shape
    // `scripts/xero-booking-repair.ts` used to print from `printUsage()`.
    const usageText = [
      "function printUsage() {",
      "  console.log(`Usage:",
      "  npx tsx scripts/xero-booking-repair.ts --apply",
      "`);",
      "}",
    ].join("\n");

    expect(extractInvocations("scripts/synthetic.ts", usageText)).toEqual([
      {
        source: "scripts/synthetic.ts",
        entry: "scripts/xero-booking-repair.ts",
        hasCondition: false,
      },
    ]);
    // …and that entrypoint really is one the rule above judges, so the fixture
    // is not describing a violation the census would shrug at.
    expect(ROOTS_REACHING_SERVER_ONLY.has("scripts/xero-booking-repair.ts")).toBe(
      true,
    );
    // The npm-script form this repository publishes instead names no `tsx`
    // entrypoint at all, so it is invisible to the sweep — which is the point.
    expect(
      extractInvocations(
        "scripts/synthetic.ts",
        "  npm run xero:booking-repair -- --apply",
      ),
    ).toEqual([]);
  });

  it("judges every `tsx` command on a line, not just the first", () => {
    // The blind spot #3186 closed, kept as a fixture because it reads as a
    // pass: the pattern used to capture every argument to the end of the line,
    // so the FIRST command swallowed the second and `matchAll` resumed past it.
    // Measured on the real tree — appending this exact command to the seed line
    // in `scripts/e2e-stack.sh` left the census green, publishing the
    // money-repair CLI without the flag.
    expect(
      extractInvocations(
        "scripts/synthetic.sh",
        "npx tsx --conditions=react-server prisma/seed.ts; " +
          "npx tsx scripts/xero-booking-repair.ts",
      ),
    ).toEqual([
      {
        source: "scripts/synthetic.sh",
        entry: "prisma/seed.ts",
        hasCondition: true,
      },
      {
        source: "scripts/synthetic.sh",
        entry: "scripts/xero-booking-repair.ts",
        hasCondition: false,
      },
    ]);

    // Every separator, and the ordinary prose case with no separator at all.
    for (const joiner of [" && ", " || ", " | ", "; ", " or "]) {
      const both = extractInvocations(
        "scripts/synthetic.sh",
        `npx tsx --conditions=react-server prisma/seed.ts${joiner}npx tsx scripts/xero-booking-repair.ts`,
      );
      expect(both.map((invocation) => invocation.hasCondition), joiner).toEqual([
        true,
        false,
      ]);
    }

    // And the flag on the FIRST command must not excuse a second that lacks
    // one, which is the failure mode a single greedy match produced.
    expect(
      extractInvocations(
        "scripts/synthetic.sh",
        "npx tsx --conditions=react-server && npx tsx prisma/seed.ts",
      ),
    ).toEqual([
      {
        source: "scripts/synthetic.sh",
        entry: "prisma/seed.ts",
        hasCondition: false,
      },
    ]);
  });

  it("does not read a word ending in `tsx` as the runner", () => {
    // The false positive the whitespace lookahead exists to stop, found while
    // making the scan per-occurrence: `scripts/lib/file-size-budget.ts` has a
    // docblock listing esbuild loader names, and without the lookahead the scan
    // started at `tsx` inside that list and reported the next file named on the
    // line as though somebody had published a command to run it.
    expect(
      extractInvocations(
        "scripts/synthetic.ts",
        "// `['tsx','ts','jsx','js']` and `next.config.ts` override nothing",
      ),
    ).toEqual([]);
    // The two spellings that must keep matching, either side of that.
    expect(
      extractInvocations(
        "docs/synthetic.md",
        "./node_modules/.bin/tsx --conditions=react-server scripts/induction-baseline.ts",
      ),
    ).toEqual([
      {
        source: "docs/synthetic.md",
        entry: "scripts/induction-baseline.ts",
        hasCondition: true,
      },
    ]);
    // The esbuild loader argument names the loader, not the runner.
    expect(
      extractInvocations(
        "scripts/synthetic.ts",
        "npx -y esbuild vendor/generate.tsx --loader:.tsx=tsx --outfile=out.mjs",
      ),
    ).toEqual([]);
  });

  it("would see the edge if one were added", () => {
    // The census is only worth its runtime if it can actually find a path, so
    // this drives the same search over a synthetic root: `club-time/server`
    // carries `import "server-only"`. Proving the search WORKS is what stops a
    // silent all-clean.
    const serverBinding = path.join(SRC, "lib", "club-time", "server.ts");
    expect(existsSync(serverBinding)).toBe(true);
    expect(findReach(serverBinding, CONDITION_EXCUSED_SPECIFIERS)).toEqual([
      serverBinding,
      "server-only",
    ]);
  });

  it("covers every tsx invocation in the repository", () => {
    // The root list above is only as good as whoever remembered to add a
    // directory to it, and on #3056 nobody had: `e2e/setup` was missing, the
    // multi-lodge E2E seed died on the `server-only` throw, and this census
    // stayed green throughout. So the roots are no longer trusted on their own
    // — an entrypoint that is published somewhere but covered by no root has
    // nothing judging whether it needs the flag.
    const covered = new Set(CLI_ROOTS.map(relative));
    const uncovered = [
      ...new Set(INVOCATIONS.map((invocation) => invocation.entry)),
    ]
      .filter((entry) => !covered.has(entry))
      .filter((entry) => existsSync(path.join(REPO_ROOT, entry)))
      .sort();

    expect(
      uncovered,
      [
        "A `tsx` entrypoint is published somewhere in this repository that no",
        "CLI root covers, so nothing checks whether it reaches a `server-only`",
        "module. Add its directory to CLI_ROOT_DIRECTORIES (or the file to",
        "CLI_ROOT_FILES) and re-run.",
      ].join(" "),
    ).toEqual([]);
  });
});
