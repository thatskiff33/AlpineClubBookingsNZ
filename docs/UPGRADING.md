# Upgrading

This guide is for **downstream forks and adopters** of AlpineClubBookingsNZ that
run their own deployment (for example `{$DOMAIN}`). It explains how to move a
live deployment from one public release to the next safely.

It complements the two documents next to it and does not repeat them:

- `docs/adopters/upstream-contributions.md` covers the **git** side — how a private
  fork keeps its history in sync with the public upstream. Read it for branching
  and merge hygiene.
- This file covers the **operational** side — how to take the code you have
  synced and roll it onto a running database and deployment without losing data
  or breaking the live app color mid-deploy.

## Principles

1. **Upgrade tag-to-tag, one release at a time.** Deploy released tags
   (`v0.9.0` → `v0.10.0`), not arbitrary `main` commits. Each release's
   Migration/deployment notes and this guide assume you are coming from the
   immediately previous tag. Skipping releases means you also skip their
   post-upgrade actions. If you must catch up several releases, apply each
   release's notes in order.
2. **Always back up the database before migrating.** A backup you have never
   restored is a hope, not a backup — see the Quarterly Backup Restore Drill in
   `docs/MAINTENANCE.md`. Take a fresh `pg_dump` immediately before every
   upgrade that runs migrations, and confirm it restores before you cut over.
3. **Read the changelog and the blue/green migration-safety ledger before you
   deploy.** `CHANGELOG.md` groups each release's changes and ends with a
   Migration/deployment notes block. `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` is
   the per-migration safety ledger. Together they tell you which migrations
   need a low-traffic window, which are destructive, and which change behaviour.
4. **Deployments are blue/green.** Migrations run before the new app color
   receives traffic while the **old** color can still be serving requests
   against the shared database (see `docs/BLUE_GREEN_MIGRATION_POLICY.md`). Most
   migrations are written to stay old-code-compatible so the old color keeps
   working during the drain. A few are not (see below) — those need a quiet
   window or a deferral.

## How to read `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`

The ledger is a tab-separated file with one row per notable migration and these
columns:

| Column | What it tells you |
| --- | --- |
| `migration_name` | The `prisma/migrations/<timestamp>_<name>` folder. |
| `phase` | `expand` (adds shape), `contract` (removes shape), or `metadata-only`. |
| `previous_expand_release` | For a `contract` migration, the earlier expand/runtime release it depends on. Do not deploy a contract migration before the named expand release has fully drained. |
| `old_code_compatible` | One of exactly three values, and **read the row's `lock_impact_plan` whichever one it is**. `yes` = the previously deployed app color keeps working while this migration is applied — but before `windowed` existed the gate *hard-required* `yes` for every breaking migration, so a number of `yes` rows are window-bounded in substance and say so in their plan text (`20260719170000_xero_grouping_age_tiers_multiselect`, for one, is `yes` while its admin grouping reads error with column-does-not-exist until cutover). **`windowed` = the old color *will* error between migrate and cutover** — only valid inside an announced maintenance window, and its `lock_impact_plan` states what breaks and what the plan is. `no` = the migration trips none of the deploy guard's breaking patterns, so there is nothing to acknowledge — but `no` was also how a genuinely old-code-incompatible data migration used to be flagged (`20260528120000_add_booking_admin_review_workflow`, `20260707000100_backfill_org_age_tier_not_applicable`). Those rows are left as they were declared; `docs/BLUE_GREEN_MIGRATION_POLICY.md` → "Historical note" gives the class rule for spotting them. |
| `lock_impact_plan` | Plain-language notes: which tables it locks, when to run it, and any operator caveat (quiet window, defer option, "run during low X traffic"). |

Before a deploy:

1. List the migrations pending for your database (folders under
   `prisma/migrations` newer than the last one your database has applied).
2. Look each up in the ledger. Note any row with `old_code_compatible=windowed`
   or `old_code_compatible=no`, any
   `contract` row, any `yes` row whose `lock_impact_plan` carries an old-code
   caveat (`OLD-CODE CAVEAT`, `RESIDUAL WINDOW`, `CAUTION`, "until cutover",
   "idle or routed"), and any `lock_impact_plan` that names a hot table (`Member`,
   `Booking`, `Payment`, membership/finance/auth tables) or a traffic window.
3. Schedule the deploy for the quietest window those rows require, and line up
   the post-upgrade actions from the release's Migration/deployment notes.

The PR-time coverage gate (CI's `migration-drift` job) guarantees every
hot-table or potentially-breaking migration at or after the ledger baseline has
a ledger row, so if a pending migration is missing from the ledger, treat that
as a red flag and check the release notes before deploying.

## Generic upgrade procedure

1. Sync the code to the target release tag (see
   `docs/adopters/upstream-contributions.md`).
2. Read this release's `CHANGELOG.md` section end to end, especially its
   Migration/deployment notes, and cross-check the pending migrations against
   `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.
3. Take and verify a database backup. If any pending migration is
   `old_code_compatible=windowed`, take it **immediately before migrating** —
   that is where the rollback boundary sits for a windowed migration
   (`docs/BLUE_GREEN_MIGRATION_POLICY.md`).
4. Choose the deploy window: low-traffic if any pending migration says so; an
   announced **maintenance window** if any pending migration is
   `old_code_compatible=windowed` (the old color will error until cutover, and
   the deploy needs `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` with a reason); and
   a **quiet window** (or a deferral) if any pending migration is
   `old_code_compatible=no` with an incompatibility caveat in its
   `lock_impact_plan`.
5. Run the deploy (`scripts/run-production-blue-green-deploy.sh` runs the
   migration-safety validator, then `prisma migrate deploy`, then cuts traffic
   over to the new color).
6. Complete the post-upgrade actions for the release (below). Confirm the app is
   healthy on the new color before you consider the upgrade done.

---

## Unreleased

### The club's time zone moves into the database (#2989, epic #2988)

**Nothing changes for your deployment at this upgrade. That is the point of how
it was built, and it is worth reading anyway, because one operator action follows
and one habit stops working.**

**What changes.** The time zone every date and time is shown in is now recorded
in the database, in-app, at **Admin → Setup & Configuration → Club Time Zone**
(`/admin/club-time`), instead of being taken from the `TZ` environment variable
the container was started with. It is stored as a place — `Pacific/Auckland` —
so the platform keeps its own daylight-saving rules.

**What the migration does to your data.** Nothing. It creates one empty table.
It deliberately does **not** write a time zone into it, because SQL cannot read
your container's environment and guessing `Pacific/Auckland` would silently
reassign the civil time of any club running on another zone. Instead, **the first
time the upgraded application starts, it records the zone you are already
effectively using**, read from your existing `TZ` or `NEXT_PUBLIC_TZ`.

**Displayed times do not change at this upgrade, on any deployment.** They are
still worked out from `TZ` for now; this release records the setting that takes
over as the remaining time-zone work ships. No stored timestamp and no lodge
night is touched, now or ever, by a time zone change.

Three outcomes on that first start, and it is worth knowing which one you get:

- **Your `TZ` names a place** — `Pacific/Auckland`, `Australia/Sydney`, and also
  older spellings such as `GB` or `NZ-CHAT`. That place is recorded, an older
  spelling under its modern name: `GB` is recorded as `Europe/London`, `NZ-CHAT`
  as `Pacific/Chatham`. Same zone, current name.
- **Neither variable is set** — `Pacific/Auckland` is recorded, the generic New
  Zealand default.
- **Your `TZ` names no place** — `UTC`, `Etc/UTC` (a common container default),
  `Etc/GMT-12`. No place on earth has "UTC" as its civil time, so there is nothing
  to preserve. **`Pacific/Auckland` is recorded** (owner decision, 23 Aug 2026:
  default rather than block), and because that is a guess rather than a
  preservation it is not done quietly — a warning is logged at startup naming
  what your `TZ` said, and the setup checklist reports the step as a **warning**
  asking a Full Administrator to confirm the zone at `/admin/club-time`.
  **If your club is not in New Zealand, this is the case to check.** Displayed
  times are unaffected in the meantime, but from the release that completes this
  work the recorded zone is what members see.

**Between `prisma migrate deploy` and that first start** the setting is empty, and
displayed times keep coming from `TZ` exactly as before — so the draining old
colour and the new colour agree on the club's time throughout the deploy. The old
colour does not know the table exists. (Strictly, the new reader answers
`Pacific/Auckland` in that window for a `TZ` that names no place, which is the
third case above; nothing displays from that reader yet, so nobody sees it.)

**The post-upgrade action.** Open `/admin/setup` after cutover and read the
**Club Time Zone** step.

- ***Complete***, naming the zone you expect — done, nothing to do.
- A ***warning*** saying the zone could not be confirmed from your environment —
  that is the third case above: your `TZ` named no place, `Pacific/Auckland` was
  recorded, and the checklist is asking you to confirm it. **If your club is not
  in New Zealand this is the one to act on**; set the real zone at
  `/admin/club-time`. If `Pacific/Auckland` is right, acknowledge the step.
- Saying the zone has **not been recorded** — the app has not restarted since the
  migration. Restart it, or run `npm run config:self-heal`, which does the same
  backfill without a restart.

**Do not remove `TZ` yet, and this is the one thing that can bite you.** It is
becoming a seed rather than the authority, but it still drives displayed times
today, and it is what the first start after this upgrade copies the club's zone
*from*. An operator who tidies `TZ=Australia/Sydney` out of the environment in the
same deploy hands the upgrade nothing to copy, and gets `Pacific/Auckland`
recorded instead. Leave it exactly as it is, confirm the setup checklist after
cutover, and keep it in step with the in-app setting from then on.

The two remain genuinely different things: the club's time zone is a club
setting, and the container's own clock is not the club's civil time.

**Who may change it.** Full Administrators only, with an explicit confirmation,
and every change is audited (`CLUB_TIME_ZONE_UPDATED`) with the administrator and
the before and after zone.

### Family email inheritance becomes direct-parent only, and re-resolves itself (#2716)

**Expect a list of members needing an email address on the first day, and expect
some mail to change recipient at this deploy.** Both are intended.

**What changes.** A member with no address of their own used to inherit one by
walking UP the family until it found an adult with a real address — so a child
could be receiving club mail at a grandparent's or great-grandparent's mailbox.
That is retired. Inheritance is now **one hop: the direct parent, or nobody.**
Pointers also re-resolve automatically whenever a parent's address is added,
changed, or removed, which previously did not happen at all: an established
pointer could keep naming somebody who was no longer the right recipient,
indefinitely, with nobody finding out.

**What the migration does to your data.** Every existing pointer that reached
past a parent is re-seated onto that direct parent. Where the direct parent has
no address the club can send to, the member inherits **nobody** and stops being
reachable. Nothing is silently re-pointed to a stranger: the only members whose
mail moves are those whose mail was already going somewhere the new rule does not
allow.

**The post-upgrade action, and it is the whole point.** Those newly-unreachable
members are findable in two places:

- **Admin → Stuck States → *Members with no reachable email address*.**
- **Admin → Members → More filters → Contactable → Unreachable.**

Work that list and record an address for each. The gap is deliberate — a gap
somebody can see beats a message going somewhere nobody chose — but it is only
the right trade if somebody actually looks.

**A new daily job.** `email-inheritance-reconcile` runs at **06:45 NZT**, just
after `age-up`, and converges every family's pointers. It is idempotent and
re-runnable: if it fails part way, the next run finishes the job. Its log line
reports `unresolved` over ALL members holding a choice, including archived and
cancelled ones, while the Stuck States tile counts only active members the club
should be reaching — so the two numbers legitimately differ, and the log's is the
larger.

**During the blue/green drain, avoid two admin actions.** The previously deployed
code does not know the new "who was chosen" column, so between migrate and
cutover it can clear an inheritance pointer while leaving the choice standing,
and the new code then re-derives the pointer from that choice. In practice that
means **unlinking a dependant**, or setting a member to **use their own address**,
may not stick if it is done on the old colour during the drain. There is no way
to tell that state apart from the ordinary "chosen parent's address is
temporarily missing", so the code cannot correct it automatically. If either
action is performed during a deploy, simply repeat it once cutover is complete
and confirm the member on the Contactable filter. Outside the drain window this
does not arise.

**Rolling back.** The column can be dropped once every new-colour instance has
drained. Pointer VALUES corrected by the migration are not restored, and should
not be: restoring them would reinstate exactly the minor-notification routing
this change removes.

### Google Analytics stops until an admin re-enters the measurement id (#2573)

**Read this before you deploy if your club uses Google Analytics: analytics will
stop at this deploy, and an admin has to turn it back on in the app.** This is an
intentional, owner-accepted hard cutover, not a regression.

**What changed.** The GA4 measurement id, whether the visitor consent banner is
shown, and the banner wording are now club configuration held in the database and
edited at **Admin → Setup & Configuration → Integrations → Google Analytics**.
`NEXT_PUBLIC_GA_MEASUREMENT_ID` is no longer read anywhere at runtime. There is no
fallback to it, and its value is **not** copied into the database automatically —
so nothing can silently start tracking under a configuration nobody reviewed.

**Migration.** `20260803060000_add_analytics_settings` creates one new, empty
`AnalyticsSettings` table plus an index. Ledgered `expand` /
`old_code_compatible=yes` in
[`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`](BLUE_GREEN_MIGRATION_SAFETY.tsv). No row
is seeded, no backfill runs, and the previously deployed colour neither reads nor
writes the table — so this needs **no maintenance window of its own** and no
special sequencing. Run it in the normal deploy window.

**Post-upgrade action — required, per club, or analytics stays off:**

1. Sign in as an admin with finance **edit** access.
2. Confirm the **Google Analytics** module is on at **Admin → Setup &
   Configuration → Modules**. If it is on but unconfigured, its readiness badge
   now reads "Needs setup" and points at Integrations rather than at an
   environment variable.
3. Go to **Admin → Setup & Configuration → Integrations**, open the **Google
   Analytics** card, select **Edit**, and enter the club's GA4 measurement id
   (`G-…`, from Google Analytics → Admin → Data streams → your web stream).
4. Choose the consent-banner mode. **Show the consent banner** is the default and
   the recommended option: nothing whatsoever is sent to Google until a visitor
   accepts. The alternative loads analytics automatically without asking, and the
   screen warns you before you save it.
5. **Save.** No restart or redeploy is needed — the save clears the public
   configuration cache and the stored public pages, so the change is live at once.
6. Remove `NEXT_PUBLIC_GA_MEASUREMENT_ID` from your `.env` / Compose environment.
   Leaving it set does nothing, but it will mislead the next operator.

**During a blue/green drain the two colours can disagree** — the old colour still
reads its environment value while the new colour reads the (empty) table. The only
consequence is that analytics may be on for the old colour and off for the new
one, which is bounded by the drain and errs towards *not* tracking. It can never
run without consent on the new colour.

Full setup walkthrough: [Integrations](guides/integrations.md).

### The subscription booking lockout becomes a three-way choice (#2543)

**Your club's booking behaviour does not change on this upgrade — but this release
needs a maintenance window.** Read this section before scheduling it.

**Two migrations, completing the change in one release.** The owner chose to finish
this in a single release rather than keep temporary dual-read/dual-write
compatibility alive for a later contract release (#2561):

- `20260803000000_subscription_lockout_three_way_mode` — additive: creates the
  `SubscriptionLockoutMode` type and adds a nullable `mode` column to the
  single-row cold `MembershipLockoutSettings` table. Ledgered `expand` /
  `old_code_compatible=yes`.
- `20260803010000_contract_subscription_lockout_drop_enabled` — backfills `mode`
  from the old `enabled` boolean (`true` → **Stop them booking**, `false` → **Let
  them book normally**), makes `mode` mandatory with a `HARD_BLOCK` default, and
  **drops `enabled`**. Ledgered `contract` /
  **`old_code_compatible=windowed`**.

**Your setting carries over exactly.** Whatever the old on/off switch said is
written into the new three-way setting by the backfill, so no club's booking
behaviour moves and no booking is repriced. A club that had deliberately switched
the lockout OFF stays off — that mapping is pinned against real rows by a
verification fixture whose mutants include the one that would silently hard-block
those clubs.

**Why the window.** Once `enabled` is dropped, the previous release can no longer
read the settings row at all — and because the booking gates resolve the lockout
policy through that read, the old version cannot take a booking. There is no
ordering that keeps both versions working, so this deploy is a short planned
outage rather than a rolling cutover:

1. build and validate the new images **first**;
2. take a fresh backup and **verify it restores**;
3. put the site into maintenance mode / remove user traffic;
4. stop the old app **and** the background workers;
5. migrate, with `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and a
   `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` naming the window;
6. start the new release.

The migration itself is quick — three metadata-only statements on a single-row
table — so the window is dominated by stopping and starting the application.

**If the #2520 family-group change below is also pending, use its order, not this
one.** The two lists differ in one place: this one takes the backup at step 2,
before traffic is removed; the #2520 list takes it after the app and every worker
have stopped. The later position is the safer of the two — no booking or payment
can land between the snapshot and the migration — and it is the order the owner
directed. The list above stands as written for a window carrying only this change.

**If you need to go back.** Prefer going forward: the schema is migrated and the
data is intact. If the new release will not start, the migration ships a tested
reverse script beside it,
`prisma/migrations/20260803010000_contract_subscription_lockout_drop_enabled/rollback.sql`,
which recreates `enabled` from the mode (**Let them book normally** → false, the
other two → true) and lets the previous release run again. Both directions were
rehearsed against a production-shaped database before this shipped; the transcript
is in `docs/PRODUCTION_UPGRADE_RUNBOOK.md` §7.1, and the full sequence is in
`DEPLOYMENT.md` → "Windowed migrations".

See also point 3 below on configuration bundles.

**The new third option is opt-in and money-affecting.** Once upgraded, an admin
can change **Admin → Subscription Lockout → Booking lockout** from the previous
on/off toggle to one of three answers, the third of which is new: *let an unpaid
member book, at non-member rates*. Choosing it charges that member's own nights at
the club's existing non-member rate (the same rate rows and the same Xero item
code as any other non-member — no new invoice type), tells them why on the quote,
and requires a paid-up adult member on the booking, refusing with a
Booking-Officer override path (which holds the bed) when there is none. That
requirement applies to any booking where somebody is being repriced, **and to any
booking made by a member whose own subscription is unpaid, whether or not they are
staying on it** — otherwise the softer option would let a member who has let their
subscription lapse go on booking beds for other people with no friction at all,
which is the one thing today's hard block reliably stops. Read
`docs/guides/subscription-lockout.md` → "What 'non-member rates' does to a
booking" before switching a live club, and tell your treasurer first. Reversing it
is a settings change, not a migration, and does not re-price bookings already
taken.

**Three things to tell people before you switch a live club to the third option.**

1. **Two narrow cases start being refused that go through today**, because the
   paid-up-adult requirement is judged over the WHOLE party while the pre-existing
   subscription checks looked only at the guests a request was adding: confirming a
   draft that carries an unfinancial member guest (confirm-draft has no member-guest
   subscription check today at all), and editing a booking that already carries an
   unfinancial member. Both answer 409 with the Booking-Officer override path and a
   hold on the bed, so they are reviewable rather than blocked - but they are new
   refusals, and the plain claim "this only ever relaxes things" is not true of them.
   No previously-blocking refusal becomes stricter. The member booking for other
   people while their own subscription is unpaid is NOT a third case: they are
   refused outright today, and under the new option get the same 409 with the
   override path and the bed held.
2. **Invoice wording changes for two classes of guest.** A hut-fee line's
   "(ADULT, Member)" label now follows the RATE the guest was charged rather than the
   membership flag, so a repriced member reads as "Non-member" - which is the point,
   since the line has always been coded to the non-member item at the non-member
   amount. The same change applies to any membership type your club has deliberately
   configured onto non-member rates. Wording only: no amount, item code, account code
   or Xero idempotency key moves, so nothing re-syncs and no reconciliation breaks.
3. **Re-export your configuration bundles after upgrading, before importing one into
   an upgraded club.** A bundle exported before this release carries only the old
   on/off boolean. The importer still derives the new three-way setting from it, and
   that compatibility is deliberate and tested — bundle files outlive the column, and
   an old bundle still records a real decision about whether the club gated bookings.
   A bundle exported from an upgraded club carries the mode itself and is
   unambiguous. There is no format-version bump for this. One case the importer now
   refuses outright, at the dry-run rather than mid-import: a bundle whose
   `membership-lockout-settings.json` states `"mode": null` and carries no old
   boolean either. Nothing can tell what policy that file means, and the column is
   not nullable, so the plan reports it as an error instead of aborting the import
   transaction on a database error part-way through. Only a hand-trimmed or
   partially-written file can be in that state; a bundle either tool produced cannot.

### The obsolete family-group "role" column is removed (#2520)

**Nothing your club does changes, and no screen changes — but this removal needs
the same maintenance window as the section above, and if both ship together they
share one window.**

**What is being removed.** `FamilyGroupMember.role` was a per-membership label on the
family-group join table. Four values ever existed: 'MEMBER' (the default, and the bulk
of rows), 'ADMIN', 'LEAD' and 'USER'. Only 'ADMIN' was ever read by anything, and
nothing ever displayed any of them.
`20260803030000_contract_drop_family_group_member_role` drops the column.

**In the version you are upgrading *from*, the label is still live.** The one power it
ever gated — declaring a partner for a family member who has no login of their own,
in one step — was re-anchored in #2284 onto who is recorded as having confirmed that
member's details, and nothing in the new version reads the label at all. But #2284
ships in this upgrade too, so on the version currently running, 'ADMIN' is still what
that check reads. That is why the reverse-script note below matters and why the
operator is asked to save a copy of the values first: this is not a column that was
already dead in production.

**Family groups carry no rank at all after this upgrade.** Every adult login co-member
of a family group is equal, and this removes the last trace of the old "group admin"
idea from the database.

**Why the window.** The runtime code that stops using the column and the migration
that drops it ship in the same release, by owner decision (3 Aug 2026) rather than
carrying an obsolete column through another upgrade. So the version currently
running still names the column — in ordinary reads, in every insert, and in a
filter — and it cannot serve family-group pages, onboarding, family requests,
member merge or Xero member import for the moments after the column is dropped.
The deploy therefore takes a planned outage:

1. build and validate the new images **first**, and confirm the image carries both
   halves — the new code and the migration;
2. put the site into maintenance mode / remove public traffic;
3. stop the old app **and** every worker, scheduler and queue consumer, then check
   nothing old is still connected;
4. take a fresh backup and verify it — in that position, *after* everything that
   writes has stopped, so nothing lands between the snapshot and the migration. Do
   the full restore drill on the most recent durable artifact **before** the window,
   and verify *this* artifact by integrity and completion checks, which take minutes
   rather than the drill's tens of minutes;
5. record the pre-migration checks (row count, the label values with counts, and —
   **required** — a per-row dump to a **host** path, then moved somewhere durable;
   it is the only way to get the exact labels back later);
6. run the repository's migration safety check — `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1`
   and a `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` naming the window go on **that**
   command, which is a separate script, not on the migrate command — then migrate;
7. verify the column is gone;
8. start the replacement app and workers, smoke-test sign-in, family groups, family
   requests and member merge, check the logs, then restore traffic.

**The order of steps 2 to 4 matters and is the owner's, not a preference.** The
backup comes after the site is quiet, not before it. A backup taken while the site
is still serving does not contain the bookings, payments and member changes made
between the snapshot and the shutdown — and for a windowed change that backup is
the last unconditional way back, so anything missing from it is lost if it is ever
needed. This is also the order that governs when both windowed changes in this
release are applied together.

**How long the outage is.** The migration itself is one metadata-only statement on a
small table and takes no meaningful time. The outage members see is steps 2 to 8, and
the migration is the cheapest thing in it: what dominates is the careful shutdown and
connection check, the snapshot and its verification, the checks and the dump, and then
starting the replacement release and working the smoke test and log sweep before
traffic returns. Time it on the staging rehearsal and announce that figure. Do not
announce "a few minutes" on the strength of the migration being quick.

Full sequence, with the exact check queries, is in
`docs/PRODUCTION_UPGRADE_RUNBOOK.md` §2.4.1.

**If you need to go back.** Prefer going forward. If the new release will not start,
the migration ships a tested reverse script beside it,
`prisma/migrations/20260803030000_contract_drop_family_group_member_role/rollback.sql`,
which recreates the column in exactly the shape the previous version expects and
refills every row with `'MEMBER'`. **Do not start the old version before running it
(or restoring the backup)** — the old version cannot run against the migrated
database.

**If both changes in this release were applied in the one window, going back needs
BOTH reverse scripts, in the reverse of the order they were applied** — this one
first, then the subscription-lockout one
(`prisma/migrations/20260803010000_contract_subscription_lockout_drop_enabled/rollback.sql`).
Running only this one is the trap: the family-group pages come back and look
healthy, but the subscription-lockout column is still missing, so the old version
cannot take a booking at all. Both, in that order, were rehearsed together.

**Two things about going forward again after a reverse script**, both measured
rather than assumed. The new release **works** on the reversed-out database, so a
rollback does not have to be undone before the new version can start. But the
migration history still records the change as applied, so `prisma migrate status`
and `prisma migrate deploy` will both report the database up to date when it is not;
the runbook names the one command that sees the difference, and the tidy-up is to
re-apply the migration by hand once things are calm.

**What the reverse script cannot give you back.** The original per-row labels: it
refills every row with `'MEMBER'`, which is a substitute, not the value the row held.
PostgreSQL cannot un-drop a column, so the only sources are the required step-5 dump
(the reverse script has a block that loads it back — rehearsed) or the backup.
`'MEMBER'` is the safe substitute because only `'ADMIN'` was ever read, so it can only
ever withhold a power, never grant one. What it costs is real but narrow and
fail-closed: on the rolled-back version nobody holds `'ADMIN'`, so the one-step partner
declaration finds no candidates and refuses for a member with no login. The ordinary
consent round-trip still works, and nothing else about family groups is affected. Take
the dump, and this stops being a question.

Every path above was rehearsed against a production-shaped database before this
shipped — the migration, the reverse script, the exact-value restore, both ways of
going forward again, and the combined two-change rollback in order
(`docs/PRODUCTION_UPGRADE_RUNBOOK.md` §7.2).

### Re-export configuration bundles for format version 4 (#2364)

Configuration bundles now require exact **format version 4**. Version 4 adds a
second required file to the `booking-policies` category,
`booking-policies/adult-member-hosting.csv`, carrying the adult-member hosting
setting for each scope under the same replace-set rules as its sibling: a scope
omitted from the file is deleted after appearing in the dry-run.

The number moves rather than the file being optional because both directions are
unsafe. A version 3 bundle has no such file, so a version 4 reader would have to
guess whether that means "clear every hosting policy" or "leave them alone"; a
version 3 reader handed a version 4 bundle is worse, because it would ignore the
file while reporting that it had replaced the club's complete booking-policy set,
leaving source and target quietly disagreeing about who may bring guests.

Re-export any configuration bundle you rely on from the upgraded source app
before importing it. Do not hand-edit `manifest.json` and do not expect **Reseal
edited bundle** to upgrade an old bundle's meaning: a valid v4 export contains
BOTH `booking-policies/minimum-stay.csv` and
`booking-policies/adult-member-hosting.csv` with the complete intended sets (or
their exact headers alone when clearing is intentional).

### Re-export configuration bundles for format version 3 (#2363)

Configuration bundles now require exact **format version 3** compatibility. The
new version adds a reviewed replace-set for minimum-stay booking policies, where
an omitted policy is deleted after appearing in the dry-run. Version 1 and 2
bundles are refused because they cannot state that complete, namespaced policy
set safely; a version 2 reader likewise refuses version 3 instead of overlooking
the destructive category.

Before upgrading, re-export any configuration bundle you rely on from the
upgraded source app. Do not change only `manifest.json` or assume **Reseal edited
bundle** upgrades an old bundle's meaning: a valid v3 export must include
`booking-policies/minimum-stay.csv` with the complete intended policy set (or its
exact header alone when clearing the set is intentional).

### One-off cleanup of another club's lodge address (#2484)

`20260802110000_clear_waldvogel_lodge_address` is a **data-only cleanup**. It
adds and removes no schema, touches no hot table, and is safe to run in the
ordinary deploy window with the previous app colour still serving.

**What it fixes.** Two steps in the upgrade history combine to write
`Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand` — Tokoroa Alpine
Club's real lodge — into the default lodge's address on every database built
from this repository: `20260708000000_add_lodge_entity_and_multi_lodge_module`
creates the default lodge, and `20260717160100_add_lodge_address` backfills that
address into it. The public Contact page then shows it under Club Details. The
backfill was right when it was written — this codebase *was* that club's live
site, and the step moved the address out of the page's own source and into the
database so the live deployment kept showing it — but the same step now runs for
everybody. This migration sets the address back to empty wherever it is still
exactly that string.

**What you will notice.** If your Contact page shows that exact address today,
then after you cut over the **whole map block under Club Details disappears —
including your lodge's name.** The page draws the pin icon, the lodge name and
the address line together, and only when an address is set, so clearing the
address takes the name line with it. Both come back the moment you enter an
address (see the next paragraph). Nothing else on the page changes: your contact
role and its phone and email, the contact form, and your page content are all
untouched.

**Post-upgrade action: put your own address in, then check the page.** **Admin →
Setup & Configuration → Site Appearance & Content → Club Identity → Lodge
details → Address**, then **Save lodge details** (`/admin/appearance/identity`).
It shows on the Contact page and in the `{{lodge-address}}` content token within
seconds. A multi-lodge club sets each lodge's address under **Admin → Setup →
Lodges** instead. Nothing in the product prompts you, so add this to your
post-upgrade list — it is about a minute's work.

**Then load your public Contact page and confirm what it shows.** Do this even
if you expect the cleanup to have emptied the field on its own. The lodge details
form saves every field it loaded when the page was opened, so an admin who had
that form open *before* the upgrade and pressed **Save lodge details**
*afterwards* writes the old address straight back — and this cleanup runs once,
so it will not clear it a second time. If the old address is still on the page,
open the same form, replace it with your own (or clear it) and save.

**An address you entered yourself is never touched.** The cleanup matches that
one exact string and nothing else, so a club that has already set its own
address keeps it byte for byte, as does every additional lodge a multi-lodge
club has created. The deliberate exception is a deployment that still holds the
original string legitimately — Tokoroa's own fork, if it ports this release down
— which is cleared like everyone else and re-enters the address with the steps
above.

**Re-running is safe.** After the cleanup no row matches that string, so a
second run changes nothing. No audit row is written: the value removed is a
string this project wrote into the row itself, quoted in full here and in the
migration's own comment, not club-authored content that could be lost.

### One-off cleanup of another club's footer affiliations (#2490)

`20260802140000_clear_starter_footer_affiliations` is a **data-only cleanup**,
and the sibling of the address cleanup above. It adds and removes no schema,
touches no hot table, and is safe to run in the ordinary deploy window with the
previous app colour still serving.

**What it fixes.** `20260702124500_add_site_content` made the three public
footer columns admin-editable and backfilled them with the copy that was, until
then, hardcoded in the footer's own source. One of those columns is
**Affiliations**, and the value it planted lists "Federated Mountain Clubs
(FMC)" and "Ruapehu Mountain Clubs Association (RMCA)". That was right when it
was written — this codebase *was* the Tokoroa Alpine Club's live site, and the
step moved the club's own footer out of the code and into the database so
nothing changed for it — but the same step now runs for everybody, so every
install and every fork publishes a regional body it does not belong to, on the
footer of **every public page**. This migration empties that column wherever it
still holds exactly the original list.

**What you will notice.** If your footer shows that exact list today, then after
you cut over the **Affiliations column disappears** and the footer shows two
columns instead of three. A footer column with no content in it is hidden
entirely, by design, so there is no empty heading and no gap where it used to
be. Nothing else changes: your club blurb, your quick links, the logo,
copyright line, and privacy/terms links are all untouched.

**Post-upgrade action: add your own affiliations, then check the footer.**
**Admin → Setup & Configuration → Site Appearance & Content → Site Content →
Footer: affiliations** (`/admin/site-content`), then **Save Footer:
affiliations**. Public pages are cached briefly for logged-out visitors, so
allow a minute or check while signed in. Nothing in the product prompts you, so
add this to your post-upgrade list.

**Then load a public page and confirm what the footer shows.** Do this even if
you expect the cleanup to have emptied the column on its own. The Site Content
editor loads all three columns when the page is opened and saves the one you
press Save on, so an admin who had that page open *before* the upgrade and
pressed **Save Footer: affiliations** *afterwards* writes the old list straight
back — and this cleanup runs once, so it will not clear it a second time. If the
old list is still there, open the same editor, clear it or replace it with your
own, and save.

**Affiliations you edited yourself are never touched.** The cleanup matches that
one exact list and nothing else, so a club that has written its own links keeps
them byte for byte — and so does a club that only deleted the RMCA line, because
what remains no longer matches. The deliberate exception is a deployment that
still holds the original list legitimately — Tokoroa's own fork, if it ports
this release down — which is cleared like everyone else and re-enters its links
with the steps above.

**Running more than one install?** An emptied affiliations column does not
travel between installs through a configuration bundle in the usual **Merge**
mode, which only writes bundle fields that have a value in them: the plan
reports the row as **Unchanged** and the target keeps its own list. Upgrade each
install — the cleanup runs on every database of its own accord — or import in
**Overwrite** mode. See the [Site Content guide](guides/site-content.md).

**Re-running is safe.** After the cleanup the column is empty, so nothing
matches the old list and a second run changes nothing. No audit row is written,
for the same reason as the address cleanup: the value removed is markup this
project wrote into the row itself, quoted in full in the migration's own
comment, not club-authored content that could be lost. The section's **Last
saved** stamp in the editor still shows the original backfill time until an
admin saves it — cosmetic, and the migration deliberately leaves it alone
because this is a system repair rather than an edit somebody made.

### One-off rewrite of the front-page hero that advertised guest booking (#2431)

`20260802150000_update_starter_home_guest_copy` is a **data-only cleanup**, the
third sibling of the two above. It adds and removes no schema, touches no hot
table, and is safe to run in the ordinary deploy window with the previous app
colour still serving.

**What it fixes.** `20260613090000_update_starter_home_page_content` set the
home page's hero — the sentence under the club name, above the fold — to *"Our
club lodge welcomes members and guests year-round. Book a stay, join the club,
and explore New Zealand's mountains."* On the front page that reads as open
visitor accommodation: anyone may come, anyone may book. The starter FAQ seeded
beside it says the opposite — a non-member stays only as the invited guest of a
financial member who is also staying — so the reference site contradicted
itself, and the front page was the surface making the wrong promise. It is also
the page's **meta description**, so it is what a search engine quotes under your
club's name. This migration replaces that sentence wherever the hero still holds
exactly it.

**What you will notice.** If your front page shows that exact sentence today,
then after you cut over it reads *"Our club lodge welcomes members year-round.
Log in to book a stay, or apply to join and explore New Zealand's mountains."*
instead. Nothing else on the page moves: the eyebrow line ("Welcome to the Club
Lodge"), the heading ("Club Lodge"), your page body, and every other page are
untouched. Unlike the two cleanups above, this one **replaces** the value rather
than clearing it — the front page needs a hero, and an empty one would look
broken rather than corrected.

**Post-upgrade action: load your public front page and read the new sentence.**
Do this even though there is nothing you are required to change. Two reasons.
First, the wording is a default and your club may want its own — **Admin → Setup
& Configuration → Site Appearance & Content → Page Content → Club Lodge**
(`/admin/page-content`), edit the header text, then Save. Second, the Page
Content editor loads a page's fields when it is opened and saves them all back,
so an admin who had **Club Lodge** open *before* the upgrade and pressed Save
*afterwards* writes the old sentence straight back — and this cleanup runs once,
so it will not rewrite it a second time. Public pages are cached briefly for
logged-out visitors, so allow a minute or check while signed in.

**Re-export your configuration bundle after upgrading, and re-check the front
page after any bundle import or disaster-recovery restore.** A configuration
bundle carries the home page's header text, and an import writes it back — in
**Merge** mode as well as **Overwrite**, because Merge only leaves out fields
that are empty in the bundle and this one is a full sentence. So a bundle you
exported *before* this release still contains the old sentence, and restoring it
puts that sentence back on your public front page. This matters most where
nobody is watching: rebuilding an install from a bundle (the disaster-recovery
flow) or cloning one runs the migrations first and imports the bundle
*afterwards*, and this cleanup runs once, so it will not correct the row a
second time. Export a fresh bundle once you have upgraded, replace any archived
one you would restore from, and load your front page after any import. The two
cleanups above can come back the same way; see issue #2511.

Since #2511 the import path also guards this **mechanically**: when a bundle's
value byte-matches one of these three removed literals (this hero, the footer
affiliations, or the lodge address), the importer **skips writing that field**,
leaves the cleaned value in place, and shows a warning row in the import preview.
The unattended rebuild-from-bundle path has no preview, so it writes that same
warning to the **boot log** instead (a `WARN` naming the skipped literal). So a
stale bundle can no longer silently put the old value back on either path — but
re-exporting after upgrading is still the right habit, and clears the warning.

**A hero you edited yourself is never touched.** The cleanup matches that one
exact sentence and nothing else, so a club that has written its own front-page
line keeps it byte for byte — and so does a club that merely reworded part of
it, because what remains no longer matches. There is no exception to note here,
unlike the two cleanups above: no club legitimately owns this sentence, because
this project wrote it as a placeholder for all of them. The caption and title
are deliberately left out of the match, so a club that renamed its front page
but never touched the hero is corrected like everyone else.

**Re-running is safe.** After the rewrite the hero holds the new sentence, so
nothing matches the old one and a second run changes nothing. No audit row is
written, for the same reason as the two cleanups above. The page's **Updated:**
stamp in the editor still shows the original backfill time until an admin saves
it — cosmetic, and the migration deliberately leaves it alone because this is a
system repair rather than an edit somebody made.

### The public "Book Now" button is switched OFF for every club (#2430)

**After this release every club's public "Book Now" button is off, whether or
not the club had chosen to show it.** If your public website shows that button
today, it will be gone the moment you cut over. This is deliberate: the owner
decided (1 Aug 2026) that the public site must not read as walk-in commercial
accommodation, and accepted that switching it off everywhere overrides clubs
that had deliberately turned it on.

**To turn it back on** — one click, and nothing was lost:

**Admin → Setup & Configuration → Site Appearance & Content → Page Content →
tick "Show the Book Now button" → Save visibility.**

`20260802100000_public_book_now_default_off` does two things. It flips the
**column default** of `PublicContentSettings.showBookNow` from true to false, so
a fresh install ships with no public booking button; and it runs
`UPDATE "PublicContentSettings" SET "showBookNow" = false`, so every club that
already has stored settings is switched off too. Nothing else about your public
content is touched — your pages, your fee and policy visibility, your Book Now
*target*, and your Club Contact role all stay exactly as they were. Only that
one checkbox moves, and only in one direction.

Nothing warns you in the product, so if your club wants the button, put the
click above on your post-upgrade list.

**The button is also renamed for signed-out visitors.** Where it is shown, a
visitor who is not signed in now sees **Member booking** instead of **Book Now**,
because booking at this club is for members and nothing behind that button lets
a visitor make one: with the booking-flow target it opens the member login, and
with a content-page target it opens that page. A signed-in member still sees
**Book Now**. The rename follows the visitor, not the target, so it applies even
if you have pointed the button at a page of your own. Nothing is configurable
here and no setting changed.

### The bumped-booking email now points non-members somewhere they can go (#2430)

The built-in **Booking Update** (bumped) wording used to end in
`Book Again: {{BASE_URL}}/book` for everyone. `/book` is the member booking flow
behind the login, and that message also goes to the organisation or school
contact whose booking came from a public booking request — a contact with no
login, who could only ever reach a sign-in screen. The built-in wording now ends
in `{{rebookLabel}}: {{BASE_URL}}{{rebookPath}}`, which renders
`Book Again: …/book` for a member and `Contact the Club: …/contact` for a
contact who cannot sign in. It also now names your support address, the same way
most other built-in messages do, because a club's Contact page need not carry a
contact form — without that line a reader who cannot sign in could be sent to a
page that gives them no way to reply.

**No saved wording is touched, and nothing warns you.** A club that saved its own
copy of that message keeps it, exactly as it wrote it — which means it keeps
sending `/book` to people who cannot use it. This is the ordinary "your copy
reads differently from the built-in wording" case: the editor states the fact
under the template with **Show differences**, and raises no warning, because a
customisation differing from the built-in text is what a customisation is. If you
have customised **Booking Update**, open it after upgrading and either replace
the `Book Again: {{BASE_URL}}/book` line with
`{{rebookLabel}}: {{BASE_URL}}{{rebookPath}}` — adding
`If you have any questions, contact the club at {{SUPPORT_EMAIL}}.` if your copy
names no email address — or press **Restore Default** to take the whole new
wording.

### One-off repair of saved email template wording (#2269)

`20260801150000_strip_email_override_bracket_annotations` is a **data-only
repair**. It adds and removes no schema, touches no hot table, and is safe to
run in the ordinary deploy window with the previous app colour still serving.

**What it fixes.** Older releases shipped square-bracketed authoring notes
inside the built-in email wording — for example `Door code: {{doorCode}} [only
when a door code is set]`. Emails substitute `{{tokens}}` and copy everything
else through untouched, so those notes were being emailed to recipients word
for word. Releases carrying #2267 and #2268 removed them from the built-in
wording, which fixes every club that has not customised that message, because
the built-in wording is compiled into the code and not stored in your database.
A club that had **saved its own copy** of a message under **Admin → Email
messages** keeps its saved copy for ever, so it also keeps the notes. This
migration removes them from those saved copies.

**What it changes, exactly.** Only the 38 exact note strings this project ever
shipped — `[only when a door code is set]`, `[when dates did not change]`,
`[heading becomes "Reminder: Confirm Your Attendee List" on reminders]` and so
on. The full list is `SHIPPED_ANNOTATIONS` in
`src/lib/email-message-token-contract.ts`.

It matches those strings **exactly**, and nothing that merely resembles one.
That is a deliberate choice with a cost on both sides, so it is worth being
plain about:

- **What it protects.** Club wording like `Ring the lodge [when you are 30
  minutes away].` or `the hut sits on [whenua administered by the rūnanga]` is
  never touched. An earlier draft matched anything opening `[when`, and that
  draft deleted all three of those examples in testing. Because the editor
  refuses to save square brackets (see below), a club whose wording we deleted
  could not simply paste it back — only someone with database access could
  recover it from the audit row. A rule that can be wrong should not be the one
  that writes.
- **What it costs.** If one of our notes was ever retyped or re-spaced inside a
  club's saved copy — `[only  when a door code is set]` with two spaces, say —
  this repair leaves it in place. That row is not abandoned: it keeps appearing
  in the **Admin → Email messages** bracket banner, where an admin removes it
  deliberately.

Everything else in your wording is left byte for byte as it was. A saved copy
with none of those exact notes is not touched at all.

**How to see what was changed.** Every altered row writes one
`EMAIL_TEMPLATE_OVERRIDE_UPDATED` entry to the audit log with no actor (no
member did this), recording the whole previous saved copy, the whole new one,
and the exact notes removed. Find them under **Admin → Audit log** filtered to
`EMAIL_TEMPLATE_OVERRIDE_UPDATED` around your upgrade time, or:

```sql
SELECT "entityId", "metadata" -> 'removedAnnotations'
FROM "AuditLog"
WHERE "action" = 'EMAIL_TEMPLATE_OVERRIDE_UPDATED'
  AND "metadata" ->> 'source' LIKE 'migration:20260801150000%';
```

If a club decides one of those notes was actually theirs, the previous text is
in `metadata -> 'previousOverride'`. Be aware that it **cannot be restored from
the editor**: the editor refuses to save square brackets, because bracketed text
is always emailed verbatim. Recovering such text means an administrator writing
it back into the database directly. This is the main reason the repair matches
exact strings and errs towards leaving things alone.

**Privacy note — this metadata is stored verbatim.** The audit rows written by
this migration are built in SQL and therefore do **not** pass through the
application's audit sanitiser, which normally truncates long strings, caps the
total size, and redacts things that look like secrets or card numbers. Storing
the wording in full is the point — a truncated copy could not be used to restore
anything — but it means that if a club typed a **literal** door code into its
template body instead of using `{{doorCode}}`, that literal is now in an
unredacted audit row kept for seven years. If that applies to you, search the
rows above before the retention window matters to you. Template subjects and
bodies are capped at 500 and 10,000 characters by the editor, so no single row
can be large.

**Re-running is safe.** The repair selects only rows that still contain a
shipped note, so a second run changes nothing and writes no second audit entry.

**Running it while the previous app colour still serves is safe.** The repair
writes a row only if that row still holds exactly the wording it read, so an
admin who presses **Save** or **Restore Default** during the deploy window wins:
their change stands, the repair skips that template, and no audit row claims we
changed something we did not.

**Every repaired message is named on screen afterwards, and here is why that
matters.** The notes this repair removes were, for some lines, the only thing
saying that the line was conditional — `Payment has been processed
successfully. [only when the booking is already paid]` is wording this project
shipped, and once the note is gone that sentence goes out on a booking that
still owes money, with nothing left to hint at it. So **Admin → Email messages**
names every message this repair touched, lists the notes it removed and quotes
the lines that now send every time. That notice is built from the migration's
own audit rows above — not by looking for a marker the migration deleted — so it
covers **every** repaired message, including lines with no `{{token}}` in them
that no other check on that screen can see. It clears when an admin opens the
message and presses **Save Template**, which is the acknowledgement.

Ask an admin to walk that list after the upgrade. It is not an emergency, but it
is not cosmetic either: a line that used to apply sometimes now applies always,
and only a person can say whether the remaining wording still reads correctly.

### Post-upgrade action: check the email templates screen

**Admin → Email messages** now tells an admin when a saved copy no longer shows
something the message is required to tell the recipient — the commonest case is
a booking confirmation saved before the promo explanation moved into
`{{promoSummary}}`, which now shows a subtotal and a total with nothing in
between to explain the difference. Each affected template is named in a banner
at the top of the screen, and the template you have open offers **Show
differences**, a line-by-line comparison of your saved copy against the current
built-in wording, so you can decide whether to patch your wording or press
**Restore Default**. Nothing is changed for you: this is advisory only, and a
saved copy that merely reads differently — which is the whole point of saving
one — is reported as a plain difference and never as a problem.

### One-off rewrite of stored bed-allocation activity categories (#2751)

`20260810020000_backfill_bed_allocation_audit_category` is a **data-only
rewrite**. It adds and removes no schema, and it is safe to run in the ordinary
deploy window with the previous app colour still serving — but it needs **one
post-cutover action** (below), which is the only part of it that can be missed.

**What it fixes.** Every activity entry in `AuditLog` carries a **category**, and
that category is written onto the row when the row is written — it is not worked
out again when you look at it. This release moved bed allocation and the lodge
display configuration out of the **Admin** category and into **Lodge** (#2730),
which changed where *new* entries are filed and deliberately left the entries
already in your database alone. Bed-allocation history was therefore split at the
upgrade date: filtering **Admin → Audit Log** by Lodge returned the newer
allocations, filtering by Admin returned the older ones, and neither answered
"what happened to the beds that weekend" if the weekend straddled the upgrade.
The same split ran through **AI Diagnostics**, where the lodge correlation tool
held one half and the system correlation tool the other. This migration rewrites
the older entries so the whole run reads as one again.

**What it changes, exactly.** `category` goes from `'admin'` to `'lodge'` on rows
whose `action` is one of **eighteen exact names**, and on nothing else:

```
BED_ALLOCATION_APPROVED             BED_ALLOCATION_PARTNERS_PROMOTED
BED_ALLOCATION_AUTO_RUN             BED_ALLOCATION_PARTNER_PROMOTED
BED_ALLOCATION_BED_CREATED          BED_ALLOCATION_RANGE_SET
BED_ALLOCATION_BED_DELETED          BED_ALLOCATION_REMOVAL_APPLIED
BED_ALLOCATION_BED_UPDATED          BED_ALLOCATION_ROOMS_BULK_CREATED
BED_ALLOCATION_BULK_SET             BED_ALLOCATION_ROOM_CREATED
BED_ALLOCATION_CONFIG_IMPORTED      BED_ALLOCATION_ROOM_DELETED
BED_ALLOCATION_MANUAL_SET           BED_ALLOCATION_ROOM_UPDATED
BED_ALLOCATION_SETTINGS_UPDATED     LODGE_DISPLAY_CONFIG_UPDATED
```

The list is **literal, never a `BED_ALLOCATION%` pattern**. A pattern cannot be
reviewed against the audit-writer census and would sweep up any bed-allocation
event added after this migration was written, including one deliberately filed
somewhere else — so the migration would rewrite rows nobody reviewed, on an
append-only table, with no undo.

`category` is also **the only column in the `SET` clause**. The date, the actor,
who it was about, the summary, the stored details, the IP address, `retentionClass`
and `expiresAt` all keep the bytes they were written with. That last pair matters:
they were derived from the category at write time, and recomputing them from the
new value is how a tidy-up silently re-dates when a row is purged. Retention does
not move here in any case — every one of these eighteen actions classifies
`critical` (seven years) under `admin` and under `lodge` alike.

**Who can see what afterwards.** Anyone with **Support** access still reads every
one of these entries in full in **Admin → Audit Log**, exactly as before; nothing
is hidden from anyone on that screen. In **AI Diagnostics** the older entries
follow the newer ones out of the system correlation tool and into the lodge one,
so an operator holding Support alone — or Support and Bookings but not Lodge — no
longer correlates them there. That is the same narrowing #2730 already applied to
new entries, now applied consistently instead of by date. **No member gains or
loses sight of anything** on their own activity page: neither `admin` nor `lodge`
is a member-visible category, so nothing crossed that boundary in either
direction.

**How to see what was changed.** The migration writes one
`AUDIT_CATEGORY_BACKFILLED` entry with no actor, filed under **Admin** on purpose
so the Support-only operator who just lost these entries from their AI Diagnostics
view can read why. Find it under **Admin → Audit Log** around your upgrade time,
or:

```sql
SELECT "createdAt", "metadata"
FROM "AuditLog"
WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'
  AND "metadata" ->> 'source' LIKE 'migration:20260810020000%';
```

`metadata -> 'measured'` holds the counts read in the same statement as the
rewrite — `adminBefore`, `lodgeBefore`, `rewritten` and the action names actually
touched — and `metadata -> 'derived'` holds `adminAfter` and `lodgeAfter`
computed from them. **Read all of those as scoped to the eighteen actions above,
not to the categories.** They count only bed-allocation and lodge-display entries,
so they are far smaller than the totals the Category filter shows for Admin or
Lodge; that is correct, not a miscount.

**Re-running is safe.** The `WHERE` clause is the state the statement destroys, so
a second run finds nothing left to move, and the `AUDIT_CATEGORY_BACKFILLED` entry
is written only when rows actually moved — a replay rewrites no row and appends no
row.

**Post-upgrade action — recommended, and the runbook asks for it.** `prisma
migrate deploy` runs **before** cutover, while the previous colour is still
serving and still filing new bed-allocation entries the old way. Every allocation
made in that window is written *after* the statement has already passed, so it
keeps `admin` permanently unless the statement runs again. Run the same file
verbatim once cutover is complete
([`PRODUCTION_UPGRADE_RUNBOOK.md`](PRODUCTION_UPGRADE_RUNBOOK.md) §3.2):

```bash
psql "$DATABASE_URL" \
  -f prisma/migrations/20260810020000_backfill_bed_allocation_audit_category/migration.sql
```

Expect either a second `AUDIT_CATEGORY_BACKFILLED` entry naming the handful of
window rows, or no new entry at all — both are correct. **Skipping it is not a
failure**, but it is not free either: those few entries stay under the **Admin**
filter (where clearing the filter, or **All**, still finds them), and the system
correlation tool in AI Diagnostics keeps returning them for up to seven days
afterwards — which is exactly the week somebody is most likely to ask what
happened during the upgrade.

**There is no rollback.** A committed data rewrite survives a rollback of the
code, and this migration is not `windowed`, so it ships no `rollback.sql`. Your
pre-migration backup (step 3 of the generic procedure) is the only way back, and
the club's own record of what happened is the audit entry above.

---

## v0.13.1 → v0.13.2

`v0.13.2` is a **patch** release carrying **six migrations — five additive/expand
migrations plus one destructive `contract` migration** — and two operator actions
that are not migrations: re-entering backup credentials, and re-exporting any
configuration bundle you rely on. The five expand migrations need no operator
action; the contract migration and the two non-migration actions are covered
below.

The five expand migrations are all additive and blue/green safe:

- **`20260722120000_add_integration_wizard_progress`** — the setup-wizard cursor
  for the new guided provider wizards (#2080).
- **`20260722130000_add_xero_webhook_validation_receipt`** — the Xero webhook
  validation-receipt sink used by the Xero wizard's verify step (#2081).
- **`20260722140000_expand_club_theme_orphan_column_defaults`** — adds a DB
  `DEFAULT` to the four legacy `ClubTheme` colour columns so the new runtime can
  `INSERT` a theme row without naming them, while the draining previous colour is
  unaffected (#2187). This is the EXPAND half of the pair whose CONTRACT drop is
  below.
- **`20260722150000_add_backup_run`** — the backup-run ledger for the managed
  backup integration (#2095).
- **`20260723120000_add_ai_assistant`** — the AI help assistant models (#2211).

### The `ClubTheme` orphan-column contract drop

`20260722160000_contract_drop_club_theme_orphan_columns` **drops** the four
former `ClubTheme` columns `brandCharcoal` / `brandRidge` / `brandMist` /
`brandSnow`. It is `old_code_compatible=yes` and carries a full rationale row in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`
(`previous_expand_release = 20260722140000_expand_club_theme_orphan_column_defaults`),
and the blue/green validator **refuses to run it without the breaking-migration
acknowledgement.**

The subtlety this release: the paired EXPAND migration ships in **this same tag**,
so at the moment `v0.13.2` is deploying, the draining previous colour (`v0.13.1`)
still names those four columns in its theme reads and writes — Prisma projects
every scalar in an unnarrowed `SELECT` and in a mutation's implicit `RETURNING`.
Dropping the columns while `v0.13.1` is still live breaks the old colour. The
drop is legal **only once `v0.13.2` has replaced and drained `v0.13.1`.** Choose
one of two paths:

- **Defer it (recommended).** Deploy `v0.13.2`, letting the five expand
  migrations run, and mark the contract migration applied **without running it**
  so the old colour keeps its columns while it drains:

  ```bash
  npx prisma migrate resolve --applied 20260722160000_contract_drop_club_theme_orphan_columns
  ```

  Then, in a later window once `v0.13.2` is the soaked, drained colour, run the
  drop for real. Because the migration is now recorded as applied,
  `prisma migrate deploy` will **never execute it again** — first reset its
  record so the deploy re-picks it up (with the override below):

  ```bash
  npx prisma migrate resolve --rolled-back 20260722160000_contract_drop_club_theme_orphan_columns
  ```

  or, equivalently, run the migration's `ALTER TABLE "ClubTheme" DROP COLUMN …`
  statements manually in that window and leave the record as applied.
- **Run it in a quiet window.** Once `v0.13.1` is fully drained and `v0.13.2` is
  the live colour, run the drop with the breaking-migration acknowledgement:

  ```bash
  export ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1
  export BLUE_GREEN_MIGRATION_OVERRIDE_REASON="ClubTheme orphan-column drop (#2187 P4); v0.13.2 substrate runtime deployed and drained since <date>; backup <id> restore-tested"
  ```

  Put the real drain date and a restore-tested backup id in the reason — it is the
  audit record for why the drop was safe. Unset both afterwards so the next deploy
  does not inherit the override.

There is **no down-migration**: a `DROP COLUMN` cannot be undone by rolling the
app back. The four dropped surfaces are derived from the generated palette at
render time, so no theme surface is lost, but the raw columns are gone — take and
restore-test a fresh backup before you run the drop.

### Before deployment

1. **Take and restore-test a fresh backup** before running the contract drop —
   the column drop is irreversible without it.
2. **Confirm your blue/green plan for the contract drop** — decide up front
   whether you are deferring it (mark-applied now, run later) or running it in a
   quiet window once `v0.13.1` has drained. Do **not** run the drop while a
   pre-`v0.13.2` colour is still live.
3. **Note the backup re-entry that follows.** If this install configured backups
   through the legacy `BACKUP_*` env vars, have the S3 access key, secret,
   bucket, region, and restore-validation DSN ready to re-enter after the upgrade
   (see post-upgrade actions) — nightly backups fail loudly until you do.

### Post-upgrade actions

1. **Re-enter the backup settings (#2095).** The legacy `BACKUP_ENABLED`,
   `BACKUP_S3_*`, `BACKUP_RETENTION_DAYS`, and `BACKUP_RESTORE_VALIDATION_URL`
   environment variables are **no longer read**. An install that configured
   backups through them upgrades to an empty store, so the nightly backup reports
   a **loud FAILURE** (never a silent skip) until you re-enter the settings at
   **Admin → Integrations → Database Backups** (`/admin/backups`). Confirm a
   manual **Run backup now** succeeds and the durable (S3) destination is
   configured. Only `BACKUP_CRON_SCHEDULE` (cron-leader timing) stays in the
   environment; remove the other `BACKUP_*` vars once migrated.
2. **Re-export any configuration bundle you rely on (#2187).** Bundles now export
   at **format version 2**; a bundle exported by a pre-`v0.13.2` app (version 1)
   is **refused on import** with a clear message. Re-export from the upgraded
   source install before moving configuration between installs.
3. **The provider wizards need no forced action (#2080/#2082/#2087).** They are
   the new guided path to the DB-only credential store already introduced in
   `v0.13.1`; existing connections keep working. Any legacy provider env vars are
   detected, warned about, and ignored — re-enter the values in the wizard, then
   remove the env vars.
4. **The AI help assistant is off by default (#2094).** It does nothing until a
   Full Admin enables the module and enters an Anthropic API key (in-app, held
   only in the encrypted vault). The chat-style help widget answers curated page
   questions regardless of whether the paid module is on. A hard monthly spend cap
   (default NZ$10) bounds AI spend once enabled.
5. **Run the contract drop when the soak is complete** if you deferred it — see
   the two paths above.

---

## v0.13.0 → v0.13.1

`v0.13.1` is a **patch** release carrying **three migrations — two destructive
`contract` migrations plus one additive/expand migration** — across two
operator-relevant workstreams:

- **Release B of the #2129/#2130 contract series** (the two `contract`
  migrations): they finish what the `v0.13.0` runtime-prep (Release A) made legal,
  require the breaking-migration acknowledgement at deploy time, and are only legal
  once `v0.13.0` is the deployed, drained colour.
- **Encrypted DB-only provider credentials (#2079)** (the one expand migration,
  `20260721210000_add_integration_credential`): Xero credential resolution is hard-
  cut from env `XERO_*` to an encrypted store, so an existing Xero-connected
  install enters a documented "needs re-entry" state at cutover and **Xero work
  pauses** until a Full Admin re-enters credentials in-app and reconnects. Its
  operator subsection is below the Release B steps.

Both workstreams ship in this one tag; complete the Release B steps **and** the
#2079 re-entry.

### Release B: the two contract migrations

This is a **separate deploy on top of `v0.13.0`** (the runtime-prep "Release
A", shipped and deployed). Do not start it until `v0.13.0` has been the live,
drained colour in production long enough that you are confident it is staying
(a normal soak — at minimum, past the point where you would have rolled back).

Two destructive `contract` migrations, both `old_code_compatible=yes`, both
fully justified in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`:

- **`20260721120000_contract_drop_season_rate`** — `DROP TABLE "SeasonRate"`,
  the frozen member/non-member boolean-keyed nightly-rate table. Its rows were
  copied forward to `MembershipTypeSeasonRate` by the E4 re-key
  (`20260717140000_pricing_rekey_by_membership_type`) and nothing has priced
  from them since. Release A (#2129 step 1) removed the last
  application-runtime reader, the public `{{hut-fees}}` embed; the only other
  references were seeders, removed in the same PR as this migration. The
  migration opens with a **coverage guard** that aborts the whole deploy if any
  `SeasonRate` row has no `MembershipTypeSeasonRate` counterpart — pre-flight it
  with the query in step 3 below.
- **`20260721130000_contract_drop_ismember_and_agetier_xero_columns`** —
  deletes the orphaned legacy `HUT_FEE` item-code rows that carry no
  `membershipTypeId` (not resolvable for pricing by the current runtime; a production install
  typically has a handful — ours had 16), drops the old
  `(category, ageTier, seasonType, isMember)` unique index, drops
  `XeroItemCodeMapping.isMember`, and drops
  `AgeTierSetting.xeroContactGroupId`/`xeroContactGroupName` (their data moved
  into `XeroContactGroupRule` at E8, `20260716140000_xero_member_grouping`).
  This one is legal **only** because `v0.12.2` narrowed the reads and Release A
  (#2130 STEP 1.5) narrowed the writes on both models, so the draining colour
  names none of these columns in a `SELECT` or an implicit `RETURNING`.

**Before deploying Release B**

1. **Take and restore-test a fresh backup — this deploy drops schema.** There is
   no down-migration. A `DROP TABLE` and a `DROP COLUMN` cannot be undone by
   rolling the app back; restore from backup is your only recovery for the
   dropped data.
2. **Confirm `v0.13.0` is actually the deployed colour.** Check the running
   image/tag, not just what merged. If the live colour is `v0.12.2` or earlier,
   **stop** — deploying Release B against it will break the drain.
3. **Pre-flight the `SeasonRate` coverage check.** The `SeasonRate` drop is only
   safe because the E4 re-key
   (`20260717140000_pricing_rekey_by_membership_type`) copied every row forward
   into `MembershipTypeSeasonRate` — but that copy was **conditional** on your
   install having a `MEMBER_RATE`-behaviour membership type and a type keyed
   `NON_MEMBER` at the time. On a fork whose types did not match, it copied
   nothing and `SeasonRate` is still the only copy of that pricing. Run this
   **read-only** query against your production database before you start:

   ```sql
   SELECT sr."seasonId", sr."ageTier", count(*) AS uncovered_rows
   FROM "SeasonRate" sr
   WHERE NOT EXISTS (
     SELECT 1 FROM "MembershipTypeSeasonRate" m
     WHERE m."seasonId" = sr."seasonId"
       AND m."ageTier" IS NOT DISTINCT FROM sr."ageTier"
   )
   GROUP BY 1, 2;
   ```

   **Zero rows means you are clear.** Any rows returned name seasons and age
   tiers whose rates exist *only* in the table about to be dropped, including
   inactive and past seasons. Recreate those rates as per-membership-type rates
   (**Admin → Seasons & Rates**) and re-run the query until it is empty. The
   migration carries the same check as an aborting guard, so if you skip this
   step the deploy fails safely instead of losing the rates — but it fails
   mid-deploy, which is a worse place to discover it. If the guard does fire,
   reconcile the rates; **do not** delete the orphaned rows or edit the guard
   out.
4. **Set the breaking-migration acknowledgement for this deploy only.** The
   blue/green validator refuses a destructive migration without it:

   ```bash
   export ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1
   export BLUE_GREEN_MIGRATION_OVERRIDE_REASON="Release B contract drops (#2129 step 2, #2130 STEP 2); Release A runtime-prep deployed and soaked since <date>; backup <id> restore-tested"
   ```

   Put the real soak date and backup identifier in the reason — it is the audit
   record for why the drop was safe. Unset both afterwards so the next deploy
   does not inherit the override.
5. **No special traffic window is needed.** Both tables are cold admin-only
   config tables: `DROP TABLE`, `DROP INDEX` and `DROP COLUMN` are
   metadata-only catalog changes taking a brief `ACCESS EXCLUSIVE` lock each,
   and the row delete touches a handful of rows. No hot table, no table
   rewrite, no backfill. The normal deploy window is fine; let the deploy guard
   stop on lock timeout.
6. **No Xero call is made.** Neither migration contacts Xero — no contact,
   contact group, item or invoice is touched.

**Post-upgrade actions (Release B)**

1. **Spot-check hut-fee pricing and one Xero hut-fee invoice line.** Quote a
   member and a non-member booking and confirm the totals and item codes match
   what you saw before the deploy. They should be identical — the migration
   removes only structures nothing reads — but this is the cheapest possible
   confirmation.
2. **Check Xero member grouping still resolves.** Visit the member-grouping
   admin page and run its dry-run. Grouping has been driven by
   `XeroContactGroupRule` since E8; the dropped `AgeTierSetting` columns were
   dead copies.
3. **Nothing to reconfigure.** No setting, flag or mapping needs re-entering,
   and no admin-visible screen changes.

**Rollback boundary (Release B).** A validator or pre-migration failure aborts
the deploy before any schema change and the old colour keeps serving untouched.
Once the migrations have applied, a failed cutover auto-restores traffic to the
Release A colour, which runs correctly against the contracted schema — that is
precisely what the runtime-prep release bought. **Rolling back past `v0.13.0`
(to `v0.12.2` or earlier) against the contracted schema will not work**: that
colour still names the dropped column and table. Roll forward, or restore the
pre-upgrade backup and lose the writes since it was taken.

### Encrypted DB-only provider credentials (#2079)

The additive migration `20260721210000_add_integration_credential` adds one new
standalone table and needs no override; it deploys alongside the Release B
migrations above. The operator-visible part is the **hard cutover of Xero
credential resolution** from env `XERO_*` to the encrypted store.

**What stops working at cutover** for a previously env-configured, Xero-connected
install:

- The old `XERO_ENCRYPTION_KEY` is no longer read, so the previously stored Xero
  OAuth tokens become **unreadable by design** (deliberately no silent key
  import). Xero surfaces a clean **"reconnect Xero"** state — nothing crashes at
  boot, cron, webhook, or page load.
- `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` / `XERO_REDIRECT_URI` /
  `XERO_WEBHOOK_KEY` are ignored; setup readiness raises a warning naming the exact
  vars still present ("configured in-app now — re-enter there, then remove these").
- **Xero sync, webhook verification, and invoice/payment automation are
  fail-flagged and paused** — not crashing — until the credentials are re-entered
  and Xero is reconnected. The Xero outbox marks each pending op FAILED (replayable
  after reconnect); no money path changes.

**Re-entry steps (Full Admin):**

1. **Ensure `AUTH_SECRET` (or `NEXTAUTH_SECRET`) is strong** — at least 32
   characters and not the `.env.example` placeholder. Credential capture is
   **hard-blocked** on a weak secret; setup readiness shows a passive amber warning
   before you start. There is no boot-time enforcement — the block is at the
   capture form only.
2. Deploy the release. Nothing fails at boot; readiness shows the legacy-env
   warnings and the Xero "reconnect" prompt.
3. Open **Admin → Xero → Setup** (the Integrations hub links here) and use the
   **Xero Credentials** section to re-enter the client id, client secret, and
   (optional) webhook key. Each write is Full-Admin only, encrypted at rest, and
   audited (metadata only); values are never displayed back. The wrapped
   token-encryption key auto-generates on first use.
4. **Reconnect Xero (OAuth)** so fresh tokens are stored under the new key. A
   client-credential write drops any stale stored tokens (verify-reset), so a
   reconnect is required after re-entry.
5. Remove the now-ignored `XERO_*` credential env vars from the environment; the
   readiness warning clears. Because production runs blue/green web slots plus a
   cron-leader, a wizard write in one web slot is observed by the cron-leader
   within the credential cache TTL (about 45 s), no restart required.

The full step-by-step, including the per-provider re-entry order, is the **DB-only
provider credentials** upgrade runbook in `DEPLOYMENT.md`.

**Credentials at rest.** Stored credentials are encrypted with AES-256-GCM under a
key derived from the app auth secret, so **a database backup plus the auth secret
decrypts everything** — treat the auth secret with the same care as the database,
and **never share a production auth secret with staging or clones** (a restored
clone is *expected* to fail decryption and enter the re-entry state, which is
correct, not a bug). See `docs/SECURITY-ATTACK-SURFACE.md` → "Credentials at
rest".

**Rollback boundary (#2079).** The migration is purely additive, so the old colour
is unaffected by it; the credential cutover is a runtime behaviour of the new
colour, not a schema break. Rolling the app back to a build that still reads env
`XERO_*` would restore the old resolution path, but the standard rollback boundary
for this release is set by the Release B contract drops above, not by this
migration.

---

## v0.12.2 → v0.13.0

`v0.13.0` is a **minor** release. It lands the annual-subscription billing epic
(#2151) — the double-billing fix with void/re-bill (#2147), billing-exception
resolution provenance (#2148), the membership-type-derived subscription
requirement that replaces the old role-based exemption (#2149), and the operator
"already invoiced" family marker (#2161) — plus a week of admin UI, theming,
config, and Xero-surface work. **This release changes money paths**: read the
full inventory in `docs/releases/v0.13.0.md` and the `0.13.0` changelog section
before starting.

It carries **four migrations, all expand / metadata-only and all
`old_code_compatible=yes`.** Unlike `v0.12.2` (which had two breaking `contract`
migrations), **none of these is breaking**: the blue/green validator passes with
**no `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` override**, and a normal deploy
window is sufficient. **If the validator demands that override for this release,
the checkout is wrong** — stop and re-check you are on `release/v0.13.0` at the
intended commit before proceeding.

Two operator concerns carried forward from the previous range still apply and are
repeated below: the config-transfer legacy-bundle window (#2131) and the public
`{{hut-fees}}` embed re-sourcing (#2129 step 1). Neither adds a migration.

### Before deployment

1. **Take and restore-test a fresh backup**, as always. This release adds tables,
   columns, an enum value, and a data-only seed, but **drops nothing and rewrites
   no table**, so a normal deploy window is sufficient.
2. **Review the four pending migrations against the safety ledger. All four are
   expand/metadata-only, old-colour compatible, and need no override.**
   - `20260720130000_subscription_invoice_dedup_void_release` (#2147, **expand,
     ledgered**) adds the `VOIDED` charge-status enum value, a
     `MemberSubscription.voidGeneration` integer (constant default 0), a nullable
     `MembershipSubscriptionChargeCoverage.releasedAt`, and swaps the coverage
     `subscriptionId` full UNIQUE for a partial UNIQUE over active
     (`releasedAt IS NULL`) claims. Metadata-only on cold membership-billing
     tables. The draining old colour never reads the new columns and cannot
     create a second coverage row per subscription (only the new void→re-bill
     runtime does), so it never needs the dropped full-unique constraint. See the
     forward-only note below.
   - `20260720140000_billing_exception_resolution_provenance` (#2148, **expand,
     ledgered**) creates the `MembershipBillingExceptionResolution` enum
     (`CONFIRM | PREVIEW_RECONCILE`) and adds a nullable
     `MembershipBillingException.resolvedVia` with no default. Metadata-only ADD
     COLUMN on a cold table; existing/legacy resolved rows and every OPEN row stay
     NULL — the documented "resolved before this column existed / not yet
     resolved" state. The old colour never names the enum or the column.
   - `20260720180000_seed_admin_lodge_membership_types` (#2149, **metadata-only
     data seed, ledgered**) seeds the built-in ADMIN and LODGE membership types
     (both `subscriptionBehavior = NOT_REQUIRED`). No DDL and no schema change on
     the cold, admin-only `MembershipType` / `MembershipTypeAgeTier` config
     tables; the old colour resolves ADMIN/LODGE via the old role exemption and
     never reads these rows for a subscription decision. See the behaviour change
     below.
   - `20260721100000_family_season_invoice_marker` (#2161, **expand, ledgered**)
     creates the new, empty `FamilyGroupSeasonInvoiceMarker` table with its
     indexes, foreign keys, and one partial UNIQUE over active markers per
     `(familyGroupId, seasonYear)`. Purely additive; the old colour has no model
     for it and never reads or writes it. See the drain-window edge below.
3. **Re-export any archived config bundle you intend to keep, before you
   upgrade (#2131).** From v0.12.2 the importer rejects the legacy bundle shapes
   at dry-run — the `isMember` column on `season-rates.csv` and on the Xero
   `item-code-mappings.csv` HUT_FEE rows, and the pre-#1931 `ENTRANCE_FEE`
   item-code category name. Any bundle exported by **v0.12.2 or earlier** is
   likely to carry them. Export a fresh bundle from your still-running install
   (**Admin → Setup & Configuration → Export & Import**) and archive that
   instead; a bundle exported after the upgrade is already in the current shape.
   If your source install is already gone, the old zip can be hand-fixed —
   follow "Converting a legacy bundle by hand" in the
   [Export & Import operator guide](guides/config-transfer.md#converting-a-legacy-bundle-by-hand),
   then **Reseal edited bundle** and re-preview. If you set
   `CONFIG_BUNDLE_IMPORT_PATH` for disaster-recovery or clone boots, make sure
   the bundle at that path is a current-shape export: a legacy bundle there is
   refused at boot (`refused-invalid`, nothing written) and the replacement
   install comes up **unconfigured**, visible only in the boot logs.

### Post-upgrade actions

1. **#2149 behaviour change — the role-based subscription exemption is dropped.**
   Membership type — `subscriptionBehavior`, plus age tier where the type is
   `BASED_ON_AGE_TIER` — is now the **sole authority** on whether a member owes a
   subscription; the login `Role` enum is a pure permission concept again. A
   fee-paying member who happens to hold `role=ADMIN` now shows their **real**
   subscription status (Paid/Unpaid/Overdue) everywhere, instead of being
   silently exempt. The migration seeds two built-in types so the dropped
   exemption has a DB-backed `NOT_REQUIRED` fallback: **ADMIN**
   (`NOT_REQUIRED`, `BLOCK_BOOKING`) and **LODGE** (`NOT_REQUIRED`,
   `MEMBER_RATE`), and `defaultMembershipTypeKeyForRole` now maps ADMIN→ADMIN and
   LODGE→LODGE (previously both fell through to the billable FULL type). Two
   consequences to expect: a **bare admin service account can no longer book as
   itself** (its fallback type is `BLOCK_BOOKING`) — a real fee-paying human who
   holds the admin permission is assigned a real membership type and is
   unaffected; and a **LODGE kiosk account still books** on behalf of members
   (`MEMBER_RATE`) and never owes a subscription. The seed is idempotent and
   self-healing: it create-if-missing **and** reconciles the
   `isBuiltIn`/`isActive` + `bookingBehavior`/`subscriptionBehavior` of any
   pre-existing **hand-created** ADMIN/LODGE row, while **preserving an
   admin-edited name and description**. After cutover, confirm a bare
   ADMIN/LODGE account is excluded from the billing preview (no
   `MISSING_MEMBERSHIP_ASSIGNMENT`) and that any real fee-paying admin shows their
   true subscription status.
2. **#2147 is a forward-only expand — recovery is roll-forward, not down.** The
   coverage `subscriptionId` UNIQUE is reshaped to a partial UNIQUE over active
   claims so a retained released claim can coexist with a fresh active one. Once
   any subscription accrues a **released + active coverage pair** after a
   void→re-bill, re-creating the old full `subscriptionId` UNIQUE (the pre-#2147
   shape) **fails on the duplicate `subscriptionId`**. There is no automated
   down-migration for this; if you must recover, roll the application forward
   (fix and redeploy the new colour) rather than attempting to restore the old
   constraint. A voided invoice now reads as `NOT_INVOICED` (re-billable) where it
   previously read as `UNPAID` (booking lockout) — an intended, documented
   semantics change.
3. **#2161 marker drain-window edge — use the standard confirm quiet window.**
   During the brief old/new overlap the new colour can create active family
   markers, and for the marker's documented use case (a real invoice or coverage
   already covers the family) the old colour's #2147 suppression predicate is a
   superset that already suppresses the same family, so no old-colour confirm
   mints a second charge. The one residual edge is a **purely manual marker with
   no DB-detectable invoice or coverage anywhere in the group**: an old-colour
   admin confirm during drain would not see that marker and could bill the
   family. Mitigate it the standard way — run the annual-billing **confirm in a
   quiet admin window** across the brief overlap and cut over promptly.
4. **Check your public hut-fee table if you use the `{{hut-fees}}` embed
   (#2129).** The embed now reads the authoritative per-membership-type rate
   table instead of the frozen legacy member/non-member one, and it renders
   **one column per publicly-listed membership type** (types priced identically
   share a column). Which columns appear is controlled entirely by the
   **Publicly listed** flag on each membership type — the same flag the joining-
   fee and annual-fee embeds already use. If you have not set that flag on the
   types you advertise, the table can collapse to a single column and quietly
   stop showing non-member pricing. Set **Admin → Membership Types → Publicly
   listed** on every type you want on the public rate card *before* upgrading,
   then check the page. Setup readiness also warns on **Seasons And Rates** when
   the embed is enabled but fewer than two types would produce a column.
   Hand-authored Xero bundles still need a membership type on every `HUT_FEE` row
   (a blank `membershipTypeKey` is a blocking row error), and export/import of
   current-shape bundles is byte-identical to before.

**Rollback boundary.** A validator or pre-migration failure aborts the deploy
before any schema change: the old colour is untouched and keeps serving. A failed
cutover auto-restores traffic to the old colour, which then runs against the
migrated schema — **every migration this release is old-colour compatible** (all
four are expand/metadata-only, and the two forward-only expands, the #2147
coverage-unique reshape and the #2161 new table, add nothing the old colour
reads), so the old colour keeps working. Roll forward (fix and redeploy the new
colour — the preferred path) or restore the pre-upgrade backup, losing all writes
since it was taken. **There is no down-migration**, and the #2147 coverage-unique
reshape cannot be automatically reversed once a void→re-bill has created a
released + active coverage pair (recovery is roll-forward).

---

## v0.12.1 → v0.12.2

`v0.12.2` is a patch release with **four migrations — two expand/additive and
two breaking `contract` migrations** (one of them destructive). This is the
first release since the expand/migrate/contract series began that carries a
destructive contract migration, so it needs more deployment care than `v0.12.1`.
It fixes the production Xero lock-date 503, adds a Xero lock-date error taxonomy
and a connection-health probe, brings the age-exempt (N/A) membership-type
lifecycle (single-source enforcement, bulk assignment, Xero Setup import, opt-in
fee item-code paid-detection), multi-select age tiers for Xero member-grouping,
a changed admin post-login landing default, and a batch of admin/booking UX
fixes. Read the full inventory in `docs/releases/v0.12.2.md` and the `0.12.2`
changelog section before starting.

### Before deployment

1. **Take and restore-test a fresh backup — this release drops schema.** As
   always take a fresh `pg_dump` immediately before migrating and confirm it
   restores, but treat it as mandatory here: `20260720120000_contract_drop_...`
   issues `DROP TABLE`s that cannot be undone by rolling the app back (there is
   no down-migration). Restore is your only recovery for the dropped data.
2. **Two of the four migrations are breaking `contract` migrations and need the
   `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` acknowledgement.** The blue/green
   validator refuses a breaking migration without it; set it (with the
   acknowledgement as the override reason) for this deploy only:
   - `20260719170000_xero_grouping_age_tiers_multiselect` backfills the scalar
     `XeroContactGroupRule.ageTier` into a new `ageTiers` array (`X → [X]`,
     `null → []` = "all tiers") and then **drops the scalar column**. It is
     `old_code_compatible=yes` but **window-bounded and admin-only**: between
     migrate and cutover the old colour's grouping/membership-admin reads still
     name `ageTier` and error with column-does-not-exist. The live grouping sync
     fails **closed** (a member edit/age-up that would re-group errors and is
     retried post-cutover — no partial write, no money, no booking capacity).
     **Deploy with grouping/membership-admin traffic idle (a quiet admin window)
     and cut over promptly.** No member is re-grouped in Xero by the migration.
   - `20260720120000_contract_drop_entrance_fee_and_agetier_xero_group` (E13,
     the blue/green-safe subset of #1939) drops the dead `EntranceFee` and
     `AgeTierXeroAcceptedContactGroup` tables and deletes the orphaned
     `entranceFeeAmountCents` account-mapping row. It is `old_code_compatible=yes`
     — an independent drop-proof review re-verified **zero readers against the
     `v0.12.1` tag** (the colour draining during this deploy): the current
     runtime issues no SQL naming those structures and there is no FK/cascade
     trap — so the draining old colour keeps working. The acknowledgement is
     required only because a `DROP` is breaking by class, not because the old
     colour breaks. Deliberately **kept/deferred** (still read by the current
     runtime): the `EntranceFeeCategory` enum, `SeasonRate` (the live public
     `{{hut-fees}}` embed), `MembershipTypeAgeTier`, and the
     `XeroItemCodeMapping.isMember` / `AgeTierSetting.xeroContactGroup*` columns
     — follow-ups #2129/#2130/#2131.
     *(Superseded after this release. The sentence above describes the position
     as at v0.12.2. Release A then re-sourced the public `{{hut-fees}}` embed
     onto `MembershipTypeSeasonRate` (#2129 step 1) and narrowed the remaining
     writes on the two column-carrying models (#2130 STEP 1.5), and Release B
     dropped `SeasonRate`, `XeroItemCodeMapping.isMember` and the
     `AgeTierSetting.xeroContactGroup*` columns — see the Unreleased section.)*
3. **The two additive migrations need no special handling.**
   `20260719150000_add_post_login_landing` adds a `PostLoginLanding` enum plus a
   nullable `Member.postLoginLanding` column with no default (metadata-only
   catalog change even on the hot `Member` table; ledgered
   `old_code_compatible=yes`). `20260719180000_add_use_fee_schedule_item_codes`
   adds a single flagged-**off** boolean on the cold single-row
   `MembershipLockoutSettings` table (additive, constant default, ledger-exempt
   under the same policy as v0.12.1's `add_login_security_setting`).
4. **Know what is opt-in vs behaviour-changing.** The new **fee item-code**
   subscription paid-detection mode is **off by default** — nothing changes until
   an admin enables "Use membership fee item codes", and it is config-only (its
   migration only adds the flag). The **age-exempt (N/A) membership types**
   feature is config-only too — no migration; it takes effect only when an admin
   sets a type's allowed age tiers to include or restrict to N/A. The one genuine
   **behaviour change** is admin **post-login landing** (below): it is applied by
   the application, not by stored data, so it takes effect at the first login
   after cutover with no migration flag to set.

**Rollback boundary.** A validator or pre-migration failure aborts the deploy
before any schema change: the old colour is untouched and keeps serving. A failed
cutover auto-restores traffic to the old colour, which then runs against the
migrated schema — every migration this release is old-colour compatible (the two
additive ones trivially; the grouping drop only under the quiet-admin-window rule
above; the E13 drops because nothing in the old colour reads the dropped
structures), so the old colour keeps working. Roll forward (fix and redeploy the
new colour — the preferred path) or restore the pre-upgrade backup, losing all
writes since it was taken. **There is no down-migration, and the E13 `DROP TABLE`s
are irreversible without that backup.**

### Post-upgrade actions

1. **Tell your admins their landing changes on the next sign-in (behaviour
   change).** From the first login after cutover, a member with admin access who
   has set no preference lands on their **admin area** (their first accessible
   admin page) instead of `/dashboard`. This applies to **every** member whose
   role resolves to an accessible admin page — not just full admins, but also
   **read-only admins** and **finance-only viewers** (for example, a finance-only
   viewer lands on `/admin/payments`). It is applied by the application, not by
   stored data. A plain member is unaffected; a member with no accessible admin
   area — including a demoted ex-admin holding a stale preference — still lands on
   `/dashboard`, never a permission-denied loop. Point admins who prefer the
   member view at the new "After sign-in, take me to" control on the profile
   **Account Information** card.
2. **Verify Xero is healthy and past-dated bookings work.** Open Admin → Xero and
   confirm the new connection-health chip shows Connected (click the probe if
   needed); if it shows reconnect-required, reconnect from Setup. Confirm that
   creating a retroactive (past-dated) booking no longer returns the 503 lock-date
   error when the org has lock dates set.
3. **Check member-grouping rules survived the multi-select migration.** Each
   former single-tier rule should now show that one tier and each former
   "Any age" rule should show "all tiers"; run the admin "Refresh from Xero" and
   confirm no unexpected full regroup. Create per-tier annual-fee rows only if you
   are on the new colour (the v0.12.1 caveat still stands).
4. **Decide on the opt-in membership tooling.** If you bill one Xero item code per
   membership type + age tier, you can now enable "Use membership fee item codes"
   for subscription paid-detection (default off). The members-page **bulk set
   membership type** tool and the Xero **Setup import** mapping modes (age tiers /
   membership types / both) are available; imports never overwrite an existing
   current-season assignment and report what they skip.
5. **Confirm age-exempt types behave as intended.** For any membership type whose
   allowed age tiers restrict to or include **N/A (no age)**, check that holders
   resolve to `NOT_APPLICABLE` as expected and that N/A members remain
   non-bookable as linked guests.
6. **Note the in-stay extension semantics.** A member already at the lodge can
   extend night-by-night from the booking edit panel; minimum-stay is now
   evaluated against the **whole contiguous stay** (a one-night extension of an
   already-valid stay is no longer wrongly rejected) and surfaced as an advisory
   warning on the quote. Adopters with clubs mid-stay get this new evaluation
   immediately.

No one-off data backfill command is required after a successful migration. Apart
from the E13 drops, the migrations write no rows; all new feature behaviour is
opt-in through admin surfaces except the admin post-login landing default.

---

## v0.12.0 → v0.12.1

`v0.12.1` is a patch release with five migrations, **all expand/additive and
none contract**. It adds optional sign-in methods (a per-club password-complexity
policy plus module-flagged email magic-link and Google OAuth, both default off),
per-age-tier membership billing (subscription requirement and annual fees),
Lobby Display template/builder polish, a full operator and member documentation
library, and a screenshot-forward README. Read the full release inventory in
`docs/releases/v0.12.1.md` and the `0.12.1` changelog section before starting.

### Before deployment

1. **Take and restore-test a fresh backup.** As always, take a fresh `pg_dump`
   immediately before migrating and confirm it restores before you cut over.
2. **A normal deploy window is sufficient — no contract migration this
   release.** Four of the five migrations are catalog-only changes on cold
   config tables. The one build to note is the `add_google_oauth` unique index
   over `Member.googleSub`: it builds over an all-NULL new column (NULLs never
   collide), so it is a fast, trivially-distinct build that briefly blocks
   `Member` writes — negligible on a normal club, but switch its statement to
   `CREATE UNIQUE INDEX CONCURRENTLY` if `Member` is very large. Review the four
   ledger rows in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`
   (`add_magic_link`, `add_google_oauth`,
   `add_based_on_age_tier_subscription_behavior`, `annual_fee_age_tier` — all
   `old_code_compatible=yes`). The fifth, `add_login_security_setting`, is a
   single additive cold table and carries no ledger row (same policy as
   v0.12.0's ledger-exempt additive migrations).
3. **Do not author any per-age-tier annual-fee rows until cutover completes.**
   `20260719140000_annual_fee_age_tier` adds a nullable
   `MembershipAnnualFee.ageTier` with no backfill, so every existing row stays
   the flat (`NULL`-tier) fallback and prices identically. But the old colour's
   fee resolver does **not** filter by age tier, so a per-tier row is **not**
   invisible to it: once such a row falls in an active window the old colour can
   select it for a member of any tier (first match by `effectiveFrom` desc) and
   mis-price them at the wrong tier's amount. Keep annual fees flat-only across
   both colours for the whole migrate→cutover window; create per-tier annual-fee
   rows only after the new colour is serving. (Per-tier joining fees already
   shipped in v0.12.0 and are unaffected.)
4. **Know that the two new sign-in modules default off.** `magicLink` and
   `googleLogin` are flagged off, so magic-link and Google sign-in stay disabled
   through the migrate→cutover window until an admin enables them after cutover.
   The password-complexity policy applies only at password-set time and never
   re-validates an existing password, so no member is locked out at cutover.

**Rollback boundary.** A validator or pre-migration failure aborts the deploy
before any schema change: the old colour is untouched and keeps serving. A
failed cutover auto-restores traffic to the old colour, which then runs against
the migrated schema — every migration this release is old-colour compatible, so
the old colour keeps working (the only rule is the per-age-tier annual-fee
authoring caveat above). Roll forward (fix and redeploy the new colour — the
preferred path) or restore the pre-upgrade backup, losing all writes since it
was taken. There is no down-migration.

### Post-upgrade actions

1. Open the admin **Login & Security** page and confirm the password-complexity
   policy is what the club intends (an un-configured club keeps the previous
   default behaviour). Confirm existing members can still sign in with their
   password.
2. Under **Admin > Modules**, decide whether to enable email magic-link and/or
   Google OAuth — both default off. For Google, set the per-club
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` per `CONFIGURATION.md`, then confirm
   a member can link their verified Google account from their profile and sign
   in; the magic-link TTL is set on the Login & Security page.
3. For any membership type set to *Required based on age tier*, verify the
   age-tier settings (`subscriptionRequiredForBooking`) drive which tiers are
   billed and that exempt tiers receive no subscription invoice.
4. Confirm annual fees render correctly in admin fee configuration and the
   public annual-fees embed; create per-age-tier annual-fee rows only now that
   cutover is complete. Check the annual-fee editor's Xero Account/Item pickers
   list the expected codes (or fall back to manual entry with the amber notice
   if Xero is disconnected).
5. If the club uses Lobby Display, confirm the module is still off unless
   intended; if enabled, spot-check the template pack and the guided builder at
   `/admin/display/builder`.

No one-off data backfill command is required after a successful migration. The
migrations write no rows; all new behaviour is opt-in through admin surfaces.

---

## v0.11.0 → v0.12.0

`v0.12.0` is a large minor release with 25 migrations (24 expand/additive, one
contract). It adds the flagged-off Lobby Display module, exclusive whole-lodge
holds, un-flagged core multi-lodge operation, database-first club identity and
configuration with boot-time self-heal, authoritative fee schedules with
subscription and joining-fee billing, and rule-based Xero member grouping,
alongside broad booking-settlement and Xero/finance hardening. Read the full
release inventory in `docs/releases/v0.12.0.md` and the `0.12.0` changelog
section before starting.

### Before deployment

1. **Take and restore-test a fresh backup.** Neither Configuration Export nor
   the new `CONFIG_BUNDLE_IMPORT_PATH` boot auto-import is a database backup;
   both intentionally exclude members and transactional data.
2. **Schedule a quiet, low-write window.** Most of the 25 migrations are
   catalog-only, but single index builds run over `Booking`, `Member`, and
   `MemberSubscription` — each fast over an all-NULL new column, but a plain
   (non-`CONCURRENTLY`) build that briefly blocks writes to that table — and
   the fee, joining-fee, and Xero-grouping migrations run one-time backfills
   over small configuration tables.
3. **Plan the contract-migration window.**
   `20260714140000_drop_committee_member` drops the legacy standalone
   committee directory table. Its expand predecessor,
   `20260629130000_add_committee_roles_assignments`, shipped in `v0.11.0`
   (deployed 2026-07-13) and backfilled the member-linked roles/assignments
   while the table still existed, so confirm `v0.11.0` is fully deployed. The
   drop loses no data beyond the retired directory itself — no assignment or
   contact data lives only in the dropped table. The old colour's admin
   committee CRUD routes error with relation-does-not-exist between migrate
   and cutover (public committee and contact surfaces are unaffected). Idle
   or drain old-colour admin traffic, cut over promptly, and use
   `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` only with a non-empty
   `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` acknowledging this reviewed window.
   Do not use the override to bypass an unreviewed validator failure.
4. **Review the new fee and billing configuration surfaces.** Season rates
   keyed by membership type, joining fees, annual-fee components,
   subscription-billing settings, and family billing modes are backfilled
   from the club's existing configuration, and the legacy tables are retained
   so both colours price season and annual fees identically during cutover
   (entrance/joining fees carry the window caveat below). Read
   `docs/AUTHORITATIVE_FEES.md`, and where possible confirm on a staging
   restore that the backfilled schedules reproduce the club's current
   amounts before deploying.
5. **Idle membership approvals and entrance-fee minting on the old colour
   from migrate until cutover.** Once `20260717170000_joining_fee_model`
   re-keys the entrance-fee Xero item-code mappings from `ENTRANCE_FEE` to
   `JOINING_FEE`, the old colour resolves **both** the item code **and** the
   amount of a new entrance-fee invoice from the legacy flat mappings: it can
   mint a wrong per-category amount, or — if the flat amount is unset — mark
   the operation SUCCEEDED and silently never create the invoice. Operations
   queued before the window carry frozen amount/item payloads and replay
   safely. Keep membership approvals and entrance-fee minting fully idle on
   the old colour for the whole migrate→cutover window.
6. **Know the Xero member-grouping cutover plan.** The
   `xero_member_grouping` migration converges grouping configuration locally
   and performs **zero** Xero calls; no member is re-grouped until an admin
   runs the dry-run and bulk re-sync in
   `docs/XERO_MEMBER_GROUPING_RUNBOOK.md`. Avoid saving membership-type
   grouping rules on the draining old colour during the window, and re-run
   the runbook pre-checks after cutover.

**Rollback boundary.** A validator or pre-migration failure aborts the deploy
before any schema change: the old colour is untouched and keeps serving. A
failed cutover auto-restores traffic to the old colour, which then runs
against the migrated schema — the admin committee CRUD errors and the
old-colour entrance-fee caveat above apply until you either roll forward (fix
and redeploy the new colour — the preferred path) or restore the pre-upgrade
backup, losing all writes since it was taken. There is no down-migration.

### Post-upgrade actions

1. Verify database-first identity and configuration: open the admin club
   identity, lodge, capacity, age-tier, and email settings surfaces and
   confirm the expected values. These now resolve from the database with
   config-file fallback; the boot-time config self-heal backfills any missing
   database values from the effective configuration and never overwrites an
   admin edit.
2. Remove the retired email environment variables — `EMAIL_FROM_NAME`,
   `SUPPORT_EMAIL`, `CONTACT_EMAIL`, and `NEXT_PUBLIC_CONTACT_EMAIL` — from
   the deployment `.env`: their values are ignored, and a boot warning fires
   while any of them remains set (`EMAIL_FROM` remains required). Then
   confirm the support and contact addresses under **Admin > Email
   Messages**.
3. Confirm fee schedules render correctly: admin fee configuration (season
   rates by membership type, joining fees, annual fees and their components,
   subscription billing) and the public join/fees pages must show the same
   amounts the club charged before the upgrade. A previously visible public
   fee embed stays visible — the `public_content_annual_fees` migration seeds
   the new `{{annual-fees}}` visibility gate from the legacy public
   membership-types toggle — while a hidden one stays hidden until
   deliberately enabled, so verify public amounts wherever the club displayed
   them before.
4. Review **Admin > Modules**: the Lobby Display module defaults off —
   enable it only deliberately, following `docs/lobby-display/operating.md`,
   and confirm guest phone numbers stay hidden unless both the member and
   the lodge opt in (and only adult members' phones ever show; youth/child
   are never shown). Multi-lodge is no longer a module and needs no flag.
5. If the club uses school/group requests, smoke-check exclusive holds: a
   request can flag exclusivity, and an admin whole-lodge hold blocks all
   other bookings for its nights until released.
6. Before enabling any Xero member-grouping bulk re-sync, verify only the
   migration's backfilled tier rules are active (runbook pre-check) and run
   a fresh dry-run; the re-sync refuses a stale dry-run.
7. Spot-check a view-only admin access role: it can read admin surfaces but
   every action button, editor, and mutating route refuses writes.
8. Confirm `CONFIG_BUNDLE_IMPORT_PATH` is unset on the production deployment
   unless deliberately used for disaster recovery or cloning; when set, it
   imports only at boot and only into a database empty of non-seed
   configuration.

No one-off data backfill command is required after a successful migration.
The release's fee, grouping, and content backfills are migration-driven and
idempotent, and the configuration self-heal runs automatically at boot.

---

## v0.10.1 → v0.11.0

`v0.11.0` is a large minor release with 30 migrations and first-class
multi-lodge operation. It also adds configuration transfer, declared-partner
and shared-double workflows, admin booking recovery/override controls, and an
application-wide design/accessibility refresh. Read the full release inventory
in `docs/releases/v0.11.0.md` and the `0.11.0` changelog section before starting.

### Before deployment

1. **Take and restore-test a fresh backup.** Do not use Configuration Export as
   a database backup; it intentionally excludes members and transactional data.
2. **Schedule a quiet, low-write window.** The lodge-scoping migrations touch
   booking and operational tables. The booking capacity-hold and persisted
   capacity-override migrations each scan `Booking` to build an index, although
   their new columns are nullable and initially empty.
3. **Audit the capacity ceiling.** When Bed Allocation is enabled,
   `LodgeSettings.capacity` now caps the active-bed count. Run the read-only
   detection query in `docs/CAPACITY_MODEL.md` and confirm every lodge whose
   configured capacity is below its installed active-bed count.
4. **Plan the contract-migration window.** Review these ledger rows in
   `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`:
   - `20260708220100_drop_member_induction_item_result` is safe only after
     confirming the retired table contains no data that must be retained.
   - `20260708220200_drop_member_induction_self_assessment_columns` can make
     old-colour induction default reads/writes fail until cutover.
   - `20260708220300_drop_finance_report_mapping_label_columns` can make
     old-colour finance dashboard/mapping reads fail until cutover.
   - `20260709130000_drop_email_message_setting_lodge_identity_columns` can
     make old-colour email-settings and lodge-admin writes fail; member email
     settings fall back while the old colour drains.

   Idle or drain those affected old-colour paths, cut over promptly, and use
   `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` only with a non-empty
   `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` that acknowledges the reviewed
   windows. Do not use the override to bypass an unreviewed validator failure.
5. **Confirm default-lodge intent.** The migration sequence converts the
   existing installation into a lodge record and scopes dependent records to
   it. Record which lodge should be default before deployment so the result can
   be checked immediately after cutover.

### Post-upgrade actions

1. Open **Admin > Lodges** and confirm the expected lodge is the default, each
   active lodge has the intended capacity, rooms/beds, seasons/rates,
   instructions, and door-code/travel identity, and lodge-scoped records appear
   under the correct lodge.
2. Review **Admin > Modules** and lodge/member access. Confirm all capabilities
   the club uses remain enabled and that kiosk, chores, finance, waitlist, Xero,
   bed allocation, Internet Banking, and multi-lodge access match policy.
3. Smoke-check a booking capacity quote, Admin Bookings, bed allocation,
   waitlist, hut leaders, roster, and kiosk for every active lodge. Do not create
   live financial transactions merely to test the release.
4. Open the Finance dashboard and Xero mappings/sync views, then verify an
   ordinary operational email resolves the correct lodge identity. This checks
   the contract-migration cutover without contacting live providers
   unnecessarily.
5. Review **Admin > Site Style** and the public/login/member/admin shells in
   light and dark mode. Untouched default themes are reseeded from sage to teal;
   completed, partially customised, and non-default themes are left unchanged.
6. Review **Admin > Notifications**. Eleven previously hardcoded operational
   templates are now editable but remain locked to always-send; `two-factor-code`
   remains hardcoded because it is authentication-critical.

No one-off data backfill command is required after a successful migration. The
release's data repairs and lodge scoping are migration-driven and idempotent.

---

## v0.10.0 → v0.10.1

`v0.10.1` is a patch release: four payment/booking-recovery hardening changes
and one operator cleanup script (see the `CHANGELOG.md` `0.10.1` section). It
contains **no database migrations** and no schema changes — there is nothing to
look up in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, and either app color can
serve throughout the deploy. The standard procedure still applies: back up the
database before deploying.

### Post-upgrade actions

None required.

**Optional cleanup:** if your fork ever ran a pre-`v0.10.0` build (any build
older than PR #1489), booking cancellations may have flattened captured
`(PARTIALLY_)REFUNDED` payments' stored `status` to `FAILED`. The read path
already compensates, so this is cosmetic-only for the stored rows. You can
restore them with `npm run payments:backfill-cancel-flattened` (dry-run by
default; review the report before re-running with `--apply`). See "Backfill
cancel-flattened payment statuses" in `docs/MAINTENANCE.md`.

---

## v0.9.0 → v0.10.0

`v0.10.0` bundles a large quality-and-hardening wave, a remediation wave
(epic #1348), and a live-feedback admin-UX wave (epic #1438). Most of its ~49
migrations are ordinary expand migrations, but a few need operator attention.
Read the full `CHANGELOG.md` `0.10.0` section for the complete list; the
post-upgrade actions that matter are below.

### Post-upgrade actions

1. **Re-enable capability modules you use (destructive default change).**
   `20260627120000_core_module_defaults_off` switches the high-risk capability
   modules — **kiosk, chores, finance dashboard, waitlist, Xero integration, bed
   allocation, and Internet Banking payments** — to default `false`, and repairs
   only the untouched singleton `ClubModuleSettings` row (the one where
   `updatedByMemberId IS NULL`, i.e. never admin-saved). If your fork never
   opened and saved **Admin > Modules**, these features will switch **OFF** on
   upgrade. After upgrading, open **Admin > Modules** and re-enable the ones you
   use once the underlying provider/setup is ready. Rows an admin has already
   saved are left untouched; general-purpose modules stay default-on.

2. **Complete or export in-flight inductions first (destructive data change).**
   `20260702100000_induction_workflow_types` moves inductions to a single-Pass
   flow and, as part of that, **deletes in-flight (`DRAFT`/`IN_PROGRESS`)
   per-item induction results and clears their self-assessment state**.
   Completed historical inductions are preserved. Before upgrading, complete or
   export any inductions that members have started but not finished.

3. **Audit membership access roles if you ran intermediate `main`.**
   `20260630120000_rename_member_role_to_user` (a `contract` migration) collapses
   the legacy `Member.role` `MEMBER`/`ASSOCIATE`/`LIFE` values into `USER` and
   recreates the `Role` enum. It assumes **no live deployment used the
   intermediate Access-Roles window**. If your fork deployed a `main` build
   between **2026-06-28 and 2026-06-30**, run
   `npm run db:audit-access-role-cleanup` after upgrading and resolve anything it
   reports. Forks that upgraded tag-to-tag (from `v0.9.0`) never entered that
   window and can skip this.

4. **Plan the AgeTier `NOT_APPLICABLE` migration deploy (owner-decided plan).**
   `20260707000000_add_age_tier_not_applicable` adds a `NOT_APPLICABLE` age tier
   and `20260707000100_backfill_org_age_tier_not_applicable` flips ADULT
   organisation-type members (legacy SCHOOL role or ORG access role) to it. The
   backfill row is `old_code_compatible=no`: a pre-`v0.10.0` app color cannot
   deserialize `NOT_APPLICABLE`, so while both colors are live, old-color reads
   of the flipped rows (the admin members list, that member's detail, school
   flows) can error between migrate and cutover. This is the classic blue/green
   enum-backfill hazard — writing a brand-new enum value into hot-table rows at
   migrate time breaks the old color's reads until it drains.

   The upstream owner ratified the deploy plan on epic #1438 on **2026-07-07**:

   > **Backfill deploy strategy — Quiet window:** ship both #1440 migrations
   > normally, deploy at low traffic, cut over promptly (per the
   > `BLUE_GREEN_MIGRATION_SAFETY.tsv` row; the defer-the-backfill option remains
   > documented as the operator fallback).

   So: **deploy both AgeTier migrations in a quiet window and cut over
   promptly**, or **defer** `20260707000100_backfill_org_age_tier_not_applicable`
   until the old color has fully drained and re-run it then (the `UPDATE` is
   idempotent and safe to run late). The enum-add migration is a plain expand and
   is safe in either plan. The ledger row for the backfill records the same
   caution.

### Verified blue/green-safe — no re-audit needed

You do not need to re-audit these; they are recorded old-code-compatible in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`:

- The `ClubTheme` sub-AA gold theme bump only rewrites a persisted theme still on
  the old default; installs that changed their theme are untouched (#1244).
- The `ClubTheme` generic sage-to-teal correction only rewrites the incomplete
  `default` row when every stored theme value still exactly matches the legacy
  generic defaults after #1244. Completed themes, partially customised themes,
  and Tokoroa themes are untouched (#1832).
- The `BookingGuestNight` backfill runs automatically and old code ignores the
  table.
- The access-role backfills keep old code reading
  `Member.role`/`financeAccessLevel` unchanged while the new tables are added.

### Behaviour changes worth telling operators about

- **Capability modules default off** (see action 1) — the most visible change.
- **Booking Officer / on-behalf booking scope widened** — Booking Officers can
  see booking detail and `bookings:edit` holders can create/quote on behalf of
  members (their own bookings still go through normal member payment paths).
- **Email preferences are enforced** on reminder/chores sends — member opt-outs
  are now honoured.
- **Non-member hold policy is admin-toggleable.**
- **Cancellation policy — tiered credit restore.** A member who paid with account
  credit and cancels inside the 0%-refund window now forfeits that value like a
  card payer, instead of getting it all back. A captured-but-partially-refunded
  cancel is tiered on the remaining value. If your club has not briefed its
  committee on this, do so before wider rollout.
