# Product configuration

Audience: Developer, Agent.

Prefix defined in this file: **`INV-CONFIG`** — the product stays generic. What
varies between clubs gets a configuration surface rather than a constant, an
upgrade that adds one falls back safely, and an unconfigured state is visible
where an operator has to act.

Read this file when you are adding a value or a feature a club could reasonably
want differently from ours, introducing a new setting that existing deployments
will not have, or deciding whether a question is an owner decision or a
configuration surface you have not recognised yet.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused.

The practical guide to the levers — module toggle, setting, seed default, and
the code change that builds a new surface — is
[`configure-or-fork.md`](../adopters/configure-or-fork.md), which is the one
home for that explanation and is not repeated here.

## INV-CONFIG-001

- **A club-varying value gets a configuration surface, not a constant.** Each
  deployment serves exactly one club, and this repository is the generic
  product: it must never encode which club. The test is *would a different club
  answer this differently?* — if yes, the answer is a module toggle, a setting
  or a seed default. This is about what the code hard-codes, not about runtime
  tenancy; one deployment still serves one club.
- **An upgrade that introduces a setting falls back to a documented default
  rather than hard-failing because the setting is absent.** An existing
  deployment upgrades without an operator having to configure the new value
  first, wherever a safe default exists.
- **Where the operator does have to act, the unconfigured state is visible** —
  the readiness badge, the setup checklist or the system health page — instead
  of failing silently at the point of use.
- Decided on #2717 (a distinct configurable Xero EXPENSE mapping with a safe
  fallback), generalised in #2720. Those issues hold the narrative, the options
  and the rejected alternatives; this entry holds only the rule.

## INV-CONFIG-002

- **The club's civil time is one persisted IANA timezone identifier, and the
  installation's configuration is the only authority for it.** Each installation
  serves one club and holds one zone — `Pacific/Auckland`, `Australia/Sydney`, a
  named place whose daylight-saving rules come from the IANA database. Never an
  abbreviation (`NZT`, `NZST`, `EST`), never a fixed offset (`+12:00`,
  `Etc/GMT-12`), never a legacy single-word alias (`NZ`, `Japan`), and never the
  `Etc/*` or `SystemV/*` namespaces — an abbreviation or an offset names no place,
  so it carries no promise about the rules a future booking will be rostered and
  priced against. It is stored in `ClubTimeSettings` (id `"default"`) and read
  through `getClubTimeZone()` in
  [`club-time-zone-settings.ts`](../../src/lib/club-time-zone-settings.ts);
  validation is [`club-time-zone.ts`](../../src/lib/club-time-zone.ts).
- **`TZ` and `NEXT_PUBLIC_TZ` are a seed, not a second opinion.** They were the
  club timezone before CT-1, so they are what an existing deployment's *current
  effective* zone means and they are the only thing a first boot after the upgrade
  can copy from. Once a value is persisted they are not consulted for the club's
  civil time, so moving the container's clock cannot move the club's. The
  transitional `APP_TIME_ZONE` constant still derives from them for the call sites
  CT-2 to CT-5 have not migrated; CT-6 retires it, and until then
  `club-time-zone-env-agreement.test.ts` pins the two readings together so they
  cannot drift apart while both exist.
- **The machine's timezone is deliberately irrelevant, and the fix is never to
  pin it harder.** A server, container, database session or browser in any zone
  must produce the same club-facing answer. Forcing the process zone would make
  the platform *look* correct on one deployment while leaving the actual
  authority ambiguous.
- **The browser is never the authority.** A viewer in London sees the same club
  time as a viewer in Ohakune. The server resolves the zone and passes the
  identifier down; a client component may list zones as *choices*, and must not
  read `Intl.DateTimeFormat().resolvedOptions().timeZone` to decide the current
  one.
- **An upgrade keeps the zone the deployment was already effectively using.**
  A SQL migration cannot read a process environment, so the migration creates the
  table and seeds nothing: guessing `Pacific/Auckland` there would silently
  reassign the civil time of every club running on another zone. The backfill is
  the create-if-absent `clubTimeZoneSelfHealStep` at boot, which is registered as
  *not* requiring a primary `config/club.json` — the value it copies comes from
  the environment, not from that file, and since #1987 an absent `club.json` is
  normal for a database-first install. `Pacific/Auckland` is the generic New
  Zealand distribution default and applies only where **nothing** was configured.
- **A preservation path uses a different normalisation from an operator's input,
  and the difference is deliberate.** The input validator judges the shape of what
  was typed *before* asking the runtime, so `EST` is refused rather than widened
  into `America/Panama`: an abbreviation names no place, so it promises nothing
  about the next daylight-saving change. A backfill is not approving anybody's
  choice — it is recording a zone a deployment has been running on for years — so
  it probes first and judges the *resolved* identifier, which preserves the
  thirty-six legacy spellings that do name a real place (`GB` to `Europe/London`,
  `NZ-CHAT` to `Pacific/Chatham`). Applying the input rule there substitutes the
  New Zealand default and moves the club, which is the defect two review lenses
  found independently on #2989. Where the environment names **no** place — `UTC`,
  `Etc/GMT` offsets, `SystemV/*` — there is nothing to preserve, and the
  distribution default is recorded (owner decision, 23 Aug 2026: default rather
  than block setup). **A default recorded in place of an unknowable value is
  announced, not assumed**: the backfill warns at boot naming the raw value, and
  the setup checklist reports that state as a warning rather than as a
  configured zone, so the one club this could be wrong for is told. That is
  `INV-CONFIG-001`'s visibility rule applied to a state that is configured but
  guessed, rather than to one that is merely absent.
- **Changing it afterwards is guarded maintenance, and it rewrites nothing.**
  Full Admin only, explicitly confirmed, and audited with the actor and the
  before/after zone and no other payload. No stored instant moves and no
  date-only value changes: what changes is how instants are *displayed* from now
  on and when club-local scheduled work fires. Lodge nights keep the calendar
  dates they already have.
- Decided on #2989 (CT-1) under epic #2988. Those issues hold the narrative and
  the rejected alternatives; this entry holds only the rule. The date-domain
  consequences are `INV-DATE` — in particular the stay boundary in
  [`booking-dates-and-capacity.md`](booking-dates-and-capacity.md), which this
  rule supplies the zone for rather than restates.
