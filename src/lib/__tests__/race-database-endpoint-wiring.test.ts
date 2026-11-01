import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jobBlock, stepBlock } from "./helpers/ci-workflow";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const job = jobBlock(workflow, "migration-drift");
const endpointStepName = "Resolve dedicated race database endpoint";
const endpoint = "postgresql://postgres:postgres@127.0.0.1:${{ job.services.concurrency-race-postgres.ports[5432] }}/concurrency_race_1881";

// INV-SSOT-001: resolve once, validate before any writer, then inherit the URL.
// Every job that stands up the dedicated race service gets the same guard (#4458
// added `realdb-all`, the second).
describe.each(["migration-drift", "realdb-all"])("dedicated CI race database endpoint in %s (#4238)", (jobId) => {
  const raceJob = jobBlock(workflow, jobId);
  const endpointStep = stepBlock(raceJob, endpointStepName);

  it("lets Docker choose a free high loopback port and validates before publishing", () => {
    expect(raceJob, `ci.yml has no ${jobId} job`).not.toBe("");
    const service = raceJob.slice(raceJob.indexOf("      concurrency-race-postgres:"), raceJob.indexOf("\n    env:"));
    expect(service).toContain("127.0.0.1:55442-65535:5432");
    expect(service).toContain("POSTGRES_DB: concurrency_race_1881");
    expect(raceJob).not.toContain("55442:5432");
    expect(raceJob.split(endpoint)).toHaveLength(2);
    expect(endpointStep).toContain(`CONCURRENCY_RACE_DATABASE_URL: ${endpoint}`);
    expect(endpointStep).toContain('import { assertSafeRaceDbUrl } from "./src/lib/__tests__/support/race-db-url"');
    const validate = endpointStep.indexOf('assertSafeRaceDbUrl(process.env.CONCURRENCY_RACE_DATABASE_URL ?? "", "CI endpoint")');
    const publish = endpointStep.indexOf('printf \'CONCURRENCY_RACE_DATABASE_URL=%s\\n\' "$CONCURRENCY_RACE_DATABASE_URL" >> "$GITHUB_ENV"');
    expect(validate, "INV-SSOT-001: reuse the shared refusal guard").toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(validate);
  });

  it("migrates only after the endpoint is resolved, from the resolved URL", () => {
    const migrationName = jobId === "migration-drift" ? "Migrate dedicated advisory-lock race database" : "Migrate dedicated race database";
    const migration = stepBlock(raceJob, migrationName);
    expect(migration).toContain("DATABASE_URL: ${{ env.CONCURRENCY_RACE_DATABASE_URL }}");
    expect(raceJob.indexOf(endpointStepName)).toBeLessThan(raceJob.indexOf(migrationName));
  });
});

describe("dedicated CI race database endpoint (#4238)", () => {
  it("keeps every real proof blocking and on the one resolved service", () => {
    expect(job).toContain("name: Migration drift check");
    expect(job).not.toMatch(/continue-on-error:|if:.*always\(/);
    const migration = stepBlock(job, "Migrate dedicated advisory-lock race database");
    expect(job.indexOf(endpointStepName)).toBeLessThan(job.indexOf("Migrate dedicated advisory-lock race database"));
    expect(migration).toContain("DATABASE_URL: ${{ env.CONCURRENCY_RACE_DATABASE_URL }}");
    for (const name of [
      "Test advisory-lock race protocol against dedicated PostgreSQL",
      "Test member-merge shared-double races against dedicated PostgreSQL",
      "Test page-content delete race against dedicated PostgreSQL",
      "Prove the SELECT-only diagnostics role against dedicated PostgreSQL",
    ]) {
      const step = stepBlock(job, name);
      expect(step).toContain('RUN_CONCURRENCY_RACE_TESTS: "1"');
      expect(step).toContain("run: pnpm exec vitest run");
      expect(step).not.toContain("CONCURRENCY_RACE_DATABASE_URL:");
      expect(step).not.toMatch(/\n\s+if:/);
      expect(job.indexOf(name)).toBeGreaterThan(job.indexOf("Migrate dedicated advisory-lock race database"));
    }
    expect(stepBlock(job, "Back-post a seeded booking history and require the census gate")).toContain(
      'run: bash scripts/booking-ledger-seed-gate.sh "${CONCURRENCY_RACE_DATABASE_URL}_ledger_history"',
    );
  });

  it.each([55442, 55443, 65535])("retains the existing refusal contract at selected port %i", (port) => {
    expect(() => assertSafeRaceDbUrl(`postgresql://postgres:postgres@127.0.0.1:${port}/concurrency_race_1881`, "CI endpoint")).not.toThrow();
  });

  it.each([
    "",
    "postgresql://postgres:postgres@127.0.0.1:/concurrency_race_1881",
    "postgresql://postgres:postgres@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://postgres:postgres@127.0.0.1:55441/concurrency_race_1881",
    "postgresql://postgres:postgres@remote.example:55443/concurrency_race_1881",
    "postgresql://postgres:postgres@127.0.0.1:55443/drift_main",
  ])("refuses missing or unsafe metadata: %s", (url) => {
    expect(() => assertSafeRaceDbUrl(url, "CI endpoint")).toThrow();
  });
});
