import type { AgeTier } from "@prisma/client";
import { clubConfig } from "@/config/club";
import {
  CLUB_TIME_SETTINGS_ID,
  CLUB_TIME_ZONE_FALLBACK,
} from "@/lib/club-time-zone";
import { classifyEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";
import {
  CLUB_CONFIG_LODGE_CAPACITY,
  getDefaultLodgeCapacity,
} from "@/lib/lodge-capacity";
import type { ConfigSelfHealStep, SelfHealDb } from "@/lib/config-self-heal";
import logger from "@/lib/logger";

/**
 * The registered config self-heal step DEFINITIONS (epic #1943 C1/C3/C4/C5, and
 * CT-1 #2989 for the club timezone).
 *
 * Split out of `config-self-heal.ts`, which now holds the contract, the registry
 * and the runner. The two files answer different questions — "what is a step and
 * how does a run work?" there, "what does each setting copy, and from where?"
 * here — and the step docblocks below are long because each one records a
 * production incident or a grain hazard that has to survive the next person.
 *
 * READ `config-self-heal.ts`'s module doc FIRST. It states the guarantees every
 * definition below has to satisfy: create-if-absent only, idempotent,
 * blue/green-safe, best-effort, and gated on a valid primary `config/club.json`
 * unless the step declares `requiresPrimaryClubConfig: false`. It also states
 * the three presence/write GRAIN shapes and which migration each one suits.
 *
 * WHY DEFINITIONS AND NOT ERASED STEPS. Each export here is a typed
 * `ConfigSelfHealStep`; `config-self-heal.ts` runs it through
 * `defineSelfHealStep` and keeps the erased `*SelfHealStep` export under its
 * original name, so every importer and every doc reference still resolves there.
 * The only thing this file imports from it is TYPES, which erase at compile time,
 * so there is no runtime import cycle between the two.
 *
 * Like `config-self-heal.ts`, this module stays free of `server-only`: the
 * out-of-band `npm run config:self-heal` tsx entrypoint pulls it in, and a
 * `server-only` import would abort that script.
 */

// ---------------------------------------------------------------------------
// Registered steps
// ---------------------------------------------------------------------------

// The ClubIdentitySettings singleton row id. Kept as a literal (mirrors
// CLUB_IDENTITY_SETTINGS_ID in `src/lib/club-identity-settings.ts`) so this
// boot module stays free of that module's `server-only` import — the
// out-of-band `npm run config:self-heal` tsx entrypoint imports this file, and
// a `server-only` import would abort it.
const CLUB_IDENTITY_SETTINGS_ID = "default";

interface ClubIdentitySelfHealValue {
  name: string;
  shortName: string | null;
  hutLeaderLabel: string | null;
}

/**
 * Identity step (epic #1943, child C1/#1980 — the fields the
 * 20260717160000_add_club_identity_settings migration added). Copies the
 * effective `config/club.json` identity into the ClubIdentitySettings singleton
 * iff the row is absent — the boot-time equivalent of the create-only seed
 * upsert (`prisma/seed.ts`), which never runs on a `migrate deploy`.
 */
export const clubIdentitySelfHealStepDefinition: ConfigSelfHealStep<ClubIdentitySelfHealValue> = {
  name: "club-identity-settings",
  async isPresent(db) {
    const row = await db.clubIdentitySettings.findUnique({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      select: { id: true },
    });
    return row !== null;
  },
  currentValue() {
    // The EFFECTIVE config identity (mirrors the seed create-only upsert).
    return {
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
    };
  },
  async write(db, value) {
    // Create-if-absent only (`update: {}`). An existing row — including one an
    // admin left partially null — is left untouched.
    await db.clubIdentitySettings.upsert({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      create: { id: CLUB_IDENTITY_SETTINGS_ID, ...value },
      update: {},
      select: { id: true },
    });
  },
};

// The legacy singleton LodgeSettings row id (mirrors LODGE_SETTINGS_ID in
// `src/lib/lodge-settings.ts`). Kept as a literal so this boot module needs no
// import of that file (which statically pulls the Prisma client). In every
// current deployment the club default lodge's capacity lives on this "default"
// row — the legacy-row branch of `updateLodgeSettings` writes it, and
// `loadLodgeCapacityOverride` reads it for the default lodge (own row absent,
// legacy row unlinked or linked to the default lodge) — so this is the row the
// capacity step heals.
const LODGE_SETTINGS_ID = "default";

/**
 * Best-effort resolution of the club default lodge id through the SelfHealDb
 * surface (`db.lodge`). Returns null — never throws — when it cannot be
 * resolved cheaply at boot: no Lodge row exists yet, or a structural test fake
 * omits the `lodge` delegate. A null result degrades the capacity heal to an
 * UNLINKED create (documented residual) rather than failing the step. Uses a
 * dynamic import so this boot module's static graph stays free of `@/lib/lodges`
 * (keeping the out-of-band `npm run config:self-heal` tsx entrypoint light).
 */
async function resolveDefaultLodgeIdSafe(db: SelfHealDb): Promise<string | null> {
  try {
    const { getDefaultLodgeId } = await import("@/lib/lodges");
    return await getDefaultLodgeId(db);
  } catch {
    return null;
  }
}

/**
 * Lodge-capacity step (epic #1943 C2 mechanism, collapse child #1982). Backfills
 * the DEFAULT lodge's `LodgeSettings.capacity` from the current club-config bed
 * total (`CLUB_CONFIG_LODGE_CAPACITY`) — but ONLY when the default lodge would
 * otherwise resolve to 0. #1982 removed the runtime `club.json` capacity
 * fallback, so without this backfill a live upgrade — which runs only
 * `prisma migrate deploy`, never the seed — would drop a Bed-Allocation-off
 * default lodge with no capacity override to capacity 0 and refuse all bookings
 * (the exact tokoroa live-safety outage this child exists to prevent). Because
 * self-heal runs on boot, the DB is populated before the removed fallback can
 * bite.
 *
 * ## The gate — heal ONLY a lodge that would otherwise resolve to 0
 * COLUMN-level presence (unlike the row-level identity step): `isPresent` keys
 * on the `capacity` COLUMN of the default lodge's row, not merely that the row
 * exists — a `LodgeSettings` row may already exist (e.g. carrying
 * `hutLeaderLookaheadDays`) with a null capacity. But a null capacity is NOT
 * always "unpopulated": on this OLD column it can be deliberate admin INTENT.
 * With Bed Allocation ON and >=1 active bed the lodge resolves to its LIVE bed
 * count and a null capacity means "no ceiling — use the bed count" (see
 * `getLodgeCapacityStatus` step 1). Writing the config bed total there would
 * install it as a per-lodge capacity OVERRIDE, which acts as a CEILING: the
 * lodge would silently resolve to `min(beds, total)` — a capacity REDUCTION that
 * violates never-overwrite-admin-intent and the "Bed Allocation on → behaviour
 * unchanged" AC. So the presence probe:
 *   1. an explicit capacity (admin-set OR previously healed) is present → skip;
 *   2. capacity IS NULL but the default lodge already resolves > 0 (Bed
 *      Allocation ON with active beds) → treated as present, NO write (the bed
 *      count is authoritative; a null there is intent, not absence);
 *   3. capacity IS NULL and the lodge resolves to 0 (Bed Allocation OFF, or ON
 *      with zero active beds — the tokoroa case) → heal.
 * The gate reuses `getDefaultLodgeCapacity`, so it can NEVER drift from the
 * frozen capacity-resolution order it mirrors. A resolution failure (e.g. no
 * Lodge row yet) degrades to "resolves to 0" → heal, matching the pre-gate
 * behaviour for an unconfigured install.
 *
 * KNOWN RESIDUAL (deliberate trade-off, see PR #1982): because module-flag read
 * errors are swallowed to defaults (`bedAllocation: false`), a transient flags
 * read failure on a genuinely Bed-Allocation-ON lodge with a deliberate null
 * capacity makes the lodge resolve 0 on that boot, so the heal fires and writes
 * a capping override that later boots will not undo (capacity is then non-null).
 * The failure direction is capacity-REDUCING (never overbooks) and
 * admin-recoverable; degrading a read error to "skip" instead would reopen the
 * cold-boot capacity-0 outage this step exists to prevent, so error→heal was
 * chosen. Revisit only with an explicit flags-read-health signal.
 *
 * ## The write — create-if-absent, null-scoped fill, linked to the default lodge
 * The write create-if-absents the legacy row and then atomically fills capacity
 * ONLY `WHERE capacity IS NULL`, so it tolerates every state safely:
 *   - no row at all               → created with the capacity,
 *   - row present, null capacity   → filled,
 *   - row with an admin-set value  → NEVER overwritten, and
 *   - concurrent (blue/green) boots → the second `updateMany` matches zero rows.
 * It also LINKS the healed row to the club default lodge (`lodgeId`), so its
 * capacity serves ONLY the default lodge and can never leak to an additional
 * lodge that lacks its own row (the #1982 additional-lodge=0 invariant — an
 * UNLINKED legacy row applies club-wide via `loadLodgeCapacityOverride`).
 * Linking is best-effort and null-scoped: a row already linked by migration
 * 20260708000100 is never re-pointed, and an unresolvable default lodge leaves
 * the row unlinked (still capacity-correct for a single-lodge club).
 * The whole-run provenance guard (see the module doc) additionally ensures this
 * only fires from a valid primary `config/club.json`.
 */
export const lodgeCapacitySelfHealStepDefinition: ConfigSelfHealStep<number> = {
  name: "lodge-capacity",
  async isPresent(db) {
    // A 0-bed primary config has nothing meaningful to persist. Report
    // already-present (mirrors the facebookUrl step's `currentFacebookUrl()
    // === null` short-circuit) so the runner never records a phantom "healed"
    // for a write that would no-op; it self-heals later once the config gains
    // beds. Kept here (not only in write) for log honesty.
    if (!Number.isFinite(CLUB_CONFIG_LODGE_CAPACITY) || CLUB_CONFIG_LODGE_CAPACITY <= 0) {
      return true;
    }
    const row = await db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
      select: { capacity: true },
    });
    // (1) An explicit capacity — admin-set or previously healed — is present.
    if (row?.capacity != null) return true;
    // capacity IS NULL. (2)/(3): heal ONLY when the default lodge would
    // otherwise resolve to 0. When it already resolves > 0 (Bed Allocation on
    // with active beds), the null is deliberate "use the bed count" intent and
    // writing a capping override would silently reduce capacity — so skip. The
    // resolved figure comes from the frozen capacity-resolution order.
    try {
      const resolved = await getDefaultLodgeCapacity(
        db as unknown as Parameters<typeof getDefaultLodgeCapacity>[0],
      );
      return resolved > 0;
    } catch {
      // Unresolvable (e.g. no Lodge row yet) → treat as unconfigured → heal.
      return false;
    }
  },
  currentValue() {
    // The current EFFECTIVE club-config bed total (clubConfig.beds.reduce).
    return CLUB_CONFIG_LODGE_CAPACITY;
  },
  async write(db, value) {
    // Guarded by isPresent (a 0-bed config reports already-present); retained as
    // a defensive backstop that can never persist a non-positive capacity.
    if (!Number.isFinite(value) || value <= 0) return;
    // Resolve the default lodge id up front so both the create and the
    // null-scoped link below point the healed row at the default lodge.
    const defaultLodgeId = await resolveDefaultLodgeIdSafe(db);
    // Create-if-absent the legacy default row (mirrors the create-only upsert
    // the seed / updateLodgeSettings use: `update: {}` never touches an existing
    // row), then fill the capacity column atomically and only while still null.
    await db.lodgeSettings.upsert({
      where: { id: LODGE_SETTINGS_ID },
      create: { id: LODGE_SETTINGS_ID, capacity: value, lodgeId: defaultLodgeId },
      update: {},
      select: { id: true },
    });
    await db.lodgeSettings.updateMany({
      where: { id: LODGE_SETTINGS_ID, capacity: null },
      data: { capacity: value },
    });
    // Link an UNLINKED legacy row to the default lodge (null-scoped, so a row
    // already linked by migration 20260708000100 is never re-pointed). Only
    // when the default lodge id was resolvable; otherwise the row stays unlinked
    // (documented residual).
    if (defaultLodgeId) {
      await db.lodgeSettings.updateMany({
        where: { id: LODGE_SETTINGS_ID, lodgeId: null },
        data: { lodgeId: defaultLodgeId },
      });
    }
  },
};

/** The effective config Facebook URL, trimmed to null when blank/absent. */
function currentFacebookUrl(): string | null {
  const trimmed = clubConfig.socialLinks?.facebook?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Facebook-URL step (epic #1943, child C5/#1984 — the `facebookUrl` column the
 * 20260717220000_add_club_identity_facebook_url migration added to the SAME
 * ClubIdentitySettings singleton). Backfills the column from the effective
 * `config/club.json socialLinks.facebook` iff the column is still null.
 *
 * ## Why this needs COLUMN-level (not row-level) presence semantics
 * The C1 identity step above is row-level create-if-absent: once the row exists
 * it is never touched. But `facebookUrl` is a NEW column added long after the row
 * (C1 created it with name/shortName/hutLeaderLabel only), so a create-if-absent
 * row-level check would skip every existing install and the column would never
 * backfill. This step therefore keys presence on the COLUMN: `isPresent` is true
 * only when `facebookUrl` is already non-null.
 *
 * ## Why column-level backfill still honours "never overwrite admin intent"
 * The never-overwrite guarantee protects a value an admin deliberately set (or an
 * intentional null they left on a field that EXISTED when they edited). A null
 * `facebookUrl` on a row created before this migration CANNOT be admin intent —
 * the column did not exist when any prior edit was made, so its null is purely
 * "column absent / never populated", exactly the migration-completion case
 * self-heal exists for. The write is additionally guarded so it can only ever
 * fill a null:
 *   - `isPresent` skips the write once the column is non-null (admin-set OR
 *     already-healed), so a configured value is never re-touched;
 *   - the backfill is an atomic `updateMany` scoped to `facebookUrl: null`, so it
 *     cannot clobber a value written between the presence read and the write
 *     (an admin edit or a concurrent booter), and cannot overwrite a non-null;
 *   - it only runs at all when the effective config actually has a Facebook URL,
 *     and only under the run-level primary-config provenance guard.
 * A later intentional admin CLEAR to null is a documented residual: because a
 * null column and a set-from-config column resolve to the identical value today
 * (the resolver falls back to the same `club.json` link), a re-heal is
 * value-preserving at heal time. See the carry-forward note in the PR.
 *
 * ## Order-independence with the identity step
 * The write is a full create-if-absent of the identity row (name/shortName/
 * hutLeaderLabel + facebookUrl) followed by the null-scoped backfill, so the two
 * steps produce the same final row in EITHER execution order: whichever runs
 * first creates the row from the same effective config; the other then no-ops its
 * create (`update: {}`) and, for this step, backfills only its own null column.
 */
export const clubFacebookUrlSelfHealStepDefinition: ConfigSelfHealStep<string | null> = {
  name: "club-identity-facebook-url",
  async isPresent(db) {
    // Nothing to backfill when the effective config has no Facebook URL.
    if (currentFacebookUrl() === null) return true;
    const row = await db.clubIdentitySettings.findUnique({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      select: { facebookUrl: true },
    });
    return row?.facebookUrl != null;
  },
  currentValue() {
    return currentFacebookUrl();
  },
  async write(db, value) {
    if (value === null) return; // guarded by isPresent; defensive.
    // 1) Ensure the singleton row exists (create-if-absent). Mirrors the identity
    //    step's create-only upsert so this step is order-independent w.r.t. it —
    //    an existing row is left untouched (`update: {}`).
    await db.clubIdentitySettings.upsert({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      create: {
        id: CLUB_IDENTITY_SETTINGS_ID,
        name: clubConfig.name,
        shortName: clubConfig.shortName ?? null,
        hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
        facebookUrl: value,
      },
      update: {},
      select: { id: true },
    });
    // 2) Backfill the column ONLY while it is still null — atomic, so it can
    //    never overwrite an admin-set value or a concurrent booter's write.
    await db.clubIdentitySettings.updateMany({
      where: { id: CLUB_IDENTITY_SETTINGS_ID, facebookUrl: null },
      data: { facebookUrl: value },
    });
  },
};

/**
 * One `AgeTierSetting` row to create when the table is empty. Mirrors the seed's
 * create-if-missing tier rows (`prisma/seed.ts` `seedAgeTierSettings` +
 * `ageTierSetting.upsert`).
 */
interface AgeTierSelfHealRow {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  sortOrder: number;
}

/**
 * Age-tier step (epic #1943, child C4 / issue #1983). Once `age-tier.ts` drops
 * its `config/club.json` fallback and reads age tiers DB-only, a live fork that
 * never re-runs the seed on a `migrate deploy` could otherwise be left with an
 * EMPTY `AgeTierSetting` table and no source of tiers. This step guarantees a
 * primary-config boot populates the table from the effective config tiers so
 * the fork can never end up with zero tiers.
 *
 * Contract differences from the identity singleton step:
 * - **Presence is table-empty, not a fixed id.** The write is skipped whenever
 *   ANY row already exists, so an admin who edited or pruned tiers is never
 *   touched (never-overwrite guarantee at the whole-table grain).
 * - **Atomic multi-row create-if-absent.** When empty, ALL configured tiers are
 *   written in a SINGLE `$transaction` of create-only `upsert({ update: {} })`
 *   calls keyed on the unique `tier`, mirroring the seed rows exactly. The write
 *   is all-or-nothing by necessity: presence is guarded at the whole-table grain
 *   (`findFirst`) but the write spans several rows, so a per-row loop that failed
 *   partway would leave a PARTIAL set (e.g. INFANT+CHILD only) that the next
 *   boot's table-empty check mistakes for "present" and skips forever — wedging
 *   the fork on an incomplete tier table. Wrapping the batch in one transaction
 *   guarantees an interrupted heal rolls back to an EMPTY table so the presence
 *   check retries cleanly next boot (the clean-retry property). Concurrent
 *   blue/green boots that both observe the table empty are safe: the create-only
 *   upsert never overwrites, and a raced INSERT that surfaces as P2002 rolls the
 *   whole transaction back and is caught by the runner as already-present.
 *
 * Scope note: this heals TIERS only. Nightly RATES live independently in
 * `MembershipTypeSeasonRate` (the authoritative runtime rate source, #1930 E4)
 * and are NOT self-healed here — the seed's tier block writes only
 * `AgeTierSetting`, so this mirrors it exactly.
 */
export const ageTierSelfHealStepDefinition: ConfigSelfHealStep<AgeTierSelfHealRow[]> = {
  name: "age-tier-settings",
  async isPresent(db) {
    // Table-empty presence: any existing row means the table is populated (an
    // admin edit / prior seed) and MUST NOT be touched.
    const existing = await db.ageTierSetting.findFirst({ select: { tier: true } });
    return existing !== null;
  },
  currentValue() {
    // The EFFECTIVE config tiers (mirrors `seedAgeTierSettings` in
    // prisma/seed.ts). Only reached when provenance === "primary" (the run
    // guard), so `clubConfig` is the fork's real config, never a fallback.
    return clubConfig.ageTiers.map((tier, sortOrder) => ({
      tier: tier.id as AgeTier,
      minAge: tier.minAge,
      maxAge: tier.maxAge,
      label: tier.label,
      subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
      familyGroupRequestCreateMemberAllowed:
        tier.familyGroupRequestCreateMemberAllowed,
      sortOrder,
    }));
  },
  async write(db, rows) {
    // ATOMIC multi-row write (see the step docblock's grain note). Presence is
    // guarded at the whole-table grain but the write spans several rows, so the
    // batch MUST be all-or-nothing — a per-row loop failing partway would leave
    // a partial set the next boot mistakes for "present". Each element is the
    // same create-if-absent upsert the seed uses (`prisma/seed.ts`
    // seedAgeTierSettings), keyed on the unique `tier`, so an existing tier is
    // never overwritten. `$transaction` gives all-or-nothing: an interrupted
    // heal rolls back to an empty table (clean retry next boot), and a raced
    // blue/green INSERT that surfaces as P2002 rolls the whole batch back and is
    // caught by the runner as already-present.
    await db.$transaction(
      rows.map((row) =>
        db.ageTierSetting.upsert({
          where: { tier: row.tier },
          create: row,
          update: {},
          select: { tier: true },
        }),
      ),
    );
  },
};

/**
 * What a create-if-absent writer should record for the club timezone, decided
 * once so the boot backfill and the seed cannot answer it differently.
 *
 * `prisma/seed.ts` claims its row is "identical to the boot backfill … so a
 * seed-created row and a boot-healed row hold byte-identical values" (the #1984
 * parity standard). That claim used to rest on both files calling the same
 * resolver with the same argument, which is exactly the arrangement that drifted
 * in the identity/facebookUrl pair before it. Sharing the DECISION makes the
 * parity true by construction instead of by inspection.
 *
 * A ZONE IS ALWAYS RECORDED (owner decision, 23 Aug 2026, on #2989). What varies
 * is where it came from, and the caller must say which — see `kind`:
 *
 * - `preserved` — the environment names a real place → record THAT place. `raw`
 *   is what the environment literally said, so a caller can log the
 *   interpretation when the two differ (`GB` → `Europe/London`).
 * - `absent` — the environment says nothing at all → record
 *   `CLUB_TIME_ZONE_FALLBACK`. This is the "truly unset legacy install" the
 *   issue's default is for, and it needs no comment: nobody is being moved.
 * - `defaulted` — the environment says something that names no place (`UTC`,
 *   `Etc/GMT-12`, `SystemV/EST5`) → record `CLUB_TIME_ZONE_FALLBACK` too, and
 *   SAY SO. This branch used to record nothing and leave the setup checklist
 *   blocked, on the reasoning that every candidate zone is a guess. The owner
 *   settled it the other way: for such an input the issue's own requirement 2
 *   ("back-fill from the zone the deployment is effectively using") and
 *   requirement 3 ("never store an offset or an abbreviation") cannot both be
 *   honoured, because the zone in use is not a storable club timezone — so the
 *   platform defaults rather than leaving the setting empty and blocking setup.
 *   `raw` is the value that could not be used.
 *
 * DEFAULTING IS NOT SILENCE, and this type exists to stop it becoming so. A club
 * genuinely running on `UTC` has just been handed a zone up to thirteen hours
 * from its own, and from CT-2 onward that recorded value is what drives every
 * displayed time — so `defaulted` is a distinct answer from `absent` even though
 * both write the same string. Every caller must tell an operator which happened:
 * the boot backfill logs a warning naming `raw`, the seed prints one, and the
 * setup checklist reports the step as a WARNING asking for confirmation rather
 * than a clean "complete". A caller that treats the two alike is the defect this
 * discriminator is here to make visible.
 *
 * WHY NOT `resolveClubTimeZone(null, seed)`, which is what both callers did
 * before (#2989 review, found independently by two lenses). That runs the
 * OPERATOR-INPUT validator over a value whose only job is to be preserved —
 * `normaliseClubTimeZoneForPreservation`'s docblock is the single home for that
 * distinction and the forty-one measured values behind it. What it cost HERE is
 * the part worth repeating: `GB`, `NZ-CHAT` and `EST5EDT` all landed on
 * `Pacific/Auckland`, create-if-absent wrote it once and never revisited it, and
 * `/admin/setup` then reported the step COMPLETE naming a zone the club had
 * never been in. That class is untouched by the owner's decision and is still
 * `preserved`: only the residual "names no place" class defaults.
 *
 * Pure — no logging, no database, no clock — so both callers can log in their own
 * idiom (the boot step through the app logger, the seed through `console`) and
 * the decision itself is unit-testable on its own.
 */
export type ClubTimeZoneBackfillDecision = {
  /** Where {@link ClubTimeZoneBackfillDecision.timeZone} came from. */
  kind: "preserved" | "absent" | "defaulted";
  /** The zone to write. Always a valid named IANA identifier, never null. */
  timeZone: string;
  /** What the environment said. Null only for `absent`. */
  raw: string | null;
};

export function decideClubTimeZoneBackfill(): ClubTimeZoneBackfillDecision {
  const seed = classifyEnvironmentClubTimeZoneSeed();
  switch (seed.kind) {
    case "preserved":
      return { kind: "preserved", timeZone: seed.timeZone, raw: seed.raw };
    case "absent":
      return { kind: "absent", timeZone: CLUB_TIME_ZONE_FALLBACK, raw: null };
    case "unusable":
      return { kind: "defaulted", timeZone: CLUB_TIME_ZONE_FALLBACK, raw: seed.raw };
  }
}

/**
 * Club-timezone step (CT-1, #2989; epic #2988). Persists the zone this
 * deployment is ALREADY effectively using, once, so that an upgrade changes
 * nobody's civil time.
 *
 * ## Why this cannot be a migration or a seed
 * A production upgrade runs `prisma migrate deploy` and nothing else: the seed
 * does not run, and SQL cannot read `process.env.TZ`. Before CT-1 the club's
 * timezone WAS `TZ` / `NEXT_PUBLIC_TZ` (via `APP_TIME_ZONE` in
 * `src/config/operational.ts`), so the only place that can copy an existing
 * deployment's current effective zone into the new `ClubTimeSettings` row is a
 * boot-time backfill. That is why the 20260822010000 migration deliberately
 * creates the table with NO row and `timeZone` with NO `@default`: the row's
 * existence is the "this club has a configured timezone" signal, and inventing a
 * default in SQL would silently move a club that has been running on, say,
 * `Australia/Sydney` to New Zealand.
 *
 * ## Grain: shape 1 (new table / fixed-id singleton → ROW-LEVEL)
 * `isPresent` asks whether the ROW exists; `write` is a single create-if-absent
 * upsert (`update: {}`). One row, one write, nothing can be half-written, and an
 * existing row — whether written by setup, by the Full-Admin maintenance
 * surface, by the seed, or by an earlier boot — is NEVER touched. That is what
 * makes `TZ` seed-only: once the row exists, moving the container's clock cannot
 * move the club's civil time (INV-CONFIG-002).
 *
 * ## Why it opts OUT of the primary-config fallback guard
 * `requiresPrimaryClubConfig: false`, and this is deliberate on two counts.
 * First, the guard exists to stop a placeholder value from `club.example.json` or
 * `SAFE_DEFAULT_CONFIG` being frozen into a DB-first row — but this step reads
 * neither file. Its source is the ENVIRONMENT, whose value is equally true (or
 * equally absent) whatever state `config/club.json` is in, so gating it on that
 * file's provenance would protect nothing. Second, gating it would break the very
 * installs it exists for: since #1987 configuration lives in the database and an
 * absent `config/club.json` is NORMAL, so provenance is routinely not
 * `"primary"` on a perfectly healthy install — those installs would never be
 * backfilled and would silently fall back to the generic NZ default forever.
 *
 * ## The value
 * {@link decideClubTimeZoneBackfill} — the zone this deployment is ALREADY
 * effectively using, or the documented default where that cannot be read. The
 * environment is read at heal time, never captured at import, so the value
 * cannot go stale on a long-running image. `updatedByMemberId` is null because a
 * boot has no actor — the same treatment every column of that shape gets on the
 * writes this module and the setup CLI own.
 *
 * ## When the environment names no place, this step records the default AND WARNS
 * `TZ=UTC` (or `Etc/GMT-12`, or `SystemV/EST5`) is a real misconfiguration for a
 * club: those are not places, they carry no daylight-saving rules, and no club's
 * civil time is one of them. This step used to record nothing at all for them and
 * leave the setup checklist blocked. The owner decided otherwise on 23 Aug 2026
 * (#2989): it records `Pacific/Auckland` rather than leaving the setting empty
 * and blocking setup — and, because that club may be up to thirteen hours from
 * the zone it was handed, it logs a warning naming both the raw environment value
 * and what was written in its place. The setup checklist reports the same state
 * as a warning asking the operator to confirm, so the two surfaces agree.
 *
 * The warning is emitted from `currentValue`, which the runner calls ONLY on the
 * boot that actually writes the row (`heal` = `write(db, currentValue())`). So a
 * club that has already chosen its timezone never sees it — `isPresent` answers
 * true from the row before the environment is even classified, which is what
 * makes a warning here mean "this value was just invented", never "your
 * configuration is wrong".
 *
 * ## And when it DOES name a place, this step says which one it recorded
 * `GB` is `Europe/London` and `NZ-CHAT` is `Pacific/Chatham`; the value stored
 * is the place, not the spelling the environment used. This is the only
 * self-heal step that can substitute a different value for its source, so the
 * interpretation is logged where an operator reading a deploy log will meet it.
 */
export const clubTimeZoneSelfHealStepDefinition: ConfigSelfHealStep<string> = {
  name: "club-time-zone",
  requiresPrimaryClubConfig: false,
  async isPresent(db) {
    const row = await db.clubTimeSettings.findUnique({
      where: { id: CLUB_TIME_SETTINGS_ID },
      select: { id: true },
    });
    // The club's own choice, whatever the environment says. Nothing else is
    // consulted, so a configured club is never warned at.
    return row !== null;
  },
  currentValue() {
    const decision = decideClubTimeZoneBackfill();
    if (decision.kind === "defaulted") {
      logger.warn(
        {
          scope: "config-self-heal",
          step: "club-time-zone",
          environmentTimeZone: decision.raw,
          clubTimeZone: decision.timeZone,
        },
        `Config self-heal recorded the club timezone as ${decision.timeZone} ` +
          `BY DEFAULT: TZ / NEXT_PUBLIC_TZ is "${decision.raw}", which is not ` +
          `a named place such as Pacific/Auckland or Europe/London. UTC, GMT ` +
          `and fixed offsets carry no daylight-saving rules, so no club's ` +
          `civil time can be read from one and there was nothing to preserve. ` +
          `If this club is not in ${decision.timeZone} an administrator must ` +
          `set the club's timezone at /admin/club-time (or run npm run setup) ` +
          `— it decides which day a lodge night falls on. The setup checklist ` +
          `reports this step as a warning until somebody confirms it.`,
      );
    } else if (decision.raw !== null && decision.raw !== decision.timeZone) {
      logger.info(
        {
          scope: "config-self-heal",
          step: "club-time-zone",
          environmentTimeZone: decision.raw,
          clubTimeZone: decision.timeZone,
        },
        `Config self-heal is recording the club timezone as ` +
          `${decision.timeZone}, read from TZ / NEXT_PUBLIC_TZ as ` +
          `"${decision.raw}" — the same place, named the way this runtime ` +
          `spells it.`,
      );
    }
    return decision.timeZone;
  },
  async write(db, value) {
    // Defensive, and cheap: `ClubTimeSettings.timeZone` is NOT NULL, so a future
    // refactor that let an empty value reach here would fail at the database
    // rather than at the one line that can still refuse it.
    if (!value) return;
    // Create-if-absent only (`update: {}`): an existing row is the club's own
    // choice and must survive every future boot untouched.
    await db.clubTimeSettings.upsert({
      where: { id: CLUB_TIME_SETTINGS_ID },
      create: {
        id: CLUB_TIME_SETTINGS_ID,
        timeZone: value,
        updatedByMemberId: null,
      },
      update: {},
      select: { id: true },
    });
  },
};
