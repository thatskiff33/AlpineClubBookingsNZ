/**
 * Slicing `.github/workflows/ci.yml` for the guards that pin a step in place.
 *
 * WHY THESE EXIST. Several suites in this repository `describe.skip` themselves
 * when the env var that points them at a real database is absent — the only
 * workable arrangement, because they cannot run in the ordinary `verify` job.
 * The cost is that unwiring their CI step turns them from evidence into a file
 * that can never fail, with every other assertion still green. So each of them
 * is pinned by a guard, and a guard that matches the WHOLE FILE is barely a
 * guard: it passes while the `env:` line has been commented out, while the
 * `run:` step has moved to a job with no PostgreSQL service, and while a
 * `continue-on-error: true` has made the job advisory.
 *
 * `INV-SSOT` (#3030): `jobBlock` was written for
 * `data-migration-verification.realdb.test.ts` (#2418) and a third caller wanted
 * it, so it moved here rather than being copied — which for a guard matters more
 * than usual, since a weaker copy is indistinguishable from the real one at the
 * call site.
 *
 * These are deliberately TEXT slices rather than a YAML parse. The repository
 * has no YAML dependency, the assertions they support are about exact literal
 * wiring, and a parse would have to be kept faithful to Actions' own semantics
 * to be worth anything. What the slicing does buy is scope: an assertion about
 * one job or one step can no longer be satisfied by text somewhere else
 * entirely.
 */

/**
 * The YAML text of one top-level job, from its `  <id>:` line to just before the
 * next top-level job. Scoping matters more than it looks: a `continue-on-error`
 * setting that lands in an unrelated job, or a step that lost its env var, must
 * not read as this job's wiring. Returns "" when the job is absent.
 */
export function jobBlock(workflow: string, jobId: string): string {
  const start = workflow.indexOf(`  ${jobId}:`);
  if (start < 0) return "";
  const rest = workflow.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return rest > -1
    ? workflow.slice(start, start + 1 + rest)
    : workflow.slice(start);
}

/**
 * The YAML text of ONE step, from its `- name: <stepName>` line to just before
 * the next step. Pass a `jobBlock(...)` result rather than the whole file when
 * the step must also be in a particular job — the two questions are separate,
 * and only asking the second is how a step migrates into a job with no database
 * behind a green guard. Returns "" when the step is absent.
 */
export function stepBlock(scope: string, stepName: string): string {
  const start = scope.indexOf(`- name: ${stepName}`);
  if (start < 0) return "";
  const rest = scope.slice(start + 1).indexOf("- name: ");
  return rest > -1 ? scope.slice(start, start + 1 + rest) : scope.slice(start);
}
