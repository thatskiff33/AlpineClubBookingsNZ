import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * NO OPERATOR SCRIPT MAY STATICALLY REACH A `server-only` MODULE
 * (CT-5, #2869; epic #2988).
 *
 * ## The failure this prevents, measured
 *
 * `server-only` throws on import under anything but the `react-server`
 * condition:
 *
 *     npx tsx -e "import('./src/lib/club-time/server.ts')"
 *     -> This module cannot be imported from a Client Component module.
 *
 * A `tsx` operator script is not a client component and `server-only` cannot
 * tell the two apart, so the throw lands at IMPORT time — before the script
 * prints anything, before it parses its arguments, and with an error message
 * about React that names nothing the operator did. `npm run
 * finance:backfill-monthly-facts`, `npm run xero:booking-repair` and
 * `npm run config:self-heal` all traverse modules that a route also uses, so an
 * edge added for a route's benefit breaks a CLI that no route test covers.
 *
 * That is exactly why `club-time-zone-runtime.ts` exists rather than the CLI
 * modules importing CT-1's `server-only` reader, and this census is what keeps
 * that decision from being quietly undone.
 *
 * ## Why a census and not a recommendation
 *
 * The first attempt at this guard was DELETED during CT-5 on the grounds that a
 * regex census over-reports on `import type`, and replaced with a note asking
 * future authors to be careful. A deleted guard plus a recommendation is
 * strictly weaker than a guard that works, and the premise was wrong twice
 * over: `client-server-boundary-census.test.ts` and
 * `.semgrep/rules/acb-client-server-boundary.yml` both already exclude
 * `import type` with the same `(?!type[\s{])` lookahead, and the real
 * over-report source is a LAZY DYNAMIC IMPORT — `await import("…")` inside a
 * function, as `module-settings.ts` writes — which never runs at module load
 * and therefore cannot break a CLI's startup.
 *
 * So this counts STATIC edges only. Measured on this tree: 0 violations across
 * every CLI root, which agrees exactly with running each entrypoint under
 * `tsx`; three separately-introduced `-> club-time/server` edges were each
 * caught with the shortest path printed; and a script importing neither is
 * correctly clean.
 *
 * ## Its blind spot, stated
 *
 * A script that reaches a `server-only` module only through a LAZY dynamic
 * import still slips through — and at runtime, if that code path is taken, it
 * will throw. That is deliberate: counting dynamic edges would report the many
 * legitimate lazy imports in this tree and the guard would be turned off within
 * a week. A guard that catches the class that actually breaks CLIs, and says so,
 * beats one nobody trusts.
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
 * repository` below derives the answer from the shell scripts and package
 * scripts instead, and fails when a `tsx` entrypoint exists that no root
 * covers.
 */
const CLI_ROOT_DIRECTORIES = ["scripts", "e2e/tools", "e2e/setup"] as const;
/** Seed entrypoints, which `prisma db seed` also runs under `tsx`. */
const CLI_ROOT_FILES = ["prisma/seed.ts", "prisma/demo-seed.ts"] as const;

/**
 * The marker itself. `next/headers` is included because it throws outside a
 * request the same way, for the same kind of reason.
 */
const FORBIDDEN_SPECIFIERS = new Set(["server-only", "next/headers"]);

/**
 * Runtime module specifiers only, and STATIC ones only.
 *
 * `import type` / `export type` are erased before anything executes. The
 * negative lookahead is `type[\s{]` rather than `type\s` because TypeScript
 * accepts `import type{ Session } from …` with no space — the same spelling
 * `client-server-boundary-census.test.ts` and the matching Semgrep rule use.
 *
 * `await import(…)` is deliberately absent: a lazy import does not run at module
 * load, so it cannot break a CLI's startup, and counting it is what made an
 * earlier attempt at this guard over-report.
 */
const STATIC_IMPORT =
  /^[ \t]*(?:import|export)\s+(?!type[\s{])(?:[^;'"]*?\bfrom\s+)?["']([^"']+)["']/gm;

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
  const value = [...readFileSync(file, "utf8").matchAll(STATIC_IMPORT)].map(
    (match) => match[1],
  );
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
function findServerOnlyReach(entry: string): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: Array<{ file: string; trail: string[] }> = [
    { file: entry, trail: [entry] },
  ];
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    for (const specifier of specifiersOf(file)) {
      if (FORBIDDEN_SPECIFIERS.has(specifier)) return [...trail, specifier];
      const next = resolveSpecifier(file, specifier);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push({ file: next, trail: [...trail, next] });
      }
    }
  }
  return null;
}

/**
 * Files directly inside one directory, by extension. Shallow on purpose: the
 * places a `tsx` entrypoint is NAMED are flat (shell scripts, workflow files),
 * and a recursive walk here would pull in fixtures that merely mention one.
 */
function walkShallow(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

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

describe("no CLI entrypoint statically reaches a server-only module", () => {
  it("found the entrypoints, so an empty census is not a silent pass", () => {
    // A moved directory or a changed extension filter would otherwise make this
    // whole file pass by checking nothing at all.
    expect(CLI_ROOTS.length).toBeGreaterThan(20);
  });

  it("has no static path from any of them to `server-only`", () => {
    const violations: string[] = [];
    for (const entry of CLI_ROOTS) {
      const trail = findServerOnlyReach(entry);
      if (trail === null) continue;
      violations.push(
        trail
          .map((step) => (step.startsWith(REPO_ROOT) ? relative(step) : step))
          .join("\n    -> "),
      );
    }

    expect(
      violations,
      "An operator script statically imports its way to a `server-only` " +
        "module, which THROWS the moment the script starts — before it prints " +
        "anything. Read the club timezone through " +
        "`@/lib/club-time-zone-runtime` rather than `@/lib/club-time/server` " +
        "or `@/lib/club-time-zone-settings`, and move any other route-only " +
        "dependency behind a lazy `await import(...)` (CT-5, #2869).\n\n" +
        violations.join("\n\n"),
    ).toEqual([]);
  });

  it("would see the edge if one were added", () => {
    // The census is only worth its runtime if it can actually find a path, so
    // this drives the same search over a synthetic root: `club-time/server`
    // carries `import "server-only"`, and every CLI root above must not reach
    // it. Proving the search WORKS is what stops a silent all-clean.
    const serverBinding = path.join(SRC, "lib", "club-time", "server.ts");
    expect(existsSync(serverBinding)).toBe(true);
    expect(findServerOnlyReach(serverBinding)).toEqual([
      serverBinding,
      "server-only",
    ]);
  });

  it("covers every tsx invocation in the repository", () => {
    // The root list above is only as good as whoever remembered to add a
    // directory to it, and on #3056 nobody had: `e2e/setup` was missing, the
    // multi-lodge E2E seed died on the `server-only` throw, and this census
    // stayed green throughout. So the roots are no longer trusted on their own
    // — this derives the answer from the places a `tsx` entrypoint is actually
    // NAMED, and fails when one exists that no root covers.
    const searched: string[] = [];
    for (const relative of [
      ...walkShallow(path.join(REPO_ROOT, "scripts"), ".sh"),
      path.join(REPO_ROOT, "package.json"),
      ...walkShallow(path.join(REPO_ROOT, ".github", "workflows"), ".yml"),
    ]) {
      if (!existsSync(relative)) continue;
      searched.push(relative);
    }
    // A non-vacuity floor: if the sweep stops finding files, it stops finding
    // invocations too, and a green here would mean nothing.
    expect(searched.length).toBeGreaterThan(5);

    const invoked = new Set<string>();
    for (const file of searched) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /(?:^|[\s"'])tsx\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.[cm]?tsx?)(?=[\s"';)]|$)/gm,
      )) {
        invoked.add(match[1].replace(/^\.\//, ""));
      }
    }
    // The sweep must be able to see one, or the assertion below is vacuous.
    expect(invoked.size).toBeGreaterThan(0);

    const covered = new Set(
      CLI_ROOTS.map((absolute) =>
        path.relative(REPO_ROOT, absolute).split(path.sep).join("/"),
      ),
    );
    const uncovered = [...invoked]
      .filter((entry) => !covered.has(entry))
      .filter((entry) => existsSync(path.join(REPO_ROOT, entry)))
      .sort();

    expect(uncovered, [
      "A `tsx` entrypoint is invoked somewhere in this repository that no CLI",
      "root covers, so nothing checks whether it reaches a `server-only`",
      "module. Add its directory to CLI_ROOT_DIRECTORIES (or the file to",
      "CLI_ROOT_FILES) and re-run.",
    ].join(" ")).toEqual([]);
  });
});
