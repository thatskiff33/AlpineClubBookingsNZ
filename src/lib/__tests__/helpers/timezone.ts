/**
 * Shared helper for tests that pin `process.env.TZ` (#2485).
 *
 * ## The hazard
 *
 * In Node, `delete process.env.TZ` does **not** return the process to the
 * system's default zone. Node/V8 only re-derives the resolved zone when
 * `process.env.TZ` is ASSIGNED; deleting the variable removes it from the
 * environment but leaves the last-assigned zone cached. Verified empirically
 * (#2485): set `TZ=Pacific/Honolulu`, delete the variable, and every later
 * `Date`/`Intl` call in the same worker still resolves Honolulu.
 *
 * Test files share a worker process (Vitest's isolation resets the module
 * registry per file, not `process.env`), so a suite that pins a zone and then
 * merely deletes it on the way out leaks that zone into whichever suite the
 * runner happens to schedule next — an order-dependent flake with nothing in
 * any diff to blame.
 *
 * ## The fix
 *
 * Never restore by deleting alone. Resolve the REAL starting zone —
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` — before the first
 * assignment, and on the way out:
 *
 * - if `process.env.TZ` started **defined**, assign it back to that exact
 *   value (an assignment always invalidates the cache correctly);
 * - if it started **undefined**, ASSIGN the resolved host zone first (so the
 *   cache is correct), then delete the variable (removing it is safe once the
 *   cache already agrees with the host default).
 *
 * ## Usage
 *
 * Capture once, at module top level or at the top of a `describe` block —
 * before anything in the file has assigned `process.env.TZ` — and restore
 * from an `afterEach/afterAll` or a `finally`:
 *
 * ```ts
 * const hostTimeZone = captureHostTimeZone();
 *
 * afterEach(() => {
 *   hostTimeZone.restore();
 * });
 * ```
 *
 * For a single pinned call, `withTimeZone`/`withTimeZoneAsync` wrap the
 * capture-set-run-restore sequence:
 *
 * ```ts
 * withTimeZone("Pacific/Auckland", () => {
 *   expect(formatSomething(date)).toBe("...");
 * });
 * ```
 *
 * ## When the zone has to move BEFORE the file's imports run
 *
 * Two things in this tree are frozen at module load and cannot be moved by a
 * `beforeEach`: `APP_TIME_ZONE` in `src/config/operational.ts`, and any
 * module-level `new Intl.DateTimeFormat(...)` constant. A suite whose subject is
 * either of those has to pin the zone from a `vi.hoisted` block, which Vitest
 * runs above the imports — and therefore cannot call `captureHostTimeZone`,
 * because the import binding does not exist yet.
 *
 * {@link readHostTimeZone} and {@link restoreHostTimeZone} are that case, split
 * in two so the restore RULE still has exactly one home:
 *
 * ```ts
 * const { ZONE, host } = vi.hoisted(() => {
 *   const zone = "America/Denver";
 *   // Inline, because `vi.hoisted` runs before this file's imports exist.
 *   const host = {
 *     envTz: process.env.TZ,
 *     resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
 *   };
 *   process.env.TZ = zone;
 *   return { ZONE: zone, host };
 * });
 *
 * afterAll(() => {
 *   restoreHostTimeZone(host);
 * });
 * ```
 *
 * Note `afterAll`, not `afterEach`: the pin is installed once, at load, so
 * restoring after every test would leave the second test on the host's zone.
 */

export interface HostTimeZone {
  /**
   * Restore `process.env.TZ` to exactly what it was when captured, forcing
   * Node to re-cache the correct zone rather than merely deleting the
   * variable.
   */
  restore(): void;
}

/**
 * The two readings a restore needs: what `process.env.TZ` held, and what the
 * process was ACTUALLY resolving. Both, because they differ whenever `TZ` is
 * unset — which is the case the naive restore gets wrong.
 */
export interface CapturedHostTimeZone {
  readonly envTz: string | undefined;
  readonly resolvedZone: string;
}

/** Both readings, as data. See the module doc's `vi.hoisted` note. */
export function readHostTimeZone(): CapturedHostTimeZone {
  return {
    envTz: process.env.TZ,
    resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/**
 * Put `process.env.TZ` back to what {@link readHostTimeZone} saw.
 *
 * THE ONE COPY OF THE #2485 RULE. Everything else in this module delegates here,
 * including a suite that had to take the reading by hand inside `vi.hoisted`.
 */
export function restoreHostTimeZone(captured: CapturedHostTimeZone): void {
  if (captured.envTz === undefined) {
    // An assignment is what invalidates Node's cached zone; deleting alone does
    // not. Assign the resolved host zone first so the cache is correct, then
    // remove the variable to match the original environment.
    process.env.TZ = captured.resolvedZone;
    delete process.env.TZ;
  } else {
    process.env.TZ = captured.envTz;
  }
}

/**
 * Capture the process's current `TZ` environment value and its actually
 * resolved zone. Call this BEFORE anything assigns `process.env.TZ`.
 */
export function captureHostTimeZone(): HostTimeZone {
  const captured = readHostTimeZone();

  return {
    restore(): void {
      restoreHostTimeZone(captured);
    },
  };
}

/** Run `run()` with `process.env.TZ` pinned to `timeZone`, then restore. */
export function withTimeZone<T>(timeZone: string, run: () => T): T {
  const hostTimeZone = captureHostTimeZone();
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    hostTimeZone.restore();
  }
}

/**
 * `withTimeZone` for an async `run` — the restore only fires after the
 * returned promise settles, so it is safe to await work (fetches, route
 * handlers) inside `run` without the zone snapping back mid-flight.
 */
export async function withTimeZoneAsync<T>(
  timeZone: string,
  run: () => Promise<T>,
): Promise<T> {
  const hostTimeZone = captureHostTimeZone();
  process.env.TZ = timeZone;
  try {
    return await run();
  } finally {
    hostTimeZone.restore();
  }
}
