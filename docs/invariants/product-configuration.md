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

## INV-CONFIG-003

- **One explicit deployment declaration says whether an installation is the
  club's live site or a copy, and nothing infers it.** The declaration is the
  `APP_ENVIRONMENT_ROLE` environment variable, whose only accepted values are
  `production` and `non-production` (case-insensitively, after trimming). It is
  read by
  [`environment-role-declaration.ts`](../../src/lib/environment-role-declaration.ts)
  and resolved by `resolveEnvironmentRole()` in
  [`environment-role.ts`](../../src/lib/environment-role.ts), which is the ONE
  place that answers "is this production?" for every caller.
- **`NODE_ENV`, `APP_RUNTIME_ROLE`, the hostname, the branch, the URL, the
  `DATABASE_URL` and the provider organisation are never inputs to that
  answer.** `NODE_ENV` is a build mode — the staging stack runs a production
  build, so it reads `production` there. `APP_RUNTIME_ROLE` names which container
  slot a process is (`web-blue`, `cron-leader`, `staging`) and is a deployment
  naming convention. Each is right until somebody stands up a copy that breaks
  the convention, which is the day it matters. The two variable names are close
  enough that operators reach for the wrong one, so both plausible mistakes fail
  safely: `APP_ENVIRONMENT_ROLE=staging` is refused and resolves UNKNOWN, and
  `APP_RUNTIME_ROLE=production` changes no safety decision at all.
- **A database override may only force the SAFER non-production state.**
  `EnvironmentSafetySettings` (id `"default"`) holds one boolean,
  `forceNonProduction`. The schema deliberately contains no column in which "this
  is production" could be expressed, so the rule is structural rather than a
  convention the code has to keep — and a database restored from the club's live
  site cannot carry a production claim into a copy, because there is nothing for
  it to travel in. Switching the override off is **not** an elevation: the
  declaration decides again, so an undeclared installation returns to UNKNOWN.
  Changing it in either direction is Full-Admin-only, explicitly confirmed
  server-side, and audited with the actor and the before/after value.
- **A missing or unrecognised declaration is UNKNOWN, which is neither
  production nor confirmed non-production.** It is never inferred to be either.
  Callers whose safety depends on the answer fail closed on UNKNOWN; in
  particular UNKNOWN must not be treated as non-production for the Xero
  sandbox/containment transformation. An unreadable override also resolves
  UNKNOWN — including under a declared `production`, because an unreadable
  override cannot rule out that an operator has already forced this instance
  safer. The one exception is a declared `non-production`, which is already the
  safest answer, so no database state or database failure can move it.
- **The unconfigured state is visible where an operator has to act**, which is
  `INV-CONFIG-001`'s visibility rule applied here: the `environment-role` setup
  step reports `blocked` naming both sources and the repair,
  `/admin/environment` shows the same, and a boot with an undeclared role logs an
  error once.
- **A production deployment cannot proceed without the declaration.** An
  installation that predates this rule has none, so shipping the fail-closed
  behaviour alone would turn a working live site into a silent mail outage.
  `scripts/run-production-blue-green-deploy.sh` therefore validates the `.env`
  entry in its preflight — before the migration runs, before the new release's
  first process starts, and long before the traffic cutover — so an undeclared
  upgrade is a loud refusal with the previous release still serving. That
  ordering is part of the invariant, not an implementation detail: a check that
  ran after the cutover would restore exactly the outcome this rule forbids.
- Decided on #3034 (ENV-SAFETY 1) under epic #2986; the consuming policies are
  `INV-CONFIG-004` (#3035, delivery) and `INV-CONFIG-005` (#3036, Xero
  containment). Those issues hold the narrative and the rejected alternatives;
  this entry holds only the rule. Operator guide:
  [`environment-role.md`](../guides/environment-role.md).

## INV-CONFIG-004

- **Every application-controlled send passes through ONE environment-aware
  delivery boundary.** The boundary is `resolveDeliveryPolicy()` in
  [`environment-delivery-policy.ts`](../../src/lib/environment-delivery-policy.ts),
  which consumes `INV-CONFIG-003`'s effective role and the deployment's declared
  transport kind and answers with one of five outcomes. Its verdict is carried by
  an unforgeable clearance token: `getEmailTransporter` (the ONLY place a mail
  transport is created) and `sendXeroInvoiceEmail` (the ONLY place
  `accountingApi.emailInvoice` is called) both require one, so a new sender
  cannot reach a provider without asking the policy — a compile-time property,
  not a convention. The token is re-validated at runtime as well, so a cast past
  the type fails closed.
- **Confirmed PRODUCTION delivers, and is behaviourally unchanged** apart from
  passing through the boundary, including the legacy "no provider flag set means
  AWS SES" fallback that existing deployments rely on.
- **A confirmed NON_PRODUCTION installation contacts no provider.** The send is
  suppressed *before* any provider attempt and recorded as
  `EmailLogStatus.SKIPPED_NON_PRODUCTION`: terminal, non-retryable, body dropped.
  That is a distinct status from `SKIPPED_NO_EMAILS`, which means the club chose
  not to email a person about a booking; conflating them would attribute a
  decision to an administrator who made none, and would make the withheld-email
  count unmeasurable.
- **An UNKNOWN role fails closed, retryably.** Nothing is transmitted, and the
  row is `FAILED` carrying a `deliveryBlockReason`, so the message goes out by
  itself once an operator declares the role and so it is distinguishable from a
  transport failure by more than a message string. UNKNOWN gets no exemption from
  any declaration that travels with it, a capture transport included: an
  installation that cannot say what it is has not earned one.
- **"Retryable" holds only while the row still carries a body, and a row nothing
  can replay is landed where an operator sees it.** No rendered body is persisted
  for the twenty-six `SENSITIVE_EMAIL_LOG_TEMPLATES`, nor for any message whose
  logged recipient is redacted, because a live sign-in link, a door code or a
  payment link must not sit at rest — and the retry cron selects only rows that
  still hold one. Such a row is therefore written AT the retry ceiling, which
  drops it out of the retry query and into the `attempts >= 3` operator
  email-failure review queue, and every operator sentence about it says it must be
  re-sent by hand rather than claiming it will self-heal. Retaining the body for
  those templates is not an acceptable alternative: that is the hazard they are
  excluded for.
- **A `deliveryBlockReason` describes the row as it stands, and is cleared the
  moment something else becomes the reason.** The column is the only sturdy thing
  separating a safety block from a transport failure, and the withheld-email count
  `INV-CONFIG-003`'s operator surface reads is `FAILED` plus a non-null reason. So
  every later terminal write on that row — a provider failure, a delivery, a
  bounce, a business withhold, a retirement — sets it back to NULL. A stale value
  would keep a repaired installation inside the withheld population for the life
  of the installation, and a count that never drains cannot distinguish anything.
- **An ambiguous mail transport must not fall through to live AWS SES.** With no
  provider flag set, only confirmed production keeps the legacy default; anywhere
  else the configuration resolves invalid and names the flags to set. This binds
  the diagnostic paths too — the health check and the setup wizard's provider test
  open a real connection with real credentials, so they go through the same rule
  and hold no transport that could send.

  **A stated limit on that last sentence:** what the diagnostic paths refuse is
  the AMBIGUOUS fallback, not every connection. An installation that has
  *explicitly* declared `USE_AWS_SES=true` or `USE_SMTP_RELAY=true` still verifies
  on a copy, so a real authenticated connection is opened there — no message is
  sent, because no transport escapes `verifyEmailTransport`, and every send is
  still suppressed by the boundary. That is deliberate: an SMTP relay counts as a
  live provider however it is configured, so refusing every verification on a copy
  would remove the one diagnostic an operator setting a staging relay up needs. A
  copy holding the club's real provider credentials is forbidden by `AGENTS.md`
  for the larger reason that such a copy could then send.
- **A capture transport is an explicit declaration and never an inference.**
  `USE_LOCAL_CAPTURE=true` declares that the configured SMTP relay is a sink that
  forwards nothing, and a confirmed non-production installation may then transmit
  into it — recorded as an ordinary `SENT`, because it was sent. Nothing infers
  this from a host name. The club's live site declaring it is **refused**
  (`CAPTURE_TRANSPORT_IN_PRODUCTION`), because a live installation in capture mode
  accepts every message and delivers none, which is the same harm as a
  wrongly-declared copy arriving from the opposite direction. A capture does not
  cover a provider that sends on our behalf: a Xero invoice email leaves Xero's
  servers for the member's stored address, so a capture copy does not ask for one
  at all, and the narrower `LiveProviderClearance` makes that a compile error
  rather than a rule.
- **The four non-delivery outcomes stay distinguishable in operations, audit and
  tests**: business suppression, environment-safety suppression,
  environment-configuration block, and provider failure. None of them may move
  booking, payment, charge or invoice business state as though a provider call had
  failed — in particular a safety suppression never populates the
  `invoiceEmailError` that marks a Xero sync operation `PARTIAL`, and never writes
  a withheld-booking-email audit row.
- **How much has been held back is countable**, because that count is the only
  signal separating a live club wrongly declared a copy from a legitimate copy
  nobody is using. `readWithheldApplicationEmail()` counts the suppressed rows and
  the environment-blocked rows together, and reports an honest "unavailable"
  rather than a zero when it cannot read them.
- Logs and operator copy stay sanitized: no message bodies, no credentials, no
  unnecessary PII, and a refused configuration value is never echoed back
  unbounded.
- Decided on #3035 (ENV-SAFETY 2) under epic #2986, consuming #3034's resolver.
  That issue holds the narrative and the rejected alternatives; this entry holds
  only the rule. Operator guide:
  [`environment-role.md`](../guides/environment-role.md).

## INV-CONFIG-005

- **Every application-managed Xero contact write asks `INV-CONFIG-003`'s
  canonical role before it puts an email address on a contact.** The one place
  that answers is `resolveXeroContactEmailPolicy()` in
  [`xero-contact-containment.ts`](../../src/lib/xero-contact-containment.ts), and
  its verdict is carried by an unforgeable policy token: the two contact payload
  builders in `xero-contacts.ts` require one, so a builder cannot be written
  without the question being asked, and the token is re-checked at runtime so a
  cast past the type fails closed.
- **It reads the ROLE and never `INV-CONFIG-004`'s delivery policy, and that is
  not a stylistic choice.** The delivery policy exempts a confirmed copy that has
  declared a local capture mailbox, because a capture intercepts everything this
  application sends. Xero emails an invoice from its OWN servers to the address
  stored on the contact, so a capture container never sees it. A non-production
  installation therefore needs full containment **regardless of its transport
  mode**, which includes every stack the browser suite runs on.
- **Containment must precede the INVOICE, not merely the invoice email.** Every
  invoice is raised `AUTHORISED` and stays that way, deliberately, so settlement
  behaviour remains testable on a copy — and Xero's own invoice reminders email the
  contact's stored address for outstanding authorised invoices with no API call
  from this application at all. So an invoice raised against an uncontained contact
  can reach a real member even though `INV-CONFIG-004` already gates
  `emailInvoice`.
- **Confirmed PRODUCTION is byte-identical.** `applyXeroContactEmailPolicy` is the
  identity function there, so every payload, every stored request payload and every
  idempotency key on the club's live site is what it was before this rule, and no
  containment record is ever written.
- **A confirmed NON_PRODUCTION installation replaces every address with one
  deterministic, idempotent, deliberately non-deliverable form.** The same real
  address always maps to the same contained address — otherwise a restored copy
  could not tell whether a contact it is looking at is already contained, and
  nothing could be reconciled afterwards. It is a SHA-256 of the normalised
  address on a reserved `.invalid` domain (RFC 2606), so it identifies the source
  without carrying it and an operator surface can report containment without
  exposing a member's email. Containing an already-contained address returns it
  unchanged: nothing may double-wrap.
- **The contained domain is NEVER one of the placeholder domains, and the two
  predicates stay disjoint.** `isPlaceholderContactEmail()` means "this person
  cannot be reached" to the mailer, the reminder crons, email inheritance, the
  non-member-contact service, deleted accounts and three Xero modules. A contained
  member can be reached — on the live site, by the club — so adding the contained
  domain to that list would make every contained member in a copy read as
  unreachable, silently changing booking flows, reminder crons and admin surfaces
  so the copy stops behaving like production. An address the placeholder predicate
  accepts is not transformed, and a contained address is not a placeholder.
- **Nor may a contained address travel INBOUND onto a `Member`.** Two admin paths
  create a member from a Xero contact's stored address; both refuse a contained
  one, because a member minted from it would read as reachable — the placeholder
  predicate deliberately says nothing about this domain — while being able to
  receive nothing.
- **Existing and restored links are in scope, and that is the whole point.** A
  copy restored from the club's live database arrives with every member already
  linked, so `findOrCreateXeroContact` returns from its steady-state fast path
  with no provider write and no look at what the contact holds. Before that id
  reaches anything that can raise a document, durable evidence must show the
  contact is contained, or containment must be established; if it cannot be, the
  call fails with a distinct named error and no document is raised.
- **The evidence is a claim about what this application has SEEN, and it is
  narrow enough to be true.** One `XeroSandboxContactContainment` row per Xero
  contact, carrying the contained address derived from the member's current stored
  address. The fast path requires that to match what the application would write
  today, so a change to the member's address invalidates the proof rather than
  leaving a stale claim, and every row is written only after reading Xero's stored
  value back — never from "we believe we sent that".
- **AND THE PROOF EXPIRES, because only Xero can invalidate a claim about Xero.**
  The fingerprint above notices a change on the LOCAL side. Nothing notices a
  change on the provider side — somebody editing the contact in Xero, or the live
  site pushing the member's real address back onto it — and the provider side is
  what the proof is about. So the fast path additionally requires the proof to be
  younger than a bounded freshness window (24 hours, sized against Xero's daily
  call ceiling: one provider read per contact per window), and re-reads the
  contact from Xero past it. **The residual is the window itself and it is
  disclosed rather than hidden:** a provider-side change made inside the window is
  not noticed until it expires. The operator guide says so, and says to finish a
  repair by moving the copy off the real Xero organisation rather than leaving it
  pointed there.
- **A recorded overwrite is never retracted.** `rewroteAddress` answers "did this
  installation overwrite a deliverable address on this contact", which is a fact
  about the past. A re-verification necessarily finds the contained address
  already in place, so recomputing and writing the flag erased the record of a
  real overwrite — and the operator surface then positively asserted that nothing
  had been overwritten. The column is monotone: false to true, never back.
- **Steady state is zero provider calls.** The fast path is one indexed read per
  contact, so a batch or subscription run over hundreds of members touches Xero
  not at all; a provider read and at most one provider write happen once per
  contact, on first containment, with an idempotency key derived from the contact
  id and the address being written so a retry cannot duplicate either.
- **UNKNOWN WRITES NOTHING TO XERO, and that is enforced at a chokepoint rather
  than asserted about a list of writers.** UNKNOWN is not evidence of being a
  copy, so writing a contained address over the club's real accounting on a guess
  is exactly as wrong as emailing real members on one. Every Xero provider
  MUTATION is refused inside `callXeroApi` — the single wrapper every provider
  call in this subsystem goes through — before the retry ladder and before any
  usage row is recorded, because nothing was attempted. The classification is
  fail-closed: an operation whose name does not begin with `get` is a mutation, so
  a writer added later is refused without being enumerated anywhere. The
  entry-point refusals still come first, so an undeclared installation refuses
  before reserving an operation or taking a lock and nothing is left half-written;
  the chokepoint is the backstop underneath them.

  This replaced a narrower claim that was **false**. Contact resolution alone
  refused, and the writers that do not go through it carried on: the
  membership-cancellation credit note, contact-group membership, archiving a
  contact, voiding an invoice, recording a payment, deallocating applied credit
  and re-pricing a booking invoice. Seven operator-facing surfaces asserted that
  nothing was reaching Xero while all of that was.
- **Reads are deliberately allowed while the role is UNKNOWN.** A read marks
  nothing in the club's books and cannot make Xero email anybody, and an operator
  diagnosing "why has this installation stopped writing to Xero" needs the Xero
  screens to keep loading. Every surface therefore says "written", never
  "reached".
- **Containment must precede an operation that can leave an invoice OUTSTANDING
  against a contact, or that raises a new document against one — not merely every
  Xero write.** That boundary is an argument, not an accident: Xero's reminders go
  to the contact of an outstanding `AUTHORISED` invoice, so those are the
  operations that can end with a real member being chased on a copy. Three writers
  qualify and none of them goes through the contact funnel — the
  membership-cancellation credit note, a booking-invoice re-price, and
  applied-credit deallocation — and all three prove containment at their entry
  point. Recording a payment, allocating a credit note and voiding an invoice only
  reduce what is outstanding; archiving a contact and changing contact-group
  membership carry no document and no address. Those take the role gate and not
  the proof.
- **The operator surface distinguishes the three states without exposing an
  address, and it is addressable.** `/admin/environment` reports production,
  confirmed non-production containment (how many contacts are contained, how many
  of those were holding a deliverable address this installation overwrote, when
  the first containment was, when the last check was, and when a deliverable
  address was last actually replaced) and environment-unknown blocking, and it
  reports "unavailable" rather than a zero when a figure cannot be read. It also
  LISTS the rewritten contacts — the member's name, a link to that contact in
  Xero, and when — because the repair is per contact and a count is not something
  anybody can act on. No email address of any kind travels to that payload.
- **The repair is manual, and every surface says so and says why.** No shipped
  route can push a member's stored address onto a Xero contact that already holds
  something: the admin force-sync links a contact rather than pushing to it, the
  Xero push refuses an already-linked member, and the ordinary contact update
  fires only on a local field change. Nor could either side do it unaided — a copy
  is forbidden from writing a real address to a contact, which is the whole rule,
  and the live site holds no record of what a copy changed, because the containment
  rows live in the copy's own database. So the instruction is to correct each
  contact in Xero, reading the address from the member's page on the live site. An
  earlier draft told operators to "re-sync those members from the live site",
  which no route performs and which would have silently disarmed the proof if it
  had.
- **The safer override STARTS containment; it does not stop it.** The override
  forces NON_PRODUCTION, and NON_PRODUCTION is the only role in which containment
  runs. So on an installation resolving PRODUCTION or UNKNOWN and connected to the
  club's real Xero organisation, switching it on begins rewriting real contacts.
  It stops member email (`INV-CONFIG-004`). Stopping Xero work means
  disconnecting Xero on that installation or pointing it at another organisation.
- Decided on #3036 (ENV-SAFETY 3) under epic #2986, consuming #3034's resolver.
  That issue holds the narrative and the rejected alternatives; this entry holds
  only the rule. Operator guide:
  [`environment-role.md`](../guides/environment-role.md); Xero topology:
  [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md).
