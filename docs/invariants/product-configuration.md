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
  transitional `APP_TIME_ZONE` constant that also derived from them is gone
  (#3567).
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
- **CT-6 (#2991) made the environment's silence mechanical, and counted what is
  left.** Naming `process.env.TZ`, `NEXT_PUBLIC_TZ` or an `APP_TIME_ZONE` import
  is a lint error under `src/**` outside a ratchet that started at nine files
  and since #3567 holds one, CT-1's seed reader. Two matrices prove the rule holds rather than
  merely being written down: `host-process-zone-matrix.test.ts` runs the club's
  answers under six process zones spanning UTC-11 to UTC+14, and
  `browser-viewer-zone-matrix.test.ts` renders member and admin surfaces under
  six viewer zones. Each row proves its own premise as a CIVIL-TIME answer
  first — the execution zone really moved — because comparing identifiers proves
  only that a string was assigned. What no selector can express is counted by
  `club-time-escape-hatch-census.test.ts`, whose numbers are ceilings.
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
- **The boundary is asked once per MESSAGE, never once per batch, run or lock
  wait.** A clearance says what was true when it was minted, so a sender that
  resolves once and then transmits many times has one check covering all of them —
  and the safer override exists precisely so an operator can stop mail *now*. So
  `sendEmail` asks for every message it renders, the email retry cron asks inside
  its loop rather than above it, and the Xero group-settlement workflow re-asks
  inside its `pg_advisory_xact_lock(1)` transaction — on the transaction client, so
  no second database connection is taken while that exclusive lock is held. Both
  of the latter two were once-per-run and were found by #3071's external review.
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
- **A capture transport is an explicit declaration and never an inference — and a
  declaration contradicted by its own host is refused.** `USE_LOCAL_CAPTURE=true`
  declares that the configured SMTP relay is a sink that forwards nothing, and a
  confirmed non-production installation may then transmit into it — recorded as an
  ordinary `SENT`, because it was sent. Nothing infers this from a host name.

  The two directions are not the same rule, and the asymmetry is load-bearing: no
  host name can GRANT capture mode, and a host name CAN refuse it. A declared
  capture whose `EMAIL_SERVER_HOST` is a public-internet host resolves the
  distinct transport kind `capture-public-host` and the distinct outcome
  `block_capture_public_host` — refused, retryable, with a reason naming the host.
  Loopback, RFC 1918/6598/4193/3927 addresses, `localhost`, a single-label
  container name and the RFC 6761/8375/2606 reserved suffixes are accepted;
  anything unrecognised fails closed; and `EMAIL_CAPTURE_ALLOW_PUBLIC_HOST=true`
  is the one explicit override, for a sink that forwards nothing but has a public
  name. What the check CANNOT establish is stated wherever it is relied on: a mail
  server on a private address can relay outward, so this is a necessary and never
  a sufficient condition, and no operator sentence may claim the capture was
  verified. Added on #3071's external review, where an installation that flipped
  only the flag on upgrade kept its live relay host and emailed real members while
  the log recorded that the message reached nobody.

  The club's live site declaring it is **refused**
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
  canonical role, never `INV-CONFIG-004`'s delivery policy, before it puts an
  email address on a contact.** A non-production installation is contained
  whatever its transport mode, every browser-suite stack included.
  `resolveXeroContactEmailPolicy()` in
  [`xero-contact-containment.ts`](../../src/lib/xero-contact-containment.ts)
  answers; the two payload builders in `xero-contacts.ts` require its unforgeable
  policy token, re-checked at runtime so a cast fails closed.
- **Containment precedes the invoice, not merely its email:** every invoice is
  raised `AUTHORISED` and stays so, copies included.
- **Confirmed PRODUCTION is byte-identical:** `applyXeroContactEmailPolicy` is
  the identity, so payloads, stored request payloads and idempotency keys are
  unchanged and no containment record is written.
- **Confirmed NON_PRODUCTION replaces every address** (`toXeroSandboxContactEmail`)
  with a SHA-256 of the normalised address on a reserved `.invalid` domain
  (RFC 2606): deterministic, non-deliverable, never double-wrapped. The contained
  domain is never a placeholder domain: a contained address is not
  `isPlaceholderContactEmail()`, and an address that predicate accepts is not
  transformed. A contained address never travels inbound onto a `Member`: both
  admin paths creating one from a Xero contact's address refuse it.
- **Existing and restored links are in scope.** Before a contact id, a
  `findOrCreateXeroContact` fast-path return included, reaches anything that can
  raise a document, `ensureXeroContactContained` finds proof or establishes
  containment, else throws (`XeroContactContainmentError`, or the provider's own
  daily-limit, outage or reconnect error, never relabelled) and nothing is raised.
- **Proof** is one `XeroSandboxContactContainment` row per contact, written only
  after reading Xero's stored value back. The fast path needs its address to
  match what the member's current address yields and the row to be younger than
  `XERO_CONTAINMENT_PROOF_MAX_AGE_MS` (24 hours), else it re-reads Xero. A
  provider-side change inside that window goes unnoticed until it expires; the
  operator guide says so, and to finish a repair by moving the copy off the real
  Xero organisation. `rewroteAddress` (this installation overwrote a deliverable
  address on the contact) is monotone: false to true, never back.
- **Steady state is zero provider calls:** one indexed read per contact; first
  containment costs one provider read and at most one write, keyed on contact id
  and written address so a retry cannot duplicate.
- **UNKNOWN writes nothing to Xero.** `assertXeroProviderWriteAllowed`, inside
  `callXeroApi`, refuses every mutation (any operation not named `get…`)
  before the retry ladder and any usage row. It is the backstop: entry points
  refuse first, before reserving an operation or taking a lock. Reads stay
  allowed, so every surface says "written", never "reached".
- **Proof is required where an operation can leave an invoice outstanding
  against a contact or raise a document against one, not on every write.**
  Outside the contact funnel: the membership-cancellation credit note,
  booking-invoice re-pricing and applied-credit deallocation, each proving at
  entry (`requireContainedXeroContactForInvoiceOperation`). Recording a payment,
  allocating a credit note and voiding an invoice only reduce what is
  outstanding; archiving a contact and contact-group membership carry no
  document or address. Those take the role gate only.
- **`/admin/environment`** reports production, contained non-production and
  environment-unknown blocking with no email address in its payload: on a copy,
  contacts contained, how many held an overwritten deliverable address, first
  containment, last check, last actual replacement, and the rewritten contacts
  (member name, Xero link, when); "unavailable", never zero, for an unreadable
  figure.
- **Repair is manual, and every surface says so and why:** no shipped route
  pushes a member's address onto a contact already holding one (force-sync links,
  the Xero push refuses a linked member, contact update fires only on a local
  field change), a copy may not write a real address, and the live site has no
  record of a copy's changes. Correct each contact in Xero from the member's page
  on the live site.
- **The safer override starts containment:** it forces NON_PRODUCTION, the only
  role containment runs in, so on an installation resolving PRODUCTION or UNKNOWN
  and connected to the club's real Xero organisation it begins rewriting real
  contacts; it stops member email (`INV-CONFIG-004`). Stopping Xero work means
  disconnecting Xero or pointing it at another organisation.
- History, measurements and rejected alternatives: #3036 (ENV-SAFETY 3,
  epic #2986, consuming #3034's resolver). Operator guide:
  [`environment-role.md`](../guides/environment-role.md); Xero topology:
  [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md).

## INV-CONFIG-006

- **The club's currency and locale are one persisted pair, and the
  installation's own configuration is the only authority for them.** One ISO
  4217 code (`NZD`, `CHF`) and one BCP 47 tag (`en-NZ`, `de-CH`) in
  `ClubFormatSettings` (id `"default"`), read through `getClubFormat()` in
  [`club-format-settings.ts`](../../src/lib/club-format-settings.ts); validated
  by [`club-format.ts`](../../src/lib/club-format.ts).
- **`CURRENCY` and `LOCALE` are a seed, not a second opinion.** They are
  consulted only while nothing is persisted; the `NEXT_PUBLIC_` twins not at all
  (#3567). Once the row exists, editing them changes nothing (D3 on #3205).
- **Card charges take the stored currency** (#3567): `stripe.ts` derives it from
  the required format, and refuses one without two decimal places.
- **The row is never seeded in SQL.** A migration cannot read a process
  environment, so inserting `NZD` would silently re-denominate a club running on
  another currency. The copy happens at boot, create-if-absent, in
  `clubFormatSelfHealStep`, which runs even when `config/club.json` is absent.
- **Neither column has a database default: the ROW's existence is the
  "configured" signal.** The chain is persisted → environment → the shipped
  `NZD` / `en-NZ`, per field, so a row with one unusable value keeps the good
  half. The last-resort constants are not an `INV-CONFIG-001` breach, for the
  reason `CLUB_TIME_ZONE_FALLBACK` is not.
- **Validation is shape, probe, shape again** — never membership of
  `Intl.supportedValuesOf` (`club-format.ts`).
- **Changing either re-denominates nothing.** Stored amounts stay integer cents
  worth what they were; only how one is WRITTEN follows this.
- **Any admin reads them (#3596); changing them is Full Admin, confirmed,
  audited, and excluded from config transfer as instance-local** — a bundle
  apply is none of those things.
- Decided on #3563 (programme #3205), which holds the narrative; #3564-#3567
  moved every reader onto it. Operator guide:
  [`club-format.md`](../guides/club-format.md).

## INV-CONFIG-007

- **The club's GST treatment is one setting, with today's treatment as its
  default.** `ClubTaxSettings` (id `"default"`) records whether the club is
  GST-registered, the rate in basis points, and the club civil date it applies
  from (#4626, decision D3 in
  [`member-money-ledger.md`](../design/member-money-ledger.md#d3-tax-and-recognition-keep-each-charges-actual-treatment)).
  It is read through `loadClubTaxSettings` in
  [`club-tax-settings.ts`](../../src/lib/club-tax-settings.ts). An absent row
  means registered at 1500 basis points from 2010-10-01, which is the
  GST-inclusive 15% treatment the Xero documents already render. Prices are
  GST-inclusive, so "inclusive" is the treatment itself, not a setting.
- **A date before the setting starts has no treatment.** A posting that needs a
  fresh tax split on such a date is refused, never guessed. Postings that need
  no split go ahead.
- **Nothing writes the row yet.** The Xero renderers still hard-code the
  inclusive OUTPUT2 code (#4632), so a second answer must not appear until Xero
  reads this setting. `club-tax-settings-writer-census.test.ts` fails on any
  writer. So the journal (M3b, #4627) posts every club's charges at the default
  treatment; a non-registered club's tax legs are wrong until #4632, and no
  reader uses them yet.
- **It is instance-local:** a legal fact about this club, excluded from config
  transfer.
