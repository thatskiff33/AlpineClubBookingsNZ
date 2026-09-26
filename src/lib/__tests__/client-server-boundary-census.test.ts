import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  MARKED_ROOTS,
  MARKER_STATEMENT,
} from "../../../scripts/ci/server-only-boundary-selftest.mjs";
import { stripComments } from "./support/strip-comments";

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
 * That does not make this census redundant, and #3204 — which put the marker on
 * the last three modules below, `@/lib/club-time-zone-env`,
 * `@/lib/environment-role-declaration` and `@/lib/environment-role` — did not
 * either. This is the only guard that covers a module the moment somebody
 * creates it, with no marker and no build to notice; it runs in the required
 * `verify` check without a build; and it reports the shortest import path it
 * found, where Turbopack reports a trace. The build proof and this census are
 * the same rule at two prices, not one superseding the other.
 *
 * The reason recorded here before #2850 was different and was WRONG: that 122
 * test files carry `vi.mock("server-only", …)` and marking `@/lib/prisma` would
 * put that on every test. `vitest.setup.ts` has stubbed the marker globally for
 * every test file since 22 Jul 2026, three weeks before that sentence was
 * written, and the full suite with the marker on the six roots marked at that
 * point reported zero `server-only` failures. A cost nobody re-measured had been keeping a
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
 * `@/lib/stripe` — also fail the Next build on their own, and since #3204 the
 * three environment readers at the end of the list do too. `@/lib/session` and
 * `@/lib/env` name no file, so they are the two that would ship silently if
 * this census missed them — there is nothing for a build to refuse until
 * somebody creates one.
 *
 * THIS LIST IS THE GUARD. It is not a sample of the server-only modules and
 * there is no rule that adds new ones automatically, so a module that is not
 * named here is not protected by this census however plainly its own docblock
 * says it is. `@/lib/club-time-zone-env` (#2989) is here for that reason: it
 * reads `process.env.TZ`, and Next inlines `NEXT_PUBLIC_*` into the browser
 * bundle, so a `"use client"` component importing it would silently answer from
 * the BUILD-TIME `NEXT_PUBLIC_TZ` rather than from the running server — the
 * split-brain second authority `INV-CONFIG-002` forbids and the one that module
 * exists to prevent. Its sibling `@/lib/club-time-zone` is pure validation with
 * no environment read and is deliberately NOT here: the admin panel needs its
 * zone list.
 *
 * `@/lib/club-format-env` (#3563) is the same pair for the same reason, and it
 * is the sharper case: `NEXT_PUBLIC_CURRENCY` and `NEXT_PUBLIC_LOCALE` have NO
 * `Dockerfile` build argument, so in the published image they inline as
 * `undefined` — a client-side read would not merely answer from the build, it
 * would answer nothing at all and fall through to the shipped New Zealand
 * defaults on every club. That is the defect programme #3205 exists to fix, so
 * re-creating it in the module written to fix it would be a particular kind of
 * absurd. Its sibling `@/lib/club-format` is pure validation and is
 * deliberately NOT here: the admin panel needs its currency list.
 *
 * `@/lib/environment-role-declaration` and `@/lib/environment-role` (#3034,
 * epic #2986) are here for the same reason and a sharper one. The declaration
 * module reads `process.env.APP_ENVIRONMENT_ROLE`, and a client component
 * importing it would answer from whatever the bundler inlined at build time for
 * a NON-public variable, which is `undefined`: the browser would read "nothing
 * has declared this installation" while the server reads `production`. What is
 * keyed on that answer is whether the club's real members get emailed
 * (INV-CONFIG-003), so a second authority here is worse than the timezone one,
 * not merely analogous.
 *
 * ALL THREE NOW CARRY THE MARKER TOO (#3204), and they stay on this list
 * anyway. The reason they were unmarked — that a `tsx` entrypoint reaching them
 * would abort — was RETIRED by #2850's `--conditions=react-server` and finally
 * acted on by #3204; the reasoning is recorded once, in
 * `docs/invariants/operations.md` -> `INV-OPS-013`, and not restated here. A
 * marked module is not a reason to delete its entry: this list is what catches
 * a new module before anyone marks it, and what answers without a build.
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
    "club-format-env",
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
  // The ESM spelling of a TypeScript module: `./x.js` names `./x.ts` (#3567).
  // Without this an edge written that way was invisible to every walk here.
  const esm = base.match(/^(.*)\.(?:[cm]?jsx?)$/);
  if (esm) {
    for (const ext of EXTENSIONS) {
      const candidate = esm[1] + ext;
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
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
 * A scanner has no backtracking to reason about at all, and since #3164 it is
 * the CANONICAL scanner rather than a fourteenth private one written here
 * (`INV-SSOT-004`). It advances strictly and uses `indexOf`, so this stays O(n)
 * by construction rather than by argument, and it now also understands the
 * string and regex literals a hand-written skip did not — which is what the
 * measurement in `support/strip-comments.ts` says is the difference between a
 * scanner and a scanner that silently eats code.
 *
 * `head` is a 400-character slice, so it can end mid-comment. An unterminated
 * comment strips to nothing and the directive is absent, which is the same
 * answer the hand-written skip returned.
 */
function startsWithUseClientDirective(head: string): boolean {
  const code = stripComments(head).trimStart();
  return code.startsWith('"use client"') || code.startsWith("'use client'");
}

/**
 * Browser entry points Next loads WITHOUT a `"use client"` line: the file name
 * is what makes them client code (#3567). Walked as roots beside the client
 * modules, so neither census can miss the graph they pull into the bundle.
 */
const BROWSER_ENTRY_FILES = ["src/instrumentation-client.ts"].map((file) =>
  path.resolve(process.cwd(), file),
);

const clientModules = [
  ...files.filter((file) => startsWithUseClientDirective(read(file).slice(0, 400))),
  ...BROWSER_ENTRY_FILES.filter((file) => existsSync(file)),
];

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
 * THE BROWSER-IMPORT CENSUS FOR CONFIGURATION (#3567, the execution contract of
 * programme #3205): no browser module reaches `@/config/operational`, at any
 * depth, however the path is spelled.
 *
 * That module held `APP_CURRENCY`, `APP_LOCALE`, `APP_STRIPE_CURRENCY` and
 * `APP_TIME_ZONE`, read from `process.env`. On the server that is the running
 * environment; in a browser it is whatever Next INLINED AT BUILD TIME for the
 * `NEXT_PUBLIC_*` spellings, which the published image never sets, so ten admin
 * screens came to show every club New Zealand dollars. #3567 deleted the module
 * once the last reader moved onto the stored settings — and this list keeps the
 * NAME protected without the file, the way `@/lib/session` and `@/lib/env` are
 * kept above, so recreating it starts out refused rather than invisible.
 *
 * A SEPARATE LIST FROM `FORBIDDEN_MODULES`, deliberately. That set is pinned to
 * `MARKED_ROOTS` plus two reserved names: its members are modules carrying the
 * `server-only` marker. This one never carried the marker — it was isomorphic
 * configuration — so putting it there would break that set's own contract.
 *
 * MATCHED ON THE SPECIFIER'S PATH, NOT ON A RESOLVED FILE. The file does not
 * exist, so resolution cannot find it; the path is normalised (`./`, `//`) and
 * any extension is dropped (`operational.js`, `operational.ts`) before the
 * compare, so every spelling of the name is caught with or without a file.
 */
const BROWSER_FORBIDDEN_CONFIG_MODULES = new Set([
  path.join(SRC, "config", "operational"),
]);

const BROWSER_CONFIG_MESSAGE =
  "NEXT_PUBLIC_* is inlined at build time, so a browser read answers from the build, not from the club (#3567, INV-CONFIG-006). Read the club's format and zone through the providers (useClubFormat, useClubTime).";

/** The forbidden configuration path a specifier names, or null. */
function isForbiddenConfigLeaf(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }
  const withoutExt = base.replace(/\.(?:[cm]?[jt]sx?)$/, "");
  return BROWSER_FORBIDDEN_CONFIG_MODULES.has(withoutExt) ? specifier : null;
}

/** Breadth-first, like `findServerReach`, so the trail is the shortest one. */
function findConfigReach(
  entry: string,
  specifiersFor: (file: string) => string[] = specifiersOf,
  resolve: (from: string, specifier: string) => string | null = resolveSpecifier,
): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: Array<{ file: string; trail: string[] }> = [{ file: entry, trail: [entry] }];
  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    for (const specifier of specifiersFor(file)) {
      const forbidden = isForbiddenConfigLeaf(file, specifier);
      if (forbidden !== null) return [...trail, forbidden];
      const next = resolve(file, specifier);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push({ file: next, trail: [...trail, next] });
      }
    }
  }
  return null;
}

describe("#3567: no browser module reaches @/config/operational, at any depth", () => {
  it("guards exactly one configuration path, and it is the retired one", () => {
    expect(BROWSER_FORBIDDEN_CONFIG_MODULES.size).toBe(1);
    expect(BROWSER_FORBIDDEN_CONFIG_MODULES.has(path.join(SRC, "config", "operational"))).toBe(true);
  });

  it("walks the browser entry files that carry no \"use client\" line", () => {
    for (const entry of BROWSER_ENTRY_FILES) {
      expect(existsSync(entry), `${path.relative(process.cwd(), entry)} is missing`).toBe(true);
      expect(clientModules).toContain(entry);
    }
  });

  it("has no path from any browser module to it", () => {
    const violations: string[] = [];
    for (const entry of clientModules) {
      const trail = findConfigReach(entry);
      if (trail !== null) {
        violations.push(
          trail
            .map((step) => (step.startsWith(SRC) ? path.relative(process.cwd(), step) : step))
            .join("\n    -> "),
        );
      }
    }
    expect(violations, `${BROWSER_CONFIG_MESSAGE}\n\n${violations.join("\n\n")}`).toEqual([]);
  });

  it("recognises every spelling of the path, with or without a file behind it", () => {
    const from = path.join(SRC, "components", "admin", "x.tsx");
    for (const specifier of [
      "@/config/operational",
      "@/config/operational.js",
      "@/config/operational.ts",
      "@/config/./operational",
      "@/config//operational",
      "../../config/operational",
      "../../config/operational.js",
    ]) {
      expect(isForbiddenConfigLeaf(from, specifier), specifier).toBe(specifier);
    }
    for (const specifier of ["@/config/operational-hours", "@/config/modules", "operational", "../config/operational"]) {
      expect(isForbiddenConfigLeaf(from, specifier), specifier).toBeNull();
    }
  });

  it("fails a planted one-hop import, a two-hop import and a dynamic import; a server module is not a root", () => {
    const client = path.join(SRC, "components", "planted-client.tsx");
    const helper = path.join(SRC, "lib", "planted-helper.ts");
    const dynamic = path.join(SRC, "components", "planted-dynamic.tsx");
    const route = path.join(SRC, "app", "api", "planted", "route.ts");
    const sources: Record<string, string> = {
      [client]: '"use client";\nimport { APP_TIME_ZONE } from "@/config/operational";\n',
      [helper]: 'export { x } from "../config/./operational.js";\n',
      [dynamic]: '"use client";\nexport const load = () => import("@/config/operational");\n',
      [route]: 'import { x } from "@/config/operational";\nexport const GET = x;\n',
    };
    const twoHop = path.join(SRC, "components", "planted-two-hop.tsx");
    sources[twoHop] = '"use client";\nimport { y } from "@/lib/planted-helper";\n';
    const specifiersFor = (file: string) => specifiers(sources[file] ?? "");
    const resolve = (_from: string, specifier: string) =>
      specifier === "@/lib/planted-helper" ? helper : null;

    expect(findConfigReach(client, specifiersFor, resolve)).toEqual([client, "@/config/operational"]);
    expect(findConfigReach(twoHop, specifiersFor, resolve)).toEqual([
      twoHop,
      helper,
      "../config/./operational.js",
    ]);
    expect(findConfigReach(dynamic, specifiersFor, resolve)).toEqual([dynamic, "@/config/operational"]);
    // The control: the same import in a server route is not a browser root.
    expect(startsWithUseClientDirective(sources[route])).toBe(false);
    expect(startsWithUseClientDirective(sources[client])).toBe(true);
  });
});

/**
 * The other half of `INV-OPS-013`, and the half that had nothing holding it
 * down until #3186.
 *
 * `scripts/ci/server-only-boundary-selftest.mjs` proves the production build
 * refuses a client component reaching `@/lib/auth` or `@/lib/prisma`, because
 * those are the two roots its fixture imports. The other seven roots this
 * invariant names — `@/lib/audit`, `@/lib/email`, `@/lib/stripe`, `@/lib/xero`
 * and, since #3204, `@/lib/club-time-zone-env`,
 * `@/lib/environment-role-declaration` and `@/lib/environment-role` — carry the
 * same marker, and nothing checked that they still did. Measured: delete it
 * from the first four and every boundary suite in this repository stayed green.
 * This assertion is what the seven unplanted roots have instead of a build, and
 * `MARKED_ROOTS` records why that trade is the right one.
 *
 * So the list of marked roots lives in the self-test beside the two it plants,
 * and this asserts each entry still carries the statement. The two lists cannot
 * drift, because `server-only-boundary-selftest.test.mjs` requires
 * `PROTECTED_ROOTS` to be a subset of `MARKED_ROOTS`.
 *
 * ANCHORED AND COMMENT-STRIPPED, and both halves are the check.
 *
 * Anchored, because eighteen files under `src/` NAME `import "server-only"`
 * inside a docblock explaining the boundary without carrying it, and the roots
 * themselves open by quoting the statement they do carry. A substring match
 * would be satisfied by the paragraph ABOUT the marker surviving while the
 * marker itself was deleted, which is precisely the mutation this exists to
 * catch.
 *
 * Comment-stripped since #3204, because anchoring alone caught DELETION and not
 * DISABLEMENT. Measured: wrap the statement in `/* … *\/` and the line still
 * sits at column 0, so the anchored match still found it while the module had
 * stopped being refused by the build — a green suite over a marker that does
 * nothing, which is the silent-green shape this whole area exists to prevent.
 * That mattered more once #3204 took the roots this assertion is the only
 * cover for from four to seven, one of them the module that decides whether
 * real members get emailed. `stripComments` is the tree's one comment stripper
 * (`INV-SSOT-004`) and this file already used it, so no second stripper and no
 * new importer: `stripCommentsAndStrings` would have been wrong here, since it
 * blanks string CONTENTS and would erase the `"server-only"` in the marker
 * itself.
 *
 * WHAT IS STILL NOT CAUGHT, stated rather than implied away: the statement
 * written at column 0 inside a TEMPLATE LITERAL. Seeing into one needs a
 * parser, and the blanking forms cannot be used for the reason just given. It
 * is left because it is not an accident shape — reaching it means deleting the
 * real import AND adding a template whose content is exactly that line, which
 * is forgery rather than debugging.
 */
const MARKER_LINE = new RegExp(
  `^${MARKER_STATEMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  "m",
);

/**
 * A marker that is PRESENT as text and INERT as code — the mutation
 * `carriesMarker` gained `stripComments` to catch (#3204).
 *
 * Module scope, and deliberately: `ssot/no-local-comment-stripper` reports a
 * function that handles comment delimiters, because that is what a second
 * comment stripper looks like. This is a FIXTURE rather than a scanner — text
 * handed to the canonical helper, which does the stripping — and the rule's own
 * suite is listed in `COMMENT_STRIPPER_ALLOWLIST` for exactly this reason.
 * Keeping the delimiters out of the `it(...)` callback is the cheaper answer
 * than a second allowlist entry, and it puts the fixture beside the regex it
 * probes.
 */
const COMMENTED_OUT_MARKER_FIXTURE = [
  "/*",
  MARKER_STATEMENT,
  "*/",
  "export const value = 1;",
].join("\n");

function carriesMarker(text: string): boolean {
  return MARKER_LINE.test(stripComments(text.replace(/\r\n/g, "\n")));
}

describe("INV-OPS-013: the forbidden-leaf list is the list it claims to be", () => {
  // #3204 decided to KEEP all ten marked roots on this list rather than let
  // the build proof replace it, because this half answers without a build and
  // covers a module before anybody marks it. That decision was enforced by
  // nothing: measured, deleting "environment-role" from `FORBIDDEN_MODULES`
  // left every suite in this repository green, while the Semgrep half of the
  // same rule is pinned by its own `ruleid:` fixtures. So the decision is
  // asserted here, at the list.
  it("names every marked root, plus the two reserved names", () => {
    const missing = MARKED_ROOTS.filter(
      (root) =>
        !FORBIDDEN_MODULES.has(
          path.resolve(process.cwd(), root).replace(/\.[^./\\]+$/, ""),
        ),
    );
    expect(
      missing,
      "A module carries `import \"server-only\"` but is not a forbidden leaf of " +
        "this census, so nothing reports the shortest client-side path to it " +
        "and nothing covers it in a run with no build (INV-OPS-013, #3204).\n\n" +
        missing.join("\n"),
    ).toEqual([]);

    // `@/lib/session` and `@/lib/env` name no file, so no build can refuse
    // them and this list is their only protection. Losing either is silent.
    for (const reserved of ["session", "env"]) {
      expect(
        FORBIDDEN_MODULES.has(path.join(SRC, "lib", reserved)),
        `@/lib/${reserved} names no file, so this list is the ONLY thing that ` +
          "would protect a module created at that path. Do not remove it.",
      ).toBe(true);
    }

    expect(
      FORBIDDEN_MODULES.size,
      "INV-OPS-013: this list is ten marked roots plus `@/lib/session` and " +
        "`@/lib/env`, which name no file. Size plus the membership checks above " +
        "pin the set EXACTLY, so a swapped entry cannot pass. Marking an " +
        "eleventh module means adding it here and to MARKED_ROOTS, and moving " +
        "this number on purpose (#3204, #3563).",
    ).toBe(12);
  });
});

describe("INV-OPS-013: the ten marked roots still carry the marker", () => {
  it("names ten roots, all of which exist", () => {
    // Non-vacuity, in the one shape that would make the assertion below pass by
    // checking nothing: a rename, a deletion, or a truncated list. The count is
    // asserted in `server-only-boundary-selftest.test.mjs` too; repeated here
    // so this file cannot be read as trusting a list it never looked at.
    expect(MARKED_ROOTS).toHaveLength(10);
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

  it("is not satisfied by the statement anywhere but column 0", () => {
    // The fixture above stopped proving the ANCHOR the moment `carriesMarker`
    // began stripping comments (#3204 review): a docblock is now removed before
    // the match, so that case fails whether or not `MARKER_LINE` is anchored,
    // and dropping the `^`/`$` would leave every other fixture here green.
    // These two isolate the anchor — both are FALSE anchored and TRUE without
    // it — so the docblock's claim that both halves are the check is proven by
    // both halves.
    expect(carriesMarker(`const sample = '${MARKER_STATEMENT}';\n`)).toBe(false);
    expect(carriesMarker(`  ${MARKER_STATEMENT}\n`)).toBe(false);
  });

  it("is not satisfied by a marker that has been COMMENTED OUT (#3204)", () => {
    // Deletion is the mutation people expect; DISABLEMENT is the one that
    // survived, because a block comment leaves the statement at column 0 and
    // the anchored match still found it there. Only this spelling needs a
    // fixture: a line-commented marker never could match, since the anchor
    // requires column 0 and `// ` occupies it.
    const commentedOut = COMMENTED_OUT_MARKER_FIXTURE;
    expect(carriesMarker(commentedOut)).toBe(false);
    // …and a real statement beside a commented-out one still counts, so this
    // cannot be read as banning the words from a file.
    expect(carriesMarker(`${commentedOut}\n${MARKER_STATEMENT}\n`)).toBe(true);
  });
});
