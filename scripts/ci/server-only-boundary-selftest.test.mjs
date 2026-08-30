import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  BOUNDARY_MESSAGE,
  BROWSER_LAYER,
  FIXTURE_PAGE,
  MARKED_ROOTS,
  MARKER_STATEMENT,
  PROTECTED_ROOTS,
  SUCCESS_PREFIX,
  isDirectInvocation,
  problemsWithSeededBuild,
  splitErrorBlocks,
  stripAnsi,
} from "./server-only-boundary-selftest.mjs";

/**
 * Unit coverage for the ADJUDICATION half of the server/client boundary
 * self-test (#2850). The gate itself plants a fixture and runs a real
 * `next build`, which is far too slow to unit-test; what is pinned here is the
 * part that decides whether the resulting failure counts as proof.
 *
 * That part carries the whole weight of the acceptance criterion. Seeding a
 * client component that reaches `@/lib/auth` also drags Prisma's `pg` driver
 * into the browser layer, so the build fails with a pile of `module-not-found`
 * errors WHETHER OR NOT Next's server-only rule exists. A gate that checked the
 * exit code would therefore be green with the boundary switched off — the exact
 * shape of vacuous pass this repository has been bitten by before (the gitleaks
 * config that replaced the default ruleset with an empty one and passed for
 * months). So the fixtures below are transcribed from real Turbopack output and
 * every one of them removes a single ingredient to prove the adjudicator
 * notices.
 *
 * Since #2850's second half the fixture reaches TWO protected roots, and the
 * cases below check each independently: a marker coming off `@/lib/prisma`
 * while `@/lib/auth` still carries one must fail this gate, because
 * `@/lib/prisma` is the module the whole exercise was about.
 */

const REAL_BOUNDARY_BLOCK = `
> Build error occurred
Error: Turbopack build failed with 16 errors:
./src/lib/auth.ts:23:1
Error: You're importing a module that depends on "server-only". This API is only available in Server Components in the App Router, but you are using it in the Pages Router.
    Learn more: https://nextjs.org/docs/app/building-your-application/rendering/server-components
> 23 | import "server-only";
     | ^^^^^^^^^^^^^^^^^^^^^

Ecmascript file had an error

Import traces:
  Client Component Browser:
    ./src/lib/auth.ts [Client Component Browser]
    ./src/app/server-only-boundary-selftest/bridge.ts [Client Component Browser]
    ./src/app/server-only-boundary-selftest/page.tsx [Client Component Browser]
    ./src/app/server-only-boundary-selftest/page.tsx [Server Component]

  Instrumentation:
    ./src/lib/auth.ts
    ./src/instrumentation.node.ts

./src/lib/prisma.ts:9:1
Error: You're importing a module that depends on "server-only". This API is only available in Server Components in the App Router, but you are using it in the Pages Router.
    Learn more: https://nextjs.org/docs/app/building-your-application/rendering/server-components
> 9 | import "server-only";
    | ^^^^^^^^^^^^^^^^^^^^^

Ecmascript file had an error

Import traces:
  Client Component Browser:
    ./src/lib/prisma.ts [Client Component Browser]
    ./src/app/server-only-boundary-selftest/bridge.ts [Client Component Browser]
    ./src/app/server-only-boundary-selftest/page.tsx [Client Component Browser]
    ./src/app/server-only-boundary-selftest/page.tsx [Server Component]
`;

/**
 * What the same seeded build prints once `import "server-only"` is taken off
 * both roots: still red, still a dozen-ish errors, and not one of them about
 * the boundary. This is the string the gate has to reject.
 */
const COLLATERAL_ONLY = `
> Build error occurred
Error: Turbopack build failed with 12 errors:
./node_modules/pg/lib/utils.js:5:20
Module not found: Can't resolve 'util/types'
> 5 | const { isDate } = require('util/types')

Import traces:
  Client Component Browser:
    ./node_modules/pg/lib/utils.js [Client Component Browser]
    ./src/lib/prisma.ts [Client Component Browser]
    ./src/lib/auth.ts [Client Component Browser]
    ./src/app/server-only-boundary-selftest/page.tsx [Client Component Browser]
`;

/** Everything above the `./src/lib/prisma.ts:9:1` heading, and nothing below. */
const AUTH_ONLY = REAL_BOUNDARY_BLOCK.slice(
  0,
  REAL_BOUNDARY_BLOCK.indexOf("./src/lib/prisma.ts:9:1"),
);

describe("server-only boundary self-test: adjudication", () => {
  it("accepts the real seeded-build output", () => {
    expect(
      problemsWithSeededBuild({ exitCode: 1, output: REAL_BOUNDARY_BLOCK }),
    ).toEqual([]);
  });

  it("rejects a build that passed, however clean the log looks", () => {
    // The only outcome that means the boundary is gone rather than merely
    // reported differently.
    const problems = problemsWithSeededBuild({
      exitCode: 0,
      output: REAL_BOUNDARY_BLOCK,
    });
    expect(problems.join(" ")).toContain("SUCCEEDED");
  });

  it("rejects a red build whose errors are all collateral", () => {
    // The vacuous-pass case: `pg` cannot resolve Node built-ins in a browser
    // bundle, so the seeded build is red even with Next's rule disabled. An
    // exit-code check would call this proof; it is not.
    const problems = problemsWithSeededBuild({
      exitCode: 1,
      output: COLLATERAL_ONLY,
    });
    expect(problems).toHaveLength(PROTECTED_ROOTS.length);
    for (const problem of problems) expect(problem).toContain("unrelated reason");
  });

  it("rejects a build that proves only ONE of the two roots", () => {
    // The regression this gate exists to catch after #2850's second half: the
    // marker comes off `@/lib/prisma`, `@/lib/auth` still carries one, the
    // build is still red for a genuine boundary reason — and the database
    // client is silently back to being covered by the source censuses alone.
    const problems = problemsWithSeededBuild({ exitCode: 1, output: AUTH_ONLY });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("./src/lib/prisma.ts");
    expect(problems[0]).toContain("unrelated reason");
  });

  it("rejects a boundary error that does not name the planted fixture", () => {
    // Some OTHER client module already reached a server-only module. The build
    // is red for the right kind of reason but not because of anything this gate
    // did, so it proves nothing about the seeded violation.
    const output = REAL_BOUNDARY_BLOCK.replaceAll(
      "./src/app/server-only-boundary-selftest/",
      "./src/components/some-other/",
    );
    const problems = problemsWithSeededBuild({ exitCode: 1, output });
    expect(problems).toHaveLength(PROTECTED_ROOTS.length);
    for (const problem of problems) expect(problem).toContain("not attributable");
  });

  it("rejects a trace that only reaches the root through a server layer", () => {
    // `[Client Component Browser]` is the layer that actually ships. A server
    // component or an instrumentation trace importing a server-only module is
    // correct and must not be mistaken for a violation.
    const output = REAL_BOUNDARY_BLOCK.replaceAll(
      BROWSER_LAYER,
      "[Server Component]",
    );
    const problems = problemsWithSeededBuild({ exitCode: 1, output });
    expect(problems.join(" ")).toContain("not attributable");
  });

  it("rejects an error attributed to a root without the boundary message", () => {
    const output = REAL_BOUNDARY_BLOCK.replaceAll(
      BOUNDARY_MESSAGE,
      "Something else went wrong.",
    );
    const problems = problemsWithSeededBuild({ exitCode: 1, output });
    expect(problems).toHaveLength(PROTECTED_ROOTS.length);
    for (const problem of problems)
      expect(problem).toContain("server-only boundary");
  });

  it("names the protected roots and the fixture it expects", () => {
    // Constants, not incidental strings: if the fixture is renamed and these
    // are not, the gate silently stops matching its own output. `@/lib/prisma`
    // is asserted by name because dropping it back to a one-root gate is the
    // quiet way to undo #2850's second half.
    expect(PROTECTED_ROOTS).toEqual([
      "./src/lib/auth.ts",
      "./src/lib/prisma.ts",
    ]);
    expect(FIXTURE_PAGE).toBe(
      "./src/app/server-only-boundary-selftest/page.tsx",
    );
  });
});

describe("server-only boundary self-test: output parsing", () => {
  it("strips the colour codes Turbopack writes", () => {
    const escape = String.fromCharCode(27);
    const coloured = `${escape}[31m${escape}[1m>${escape}[0m 23 | import`;
    expect(stripAnsi(coloured)).toBe("> 23 | import");
  });

  it("splits on the file:line:col heading Turbopack uses per error", () => {
    const blocks = splitErrorBlocks(REAL_BOUNDARY_BLOCK);
    expect(blocks.map((block) => block.file)).toEqual([
      "./src/lib/auth.ts",
      "./src/lib/prisma.ts",
    ]);
    expect(blocks[0].lines.some((line) => line.includes(BOUNDARY_MESSAGE))).toBe(
      true,
    );
  });

  it("does not treat a bare path mention as an error heading", () => {
    // Import traces name files too. Only a `path:line:col` line on its own
    // starts a block, or every trace entry would split one.
    expect(splitErrorBlocks("./src/lib/auth.ts\n./src/lib/prisma.ts")).toEqual(
      [],
    );
  });
});

describe("server-only boundary self-test: the two root lists", () => {
  it("plants only roots the census also polices", () => {
    // The lists answer different questions - `PROTECTED_ROOTS` is what the
    // build proof plants, `MARKED_ROOTS` is every module carrying the marker -
    // so they are allowed to differ in size. They are NOT allowed to diverge:
    // a root the build proves but the census has never heard of would lose its
    // marker silently the moment the fixture stopped naming it.
    for (const root of PROTECTED_ROOTS) {
      expect(
        MARKED_ROOTS,
        `${root} is planted by the build proof but is not in MARKED_ROOTS, so ` +
          "nothing asserts it still carries the marker",
      ).toContain(root);
    }
  });

  it("names six roots, sorted and without duplicates", () => {
    // A non-vacuity floor for the census that consumes this list: a rename that
    // emptied it, or a copy-paste that duplicated an entry into looking full,
    // would otherwise leave that census checking nothing while staying green.
    expect(MARKED_ROOTS).toHaveLength(6);
    expect(new Set(MARKED_ROOTS).size).toBe(MARKED_ROOTS.length);
    expect([...MARKED_ROOTS].sort()).toEqual(MARKED_ROOTS);
    expect(MARKER_STATEMENT).toBe('import "server-only";');
  });
});

const TEMPORARY_DIRECTORIES = [];
afterAll(() => {
  for (const directory of TEMPORARY_DIRECTORIES) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("server-only boundary self-test: the run-directly guard", () => {
  it("still recognises the plain, unlinked spelling", () => {
    const here = pathToFileURL(
      path.join(process.cwd(), "scripts", "ci", "example.mjs"),
    ).href;
    expect(
      isDirectInvocation(path.join("scripts", "ci", "example.mjs"), here),
    ).toBe(true);
    expect(
      isDirectInvocation(path.join("scripts", "ci", "other.mjs"), here),
    ).toBe(false);
  });

  it("returns false when there is no argv[1] at all", () => {
    expect(isDirectInvocation(undefined, import.meta.url)).toBe(false);
    expect(isDirectInvocation("", import.meta.url)).toBe(false);
  });

  it("recognises a checkout reached through a symlink", () => {
    // The silent-green case, and the reason the guard realpaths BOTH sides.
    // Node resolves `import.meta.url` through the link and hands
    // `process.argv[1]` back as spelled, so comparing the raw strings decides
    // "this file was imported, not run" - and the gate exits 0 without doing
    // anything, while the CI step that runs it reports success. Live on a
    // self-hosted runner whose workspace is a link, on a container bind-mount
    // through one, and on macOS where `/tmp` is itself a symlink.
    const root = mkdtempSync(path.join(tmpdir(), "server-only-selftest-"));
    TEMPORARY_DIRECTORIES.push(root);
    const real = path.join(root, "real");
    mkdirSync(real);
    writeFileSync(path.join(real, "gate.mjs"), "export const x = 1;", "utf8");
    // `"junction"` is what works on Windows without elevation; every other
    // platform ignores the type and makes an ordinary symlink.
    symlinkSync(real, path.join(root, "link"), "junction");

    expect(
      isDirectInvocation(
        path.join(root, "link", "gate.mjs"),
        pathToFileURL(path.join(real, "gate.mjs")).href,
      ),
    ).toBe(true);
  });
});

describe("server-only boundary self-test: the CI step that runs it", () => {
  it("greps for a line this script really prints", () => {
    // The `verify` step asserts the success line rather than trusting the exit
    // code, because a script that never reached `main()` exited 0 in silence
    // and the required check went green on a proof that had not run. That only
    // works while the two strings agree, and nothing else would notice if they
    // stopped: the gate would simply fail every run, or - if the grep were
    // loosened instead - go back to proving nothing.
    const workflow = readFileSync(
      path.join(process.cwd(), ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toContain(`grep -qF '${SUCCESS_PREFIX}'`);
    expect(SUCCESS_PREFIX).not.toContain("'");
  });
});
