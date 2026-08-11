# AI Diagnostics deployment and operator guide

How a deployment turns AI Diagnostics on, and what it must provision first. AI
Diagnostics is an **optional, admin-only, default-off** module (epic
[#2369](README.md)).

This guide covers what has landed: the module flag, the dedicated Anthropic
credential, the monthly budget and limits (AID-2, #2371), and the dedicated
SELECT-only database role (AID-5, #2374). Provider disclosure, zero-retention
posture, and the private knowledge overlay are documented by AID-8 (#2379) when it
lands.

Extends [`DEPLOYMENT.md`](../../DEPLOYMENT.md) and
[`CONFIGURATION.md`](../../CONFIGURATION.md).

## Configuration is deployment-local

Every Diagnostics setting is **deployment-owned** and stays out of config-transfer
bundles ([ADR-006](decisions/ADR-006-deployment-provider-disclosure-private-overlay-config-non-travel.md)).
Two deployments of this codebase can run Diagnostics with different keys, budgets,
and database roles, and nothing about one travels to the other.

## Setup order

1. **Provision the SELECT-only database role** (below) and set
   `AI_DIAGNOSTICS_DATABASE_URL`.
2. **Store the dedicated Anthropic API key** in **Admin → Integrations** (encrypted
   `IntegrationCredential`, provider `anthropic-diagnostics`). It is deliberately a
   separate key from the member-facing Page help assistant's, so Diagnostics spend
   can be billed and capped on its own workspace, and a Page help key can never
   silently authorise Diagnostics spend.
3. **Set a positive monthly budget** in integer cents.
4. **Enable the `aiDiagnostics` module.**

Check progress at any time with `GET /api/admin/ai-diagnostics/readiness`
(support-area admin permission; reachable **while the module is off**, on purpose,
so setup can be completed before the paid product is switched on). It spends
nothing and returns no secret value.

Readiness is **fail-closed**: `ready` is true only when the module is on, the
dedicated key is stored and decryptable, the monthly budget is positive, and the
SELECT-only role is **verified** least-privilege. Any fault while resolving those
returns `ready: false` with a `resolve_error` blocker rather than throwing.

## The dedicated SELECT-only database role

### Why it is mandatory

The application's own database role, as provisioned in the Compose stack, is a
PostgreSQL **superuser**. Diagnostics runs data-retrieval tools; if those ran on
`DATABASE_URL`, a single flaw would run with superuser rights and could read the
encrypted credential store, write, or escalate.
[ADR-007](decisions/ADR-007-least-privilege-select-only-database-credential.md)
therefore requires a **separate, non-superuser, SELECT-only** role, and the
application **refuses to run any diagnostics read** without one. There is no
fallback to `DATABASE_URL`.

The refusal is not a configuration check that trusts the URL. The application asks
the **server** what the connected role actually is and actually holds, and refuses
every tool call unless the answer is the least-privilege shape ADR-007 requires:

- it is the same role the connection string names (`current_user`, not the URL's
  claim);
- no `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS` attribute;
- no `TEMPORARY` or `CREATE` on the database, and no `CREATE` on schema `public`;
- no `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` on any relation in `public`, at table
  or column level;
- no `SELECT` on any relation in `public` that the declared 26-relation allowlist
  does not name, no undeclared column on a named relation, and no table-wide
  `SELECT` on any column-restricted declaration — even when that declaration
  currently names every physical column;
- no membership in **any** other role — not a shortlist of dangerous ones, a total of
  zero. A member of any role is one `SET ROLE` away from that role's privileges, and
  because this role is `NOINHERIT` the membership shows up in nothing else the server
  is asked: `GRANT tac_app TO ai_diagnostics_ro` leaves every other answer above
  clean, and one `SET ROLE tac_app` then reads `IntegrationCredential` and writes
  `Booking`. Membership is tested as membership rather than as inherited usage for the
  same reason, and it is counted through chains as well as direct grants, because
  `SET ROLE` reaches a role granted two hops away. When the granted role is one of the
  privilege-escalating predefined roles (`pg_read_all_data` and the rest), the refusal
  logged on the server names it, because that is a more useful sentence than a count.
  The readiness screen does not: it reports `over_privileged` and no privilege detail
  at all, by design, since it is JSON an admin browser receives. Ordinary role names
  are not logged either — only the eight predefined names, which are PostgreSQL
  built-ins rather than anything about this deployment;
- no `EXECUTE` on any overload of `pg_read_file`, `pg_read_binary_file`, `pg_ls_dir`,
  `pg_stat_file`, `lo_import` or `lo_export`;
- no `EXECUTE` on a `SECURITY DEFINER` routine in `public` (see "What is deliberately
  not done").

That answer is **re-read from the server at least once a minute**, not cached for the
life of the container. A role that was hand-edited back towards write access stops
being accepted within a minute, and the readiness screen changes with it — no restart
required. If the server cannot be asked, the role is not trusted: the state becomes
`unverified` and every tool call is refused. It never hangs waiting, either.

The connection string is also refused outright if it carries a query parameter that
would override what was checked — `user`, `password`, `host`, `port`, `options`,
`statement_timeout`, `query_timeout`, `lock_timeout`,
`idle_in_transaction_session_timeout` or `replication`. The PostgreSQL driver reads
those in preference to the URL's own username and over the application's own pool
settings, so a URL of the form
`postgresql://ai_diagnostics_ro:***@host/db?user=tac_app&password=***` would otherwise
pass the "not the application role" check and then connect as the application role.
Ordinary parameters such as `sslmode` and `connection_limit` are unaffected.

### Provisioning

```bash
AI_DIAGNOSTICS_DB_PASSWORD='<a long random secret>' npm run diagnostics:provision-role
```

Preview the exact statements without connecting (the password literal is replaced
with a placeholder, so nothing secret is printed):

```bash
npm run diagnostics:provision-role -- --dry-run
```

The script needs a connection that may create roles: the application's own
`DATABASE_URL` in the stock Compose stack, or `AI_DIAGNOSTICS_PROVISION_DATABASE_URL`
for a deployment that keeps a separate DBA credential.

| Variable | Required | Meaning |
| --- | --- | --- |
| `AI_DIAGNOSTICS_DB_PASSWORD` | yes (not for `--dry-run`) | The new role's password. Minimum 20 characters. Never printed or logged. |
| `AI_DIAGNOSTICS_PROVISION_DATABASE_URL` | no | Connection that may create roles. Defaults to `DATABASE_URL`. |
| `AI_DIAGNOSTICS_DB_ROLE` | no | Role name. Defaults to `ai_diagnostics_ro`. Refused if it equals the provisioning role, or if it is not a supported identifier (below). |
| `AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES` | no | Comma-separated roles that must keep `TEMPORARY` on the database (see below). Defaults to the provisioning role, so a deployment whose **application** role name is unsupported must set this explicitly. |

**Supported identifiers.** Every role and database name the script interpolates must
be letters, digits and underscores only, starting with a letter or underscore, at most
63 characters. That is narrower than PostgreSQL allows: these names are also emitted as
SQL literals inside dollar-quoted `DO $$ … $$` blocks, where a `$` would end the block
early. A managed-provider name such as `tac-app` (AWS RDS) or `user@server` (Azure
Database for PostgreSQL) is therefore refused, with a message naming the variable that
carried it. Create the diagnostics role under a supported name, and for
`AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES` see the `TEMPORARY` note below — a superuser
application role does not need listing at all.

Then set the connection string in the deployment environment (the Compose `.env`):

```
AI_DIAGNOSTICS_DATABASE_URL=postgresql://ai_diagnostics_ro:<your-password>@postgres:5432/tacbookings?connection_limit=3
```

Compose passes it through to the app containers. Leave it empty and Diagnostics
stays not-ready; there is no unsafe default.

### What provisioning does

It runs one transaction, so a failure part-way leaves no partially privileged role
behind. The statements are **declarative, not additive**: every role membership, and
every table, sequence, and routine privilege, is revoked from the role before the
declared allowlist is granted back. The allowlist lives in
`src/lib/diagnostics/tools/provision-role.ts`, in public code, so "which tables can
Diagnostics read" is answered by reading one file.

- Creates the role if absent, then pins its attributes whether it was just created
  or already existed with drifted attributes: `NOSUPERUSER`, `NOCREATEDB`,
  `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, `NOBYPASSRLS`, a `CONNECTION LIMIT`,
  and the password.
- Sets server-side defaults on the role itself — `default_transaction_read_only`,
  `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, and
  `search_path` — so the restrictions hold even for a `psql` session an operator
  opens with this credential, not only for the application's own transactions.
- Revokes membership in every privilege-escalating predefined role
  (`pg_read_all_data`, `pg_write_all_data`, `pg_read_server_files`,
  `pg_write_server_files`, `pg_execute_server_program`, `pg_signal_backend`,
  `pg_monitor`, `pg_maintain`). A role that does not exist on this server (the set
  grows with the version — `pg_maintain` is PostgreSQL 17+) simply has no membership to
  revoke.
- Then revokes **every remaining membership**, whatever it is in. That is the actual
  control; the named list above documents what it is for. Only the direct grants need
  revoking — a chain always starts with one — so stripping them removes the two-hop
  case too.
- **Every one of those revokes names the grantor that made the grant, and the result is
  re-checked before the transaction is allowed to commit.** This is not a detail. A
  membership is recorded per grantor, and `REVOKE <role> FROM <member>` without
  `GRANTED BY` removes only the grant the *current* role made — even for a superuser.
  Anybody else's grant survives, and PostgreSQL reports that as a `WARNING` while still
  returning success, so the repair would have looked like it worked and left the role
  one `SET ROLE` from the privileges it was supposed to lose. The statement list
  therefore revokes each recorded grant with its own grantor and then raises an error
  if any membership is still recorded, which rolls the whole transaction back.
- Two consequences worth knowing. First, if the provisioning credential may not revoke
  another role's grant, the run fails loudly (`permission denied to revoke privileges
  granted by role "…"`) rather than half-succeeding: that credential cannot produce a
  role the runtime would accept, so the failure is the right answer. Second, the script
  now prints whatever the server said at `WARNING` level and above, and only claims
  memberships were stripped when it said nothing.
- Grants `CONNECT` on the database and `USAGE` on schema `public` — never `CREATE`.
- Revokes all table and sequence privileges plus default privileges, then grants back
  only the declared `SELECT` allowlist.
- Revokes the role's own routine privileges. Note what that does **not** do:
  PostgreSQL grants `EXECUTE` on every function to `PUBLIC` by default and a `PUBLIC`
  grant cannot be revoked for one role, so the diagnostics role can still call the
  schema's functions. What contains that is the read-only transaction plus the runtime
  self-check, which refuses the role if it can execute any `SECURITY DEFINER` routine
  in `public` — the one shape that would run with its owner's privileges. This
  schema's functions are all ordinary trigger functions, so the count is zero.

**It is safe to re-run, and re-running is the intended path** for rotating the
password and for picking up a new table grant. Because it is declarative, a re-run
also **removes** a grant, or a role membership, somebody added by hand — that is
deliberate.

**The one refusal re-provisioning cannot repair: don't make the diagnostics role a
database owner.** `pg_database_owner` is an implicit membership — PostgreSQL treats
whoever owns the current database as a member of it, with no row recorded and nothing
to revoke. A diagnostics role that owns its own database therefore reports one
membership, is refused at runtime, and stays refused however many times the
provisioning is re-run. Nothing in the documented deployment does this (the role is
created by the provisioning script and never owns a database), and the fix is to give
the role no ownership rather than to relax the membership rule: an owner can `SET ROLE
pg_database_owner`, and in this schema `public` is owned through exactly that role. The
provisioning deliberately does not raise on it, so the situation is a runtime refusal
an operator can diagnose rather than a provisioning run that can never succeed.

### One collateral change to shared database state

PostgreSQL grants `TEMPORARY` on a database to `PUBLIC` by default, and a `PUBLIC`
grant cannot be revoked for a single role. Denying the diagnostics role `TEMP`
therefore requires `REVOKE TEMPORARY … FROM PUBLIC` and granting it back to the
roles that should keep it.

The stock Compose stack is unaffected — its app role is a superuser and bypasses
privilege checks entirely. **A fork whose application role is not a superuser must
list that role (and whoever runs migrations) in
`AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES`** before provisioning, or those roles lose
the ability to create temporary tables.

### What is deliberately not done

`CREATE ON SCHEMA public` is **not** revoked from `PUBLIC`. PostgreSQL 15+ already
denies it, so on a supported server the statement is a no-op, and on an older or
hand-tuned fork it could break a non-superuser app role mid-migration. Instead the
runtime self-check refuses to run any tool if the diagnostics role turns out to hold
schema `CREATE`, so the anomaly is loud rather than silently patched under an
operator's feet.

The script also does not create the database, the app role, or any view.

### What the diagnostics role may read today

The allowlist lives in `SELECT_GRANTS` (`src/lib/diagnostics/tools/provision-role.ts`),
in public code, so "which relations — and which columns of them — can Diagnostics
read" is answerable by reading one file. As of AID-6B (#2376) it names
**twenty-six** relations and **243 columns**, and **every one of them is granted by
column, never wholesale**:

| Relation | Granted | Read by |
| --- | --- | --- |
| `public."AuditLog"` | **9 columns**: `id`, `action`, `category`, `severity`, `outcome`, `entityType`, `entityId`, `requestId`, `createdAt` | the five audit-correlation tools ([tool-pack-support.md](tool-pack-support.md)), the finance audit-history tool ([tool-pack-finance.md](tool-pack-finance.md)), and the booking and membership audit-history tools ([tool-pack-booking-membership.md](tool-pack-booking-membership.md)) |
| `public."Payment"` | 22 columns | the finance searches, the payment summary, the refund state ([tool-pack-finance.md](tool-pack-finance.md)) |
| `public."PaymentTransaction"` | 12 columns | the reference search, the attempt ledger |
| `public."PaymentRefund"` | 10 columns | the reference search, the refund state |
| `public."PaymentRecoveryOperation"` | 10 columns | the attempt ledger, the refund state |
| `public."ManualRefundTask"` | 6 columns | the refund state |
| `public."RefundRequest"` | 7 columns | the refund state |
| `public."ProcessedWebhookEvent"` | 6 columns (its surrogate `id` is deliberately not granted) | the webhook timeline |
| `public."WebhookLog"` | 7 columns | the webhook timeline |
| `public."XeroInboundEvent"` | 9 columns | the webhook timeline |
| `public."XeroObjectLink"` | 10 columns | the Xero invoice and contact linkage tools |
| `public."XeroSyncOperation"` | 17 columns | the Xero invoice and contact linkage tools |
| `public."Member"` | **23 columns** — widened by AID-6B from the two AID-6C granted. `email` is projected by one entry and is a search predicate; `phoneCountryCode`, `phoneAreaCode` and `phoneNumber` are predicates only and are projected by nothing | the Xero contact linkage tool, the member search, the member summary, the family relationships ([tool-pack-booking-membership.md](tool-pack-booking-membership.md)) |
| `public."Booking"` | 25 columns | the booking search, the booking summary, a member's booking involvement ([tool-pack-booking-membership.md](tool-pack-booking-membership.md)) |
| `public."Lodge"` | **2 columns**: `id`, `name` | the booking search, a member's booking involvement |
| `public."BookingGuest"` | 15 columns (a guest's given and family name included; consent responder and expiry are classifier inputs only) | booking party state, guest counts, member-booking involvement and double-sharing evidence |
| `public."MemberPartnerLink"` | 3 columns: canonical pair ids and status | the canonical double-bed-sharing verdict; raw pair ids are not projected |
| `public."BookingGuestNight"` | **2 columns**: `bookingGuestId`, `stayDate` | the booking party state's per-night footprint |
| `public."BedAllocation"` | 8 columns (`approvedByMemberId` is deliberately not granted) | the bed allocation state |
| `public."LodgeRoom"` | **2 columns**: `id`, `name` (`notes` is not granted) | the bed allocation state |
| `public."LodgeBed"` | 4 columns | the bed allocation state |
| `public."BookingChangeRequest"` | 16 columns (no free text, no raw JSON, no reviewing officer) | the booking change and exception request state |
| `public."PolicyExceptionReservationNight"` | **1 column**: `changeRequestId` — the narrowest grant in the file | the booking change and exception request state |
| `public."MemberSubscription"` | 11 columns (`manualPaymentNote` is **not** granted) | the member subscription state |
| `public."FamilyGroupMember"` | **4 explicitly named columns** — all current columns, but not a table-wide grant; the relation has no `role` column | the member family relationships |
| `public."FamilyGroup"` | **2 columns**: `id`, `name` | the member family relationships |

The table above explains why each relation is present. The following block is the
canonical exact column declaration for operators and reviewers. It is intentionally
machine-readable: the provisioning test parses it and compares every relation and
column in both directions with `SELECT_GRANTS`, so replacing one column with another
while keeping the same count fails CI.

<!-- ai-diagnostics-exact-grants:start -->
```text
public."AuditLog": id, action, category, severity, outcome, entityType, entityId, requestId, createdAt
public."Payment": id, bookingId, status, source, amountCents, refundedAmountCents, changeFeeCents, additionalAmountCents, creditAppliedCents, additionalPaymentStatus, reference, stripePaymentIntentId, additionalPaymentIntentId, xeroInvoiceId, xeroInvoiceNumber, xeroRefundCreditNoteId, internetBankingHoldSlots, internetBankingHoldUntil, internetBankingHoldReleasedAt, manuallyMarkedPaidAt, createdAt, updatedAt
public."PaymentTransaction": id, paymentId, kind, source, status, amountCents, refundedAmountCents, reference, stripePaymentIntentId, xeroInvoiceNumber, createdAt, updatedAt
public."PaymentRefund": id, paymentId, status, amountCents, currency, stripeRefundId, stripeChargeId, xeroRefundCreditNoteId, stripeCreatedAt, createdAt
public."PaymentRecoveryOperation": id, type, status, paymentId, amountCents, attempts, idempotencyKey, succeededAt, createdAt, updatedAt
public."ManualRefundTask": id, paymentId, amountCents, status, completedAt, createdAt
public."RefundRequest": id, bookingId, status, requestedAmountCents, approvedAmountCents, reviewedAt, createdAt
public."ProcessedWebhookEvent": eventId, source, eventType, status, processingStartedAt, processedAt
public."WebhookLog": id, source, eventType, eventId, status, durationMs, createdAt
public."XeroInboundEvent": id, eventCategory, eventType, resourceId, correlationKey, status, eventCreatedAt, processedAt, createdAt
public."XeroObjectLink": id, localModel, localId, xeroObjectType, xeroObjectId, xeroObjectNumber, role, active, createdAt, updatedAt
public."XeroSyncOperation": id, direction, operationType, localModel, localId, status, attemptCount, replayable, lastErrorCode, xeroObjectType, xeroObjectId, xeroObjectNumber, manuallyResolvedAt, startedAt, completedAt, createdAt, updatedAt
public."Member": id, email, firstName, lastName, ageTier, active, canLogin, cancelledAt, archivedAt, joinedDate, lifeMemberDate, requiresInduction, hutLeaderEligible, parentMemberId, secondaryParentId, familyGroupId, billingFamilyGroupId, phoneAreaCode, phoneNumber, phoneCountryCode, xeroContactId, createdAt, updatedAt
public."Booking": id, memberId, lodgeId, status, checkIn, checkOut, totalPriceCents, discountCents, promoAdjustmentCents, finalPriceCents, creditElectionCents, hasNonMembers, nonMemberHoldUntil, parentBookingId, draftExpiresAt, requiresAdminReview, adminReviewStatus, adultMemberHostingReviewStatus, waitlistPosition, wholeLodgeHold, adminCapacityHoldAt, capacityOverriddenAt, deletedAt, createdAt, updatedAt
public."Lodge": id, name
public."BookingGuest": id, bookingId, firstName, lastName, ageTier, isMember, memberId, stayStart, stayEnd, priceCents, consentStatus, consentRequestedAt, consentRespondedAt, consentRespondedByMemberId, consentExpiresAt
public."MemberPartnerLink": memberAId, memberBId, status
public."BookingGuestNight": bookingGuestId, stayDate
public."BedAllocation": id, bookingId, bookingGuestId, roomId, bedId, stayDate, bedType, isSecondOccupant
public."LodgeRoom": id, name
public."LodgeBed": id, roomId, name, bedType
public."BookingChangeRequest": id, bookingId, kind, status, requestedByMemberId, aggregateCapacityMode, attemptCount, conflictCount, lastConflictAt, holdExpiresAt, reviewedAt, cancelledAt, supersededByRequestId, linkedModificationId, createdAt, updatedAt
public."PolicyExceptionReservationNight": changeRequestId
public."MemberSubscription": id, memberId, seasonYear, status, xeroInvoiceId, xeroInvoiceNumber, paidAt, manuallyMarkedPaidAt, voidGeneration, createdAt, updatedAt
public."FamilyGroupMember": id, familyGroupId, memberId, joinedAt
public."FamilyGroup": id, name
```
<!-- ai-diagnostics-exact-grants:end -->

Every other relation in the schema is unreadable — including `IntegrationCredential`
(encrypted provider secrets), `XeroToken`, which stores **plaintext** Xero OAuth
access and refresh tokens, and `FamilyGroupJoinRequest`, which carries requester
free text and children's dates of birth. The first two are permanently out of scope
under ADR-007 §1 and no tool pack may grant them.

So is every other **column** of the twenty-six. The grants are by column, so as the
diagnostics role `SELECT "ipAddress" FROM "AuditLog"`,
`SELECT "dateOfBirth" FROM "Member"`, `SELECT "notes" FROM "Booking"`,
`SELECT "internalNotes" FROM "BookingChangeRequest"`,
`SELECT "payload" FROM "XeroInboundEvent"` and `SELECT *` from any of them are all
refused by PostgreSQL with `42501`. That is also why **no presence boolean is
projected over an ungranted column**: a column privilege covers every reference to
the column, `notes IS NOT NULL` included, so a `hasNotes` flag would have made every
booking note readable in a `psql` session opened with this credential.

**Seven columns LEFT the allowlist in the AID-6B release, and none of them was an
AID-6B column.** `PaymentTransaction."xeroInvoiceId"`,
`PaymentRefund."paymentTransactionId"`, `PaymentRefund."stripePaymentIntentId"`,
`PaymentRecoveryOperation."bookingId"`, `ManualRefundTask."bookingId"`,
`XeroInboundEvent."source"` and `XeroSyncOperation."entityType"` were granted by
AID-6C and read by no statement in any pack. Two of them stopped being harmless in
this very release: the two `"bookingId"` grants were opaque identifiers while
`Booking` was ungranted, and AID-6B grants `Booking`, so leaving them would have
handed this credential a join from a refund task onto a booking's dates, prices and
owner that no tool performs.

They survived two releases because the check that was supposed to catch them never
ran — the finance pack's suite built a correctly-keyed set of granted columns and
never passed it to an assertion. `provision-role.test.ts` now reconciles the
allowlist against **every registered statement in both directions**, with
`alias -> relation` resolved per statement, and pins the census (twenty-six
relations, 243 columns) so this page and the pack pages cannot drift from it again.

**And the same property is now proved a second time against PostgreSQL itself.**
The real-database suite
(`src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts`, run by the
Migration drift check) asks the server, column by column, whether the provisioned
role may read it, and requires that answer to match *both* the allowlist *and* the
statements: **this credential may read a column if and only if a registered
statement reads that column.** The forward half is what a missing grant breaks at
runtime with `42501`; the reverse half is the one that catches reach nobody argued
for. Both suites share one `alias -> relation` resolver
(`src/lib/__tests__/helpers/diagnostics-statement-reads.ts`) so the declaration-side
and server-side halves cannot drift into answering different questions.

One consequence is worth stating because it replaced a weaker check. The suite used
to require that every granted relation withhold at least one column — a *proxy* for
"granted by column, not wholesale". That proxy is wrong for a relation that is
simply small: `FamilyGroupMember` has four columns and the family-relationships
statement reads all four, so there is nothing left to withhold and narrowing the
grant would break the tool. Relations in that state are now **enumerated** in the
suite with the argument for each, and the enumeration is asserted as an exact set —
so a *second* relation becoming fully granted fails by name, while the
if-and-only-if check above independently proves that every column of a fully granted
relation is one a shipped statement actually reads.

The operator CLI prints the declared grants, columns and all, on every run and on
`--dry-run`.

**Upgrading to the AID-6B release is a two-step operation: deploy, then re-run
`npm run diagnostics:provision-role`.** This release adds thirteen relations and
widens `Member` from two columns to twenty-three, so until it is re-run the
*previous* release's grants no longer match the declared allowlist and **every
SQL-backed tool refuses, by design**.

Which state readiness reports in the meantime depends on the stale role, and the
precedence is worth knowing before an operator reads it as a smaller problem than it
is. `under_provisioned` is reported **only** when the stale role is otherwise
exactly safe — every privilege it holds is one this release still declares, and the
only difference is grants that are absent. If the stale role also holds anything the
new declaration does *not* include, **excess privilege takes precedence and the state
is `over_privileged`**, because a role that can read more than the allowlist declares
is the more serious of the two facts and must not be reported as merely
incomplete. `checkDiagnosticsDatabaseReadiness` derives that ordering structurally:
it reports missing grants only when zeroing them would make the privilege report
safe.

**THIS IS THE EXPECTED STATE of an un-reprovisioned AID-6B deploy: for THIS release the answer is `over_privileged`, on the path essentially every
deployment is on.** AID-6B does not only add: it REMOVES seven columns AID-6C
granted — `PaymentTransaction."xeroInvoiceId"`, `PaymentRefund."paymentTransactionId"`,
`PaymentRefund."stripePaymentIntentId"`, `PaymentRecoveryOperation."bookingId"`,
`ManualRefundTask."bookingId"`, `XeroInboundEvent."source"` and
`XeroSyncOperation."entityType"` — forced by the no-exemption "reads every column it
grants" test. A role provisioned for AID-6C therefore holds seven columns the new
declaration omits, so zeroing the missing-grant counters does not make it safe and
the state is `over_privileged`. `under_provisioned` is reported only from an AID-6A
role, whose nine `AuditLog` columns this release leaves untouched and which is
therefore a strict subset. Neither state is an incident: both refuse every SQL-backed
tool, fail closed. Escalate as privilege drift only if the state is still
`over_privileged` AFTER re-provisioning. That is
ADR-007's deliberate friction, and it is the same step AID-6A and AID-6C each
required. The three `server_owned` entries in AID-6B do not read through this
credential and are unaffected, so a deployment that has not been re-provisioned can
still be misread as partly working: check readiness rather than a single tool.

**THE ONLY PRODUCTION CHANGE THIS RELEASE MAKES IS THE GRANT, and it is worth
stating plainly rather than leaving it to be inferred.** `invokeDiagnosticsTool`
has no production call site: there is no `/admin/ai-diagnostics` page and nothing
in the shipped runtime calls a tool. The pack therefore ships **dormant** — every
entry is registered, reviewed and tested, and none of them can be reached by an
operator until #2378 builds the surface. What *does* change on deploy is the
database credential: after `npm run diagnostics:provision-role`, `ai_diagnostics_ro`
holds SELECT on thirteen new relations and on a `Member` widened from two columns to
twenty-three, none of which any tool can use yet. The credential's blast radius
therefore grows one release ahead of the feature. That is defensible and it is
ADR-007's own trade — the friction requires the grant to ship with the tool it
belongs to, not with the page — but it means the grant, and not the pack, is what a
production incident in this release could touch.

### Adding a relation grant later

A tool pack (AID-6A/B/C) that needs a new relation adds its grant to `SELECT_GRANTS`
in the same pull request as the tool — by **column** unless every column of the
relation is appropriate diagnostics evidence. Upgrading to that release is therefore a
two-step operation: deploy, then **re-run `npm run diagnostics:provision-role`**.
ADR-007's deliberate friction is exactly this — a new relation becoming readable by
Diagnostics is a visible, reviewed, operator action, not a side effect.

**Until you re-run it, the new tools will not work**: readiness reports
`under_provisioned` (the role is safe but can read less than the allowlist declares) and
the affected tool calls are refused. That is the intended failure, not a bug.

Re-provisioning also **narrows**. PostgreSQL's `REVOKE` reference states that revoking
a privilege on a table also revokes the corresponding column privileges, so a release
that drops a column from an allowlist entry really does take it away rather than
leaving the wider grant in place. The real-PostgreSQL proof asserts it by hand-granting
`"ipAddress"` on `AuditLog`, re-provisioning, and finding the read refused.

### Rotating the password

Re-run the script with a new `AI_DIAGNOSTICS_DB_PASSWORD`, then update
`AI_DIAGNOSTICS_DATABASE_URL` and restart the app containers. The script re-asserts
every restriction at the same time.

## Reading readiness

`GET /api/admin/ai-diagnostics/readiness` reports metadata only. The
`databaseState` field says what to do next:

| `databaseState` | Meaning | Operator action |
| --- | --- | --- |
| `not_configured` | `AI_DIAGNOSTICS_DATABASE_URL` is not set. Nothing was contacted. | Provision the role and set the variable. |
| `misconfigured` | Set, but unusable as configured: not a valid `postgres://` URL, no username, it names the **same role** as `DATABASE_URL`, or it carries one of the refused query parameters above. | Fix the connection string; it must be the dedicated role, with no overriding parameters. |
| `unverified` | Set, but the server could not be asked — unreachable host, bad password, connection limit, or no answer inside the probe deadline. The role is **not** trusted. | Fix connectivity or credentials, then re-check. |
| `under_provisioned` | Reachable and otherwise safe, but missing at least one declared relation or column grant. | Re-run `npm run diagnostics:provision-role`, then re-check readiness. |
| `over_privileged` | Reachable, and the role holds a privilege ADR-007 forbids, can read an undeclared relation or column, or is not the configured role. | Re-run provisioning and investigate privilege drift. If the role name does not match `current_user`, fix the string. |
| `verified` | The server itself confirmed the named role is a non-superuser that can only `SELECT`, and only from the declared allowlist. | Nothing. |

The response never contains the connection string, the password, or the role name.

Every state except `verified` blocks readiness, and every diagnostics tool call is
refused independently of readiness — the credential gate is the control, and readiness
is the operator-facing explanation of it. Both read the same server answer and age it
out on the same one-minute clock, so the screen cannot report green while the executor
refuses.

## Connection budget

The diagnostics pool is capped at 3 connections and the role carries its own
`CONNECTION LIMIT`. Count it alongside the Prisma pools when sizing
`max_connections` — see "Connection pool sizing" in
[`DEPLOYMENT.md`](../../DEPLOYMENT.md).

## Verifying it yourself

The repository ships a real-PostgreSQL privilege proof that runs the **shipped**
provisioning statements and then asserts that mutation, DDL, `TEMP`, credential-store
reads, and long queries all fail as the restricted role. To run it against a
throwaway database:

```bash
docker run -d --name aid5-pg -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=concurrency_race_1881 \
  -p 127.0.0.1:55442:5432 postgres:16-alpine

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
  npx prisma migrate deploy

RUN_CONCURRENCY_RACE_TESTS=1 \
CONCURRENCY_RACE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881 \
  npx vitest run src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts
```

The suite refuses to run against port 5432, a non-loopback host, or a database
whose name lacks the dedicated marker. **Never point it at a live database**: it
provisions and drops a cluster role and temporarily revokes
`TEMPORARY … FROM PUBLIC`.

## Related

- [Tool substrate reference](tools.md) — the gates, bounds, audit, and the rules
  for adding a tool.
- [Support tool pack (AID-6A)](tool-pack-support.md) — what is registered today, the
  permission each tool requires, and the operator troubleshooting table.
- [Hub, ADRs, and threat model](README.md).
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md), [`CONFIGURATION.md`](../../CONFIGURATION.md).
