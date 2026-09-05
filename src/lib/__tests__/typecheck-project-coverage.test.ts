import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import {
  isProductionFile,
  isRatchetExcludedTestFile,
} from "../../../scripts/lib/file-size-budget";

/**
 * `npm run typecheck` runs three projects: `tsconfig.json` (the app),
 * `tsconfig.test.json` (Vitest tests) and `tsconfig.e2e.json` (the Playwright
 * suite, #2693). Between them they must read every tracked TypeScript file.
 * That was false before #2875: tests under `scripts/__tests__/` sat in neither
 * project, including the tests for the blocking file-size gate.
 *
 * Vitest's extension surface is wider than `.test.ts(x)`. This contract pins
 * the runner's actual default, asks TypeScript which files each project lists
 * as a root, and distinguishes two promises deliberately:
 *
 * - `.ts`, `.tsx`, `.mts` and `.cts` tests are statically typechecked in the
 *   test project and excluded from the app project;
 * - the JavaScript tests Vitest also collects are in NO project. `allowJs` is
 *   off everywhere (#2693); before that they were loaded with `checkJs: false`,
 *   which produced no diagnostics either, so nothing was lost — but the list
 *   is pinned below so a new JavaScript test cannot arrive unnoticed. The
 *   production-graph guard is the one place JavaScript is still followed, and
 *   only to resolve imports from every file covered by the size ratchet.
 *
 * "In a project" here means listed as a ROOT by that project's `include`, which
 * is what `parseJsonConfigFileContent` reports. A file another project reaches
 * through an import (several Vitest suites import `e2e/helpers/*`) is not owned
 * by it, and ownership is what this contract is about.
 */

const ROOT = process.cwd();
const VITEST_DEFAULT_INCLUDE = "**/*.{test,spec}.?(c|m)[jt]s?(x)";
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const PROJECT_SUPPORTED_VITEST_EXTENSIONS = new Set([
  ...TYPESCRIPT_EXTENSIONS,
  ...JAVASCRIPT_EXTENSIONS,
]);

/**
 * Every JavaScript test Vitest collects, by name. Each is a suite for a
 * `scripts/**` tool that runs under a bare `node` in CI, so both the tool and
 * its test stay `.mjs`. They execute in Vitest and are typechecked by nobody —
 * which was already true under `allowJs: true, checkJs: false`. Adding a name
 * here is a deliberate act; the default for a new test is TypeScript.
 */
const JAVASCRIPT_VITEST_TESTS = [
  "scripts/ci/check-doc-index-integrity.test.mjs",
  "scripts/ci/check-pr-body.test.mjs",
  "scripts/ci/check-pr-changelog-fragment.test.mjs",
  "scripts/ci/check-pr-concurrency-declaration.test.mjs",
  "scripts/ci/check-prerendered-script-nonces.test.mjs",
  "scripts/ci/check-website-prerender-manifest.test.mjs",
  "scripts/ci/check-website-render-modes.test.mjs",
  "scripts/ci/check-workflow-suite-checkout-depth.test.mjs",
  "scripts/ci/filter-suppressed-sarif.test.mjs",
  "scripts/ci/render-epic-sync-pr-body.test.mjs",
  "scripts/ci/server-only-boundary-selftest.test.mjs",
  "scripts/issue-thread.test.mjs",
  "scripts/release/compile-changelog.test.mjs",
  "scripts/run-named-tests.test.mjs",
  "scripts/stale-containers.test.mjs",
];

/**
 * JavaScript modules a TypeScript test imports. With `allowJs` off, TypeScript
 * resolves each import to the sibling declaration file named here instead of
 * reading the JavaScript, so a missing sibling is an implicit-`any` import
 * error and a stale one is a lie about the module's surface. Each pair is
 * pinned so the declaration cannot quietly become the only half that exists.
 */
const DECLARED_JAVASCRIPT_MODULES = [
  {
    module: "eslint.config.mjs",
    declaration: "eslint.config.d.mts",
    load: () => import("../../../eslint.config.mjs"),
  },
  {
    module: "load/lib/contention-invariant.js",
    declaration: "load/lib/contention-invariant.d.ts",
    load: () => import("../../../load/lib/contention-invariant.js"),
  },
  {
    module: "scripts/ci/server-only-boundary-selftest.mjs",
    declaration: "scripts/ci/server-only-boundary-selftest.d.mts",
    load: () => import("../../../scripts/ci/server-only-boundary-selftest.mjs"),
  },
  {
    module: "scripts/sync-user-guide-wiki.mjs",
    declaration: "scripts/sync-user-guide-wiki.d.mts",
    load: () => import("../../../scripts/sync-user-guide-wiki.mjs"),
  },
] as const;

/**
 * The runtime export names a declaration file promises: every
 * `export declare const|function NAME`, plus `default` when it has one.
 * `export type` and `export interface` are type-only and have no runtime
 * counterpart, so they are skipped. Any OTHER `export` form (`export { … }`
 * lists, `export declare let|class`, `export * from`) is refused rather than
 * silently ignored — the #3280 delta review appended each of those to a
 * declaration and this parser passed every one, promising names the module
 * never had. Failing closed keeps "exactly" true: add the form here when a
 * declaration genuinely needs it.
 */
function declaredRuntimeExports(declaration: string): string[] {
  const source = readFileSync(path.join(ROOT, declaration), "utf8");
  const unsupported = [
    ...source.matchAll(
      /^export (?!declare (?:const|function) |type |interface |default )(.*)$/gm,
    ),
  ].map((match) => match[0].trim());
  if (unsupported.length > 0) {
    throw new Error(
      `${declaration} uses export forms this parity check does not read, so it ` +
        `cannot say what the module promises: ${unsupported.join(" | ")}. Write ` +
        `\`export declare const|function NAME\` (or \`export default\`), or teach ` +
        `declaredRuntimeExports the form.`,
    );
  }
  const names = [
    ...source.matchAll(/^export declare (?:const|function) ([A-Za-z_$][\w$]*)/gm),
  ].map((match) => match[1]);
  if (/^export default /m.test(source)) names.push("default");
  return names.sort();
}

type ProjectCoverage = {
  files: Set<string>;
  options: ts.CompilerOptions;
  projectReferences: readonly ts.ProjectReference[] | undefined;
};

function repoRelative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/** Repo-relative root paths TypeScript resolves for a project, exactly as tsc would. */
function projectCoverage(configName: string): ProjectCoverage {
  const configPath = path.join(ROOT, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error, `${configName} should parse`).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    ROOT,
    undefined,
    configPath,
  );
  expect(
    parsed.errors,
    `${configName} should resolve without config errors`,
  ).toEqual([]);
  return {
    files: new Set(parsed.fileNames.map(repoRelative)),
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  };
}

/** Tracked files only — `git add` a new file before trusting a local run. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

function isVitestTestFile(file: string): boolean {
  return /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file);
}

/**
 * The only TypeScript files allowed outside every project. Semgrep fixtures
 * are deliberately broken sample code whose only reader is Semgrep's `--test`
 * runner; making them typecheck would stop them being useful fixtures (#2686).
 */
const EXEMPT = new Set([
  ".semgrep/tests/acb-client-server-boundary.tsx",
  ".semgrep/tests/acb-unsafe-raw-sql.ts",
]);

describe("typecheck project coverage", () => {
  const app = projectCoverage("tsconfig.json");
  const test = projectCoverage("tsconfig.test.json");
  const e2e = projectCoverage("tsconfig.e2e.json");
  const projects = [
    ["tsconfig.json", app],
    ["tsconfig.test.json", test],
    ["tsconfig.e2e.json", e2e],
  ] as const;
  const tracked = trackedFiles();
  const trackedTypeScript = tracked.filter((file) =>
    /\.(ts|tsx|mts|cts)$/.test(file),
  );
  const vitestTests = tracked.filter(
    (file) =>
      isVitestTestFile(file) &&
      !file.startsWith("e2e/") &&
      !file.includes("/.claude/"),
  );

  it("pins the Vitest default test/spec extension contract", () => {
    expect(configDefaults.include).toEqual([VITEST_DEFAULT_INCLUDE]);
    const extensionsMatchedByThatGlob = [
      ".js",
      ".jsx",
      ".cjs",
      ".cjsx",
      ".mjs",
      ".mjsx",
      ".ts",
      ".tsx",
      ".cts",
      ".ctsx",
      ".mts",
      ".mtsx",
    ];
    for (const extension of extensionsMatchedByThatGlob) {
      expect(isVitestTestFile(`scripts/example.test${extension}`)).toBe(true);
      expect(isVitestTestFile(`src/example.spec${extension}`)).toBe(true);
    }
  });

  it("reads every tracked TypeScript file in exactly one project", () => {
    const uncovered = trackedTypeScript.filter(
      (file) =>
        !EXEMPT.has(file) &&
        !app.files.has(file) &&
        !test.files.has(file) &&
        !e2e.files.has(file),
    );
    expect(
      uncovered,
      "these tracked TypeScript files are in no tsconfig project, so `npm run typecheck` never reads them",
    ).toEqual([]);

    const shared = trackedTypeScript.filter(
      (file) =>
        [app, test, e2e].filter((project) => project.files.has(file)).length >
        1,
    );
    expect(
      shared,
      "these files are roots of more than one project; ownership must be explicit and non-overlapping",
    ).toEqual([]);
  });

  it("turns allowJs off in every project", () => {
    for (const [name, project] of projects) {
      expect(project.options.allowJs ?? false, `${name} allowJs`).toBe(false);
      expect(project.options.checkJs ?? false, `${name} checkJs`).toBe(false);
    }
  });

  it("puts every supported TypeScript Vitest extension in the test project only", () => {
    const testFiles = vitestTests.filter((file) =>
      TYPESCRIPT_EXTENSIONS.has(path.extname(file)),
    );
    expect(testFiles.length).toBeGreaterThan(1000);
    for (const file of testFiles) {
      expect(
        test.files.has(file),
        `${file} should be in tsconfig.test.json`,
      ).toBe(true);
      expect(
        app.files.has(file),
        `${file} should stay out of tsconfig.json`,
      ).toBe(false);
      expect(
        e2e.files.has(file),
        `${file} should stay out of tsconfig.e2e.json`,
      ).toBe(false);
    }
  });

  it("keeps ratchet-excluded test paths out of the production source graph", () => {
    const productionRoots = tracked
      .filter(isProductionFile)
      .map((file) => path.join(ROOT, file));
    expect(productionRoots.length).toBeGreaterThan(1000);

    // This Program is a module-reachability guard, not an additional
    // typechecking claim. `allowJs` lets it follow every JS-family extension
    // accepted by the ratchet; `checkJs: false` keeps that explicit. It is the
    // only place JavaScript is loaded into a TypeScript program at all, and
    // the projects themselves never do (asserted above).
    const graphOptions: ts.CompilerOptions = {
      ...app.options,
      allowJs: true,
      checkJs: false,
    };
    expect(graphOptions.allowJs).toBe(true);
    expect(graphOptions.checkJs).toBe(false);

    const program = ts.createProgram({
      rootNames: productionRoots,
      options: graphOptions,
      projectReferences: app.projectReferences,
    });
    const importedTestPaths = program
      .getSourceFiles()
      .map((sourceFile) => repoRelative(sourceFile.fileName))
      .filter(isRatchetExcludedTestFile)
      .sort();

    expect(
      importedTestPaths,
      "production app roots import these test-path modules, but the file-size ratchet excludes them from production debt",
    ).toEqual([]);
  }, 30_000);

  it("names every JavaScript Vitest test, and keeps each out of every project", () => {
    const javaScriptTests = vitestTests
      .filter((file) => JAVASCRIPT_EXTENSIONS.has(path.extname(file)))
      .sort();
    expect(
      javaScriptTests,
      "Vitest collects a JavaScript test this contract does not name. Write the new test in TypeScript so it is typechecked; a `.mjs` tool's own suite that must stay JavaScript is added to JAVASCRIPT_VITEST_TESTS deliberately.",
    ).toEqual([...JAVASCRIPT_VITEST_TESTS].sort());
    for (const file of javaScriptTests) {
      for (const [name, project] of projects) {
        expect(
          project.files.has(file),
          `${file} should not be a root of ${name}`,
        ).toBe(false);
      }
    }
  });

  it("pairs every JavaScript module a TypeScript test imports with a sibling declaration", () => {
    for (const { module, declaration } of DECLARED_JAVASCRIPT_MODULES) {
      expect(existsSync(path.join(ROOT, module)), `${module} exists`).toBe(
        true,
      );
      expect(
        existsSync(path.join(ROOT, declaration)),
        `${declaration} exists`,
      ).toBe(true);
      expect(
        app.files.has(declaration),
        `${declaration} is typechecked by tsconfig.json`,
      ).toBe(true);
    }
  });

  it("declares exactly the runtime exports each JavaScript module has", async () => {
    // A declaration is a promise about a module TypeScript never reads. A name
    // the module gained is unreachable until declared; a name it lost arrives as
    // `undefined`. Comparing the two lists makes both a failure here rather than
    // a surprise in whichever suite imports the name.
    for (const { module, declaration, load } of DECLARED_JAVASCRIPT_MODULES) {
      const runtime = Object.keys(await load()).sort();
      expect(
        declaredRuntimeExports(declaration),
        `${declaration} must declare exactly the exports of ${module}`,
      ).toEqual(runtime);
    }
  });

  it("refuses a Vitest-collected extension that TypeScript cannot load", () => {
    const unsupported = vitestTests.filter(
      (file) => !PROJECT_SUPPORTED_VITEST_EXTENSIONS.has(path.extname(file)),
    );
    expect(
      unsupported,
      "Vitest collects these files, but no TypeScript project can load their compound JSX extension. Rename them to .tsx/.jsx or another supported extension.",
    ).toEqual([]);
  });

  it("gives the Playwright suite tsconfig.e2e.json and nothing else", () => {
    const playwright = trackedTypeScript.filter(
      (file) => file.startsWith("e2e/") || file === "playwright.config.ts",
    );
    expect(playwright.length).toBeGreaterThan(50);
    expect(playwright).toContain("playwright.config.ts");
    for (const file of playwright) {
      expect(e2e.files.has(file), `${file} is owned by tsconfig.e2e.json`).toBe(
        true,
      );
      expect(app.files.has(file), `${file} is out of tsconfig.json`).toBe(false);
      expect(test.files.has(file), `${file} is not a Vitest test`).toBe(false);
    }
    // And only that: the e2e project reaches application code through imports,
    // never by listing it.
    const strays = [...e2e.files].filter(
      (file) => !file.startsWith("e2e/") && file !== "playwright.config.ts",
    );
    expect(strays, "tsconfig.e2e.json lists non-Playwright roots").toEqual([]);
    expect(e2e.options.types).toEqual(["node"]);
  });

  it("owns the Vitest config and setup files in the test project", () => {
    for (const file of [
      "vitest.config.mts",
      "vitest.setup.ts",
      "vitest.clock-setup.ts",
    ]) {
      expect(test.files.has(file), `${file} is a test-project root`).toBe(true);
      expect(app.files.has(file), `${file} is out of tsconfig.json`).toBe(false);
    }
  });

  it("covers scripts/__tests__ specifically, which is the #2875 hole", () => {
    const scriptTests = trackedTypeScript.filter(
      (file) => file.startsWith("scripts/") && file.includes("/__tests__/"),
    );
    expect(scriptTests.length).toBeGreaterThan(0);
    for (const file of scriptTests) expect(test.files.has(file)).toBe(true);
  });

  it("is not vacuous: every project resolves a substantial file set", () => {
    expect(trackedTypeScript.length).toBeGreaterThan(3000);
    expect(app.files.size).toBeGreaterThan(1000);
    expect(test.files.size).toBeGreaterThan(1000);
    expect(e2e.files.size).toBeGreaterThan(50);
  });
});
