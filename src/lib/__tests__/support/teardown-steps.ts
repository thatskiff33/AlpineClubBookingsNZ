/**
 * Fail-safe teardown for a real-database suite (#5349).
 *
 * A scratch database's teardown is a sequence: disconnect the clients, drop the
 * database, drop its roles, end the admin connection. Run one after another
 * with plain `await`s, the first failure skips the rest, and a skipped role
 * drop outlives the run (roles are server-wide, not per database) while a
 * skipped `end()` leaves a connection open. `database-roles.realdb.test.ts`
 * already catches each drop; this is that shape as one helper, except that it
 * throws at the end, where that suite swallows.
 *
 * Every step is attempted whatever an earlier one did. Each step that fails is
 * logged by name, so the log says what was left behind, and the teardown then
 * throws one `AggregateError` naming them all: a teardown that could not clean
 * up still fails the suite, after it has done everything it could.
 */
export interface TeardownStep {
  /** What the step does, phrased to follow "could not", e.g. `drop role "mm_x_app"`. */
  what: string;
  run: () => unknown;
}

export async function runEveryTeardownStep(label: string, steps: readonly TeardownStep[]): Promise<void> {
  const failures: { what: string; error: unknown }[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push({ what: step.what, error });
      console.warn(`[${label}] teardown could not ${step.what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length === 0) return;
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `[${label}] teardown attempted every step; could not: ${failures.map((failure) => failure.what).join("; ")}`,
  );
}
