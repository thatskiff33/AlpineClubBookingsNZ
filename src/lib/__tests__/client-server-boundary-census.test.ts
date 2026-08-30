import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  MARKED_ROOTS,
  MARKER_STATEMENT,
} from "../../../scripts/ci/server-only-boundary-selftest.mjs";

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
 * module makes the compiler refuse the whole chain — and since #2850 this
 * repository uses it, proven by a real production build in
 * `scripts/ci/server-only-boundary-selftest.mjs`. Its second half then put the
 * marker on `@/lib/prisma`, `@/lib/audit`, `@/lib/email`, `@/lib/xero` and
 * `@/lib/stripe` as well, which had been impossible while fourteen operator CLI
 * entrypoints reached the database client under plain Node, where `server-only`
 * throws at import. Those commands now run with `--conditions=react-server`,
 * under which the marker resolves to an empty module, and
 * `cli-server-only-reach-census.test.ts` (CT-5, #2869) fails any published
 * command that reaches a marked module without it.
 *
 * That does not make this census redundant. Three of the modules below still
 * cannot carry the marker — `@/lib/club-time-zone-env`,
 * `@/lib/environment-role-declaration` and `@/lib/environment-role` — and this
 * is the only guard that covers a module the moment somebody creates it, with
 * no marker and no build to notice.
 *
 * The reason recorded here before #2850 was different and was WRONG: that 122
 * test files carry `vi.mock("server-only", …)` and marking `@/lib/prisma` would
 * put that on every test. `vitest.setup.ts` has stubbed the marker globally for
 * every test file since 22 Jul 2026, three weeks before that sentence was
 * written, and the full suite with the marker on six protected roots reported
 * zero `server-only` failures. A cost nobody re-measured had been keeping a
 * guard off for a year.
 *
 * So this census carries the modules the build cannot, and carries every module
 * cheaply, inside the REQUIRED `verify` check. It walks the real import graph
 * from every `"use client"` module and fails with the shortest path it found.
 * `@/lib/session` and `@/lib/env` below name no file that exists; they stay so
 * that creating one starts out protected rather than starting out invisible.
 */

const SRC = path.resolve(process.cwd(), "src");
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/**
 * The leaves a browser bundle must never reach. Since #2850 six of them —
 * `@/lib/auth`, `@/lib/prisma`, `@/lib/audit`, `@/lib/email`, `@/lib/xero` and
 * `@/lib/stripe` — also fail the Next build on their own. The three
 * environment readers at the end of the list do not, so those are the ones
 * that would ship silently if this census missed them.
 *
 * THIS LIST IS THE GUARD. It is not a sample of the server-only modules and
 * there is no rule that adds new ones automatically, so a module that is not
 * named here is not protected by this census however plainly its own docblock
 * says it is. `@/lib/club-time-zone-env` (#2989) is here for that reason: it
 * reads `process.env.TZ` and is deliberately NOT marked `server-only`. Its
 * `tsx` callers would survive the marker now that they carry
 * `--conditions=react-server` (#2850), so the "an entrypoint would abort"
 * reason those docblocks used to give is RETIRED; it is unmarked as a decision
 * instead, recorded once in `docs/invariants/operations.md` -> `INV-OPS-013`,
 * "The three modules that stay unmarked" — where the sealing work is tracked
 * as #3204 — and not restated here. Next inlines
 * `NEXT_PUBLIC_*` into the browser bundle, so a
 * `"use client"` component importing it would silently answer from the
 * BUILD-TIME `NEXT_PUBLIC_TZ` rather than from the running server — the
 * split-brain second authority `INV-CONFIG-002` forbids and the one that module
 * exists to prevent. Its sibling `@/lib/club-time-zone` is pure validation with
 * no environment read and is deliberately NOT here: the admin panel needs its
 * zone list.
 *
 * `@/lib/environment-role-declaration` and `@/lib/environment-role` (#3034,
 * epic #2986) are here for the same reason and a sharper one. Neither is
 * `server-only` — `setup-readiness-db.ts` reaches the resolver from the
 * `npm run setup:check` entrypoint, which carries the condition and would
 * survive the marker, and the same deliberate-decision answer above applies —
 * and the
 * declaration module reads `process.env.APP_ENVIRONMENT_ROLE`. A client
 * component importing it would answer from whatever the bundler inlined at
 * build time for a NON-public variable, which is `undefined`: the browser would
 * read "nothing has declared this installation" while the server reads
 * `production`. What is keyed on that answer is whether the club's real members
 * get emailed (INV-CONFIG-003), so a second authority here is worse than the
 * timezone one, not merely analogous.
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
    "environment-role-declaration",
    "environment-role",
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
 * THERE IS NO ALLOWLIST HERE, AND ADDING ONE BACK IS A REVIEWABLE ACT.
 *
 * There used to be. When #2686 introduced this census it found one live edge —
 * `src/lib/booking-exception-requests.ts -> node:crypto` — and named it in a
 * `KNOWN_EDGES` set rather than fixing it, because the fix was a code move
 * inside capacity-adjacent Critical code and did not belong in a CI-enforcement
 * change. Seven `"use client"` modules reached it for `MEMBER_MESSAGE_MAX_LENGTH`
 * and `formatPolicyExceptionRequestAge`, so the whole module —
 * `createHash` and all — was compiled into the browser bundle. It built anyway,
 * which meant the bundler was shimming or dropping `node:crypto`: an
 * implementation detail, not a guarantee.
 *
 * #2851 did that code move: those two values now live in
 * `@/lib/booking-exception-request-shared`, which imports nothing, and the
 * workflow module is off the client graph. #2850 forbids baselining or
 * allowlisting the known violation, so with its last entry gone the MECHANISM
 * went too, deliberately. An empty exemption set is an invitation — it makes
 * adding the next entry a one-line diff that reads as using an existing
 * facility. Re-introducing the set is now a visible design change a reviewer
 * has to agree to, which is the correct weight for "we are shipping a Node
 * built-in to the browser on purpose".
 *
 * If you are here because a real edge cannot be removed: split the client-safe
 * values into a pure module, as #2851 did. That is the fix, and it took one new
 * file.
 */

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

function isForbiddenLeaf(fromFile: string, specifier: string): string | null {
  const forbidden =
    specifier === "server-only" ||
    specifier === "next/headers" ||
    specifier.startsWith("node:") ||
    NODE_BUILTINS.has(specifier.split("/")[0]);
  if (forbidden) return specifier;
  const resolved = resolveSpecifier(fromFile, specifier);
  if (resolved === null) return null;
  const withoutExt = resolved.replace(/\.(tsx?|jsx?|mjs)$/, "");
  if (!FORBIDDEN_MODULES.has(withoutExt)) return null;
  // No exemption exists to consult: reaching any of these from the client is a
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
});

/**
 * The other half of `INV-OPS-013`, and the half that had nothing holding it
 * down until #3186.
 *
 * `scripts/ci/server-only-boundary-selftest.mjs` proves the production build
 * refuses a client component reaching `@/lib/auth` or `@/lib/prisma`, because
 * those are the two roots its fixture imports. The other four roots this
 * invariant names — `@/lib/audit`, `@/lib/email`, `@/lib/stripe` and
 * `@/lib/xero` — carry the same marker, and nothing checked that they still
 * did. Measured: delete it from all four and every boundary suite in this
 * repository stays green.
 *
 * So the list of marked roots lives in the self-test beside the two it plants,
 * and this asserts each entry still carries the statement. The two lists cannot
 * drift, because `server-only-boundary-selftest.test.mjs` requires
 * `PROTECTED_ROOTS` to be a subset of `MARKED_ROOTS`.
 *
 * ANCHORED, not a substring search, and that distinction is the whole check.
 * Fifteen files here NAME `import "server-only"` inside a docblock explaining
 * the boundary — including the roots themselves, whose docblocks open by
 * quoting the statement they carry. A substring match would be satisfied by the
 * paragraph ABOUT the marker surviving while the marker itself was deleted,
 * which is precisely the mutation this exists to catch.
 */
const MARKER_LINE = new RegExp(
  `^${MARKER_STATEMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  "m",
);

function carriesMarker(text: string): boolean {
  return MARKER_LINE.test(text.replace(/\r\n/g, "\n"));
}

describe("INV-OPS-013: the six marked roots still carry the marker", () => {
  it("names six roots, all of which exist", () => {
    // Non-vacuity, in the one shape that would make the assertion below pass by
    // checking nothing: a rename, a deletion, or a truncated list. The count is
    // asserted in `server-only-boundary-selftest.test.mjs` too; repeated here
    // so this file cannot be read as trusting a list it never looked at.
    expect(MARKED_ROOTS).toHaveLength(6);
    for (const root of MARKED_ROOTS) {
      expect(
        existsSync(path.resolve(process.cwd(), root)),
        `${root} is listed as a server-only root but no such file exists, ` +
          "so the marker assertion below is checking nothing",
      ).toBe(true);
    }
  });

  it("finds the marker as a real statement in each of them", () => {
    const missing = MARKED_ROOTS.filter(
      (root) =>
        !carriesMarker(readFileSync(path.resolve(process.cwd(), root), "utf8")),
    );

    expect(
      missing,
      "A module listed as a server-only root no longer carries " +
        `\`${MARKER_STATEMENT}\`, so the production build will happily compile ` +
        "it into a browser bundle. Restore the statement, or remove the module " +
        "from MARKED_ROOTS in scripts/ci/server-only-boundary-selftest.mjs and " +
        "say in review why shipping it to visitors is acceptable " +
        "(INV-OPS-013, #2850, #3186).\n\n" +
        missing.join("\n"),
    ).toEqual([]);
  });

  it("is not satisfied by a docblock that merely mentions the marker", () => {
    // The mutation the anchor exists to survive, run as a fixture rather than
    // left to whoever remembers to try it by hand. Every one of these roots
    // opens with a docblock quoting the statement, so an unanchored search
    // would call a stripped module marked.
    const docblockOnly = [
      "/**",
      ` * \`${MARKER_STATEMENT}\` makes the production build REFUSE this module`,
      " * in a browser bundle, at any depth.",
      " */",
      "export const value = 1;",
    ].join("\n");
    expect(carriesMarker(docblockOnly)).toBe(false);
    expect(carriesMarker(`${docblockOnly}\n${MARKER_STATEMENT}\n`)).toBe(true);
  });
});
