# School Organisation Cutover

Audience: Operator

## What it is

The one-off release that stops a school being a person.

Until now, every school that booked with the club existed as a **member record**
with the school's name where a first name goes and nothing where a surname goes.
That invented person owned the booking, held the school's Xero customer and was
the subject of every audit line about it. This release gives each school a record
of its own and moves its bookings onto it, so the member list stops containing
buildings and Xero stops holding surnameless people.

It is a **windowed** release: the previous version of the application cannot read
a booking that has no member, so the club is offline for the length of the
migration rather than switching over while running. The technical sequence is in
[`DEPLOYMENT.md`](../../DEPLOYMENT.md) → "Windowed migrations" and
[`PRODUCTION_UPGRADE_RUNBOOK.md`](../PRODUCTION_UPGRADE_RUNBOOK.md) §2.4.2. This
page is the part that needs a person's judgement, and it happens **before** the
window opens.

## When you'd use it

- Once, when the release carrying programme #2912 is deployed.
- Again on a rehearsal database, before the real thing, to see the numbers and to
  make the decisions somewhere nothing depends on them.

## THE ONE THING THAT CAN STOP THE DEPLOY

The migration that moves the bookings **refuses to run, and writes nothing at
all, while any school-shaped member row is undecided**. That is deliberate. There
is no way to make it guess, and there is no flag that overrides it.

So the work below is not optional paperwork before a deploy. It *is* the deploy's
precondition, and it is the only part of the window that can take an unknown
amount of time — because it may need somebody to go and look at the club's own
records.

**Do it days before the window, not on the night.**

## Running these commands on the deploy host

**The deploy host has Docker and Docker Compose and nothing else** — no Node, no
`npm`, no `psql` (`DEPLOYMENT.md` → "Prerequisites"). Every command on this page
is therefore written to run *inside* a container, and a bare `npm run …` or
`psql …` pasted at the host shell fails with `command not found`. The two
wrappers, from the repository root:

```bash
# Anything that runs repository code — the census, in every form below.
docker compose --profile migrate run --rm migrate <command>

# Anything that is SQL.
docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
```

The `migrate` service is built from the image's `builder` stage, which carries
the repository and `node_modules`; the running app image deliberately has `npm`
and `npx` removed, so do not substitute it.

**Where "save the output" means.** Redirect on the **host**, outside the
container. A file written inside a container lands in its writable layer and is
destroyed the next time the deploy script recreates it — measured, and
§2.4.1 of [`PRODUCTION_UPGRADE_RUNBOOK.md`](../PRODUCTION_UPGRADE_RUNBOOK.md) is
emphatic about it. So:

```bash
docker compose --profile migrate run --rm migrate \
  npm run db:school-classification-census \
  | tee ./school-census-$(date +%Y%m%d-%H%M).txt
```

and then move that file off the host, beside the backup.

On a laptop with the repository and a Node toolchain — a rehearsal database, say
— the bare forms work and are shorter: `npm run db:school-classification-census`.
Nothing on this page depends on which you use.

## Step-by-step

### 1. See what the club actually has

Run the census against the club's database. It is **read-only**: it writes
nothing, changes nothing, and can be run as often as you like.

```bash
docker compose --profile migrate run --rm migrate \
  npm run db:school-classification-census \
  | tee ./school-census-$(date +%Y%m%d-%H%M).txt
```

It prints something like:

```
SCHOOL MEMBER CLASSIFICATION CENSUS (#3369)

Candidates (a Role.SCHOOL member that owns at least one booking): 23
  proved to be a SCHOOL      : 17
  proved to be a PERSON      : 4
  CANNOT TELL                : 2

Already recorded in SchoolMemberClassification: 0
Still unrecorded, so still blocking the cutover: 23

NOT READY: 23 candidate(s) are unrecorded. The backfill will refuse and write nothing.
```

**A candidate** is a member row the old code marked `SCHOOL` **and** that owns at
least one booking. A school row that never booked is left alone — there is no
ownership to move, so asking about it would be asking a question with no
consequence.

**Proved to be a SCHOOL** means all three of: no surname, cannot sign in, and a
school booking request that names this very row as the member it converted to,
under the same school name. That last one is the real proof — it is the approval
code's own record of what it created, written in the same breath.

**Proved to be a PERSON** means any one of: they can sign in, they have a
surname, or they are a school booking's hut leader. Those are teachers, and their
bookings are not touched.

**CANNOT TELL** means neither proof held — or, just as importantly, **both** did.
A row telling two stories about itself is a question, not a tie-break.

**A candidate row must own a booking**, so a school-shaped row that has never
booked is never classified and is outside this page and outside the migration —
there is no ownership to move for it. It is NOT outside the rule that stops a
school being merged into a person: that rule reads the classification where
there is one and falls back to the row's shape where there is not, so it still
refuses. See "What this does not change" at the foot of this page.

If you would rather see the numbers yourself, `-- --sql` prints the exact query so
you can run it against a read-only replica:

```bash
docker compose --profile migrate run --rm migrate \
  npm run db:school-classification-census -- --sql
```

### 2. Read the groups that are about to become one record

Below the counts, the census lists every group of rows whose school **names fold
to the same thing**. Each group becomes **one** record, with **one** email
address and **one** Xero customer:

```
ROWS THAT WILL BECOME ONE RECORD
...
  "tokoroa primary school" — 2 rows, becoming one record:
      cm9x4k2p0000abcd  "Tokoroa Primary School"                 office@tps.test  [holds a Xero customer]
      cm9x4k2p0001efgh  "  Tokoroa   Primary School "            admin@tps.test   [holds a Xero customer]
```

**Confirm every group is really one school before the window opens.** Usually it
is — a school gets a new invented row each time it books, which is exactly the
mess this release cleans up. But two genuinely different schools that happen to
share a name would be merged here, with nothing on any screen to say it
happened, and the reverse scripts cannot separate them again afterwards.

The names are printed quoted so leading, trailing and doubled spaces are
visible.

**Nothing in the migration refuses a group you have not confirmed.** The club's
decision is that same-named schools merge exactly as described above, and that an
operator sees the groups first — so this check is a person's, and it has to be
done before the window opens rather than during it. The reason it is a person's:
the ordinary runtime resolve applies this same folding one booking at a time, in
front of an officer who can see the name they just typed. Here it is applied in
bulk, silently, inside an outage — and it is what makes the rollback lossy,
because once two members' bookings sit under one organisation nothing records
which booking belonged to which.

**If you cannot confirm a group, split it.** Open the member row the census names
— the id in the first column is its `/admin/members/<id>` page — and correct that
school's name so the two no longer fold to the same thing: the campus, the town,
the trust, whatever actually tells them apart. Then run the census again. The two
rows now fold differently, the group is gone, and the backfill gives each school
its own record.

**Correct a name AFTER step 3, not before.** The school proof compares the
member's name against the name on the booking request that converted it, so
renaming a row that has no recorded decision yet turns it into a CANNOT TELL you
then have to settle by hand in step 4. A decision already recorded is never
re-checked — the backfill reads the recorded classification and folds whichever
name the row now carries — so recording first and renaming second costs nothing.

The record keeps the name, address and Xero customer of the first row by id. A
second Xero customer stays on its own row, for an officer to merge in Xero
afterwards; that is a visible duplicate rather than a silent overwrite, which is
the one outcome that could not be undone.

### 3. Record the rows the census proved

```bash
docker compose --profile migrate run --rm migrate \
  npm run db:school-classification-census -- --record-proved
```

This writes a decision for every row the two proofs settle, recorded as
`census` with the proof stated. It **never** overwrites a decision a person has
already made, and it records nothing for a CANNOT TELL row. The counts it prints
afterwards are the counts *after* those writes, so the unrecorded figure should
already equal the CANNOT TELL count without running it again.

### 4. Decide the rest yourself

The census prints each undecided row with the facts you need:

```
  cm9x4k2p0000abcd  Ōtorohanga Area School             office@oas.school.nz
      no surname; 3 bookings; holds a Xero customer; school proof does not hold; person proof does not hold
```

Go and look. The club's own records — an old invoice, the booking file, somebody
who remembers — are what settle it. When you know, record it:

```bash
docker compose --profile migrate run --rm migrate \
  npm run db:school-classification-census -- \
  --classify cm9x4k2p0000abcd --as ORGANISATION \
  --by "Jordan (treasurer)" --because "2019 invoice file: this is the school itself, not Mr Smith."
```

`--as` takes `ORGANISATION` or `PERSON`. There is no third value, and both `--by`
and `--because` are required — a decision nobody signed, or nobody gave a reason
for, is not a decision, and in six months it is the only thing that can answer
whether this was right.

If a row genuinely cannot be settled, **stop and say so**. The cutover waits. That
is the rule this whole programme exists to enforce: nothing is guessed, and no
surname is invented to get a row past a validator.

### 5. Check the census agrees with you

Run it once more. You want:

```
READY: every candidate is recorded, so the backfill will run.
```

If it lists **RECORDED DECISIONS THAT CONTRADICT THE PROOFS**, read them. You may
well be right and the proof wrong — you can see the club's records and the program
cannot — but it is worth seeing the disagreement now rather than discovering it
afterwards.

Read **ROWS THAT WILL BECOME ONE RECORD** again too, and check every group still
listed is one you confirmed in step 2. Recording decisions changes which rows are
grouped, because a row only joins a group once it is classified as a school — so
a group can appear here that was not there the first time.

### 6. Run the census one last time, after the club is offline

Between your last run and the window, an officer could approve another school
booking and create another candidate. Run the census again **after** traffic has
been removed and the old application and workers are stopped (step 3 of the
windowed sequence in `DEPLOYMENT.md`). It takes seconds and it is the difference
between a clean migration and a refusal in the middle of an outage.

Save the output **on the host** — the `| tee ./school-census-….txt` in step 1 —
and move the file off the host beside the backup. It is the pre-migration record
for this migration, and §8 of
[`PRODUCTION_UPGRADE_RUNBOOK.md`](../PRODUCTION_UPGRADE_RUNBOOK.md) has a row
waiting for it.

### 7. Migrate

Follow the windowed sequence in `DEPLOYMENT.md`. Nothing about it is special to
this release except that two migrations — `20260922010000` and `20260922020000` —
are **one window and are never applied apart**.

### 8. Verify

After migrating, before starting the new release:

```bash
docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL' \
  | tee ./school-cutover-verify-$(date +%Y%m%d-%H%M).txt
-- Every school booking now belongs to a school and to no person.
SELECT count(*) FROM "Booking" WHERE "memberId" IS NULL AND "organisationId" IS NULL;
-- must be 0

SELECT count(*) FROM "Booking" WHERE "organisationId" IS NOT NULL;
-- should equal the number of school bookings the census counted

-- The schools themselves.
SELECT "name", "email", "xeroContactId" FROM "Organisation" WHERE kind = 'SCHOOL' ORDER BY "name";
SQL
```

The redirection is on the **host**, outside the container, for the same reason as
the census output above.

Then start the new release and look at two screens with your own eyes:

- **Admin → Bookings.** A school's booking names the school. There is no
  surnameless person in the list any more.
- **Admin → Members.** The old school rows are still there as historical
  non-member contacts — they are what the club's audit history refers to — but
  none of them owns a booking and none of them holds a Xero customer.

## Rolling back

Only while the new release has not yet taken a booking, a payment or a refund.

Run the two reverse scripts **in the opposite order to the one they were applied
in**. The scripts are files in the repository and `psql` lives in the database
container, so feed each one in on the container's standard input — from the
repository root on the deploy host:

```bash
docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < prisma/migrations/20260922020000_backfill_school_bookings_to_organisations/rollback.sql

docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < prisma/migrations/20260922010000_booking_owner_optional_member/rollback.sql
```

`-v ON_ERROR_STOP=1` matters: without it `psql` prints the refusal and carries on
to the next statement, which is the opposite of what every refusal in these
scripts is for. Each script is one transaction, so a refusal changes nothing.

The first gives every school booking its member back and returns the Xero
customer. The second re-imposes the required member link, and **refuses with
`school_reverse_wrong_order` if the first has not run** — that refusal reads the
presence of the `Booking_owner_exactly_one` constraint, which is a fact about the
database's shape, so it holds even for a club with no school bookings at all.

**Then start the next attempt from the migration files, not from `migrate
deploy`.** Neither reverse touches the migration ledger, so afterwards
`prisma migrate status` says the database is up to date, `prisma migrate deploy`
says there is nothing pending, and the drift check agrees — all three truthfully,
about a database that is back on the old model. To roll forward, re-apply the two
`migration.sql` files by hand, in order, the same way as above:

```bash
docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < prisma/migrations/20260922010000_booking_owner_optional_member/migration.sql

docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < prisma/migrations/20260922020000_backfill_school_bookings_to_organisations/migration.sql
```

They are written to survive that: the classification table and its enum are kept
by the rollback, and the first migration's creation of them is guarded so it does
not fail with "already exists". Deleting the two `_prisma_migrations` rows and
running `prisma migrate deploy` instead is equivalent; it edits migration history
for no gain.

**What is deliberately NOT undone:** the decisions you recorded. They are your
work, and the next attempt needs them — which is the whole reason the roll-forward
above has to work.

## Settings reference

**There are none, and that is the whole shape of this page.** Nothing here is a
setting: this is a one-off release with no screen, no toggle and no configurable
value. The two commands and their flags are documented where they are used above.
(The operator-guide skeleton in
[`STYLE_GUIDE.md`](../STYLE_GUIDE.md) asks for this section; it is named rather
than dropped, because a silently missing section reads as an oversight.)

## Troubleshooting

Every refusal below is deliberate: each one stops with the database exactly as it
was, because each script is a single transaction. **None of them names a school,
a member or a count** — a maintenance-window stack trace is the wrong place for
the club's data — so this table is the only place the identifiers can be decoded.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `school_member_classification_incomplete` from the backfill | At least one candidate row has no recorded decision. Almost always an officer approved another school booking between your last census and the window. | Run the census (step 1). It prints the list. Record the new rows (steps 3–4), then run the migration again. Nothing was written. |
| `school_backfill_organisation_unresolved` from the backfill | A classified school row does not match the record minted from its own name. The fold is collapse-then-trim-then-cap, so this should not happen; if it does, the two names differ in a way the fold does not remove. | Stop and get help before re-running. The query in the next row lists the rows involved. |
| `school_reverse_wrong_order` from `20260922010000/rollback.sql` | The two reverse scripts were run in the order they were applied. | Run `20260922020000/rollback.sql` first, then this one. See "Rolling back". |
| `school_backfill_rollback_unreconstructable` from `20260922020000/rollback.sql` | A booking owned by a school has no member to give back — the new release has already created one, or two member rows spell one school and the booking request that would say which owned which is gone. | Stop. This is the point at which the reverse scripts are not a release rollback. Restore the verified backup taken immediately before the migration, with the owner leading. |
| `school_backfill_rollback_xero_unreconstructable` from `20260922020000/rollback.sql` | A school record holds a Xero customer whose original owner cannot be proved from what is left. Returning it to the wrong member would misattribute a provider identity permanently and invisibly. | Stop, and restore from the backup as above. Do not hand the customer back by hand without checking Xero's own history first. |
| `NOT READY` from the census, and the listed rows are all `CANNOT TELL` | Neither proof holds for those rows — or both do, which counts the same way. | Go and look at the club's records, then record each one with `--classify` (step 4). If a row genuinely cannot be settled, the cutover waits. |
| The census prints a group under **ROWS THAT WILL BECOME ONE RECORD** that is two different schools | Two schools share a name after folding. | Split it before the window: record the proved rows first (step 3), then correct one school's name on its `/admin/members/<id>` page so the two no longer fold alike, and re-run the census until the group is gone. Nothing refuses the group for you, and merging them is not reversible. |

The query behind the second row, for whoever is helping:

```bash
docker compose exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
SELECT m."id",
       m."firstName",
       btrim(left(btrim(regexp_replace(m."firstName", '\s+', ' ', 'g')), 200)) AS folded
FROM "Member" m
JOIN "SchoolMemberClassification" c ON c."memberId" = m."id"
WHERE c."classification" = 'ORGANISATION'
  AND m."role" = 'SCHOOL'
  AND EXISTS (SELECT 1 FROM "Booking" b WHERE b."memberId" = m."id")
  AND NOT EXISTS (
    SELECT 1 FROM "Organisation" o
    WHERE o."kind" = 'SCHOOL'
      AND lower(btrim(left(btrim(regexp_replace(o."name", '\s+', ' ', 'g')), 200)))
          = lower(btrim(left(btrim(regexp_replace(m."firstName", '\s+', ' ', 'g')), 200)))
  )
ORDER BY m."id";
SQL
```

## What this does not change

- **Nothing about what a school is charged.** No price, fee, discount or refund
  moves. The migration touches ownership and contact identity and nothing else.
- **No money row is repaired.** If a school's invoice or payment was wrong before
  the cutover, it is wrong after it.
- **The old school member rows are not deleted.** They hold audit history, so
  they stay — as ordinary non-member contact rows carrying no authority. What
  becomes of them is a separate decision for the club.
- **A school-shaped row that never booked is untouched, and stays unclassified.**
  The census only asks about rows that own a booking, so the classification table
  covers exactly those. The rule that stops a school being merged into a person
  reads that table **and** falls back to the row's shape — the school's name, a
  blank surname, marked as a school contact, no login — so it still refuses a
  row nobody has decided about, including one the school approval mints after
  the cutover. If such a row really is a person, record that decision and the
  merge then proceeds:

  ```bash
  docker compose --profile migrate run --rm migrate     npm run db:school-classification-census --     --classify <memberId> --as PERSON     --by "<your name>" --because "<what you checked>"
  ```

## Related

- [`DEPLOYMENT.md`](../../DEPLOYMENT.md) — the windowed deploy sequence.
- [`PRODUCTION_UPGRADE_RUNBOOK.md`](../PRODUCTION_UPGRADE_RUNBOOK.md) §2.4.2 —
  the command-by-command version of the same window.
- [`BLUE_GREEN_MIGRATION_POLICY.md`](../BLUE_GREEN_MIGRATION_POLICY.md) — why a
  windowed migration exists at all.
- [`integrations.md`](integrations.md) — the Xero side of a school's identity.
