import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CHANGE_SCOPES, decideScope, pullRequestChangedFiles, touchesAny } from "./change-scope.mjs";
import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const workflow = parseWorkflowYaml(readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8"));
const needed = (scope, files) => touchesAny(files, CHANGE_SCOPES[scope].triggers, CHANGE_SCOPES[scope].subject).needed;

function cli(args, env) {
  const output = path.join(mkdtempSync(path.join(tmpdir(), "change-scope-")), "out");
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "change-scope.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  return { stdout: result.stdout, output: readFileSync(output, "utf8") };
}

describe("change-scope: which pull requests can skip a required job's heavy steps (#4425)", () => {
  it("runs whenever git had to quote a changed path (a quoted path can't be matched reliably)", () => {
    expect(needed("migrations", ['"prisma/migrations/a\\"b/migration.sql"'])).toBe(true);
    expect(needed("image", ['"Docker\\tfile"'])).toBe(true);
  });

  it.each([
    [["prisma/schema.prisma"], true],
    [["prisma/migrations/20261026000000_x/migration.sql"], true],
    [["src/lib/__tests__/concurrency-lock-races.realdb.test.ts"], true],
    [["src/lib/__tests__/helpers/real-db.ts"], true],
    [["scripts/check-partial-indexes.sh"], true],
    [["pnpm-lock.yaml"], true],
    [[".github/workflows/ci.yml"], true],
    [["scripts/ci/change-scope.mjs"], true],
    [["docs/a.md", "src/app/page.tsx", "src/lib/booking.ts"], false],
    [[".github/workflows/e2e.yml"], false],
  ])("migrations: %j -> needed %s", (files, expected) => {
    expect(needed("migrations", files)).toBe(expected);
  });

  // The owner's list (decision of 26 Oct 2026 on #4425), plus the classifier itself.
  it.each([
    [["package.json"], true],
    [["pnpm-lock.yaml"], true],
    [["pnpm-workspace.yaml"], true],
    [["patches/next@16.0.0.patch"], true],
    [["Dockerfile"], true],
    [["docker-compose.yml"], true],
    [["docker-compose.e2e.yml"], true],
    [[".dockerignore"], true],
    [[".trivyignore"], true],
    [["scripts/ci/first-install-smoke.mjs"], true],
    [["prisma/seed.ts"], true],
    [[".env.example"], true],
    [["prisma/demo-seed.ts"], false],
    [[".github/workflows/ci.yml"], true],
    [["scripts/ci/pr-body.mjs"], true],
    [["src/lib/booking.ts", "prisma/schema.prisma", "docs/a.md"], false],
    [["deploy/Dockerfile"], false],
    [["src/package.json"], false],
  ])("image: %j -> needed %s", (files, expected) => {
    expect(needed("image", files)).toBe(expected);
  });

  it("an empty or missing change list runs", () => {
    expect(needed("image", [])).toBe(true);
    expect(needed("migrations", undefined)).toBe(true);
  });

  it("fails toward running: a push, a listing error or a garbled answer all run", () => {
    const skip = () => ({ needed: false, reason: "nothing" });
    expect(decideScope("pull_request", skip, () => ["docs/a.md"]).needed).toBe(false);
    expect(decideScope("push", skip, () => ["docs/a.md"]).needed).toBe(true);
    expect(decideScope("schedule", skip, () => ["docs/a.md"]).needed).toBe(true);
    expect(decideScope(undefined, skip, () => ["docs/a.md"]).needed).toBe(true);
    expect(decideScope("pull_request", skip, () => { throw new Error("shallow clone"); }).needed).toBe(true);
    expect(decideScope("pull_request", () => { throw new Error("bad pattern"); }, () => []).needed).toBe(true);
    expect(decideScope("pull_request", () => ({ needed: "false" }), () => []).needed).toBe(true);
    expect(decideScope("pull_request", () => undefined, () => []).needed).toBe(true);
  });

  it("reads a merge commit's change with the shared reader, a rename as both paths, and refuses a non-merge HEAD", () => {
    const files = pullRequestChangedFiles({
      run: () => "merge base head\n",
      diff: () => "M\tdocs/a.md\nR100\tprisma/old.sql\tdocs/new.md\n",
    });
    expect(files).toEqual(["docs/a.md", "prisma/old.sql", "docs/new.md"]);
    expect(needed("migrations", files)).toBe(true);
    expect(() => pullRequestChangedFiles({ run: () => "only-one-commit parent\n", diff: () => "" })).toThrow(/two-parent merge/);
  });

  it("the CLI writes needed=true on a push and for an unknown or missing scope", () => {
    expect(cli(["image"], { GITHUB_EVENT_NAME: "push" }).output).toBe("needed=true\n");
    expect(cli(["imag"], { GITHUB_EVENT_NAME: "pull_request" }).output).toBe("needed=true\n");
    expect(cli([], { GITHUB_EVENT_NAME: "pull_request" }).output).toBe("needed=true\n");
    expect(cli(["toString"], { GITHUB_EVENT_NAME: "pull_request" }).output).toBe("needed=true\n");
  });
});

// The required jobs that skip on a scope. Each must keep its required name,
// take no job-level condition, decide in an unconditional step, and skip only
// on an explicit `needed=false` - so a missing answer runs everything.
describe("ci.yml's scoped required jobs", () => {
  const SKIP = "steps.scope.outputs.needed != 'false'";
  // Only steps that read nothing but prisma/, the migrations and their own test
  // files may skip. A real-Postgres proof that imports app code (the race
  // harness, the diagnostics role, the back-post census, the school naming
  // races) must run on every pull request: nothing else runs it before main
  // (#4433 review).
  const MIGRATION_ONLY_STEPS = new Set([
    "Create shadow database",
    "Test guarded Xero member-grouping migration against PostgreSQL",
    "Test ManualRefundTask money constraints against PostgreSQL",
    "Check migrations reproduce schema.prisma",
    "Apply migrations to the drift database",
    "Check partial indexes match the manifest",
    "Verify data migrations against PostgreSQL",
    "Prove the school backfill refuses an unclassified row",
  ]);
  const JOBS = [
    { id: "migration-drift", name: "Migration drift check", scope: "migrations", skippable: MIGRATION_ONLY_STEPS },
    { id: "data-migration-verification", name: "Data migration verification", scope: "migrations", skippable: MIGRATION_ONLY_STEPS },
    { id: "docker-image-security", name: "Image security gate (Trivy CRITICAL)", scope: "image", skippable: null },
  ];

  it.each(JOBS)("$name has no needs/if and skips only after its scope step, only on needed=false", ({ id, name, scope, skippable }) => {
    const job = workflow.jobs[id];
    expect(job.name).toBe(name);
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    const at = job.steps.findIndex((step) => step.id === "scope");
    expect(at).toBeGreaterThan(0);
    expect(job.steps[at].run).toBe(`node scripts/ci/change-scope.mjs ${scope}`);
    expect(job.steps[at].if).toBeUndefined();
    expect(job.steps[at]["continue-on-error"]).toBeUndefined();
    // The diff needs the merge commit's base parent.
    const depth = Number(job.steps.find((step) => step.uses?.startsWith("actions/checkout"))?.with?.["fetch-depth"]);
    expect(depth === 0 || depth >= 2).toBe(true);
    job.steps.slice(0, at).forEach((step) => expect(step.if, step.name).toBeUndefined());
    job.steps.slice(at + 1).forEach((step) =>
      expect(step.if, step.name).toBe(skippable === null || skippable.has(step.name) ? SKIP : undefined),
    );
    // The heavy steps are still there to run.
    expect(job.steps.slice(at + 1).filter((step) => step.if === SKIP).length).toBeGreaterThan(skippable === null ? 3 : 1);
  });

  it("the Trivy CRITICAL gate itself still blocks whenever it runs", () => {
    const gate = workflow.jobs["docker-image-security"].steps.find((step) => step.name?.startsWith("Trivy CRITICAL gate"));
    expect(gate["continue-on-error"]).toBeUndefined();
    expect(gate.with["exit-code"]).toBe("1");
  });

  // A file a migration job's step names that the scope cannot see would be
  // skipped when only it changed, so a new step's harness must join the list.
  it("the migrations scope matches every repository file the two migration jobs' steps name", () => {
    const named = new Set();
    for (const { id, scope } of JOBS) {
      if (scope !== "migrations") continue;
      for (const step of workflow.jobs[id].steps) {
        for (const [file] of String(step.run ?? "").matchAll(/(?:\.\/)?\b(?:src|scripts|prisma)\/[\w./-]+/g)) {
          named.add(file.replace(/^\.\//, ""));
        }
      }
    }
    const files = [...named].filter((file) => existsSync(path.join(root, file)));
    expect(files.length).toBeGreaterThan(10);
    const unmatched = files.filter((file) => !CHANGE_SCOPES.migrations.triggers.some((pattern) => pattern.test(file)));
    expect(unmatched).toEqual([]);
  });
});
