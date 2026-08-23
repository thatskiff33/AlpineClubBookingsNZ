import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * INV-OPS-013, with transitive reach (#2686).
 *
 * `.semgrep/rules/acb-client-server-boundary.yml` reports a `"use client"`
 * module that imports a server-only module DIRECTLY, which is the shape that
 * shows up in a diff and the shape a reviewer can see. It cannot see one hop
 * further: a client component importing `@/lib/audit`, which imports
 * `@/lib/prisma`, ships the database client to the browser exactly as the direct
 * import would, and no regex over a single file can know that.
 *
 * Next.js does have a build-time answer — `import "server-only"` in the leaf
 * module makes the compiler refuse the whole chain — and that remains the better
 * long-term fix. It is not this pull request's change to make: `server-only`
 * throws when evaluated outside a React Server Component, this suite runs in
 * Node, and 122 test files already carry `vi.mock("server-only", …)` for the
 * modules that have it today. Putting it on `@/lib/prisma` would put that
 * requirement on essentially every test in the repository, and the only proof
 * the change was safe would be a full `next build`.
 *
 * So the reach is asserted here instead, where it is cheap and where it runs
 * inside the REQUIRED `verify` check. This walks the real import graph from
 * every `"use client"` module and fails with the shortest path it found.
 */

const SRC = path.resolve(process.cwd(), "src");
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * The leaves a browser bundle must never reach. `@/lib/prisma` and `@/lib/auth`
 * are the two that do NOT fail the Next build today, because neither imports
 * `server-only` — so they are the two that would ship silently.
 *
 * THIS LIST IS THE GUARD. It is not a sample of the server-only modules and
 * there is no rule that adds new ones automatically, so a module that is not
 * named here is not protected by this census however plainly its own docblock
 * says it is. `@/lib/club-time-zone-env` (#2989) is here for that reason: it
 * reads `process.env.TZ` and is deliberately NOT marked `server-only`, because
 * two of its callers are `tsx` entrypoints that a `server-only` import would
 * abort. Next inlines `NEXT_PUBLIC_*` into the browser bundle, so a
 * `"use client"` component importing it would silently answer from the
 * BUILD-TIME `NEXT_PUBLIC_TZ` rather than from the running server — the
 * split-brain second authority `INV-CONFIG-002` forbids and the one that module
 * exists to prevent. Its sibling `@/lib/club-time-zone` is pure validation with
 * no environment read and is deliberately NOT here: the admin panel needs its
 * zone list.
 */
const FORBIDDEN_MODULES = new Set(
  [
    "prisma",
    "auth",
    "audit",
    "session",
    "email",
    "xero",
    "stripe",
    "env",
    "club-time-zone-env",
  ].map((name) => path.join(SRC, "lib", name)),
);

/** Everything Node-only, whatever spelling. `node:`-prefixed is always Node. */
const NODE_BUILTINS = new Set([
  "async_hooks", "child_process", "cluster", "crypto", "dgram",
  "diagnostics_channel", "dns", "fs", "http", "http2", "https", "inspector",
  "module", "net", "os", "perf_hooks", "readline", "repl", "sqlite", "tls",
  "trace_events", "tty", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/**
 * The one edge that exists today, named rather than tolerated.
 *
 * `src/lib/booking-exception-requests.ts` opens with
 * `import { createHash } from "node:crypto"`, for `computeProposalHash`, and
 * four client components import VALUES from it —
 * `MEMBER_MESSAGE_MAX_LENGTH` and `formatPolicyExceptionRequestAge` — so the
 * whole module, and its `node:crypto` import, is on the client graph. It builds
 * today, which means the bundler is shimming or dropping it; that is a bundler
 * implementation detail and not a guarantee.
 *
 * It is NOT fixed here on purpose. The fix is to move `computeProposalHash` and
 * its canonicalisation helpers into their own server-side module and re-point
 * `booking-exception-approval.ts` and `booking-exception-execution.ts` at it —
 * a code move inside the booking policy-exception workflow, which is
 * capacity-adjacent Critical code and needs its own review, not a drive-by edit
 * in a CI-enforcement change (#2686).
 *
 * Every entry here is `<module under src/> -> <specifier>` and is a debt, not a
 * dispensation: nothing NEW joins this list without the same explanation.
 */
const KNOWN_EDGES = new Set([
  "src/lib/booking-exception-requests.ts -> node:crypto",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (EXTENSIONS.includes(path.extname(name))) {
      out.push(full);
    }
  }
  return out;
}

function read(file: string) {
  return readFileSync(file, "utf8");
}

/**
 * Runtime module specifiers only. `import type` / `export type` are erased
 * before a bundle exists and cannot carry anything into it, so they are not
 * edges. The negative lookahead is `type[\s{]` rather than `type\s` because
 * TypeScript accepts `import type{ Session } from …` with no space.
 */
const RUNTIME_IMPORT =
  /^[ \t]*(?:import|export)\s+(?!type[\s{])(?:[^;'"]*?\bfrom\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /(?:\bimport|\brequire)\s*\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(text: string): string[] {
  return [
    ...[...text.matchAll(RUNTIME_IMPORT)].map((m) => m[1]),
    ...[...text.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]),
  ];
}

/** Resolve a specifier to an absolute file under `src/`, or null if external. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }
  for (const ext of ["", ...EXTENSIONS]) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = path.join(base, `index${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function edgeKey(fromFile: string, specifier: string) {
  return `${path.relative(process.cwd(), fromFile).split(path.sep).join("/")} -> ${specifier}`;
}

function isForbiddenLeaf(fromFile: string, specifier: string): string | null {
  const forbidden =
    specifier === "server-only" ||
    specifier === "next/headers" ||
    specifier.startsWith("node:") ||
    NODE_BUILTINS.has(specifier.split("/")[0]);
  if (forbidden) {
    return KNOWN_EDGES.has(edgeKey(fromFile, specifier)) ? null : specifier;
  }
  const resolved = resolveSpecifier(fromFile, specifier);
  if (resolved === null) return null;
  const withoutExt = resolved.replace(/\.(tsx?|jsx?|mjs)$/, "");
  if (!FORBIDDEN_MODULES.has(withoutExt)) return null;
  // Prisma and auth are never exemptable — an exemption for either is a
  // credential or a database client in a browser bundle, which is the thing
  // this census exists to make impossible.
  return specifier;
}

const files = walk(SRC).filter(
  (file) => !file.includes(`${path.sep}__tests__${path.sep}`) && !/\.test\.tsx?$/.test(file),
);

const specifierCache = new Map<string, string[]>();
function specifiersOf(file: string): string[] {
  const cached = specifierCache.get(file);
  if (cached) return cached;
  const value = specifiers(read(file));
  specifierCache.set(file, value);
  return value;
}

/**
 * Does this source begin with a `"use client"` directive, once leading
 * whitespace and comments are skipped?
 *
 * Deliberately NOT a regular expression. The obvious spelling —
 * `^(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']` — is ambiguous,
 * because the trailing `\s*` inside a starred group can match one run of
 * whitespace in more than one way, and CodeQL flagged it as exponential
 * backtracking on input shaped like a repeated `*//*` (`js/redos`, high).
 *
 * The first attempt at a fix rewrote it as one alternation whose branches are
 * each decided by their opening characters. That reasoning was right, but CodeQL
 * still flagged it — a nested quantifier inside a starred group is enough for the
 * analysis regardless of whether the branches can actually overlap. Arguing with a
 * checker that only runs in CI is a poor trade for a helper this small.
 *
 * A scanner has no backtracking to reason about at all. Every branch below
 * advances `i` strictly, and `indexOf` is linear, so this is O(n) by
 * construction rather than by argument. That it also reads more plainly than the
 * regex is a bonus.
 */
function startsWithUseClientDirective(head: string): boolean {
  let i = 0;
  while (i < head.length) {
    const ch = head[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "/" && head[i + 1] === "/") {
      const newline = head.indexOf("\n", i + 2);
      if (newline === -1) return false;
      i = newline + 1;
      continue;
    }
    if (ch === "/" && head[i + 1] === "*") {
      const close = head.indexOf("*/", i + 2);
      if (close === -1) return false;
      i = close + 2;
      continue;
    }
    return head.startsWith('"use client"', i) || head.startsWith("'use client'", i);
  }
  return false;
}

const clientModules = files.filter((file) =>
  startsWithUseClientDirective(read(file).slice(0, 400)),
);

/** Breadth-first, so the path reported is the shortest one. */
function findServerReach(entry: string): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: Array<{ file: string; trail: string[] }> = [{ file: entry, trail: [entry] }];
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    for (const specifier of specifiersOf(file)) {
      const forbidden = isForbiddenLeaf(file, specifier);
      if (forbidden !== null) return [...trail, forbidden];
      const next = resolveSpecifier(file, specifier);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push({ file: next, trail: [...trail, next] });
      }
    }
  }
  return null;
}

describe("INV-OPS-013: no client module reaches server-only code, at any depth", () => {
  it("finds the client modules to check, so an empty census is not a silent pass", () => {
    // The census is only worth anything if it found the population. A refactor
    // that moves `"use client"` behind a directive prologue this regex does not
    // recognise would otherwise pass by checking nothing.
    expect(clientModules.length).toBeGreaterThan(300);
  });

  it("has no path from any client module to prisma, auth, or a Node built-in", () => {
    const violations: string[] = [];
    for (const entry of clientModules) {
      const trail = findServerReach(entry);
      if (trail !== null) {
        violations.push(
          trail
            .map((step) => (step.startsWith(SRC) ? path.relative(process.cwd(), step) : step))
            .join("\n    -> "),
        );
      }
    }
    expect(
      violations,
      `A "use client" module reaches server-only code. Everything on the path below is compiled into the browser bundle:\n\n${violations.join("\n\n")}`,
    ).toEqual([]);
  });

  it("keeps the known-edge list from silently outliving the edges", () => {
    // A stale exemption is the same defect as a stale suppression: it reads as
    // a reviewed decision when it is really a leftover. Each entry must still
    // describe a real import, so removing the last one fails here and gets the
    // line deleted rather than left behind.
    for (const edge of KNOWN_EDGES) {
      const [file, specifier] = edge.split(" -> ");
      const absolute = path.resolve(process.cwd(), file);
      expect(existsSync(absolute), `${file} no longer exists; drop this entry`).toBe(true);
      expect(
        specifiersOf(absolute),
        `${file} no longer imports ${specifier}; drop this entry`,
      ).toContain(specifier);
    }
  });
});
