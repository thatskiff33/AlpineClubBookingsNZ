/**
 * The zone the SCHEDULER is actually running on, published for the surfaces
 * that report it (CT-5, #2869; epic #2988).
 *
 * ## The two zones, and why reporting the wrong one is a defect
 *
 * `node-cron` reads its `timezone` option when a job is REGISTERED and nothing
 * re-reads it afterwards, so the zone every scheduled job runs on is whatever
 * the boot hook resolved — pinned for the life of the process. The club's
 * PERSISTED zone, meanwhile, can be changed from a web form at any moment. The
 * two are the same almost always and differ in exactly one window: between an
 * admin saving a new zone and the next restart.
 *
 * In that window the admin health page and the AI-diagnostics evidence tool
 * were both reading the LIVE setting and printing it as "expected local time"
 * for around forty job descriptions — asserting an hour no job would fire at.
 * This module is the channel that lets them report the running zone instead,
 * and say plainly when a restart is outstanding.
 *
 * ## Why `globalThis` and not a module-level `let`
 *
 * Next bundles `instrumentation.node.ts` separately from the route handlers, so
 * a value written into a module-level binding by the boot hook is not reliably
 * the same binding a route imports — the same module can exist in both chunks.
 * A `Symbol.for` entry in the global registry is keyed by the PROCESS, which is
 * exactly the scope the fact has: "this Node process registered its cron jobs
 * against X".
 *
 * ## What `null` means, and why it is not a failure
 *
 * `null` means "this process did not register the cron jobs". That is the
 * normal state on a blue/green WEB slot, where the scheduler runs in the cron
 * leader container instead — which is why `/api/deploy/runtime-status` carries
 * the value too, and the admin health route prefers the leader's answer over
 * its own. A reader that has neither must say the zone it shows is the
 * configured one and takes effect on restart, rather than implying it is live.
 */

/** Process-scoped, so a separately-bundled chunk reads the same value. */
const CRON_RUNTIME_ZONE_KEY = Symbol.for(
  "alpineclubbookings.cron-runtime-zone",
);

type CronRuntimeZoneCarrier = {
  [CRON_RUNTIME_ZONE_KEY]?: string;
};

/**
 * Record the zone this process registered its scheduled jobs against.
 *
 * Called once, by the boot hook, immediately after the zone is resolved and
 * before the first `cron.schedule(...)`.
 */
export function publishCronRuntimeZone(zone: string): void {
  (globalThis as CronRuntimeZoneCarrier)[CRON_RUNTIME_ZONE_KEY] = zone;
}

/**
 * The zone this process's scheduled jobs are running on, or `null` when this
 * process is not the one that registered them.
 */
export function readCronRuntimeZone(): string | null {
  const value = (globalThis as CronRuntimeZoneCarrier)[CRON_RUNTIME_ZONE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Test hook: forget the published zone. */
export function __resetCronRuntimeZoneForTests(): void {
  delete (globalThis as CronRuntimeZoneCarrier)[CRON_RUNTIME_ZONE_KEY];
}
