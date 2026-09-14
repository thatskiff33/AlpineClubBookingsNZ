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

## Step-by-step

### 1. See what the club actually has

Run the census against the club's database. It is **read-only**: it writes
nothing, changes nothing, and can be run as often as you like.

```bash
DATABASE_URL='postgresql://…' npm run db:school-classification-census
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

If you would rather see the numbers yourself, `-- --sql` prints the exact query so
you can run it against a read-only replica:

```bash
npm run db:school-classification-census -- --sql
```

### 2. Record the rows the census proved

```bash
npm run db:school-classification-census -- --record-proved
```

This writes a decision for every row the two proofs settle, recorded as
`census` with the proof stated. It **never** overwrites a decision a person has
already made, and it records nothing for a CANNOT TELL row.

Run the census again. The count of unrecorded rows should now equal the CANNOT
TELL count.

### 3. Decide the rest yourself

The census prints each undecided row with the facts you need:

```
  cm9x4k2p0000abcd  Ōtorohanga Area School             office@oas.school.nz
      no surname; 3 bookings; holds a Xero customer; school proof does not hold; person proof does not hold
```

Go and look. The club's own records — an old invoice, the booking file, somebody
who remembers — are what settle it. When you know, record it:

```bash
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

### 4. Check the census agrees with you

Run it once more. You want:

```
READY: every candidate is recorded, so the backfill will run.
```

If it lists **RECORDED DECISIONS THAT CONTRADICT THE PROOFS**, read them. You may
well be right and the proof wrong — you can see the club's records and the program
cannot — but it is worth seeing the disagreement now rather than discovering it
afterwards.

### 5. Run the census one last time, after the club is offline

Between your last run and the window, an officer could approve another school
booking and create another candidate. Run the census again **after** traffic has
been removed and the old application and workers are stopped (step 3 of the
windowed sequence in `DEPLOYMENT.md`). It takes seconds and it is the difference
between a clean migration and a refusal in the middle of an outage.

Save the output. It is the pre-migration record for this migration.

### 6. Migrate

Follow the windowed sequence in `DEPLOYMENT.md`. Nothing about it is special to
this release except that two migrations — `20260922010000` and `20260922020000` —
are **one window and are never applied apart**.

### 7. Verify

After migrating, before starting the new release:

```sql
-- Every school booking now belongs to a school and to no person.
SELECT count(*) FROM "Booking" WHERE "memberId" IS NULL AND "organisationId" IS NULL;
-- must be 0

SELECT count(*) FROM "Booking" WHERE "organisationId" IS NOT NULL;
-- should equal the number of school bookings the census counted

-- The schools themselves.
SELECT "name", "email", "xeroContactId" FROM "Organisation" WHERE kind = 'SCHOOL' ORDER BY "name";
```

Then start the new release and look at two screens with your own eyes:

- **Admin → Bookings.** A school's booking names the school. There is no
  surnameless person in the list any more.
- **Admin → Members.** The old school rows are still there as historical
  non-member contacts — they are what the club's audit history refers to — but
  none of them owns a booking and none of them holds a Xero customer.

## Rolling back

Only while the new release has not yet taken a booking, a payment or a refund.

Run the two reverse scripts **in the opposite order to the one they were applied
in**, as the migration database role:

```bash
psql "$DATABASE_URL" -f prisma/migrations/20260922020000_backfill_school_bookings_to_organisations/rollback.sql
psql "$DATABASE_URL" -f prisma/migrations/20260922010000_booking_owner_optional_member/rollback.sql
```

The first gives every school booking its member back and returns the Xero
customer. The second re-imposes the required member link, and **refuses loudly if
the first has not run** — that refusal is the guard against doing it in the wrong
order, not a failure.

If the first script raises `school_backfill_rollback_unreconstructable`, the new
release has already created a booking that never had a member. Stop. That is the
point at which the reverse scripts are no longer a release rollback: restore the
verified backup taken immediately before the migration, with the owner leading.

**What is deliberately NOT undone:** the decisions you recorded. They are your
work, and the next attempt needs them.

## What this does not change

- **Nothing about what a school is charged.** No price, fee, discount or refund
  moves. The migration touches ownership and contact identity and nothing else.
- **No money row is repaired.** If a school's invoice or payment was wrong before
  the cutover, it is wrong after it.
- **The old school member rows are not deleted.** They hold audit history, so
  they stay — as ordinary non-member contact rows carrying no authority. What
  becomes of them is a separate decision for the club.

## Related

- [`DEPLOYMENT.md`](../../DEPLOYMENT.md) — the windowed deploy sequence.
- [`PRODUCTION_UPGRADE_RUNBOOK.md`](../PRODUCTION_UPGRADE_RUNBOOK.md) §2.4.2 —
  the command-by-command version of the same window.
- [`BLUE_GREEN_MIGRATION_POLICY.md`](../BLUE_GREEN_MIGRATION_POLICY.md) — why a
  windowed migration exists at all.
- [`integrations.md`](integrations.md) — the Xero side of a school's identity.
