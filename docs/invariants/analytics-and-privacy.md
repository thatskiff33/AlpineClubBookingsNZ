# Analytics And Privacy

Audience: Developer, Agent.

Prefix defined in this file: **`INV-PRIV`** — analytics loading and consent, what
this application is allowed to send to Google, what a visitor's choice does, what
personal data may appear in a log, and who may read an audit row.

Read this file when you are changing analytics loading, the consent banner or the
public Analytics preferences control, the analytics route policy, anything that
decides what leaves this application for Google, the log/Sentry redactor and what
it strips out, or the `category` an audit writer records — which decides both the
admin permissions a reader needs and whether the subject member sees the row.
Read it too before anything reads, writes, exports or logs a member's
dietary/allergy information (`INV-PRIV-022`).

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

That applies to `INV-PRIV-001` through `INV-PRIV-010`, which are the transcribed
blocks. `INV-PRIV-011` (#2683), `INV-PRIV-012` (#2755) and `INV-PRIV-013` (#2765)
were written after the
restructure rather than moved into it, so there is no source text to preserve
them against: correct them like any other prose, in their own reviewable change.
See [`SCHEME.md`](SCHEME.md) §3 — the no-rewording rule governs transcriptions,
not rules first written here. #2765 used that licence to scope `INV-PRIV-012`'s
"narrowing, member-invisible in both directions" sentence to `lodge`, which is the
only destination it is true of.

## INV-PRIV-001

Google Analytics must not load unless ALL of the following hold (#2573):

- the Analytics module is enabled at Admin → Modules (the master switch);
- a valid GA4 measurement id is stored in `AnalyticsSettings` — the database is
  the sole canonical source, `NEXT_PUBLIC_GA_MEASUREMENT_ID` is not read
  anywhere at runtime, and there is no fallback to it;
- the route is analytics-eligible under the fixed, application-controlled policy
  in `src/lib/analytics-route-policy.ts`; and
- the visitor has explicitly accepted, **whenever the consent banner is
  enabled**.

## INV-PRIV-002

While the banner is enabled and no accepted choice is recorded at the club's
current consent revision, nothing at all reaches Google: no tag load, no
request, no cookieless ping and no consent-status signal. Declining or
dismissing the banner both count as denied.

## INV-PRIV-003

While the banner is disabled the tag loads automatically on eligible routes, a
decline recorded *while the banner was showing* is invalidated once, and a
subsequent opt-out through the public Analytics preferences control is honoured
at any consent revision — so the preferences control can never be made
ineffective by turning the banner off.

## INV-PRIV-004

Advertising storage, advertising user data and advertising personalisation are
denied in every consent signal, in both banner modes, with no setting that
changes it.

## INV-PRIV-005

Every page view **this application sends** carries `origin + pathname` only, and
is sent only for an eligible route. Never a query string, never a fragment, and
never a reset token, invitation token, verification code, PIN, email address,
member id, booking id or payment id — including in the referrer, which is
sanitised before Google sees it.

## INV-PRIV-006

It sends **exactly one such page view per address** across client-side
navigation: `send_page_view: false` suppresses the one the `config` call would
send, and the manual event is de-duplicated against the last location actually
sent.

## INV-PRIV-007

**Both of those hold end to end only if the GA property's enhanced-measurement
option “Page changes based on browser history events” is switched off.** It is a
Google-side setting, on by default for a new web stream and not controllable from
`gtag`, and it works by watching the browser's own history rather than by asking
the application — so with it on Google adds a page view of its own on every soft
navigation, including the navigation that LEAVES the public website for an
excluded route. Next flips the URL in `HistoryUpdater`'s `useInsertionEffect`
(the commit's mutation phase, `next@16.2.12`), while the runtime's kill switch is
a passive effect destroy React schedules after paint, so the resident tag
observes `/login`, `/dashboard` or `/book` while `ga-disable-<id>` is still
false. Whether the resulting hit carries the browser's raw URL or inherits the
sanitised value already `set` on the tag is Google's internal behaviour and is
not verifiable from this repository; under either reading a page view leaves for
an address the policy excludes. The setup panel and `docs/guides/integrations.md`
therefore make switching it off a REQUIRED setup step, and state the disclosure
rather than the double count as the reason. The application cannot switch it off
itself, which is why this is a documented operator obligation and not an
enforced invariant.

## INV-PRIV-008

Leaving the public website is part of the same guarantee. The runtime is mounted by
the public website layouts only, so a soft navigation into the member, admin or
login/recovery groups unmounts it — and because neither that unmount nor removal of
an injected script node can unload an executed library (and Next may retain the node
for the document), the unmount sets Google's per-id kill switch and queues a denial.
A visitor's opt-out is propagated to other open tabs the same way, over the `storage`
event.

## INV-PRIV-009

The per-browser choice (`analytics-consent.v2`) stores the applicable consent
revision and which surface recorded it, and is honoured on revisit. Only the
explicit “Ask visitors to choose again” admin action bumps the revision; an
ordinary settings save never does. Every read and write of the configuration is
permission-checked server-side, every change is audit logged, and a save
invalidates the public configuration cache so a removed or invalid measurement
id can never leave a stale tag active.

## INV-PRIV-010

Every one of these fails CLOSED: a missing row, an invalid measurement id, a
disabled module or a database read failure all mean no analytics, and the public
website still renders normally.

## INV-PRIV-011

What personal data may appear in a log, and what an audit row is allowed to keep.
These are two different answers on purpose, and neither is "none".

- **The log/Sentry redactor strips person fields BY KEY NAME, and its coverage
  is therefore not exhaustive.** `src/lib/redact-sensitive-json.ts` is what every
  log line and every Sentry event passes through — pino's `log` formatter in
  `src/lib/logger.ts`, and `beforeSend`/`beforeBreadcrumb` in all THREE Sentry
  surfaces (`src/instrumentation-client.ts`, `sentry.server.config.ts`,
  `sentry.edge.config.ts`; the server one is the one that sees Prisma member
  objects). It redacts, by key: first, last, middle and given names and the
  composed spellings a route invents (`fullName`, `memberName`, `guestName`,
  `contactName`, `surname`, `familyName`); street and postal address including
  Xero's own bare `City`/`Region`/`Country`/`PostalCode`; date of birth; gender;
  occupation; dietary/allergy keys; email; phone; credentials including hashed and second-factor ones;
  and payment identifiers.
- **A key spelling it does not know is a leak, so this list is a floor and not a
  guarantee.** Emails and phone numbers have a second, value-shaped net, so a
  missed key name still cannot leak one of those. Names and addresses have NO
  such fallback — nothing about the string "12 Example Street" identifies it as
  an address — so for those the key name is the only defence. A call site that
  composes a person's name into a key the list does not carry defeats it
  entirely, which is what #2683 found in five places (a family group's name, a
  Xero import result, a webhook payload spread, a minor's name on a
  member-facing route, and the nightly hut-leader cron). Those are fixed at
  source. **When you add a call site that logs a person, log the identifier.**
- **`name` is deliberately NOT on the denylist**, neither as an exact key nor as
  a fragment. It is the key for lodges, rooms, membership types, email
  templates, modules, fee schedules and Xero contact groups, and the admin Xero
  operations panel reads group names straight out of an already-redacted
  payload, so redacting it would blank operational logs and live admin UI. Where
  a person's `name` genuinely must be SENT — Xero's API requires `Name` on a
  contact — it is stripped at the persistence boundary instead, so the outbound
  request carries it and `XeroSyncOperation.requestPayload` does not
  (`stripPersonNameFromStoredContactPayload` in `src/lib/xero-contacts.ts`).
- **Audit rows deliberately keep MORE than a log line does: first name, last
  name and street address.** The admin-action audit trail is written through
  `src/lib/audit.ts` (`logAudit`, `createAuditLog`, `createStructuredAuditLog`),
  whose `details` and `metadata` are sanitised by `sanitizeAuditMetadata` and
  `sanitizeAuditArchiveText` — a different key list, which redacts credentials,
  tokens, card numbers and long HTML but NOT person fields. Owner decision of
  9-10 Aug 2026 on #2683: an `AuditLog` row is a permission-gated,
  retention-classed evidence record whose job is to say who did what to whom, so
  "who" has to be legible to the officer reviewing it; the one special-category
  field, dietary/allergy information, is recorded only as changed
  (`INV-PRIV-022`), and the file's own
  ARCHIVE MODE note records that over-redaction had already destroyed the only
  surviving copy of a club's email wording. `src/lib/__tests__/audit.test.ts`
  pins all three fields, in both directions at once.
- **The boundary is the module, not the caller's intent.** A value keeps a person
  field only by being written as an audit row through `audit.ts`. Anything that
  reaches `logger.*`, Sentry, a webhook log or a persisted Xero payload goes
  through the redactor and loses it, whatever the calling code believes its
  context to be. There is no "audit context" switch on the redactor for a later
  change to copy, so the exception cannot spread by imitation; widening it means
  moving a call onto the audit writer, which is a visible change carrying its own
  permission and retention consequences.
- **The redactor has two limit profiles, and the difference is load-bearing.**
  `redactSensitiveJson` is the log path: depth 6 and an output budget, because a
  log line must stay cheap. `redactSensitiveRecord` is the stored-or-displayed
  path — `sanitizeForJson` in `src/lib/xero-sync.ts` and the admin Xero panels —
  and drops those limits, because those payloads are persisted records that
  read-modify-write cycles re-read and re-persist, so a truncation there is
  permanent and compounds. Both apply exactly the same redaction rules.
- **A key added to the denylist must never be broad enough to rewrite an
  identifier.** The value-shaped phone pattern is bounded so that an 8+ digit run
  inside a cuid survives, because those ids are load-bearing in persisted
  payloads. The email pattern excludes path separators for the same reason: it
  used to match `node_modules/@sentry/nextjs/…` and replace every stack trace
  naming a scoped package with `[REDACTED]`. The same caution governs every key
  fragment added later — which is why `region`, `country` and `city` are exact
  keys rather than fragments, and why `token` is not a fragment at all.

## INV-PRIV-012

Who may read an audit row, and how the category that decides it is chosen. The
category is a **permission decision made at write time**: it picks which AI
Diagnostics correlation entry can return the row, so which admin areas an
operator must hold, and, separately, whether the subject member sees the row on
their own timeline. It is stored on the row, never recomputed at read time, so
**a code change reclassifies only rows written afterwards**; older rows keep the
superseded value until a backfill moves them. `INV-OPS-012`
([`operations.md`](operations.md)) makes the reclassifying pull request ship
that backfill or file it as an issue, never neither and never as prose; a
backfill crossing the member-visible line in either direction is the owner's
decision, not automatic.

- **Category follows the business domain affected — never the initiator, the
  route or the screen** (#2581). Pass a literal category at each write site; a
  conditional between literals is banned (the census contract pins zero). A site
  serving two domains makes two calls with two literals.
- **Member visibility is a separate, explicit declaration.**
  `MEMBER_VISIBLE_AUDIT_CATEGORIES` (`src/lib/audit-query.ts`) is hand-listed,
  not derived, so a new taxonomy category cannot publish to members;
  re-classifying an existing writer can, and that crossing must be argued
  explicitly. **`buildMemberAuditLogWhere` decides whether it crosses, not the
  presence of a subject:** a row reaches a member's timeline if it passes
  `subjectMemberId` for them, or leaves it null while passing `targetId`,
  `memberId` or `actorMemberId` for them — four legs, pinned in
  `src/lib/__tests__/audit.test.ts` — so "it has no subject member" never makes
  a move into a member-visible category invisible.
- **A re-classification moves ROWS; `INV-PRIV-018`'s per-event declaration
  decides FREE TEXT** (#2695); neither substitutes for the other. Never pick a
  member-visible category to achieve visibility or to tidy labels: audit rows
  are append-only, so publication cannot be quietly undone.
- **Stored `details` read outside the Audit Log is a second door with its own
  decided readership** (#3232 D4); the category does not decide who reads the
  words where a domain page renders them under its own permission. The booking
  page shows the `details` of `booking.hostingCoverage.incidentOpened` /
  `.incidentUpdated` (`admin`: Support only in the Audit Log) to anyone holding
  `bookings:edit` (`canSeeAdminTools`). For this and every later such surface:
  the readership is decided and written down, here and in
  [`guides/audit-log.md`](../guides/audit-log.md), never inferred from a page's
  query; it is enforced where editing that query cannot lose it
  (`buildBookingHistoryItems` takes a REQUIRED audience and drops the rows for a
  member; the page's gate is defence in depth); and the booking's own member is
  never a reader — sideways, never downwards.
- **All three writers of the six member-record actions file `admin`, and the
  join is `admin` for that reason** (#2755): `admin.member.updated` /
  `.deactivated` / `.reactivated` (`src/lib/admin-member-detail-service.ts`) and
  `member.bulk-set-role` / `member.bulk-deactivate` / `member.bulk-reactivate`
  (`src/app/api/admin/members/bulk-update/route.ts`). Administering a member's
  record — fields, activation, what they may do — is one domain however many
  screens reach it. None of the six reaches the subject member's timeline; only
  the System correlation entry (`support` area alone) returns them. Rows written earlier keep their
  stored category, so bulk history splits by date; rewriting it would withdraw
  rows members can see, and is the owner's decision (#2763).

  **Scoped to those six actions, never "an officer acted, so `admin`"** — who
  acted is the discriminator the first bullet forbids. The member's own content
  and requests stay in the member's domain whoever touched them, so these file
  `account`, member-visible, deliberately: `member.profile.updated`
  (`/api/profile`: actor is subject, no on-behalf path); `member_photo.upload` /
  `.remove` (`src/app/api/members/[id]/photo/route.ts`) even when an officer
  acts — so on the admin member-detail page a field edit files `admin` and a
  photo change `account`, the domain following the artefact; and the
  officer-driven cancellation writers (`membership_cancellation.admin_requested`,
  `.approval_blocked`, `.participant_cancelled`, `.participant_rejected`,
  `.confirmation_token_reissued`), the member being party to the decision. The
  photo and cancellation writers are pinned in
  `OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755`
  (`scripts/audit/audit-writer-census-manifest.ts`), so citing this rule to move
  one to `admin` fails CI. Moving any of them is a readership change for the
  owner — not a sweep, nor an inference from this rule.
- **Two groups stay `admin` as recorded decisions, not an unexamined default:**
  the fifteen lodge-gated operational sites (#2765, pinned in
  `LODGE_GATED_ADMIN_CATEGORIES_2765`) and, within them, `lockers`
  (#2777), which a revisit must reason about on its own terms. `INV-PRIV-013` is
  the record: its split test decides, **not** "does it name a lodge" or "is the
  route gated `lodge:edit`", and it requires the correlation entries to name the
  set as `admin`.

  Moving either group **to `lodge`** would be a **narrowing**, member-invisible
  in both directions and retention-neutral — materially easier than any
  widening, but still a readership change needing a decision, not a sweep.
  **That reading is scoped to `lodge` and does not travel:** for `lockers` the
  membership correlation domain is measurably a widening. The deciding rule and
  the `lockers` settlement are `INV-PRIV-013`;
  `docs/ai-diagnostics/audit-admin-category-review.md` carries the per-site
  verdict and alternative reading for all 118 writers #2730 reviewed.

History, measurements and rejected alternatives: #2755 (and #2581, #2695, #2730, #2751, #2763, #2765, #2777, #3232).

## INV-PRIV-013

The test that decides whether an `admin` audit writer moves in a sweep, and the
one destination a lane may never choose for itself. Owner decisions of 11 August
2026: #2765 (the fifteen keeps, with the deciding rule) and #2777 (`lockers`
stay `admin`; reopening is a fresh owner decision). The measurement and the
costed options live on those issues, not here.

- **The test is: did this site SPLIT a subsystem? Not: does this site name a
  lodge, a member or a payment.** A split is the defect — some other writer of
  the same objects already answers to a different gate, so no operator can get a
  complete answer and nothing tells them the answer is partial. **A group that
  is UNIFORM has no split to close, so moving it fixes nothing and opens a fresh
  readership question of its own size.** Enforced per site, measured from the
  tree: the #2730 movers in `REVIEWED_ADMIN_CATEGORIES_2730`, the keeps in
  `LODGE_GATED_ADMIN_CATEGORIES_2765`
  (`scripts/audit/audit-writer-census-manifest.ts`) — #2765's fifteen plus any
  later lodge-gated `admin` writer classified under this rule on arrival
  (#2749's other-lodges registry is the first) — a sweep that disagrees
  fails CI with the rule named. Per-site verdicts and worked examples:
  `docs/ai-diagnostics/audit-admin-category-review.md`. The `INV-PRIV-012`
  sentence calling a move of this group "a narrowing, member-invisible in both
  directions" is scoped to `lodge` as the destination and does not travel: it is
  measurably false of the membership correlation domain (#2765's measurement,
  on the issue).
- **The `lockers` settlement (#2777, 11 August 2026): the four stay `admin`.**
  The decided move to `membership` was refused on measurement — `membership` is
  a permission area and a correlation domain here, not an audit category — and
  the one implementable alternative (a NEW canonical category mapped to the
  membership correlation domain and left out of
  `MEMBER_VISIBLE_AUDIT_CATEGORIES`) was costed on #2777 and **declined**. The
  accepted cost is a permission requirement, not a choice of tool: these rows
  correlate only through the System entry, so a Membership Officer who does not
  also hold Support & System cannot correlate a member's locker history at all.
  Three facts from the measurement stay load-bearing and are asserted by
  `src/lib/__tests__/audit-writer-census.test.ts` rather than restated as
  prose: no member-invisible category routes to the membership correlation
  domain in today's taxonomy (pinned as an empty set, so a taxonomy change that
  reopens the question fails by name); the only migration ever to rewrite a
  stored `AuditLog.category` is #2751's backfill, which is why any future
  category here must not reuse the stored string `membership`; and the four
  writers reach the acting officer's own member timeline through the
  null-subject `memberId` leg, so every member-visible destination is a
  widening reserved to the owner (`INV-PRIV-012`, `INV-OPS-012`). The full
  reasoning, options and costs: #2777.
- **While any writer pinned in that map stays `admin`, both correlation tools'
  evidence scope must keep NAMING its subsystem.** The cost of the keep is a
  silent absence: a Lodge correlation entry that returns nothing to "when was
  this lodge deactivated?" reads as evidence that nothing happened. The Lodge
  entry's `scope` and `description` and the System entry's `scope` therefore
  name chores, lockers, work parties, lodge instructions, lodge settings, the
  `LODGE_*` records and the other-lodges registry as `admin`, so an empty
  answer reads as a **known gap**. A scope string that stops naming this set —
  or that starts implying completeness — is a defect of the same kind as the
  mis-classification, in the opposite direction. **Pinned, not left to a
  reviewer:** `src/lib/diagnostics/tools/packs/__tests__/support-correlation.test.ts`
  asserts all three strings name every subsystem in the set, so a copy-edit
  that drops one fails by name. The population here is three string literals in
  one file, which is why this half is pinned rather than reviewer-enforced like
  the 369 unpinned write sites in `INV-OPS-012`.

## INV-PRIV-014

What an AI Diagnostics question sends to the third-party AI model provider from
the operator's own screen, and which controls do — and do not — govern it. Owner
decision of 13 August 2026 (#2816). The two per-question consent ticks are NOT
the gate on the page's view state: a Diagnostics operator's **applied page
filters and typed free-text search travel to the provider on every Diagnostics
question, ungated by either tick**.

- **What leaves, and when.** The page's *applied* view state — its allowlisted
  `tab`/`step`/`status`/`errorCode` tokens and its allowlisted filter values,
  **including anything typed into a search box** — is re-emitted to the provider
  as the "operator selection" span of the page-context evidence block on **every**
  question the operator sends. It is not the address bar but the values that
  actually reached the page's own query (post-parse, defaults included); the
  mechanism is the page-context plumbing documented in
  [`docs/ai-diagnostics/page-context.md`](../ai-diagnostics/page-context.md#where-the-view-state-comes-from)
  and [`docs/ai-diagnostics/ux.md`](../ai-diagnostics/ux.md). The chokepoint is
  the ask route (`src/app/api/admin/ai-diagnostics/ask/route.ts`): it narrows the
  client's raw view to the matched registry row's allowlists and builds the
  selector's five view fields **without reference to either tick**, the resolver's
  `buildSelection` (`src/lib/diagnostics/page-context/resolve.ts`) echoes that view
  independent of `includeSensitiveRecord`, and the rendered block is pushed into
  the first user turn sent to the provider by the answer loop
  (`src/lib/diagnostics/answer/loop.ts`).

- **The two ticks govern a different boundary.** The **record-details tick**
  (`allowRecordPersonalDetails` → the selector's `includeSensitiveRecord`) governs
  whether the identifying fields of the one selected record are re-read and
  disclosed; the **people-search tick** (`allowPeopleSearch`) governs whether the
  answer loop's tools may search for people and records. Neither governs the
  page-filter/search view context. A control sitting directly above something it
  does not govern would be read as governing it, so the operator disclosure beside
  the question box states plainly that the filters and typed search travel with the
  question and "the boxes above do not affect that".

- **Pinned, not left to a reviewer.**
  `src/app/api/admin/ai-diagnostics/ask/__tests__/view-context-ungated-by-consent.test.ts`
  drives the real page-context pipeline (route → resolve → render → the block
  handed to the answer loop) across the full tick matrix and fails, naming this
  id, if a typed search value or an applied status stops reaching the provider
  when a tick is off — or if either tick starts gating it. The same guard pins the
  governed boundary in contrast: the record's personal-detail disclosure line
  flips with the record tick while the view lines do not.

## INV-PRIV-015

A hut leader's PIN session on a shared lodge device is bounded by **inactivity**,
not by a shift. Owner decision of 1 September 2026 (#3228). Before it, one PIN
entry left a wall tablet showing a hut leader's view for **twelve hours**, to
whoever walked up to it, with nothing in the tree able to clear the cookie.

- **The window is ten minutes of a PERSON, and the distinction is the rule.** The
  deadline moves only on `pointerdown`, `keydown`, `touchstart` or `wheel`, and
  never on the page's own traffic. The kiosk refreshes itself, so a deadline that
  slid on any request would let an untouched tablet keep its own session alive
  for ever — which is the exact exposure this rule exists to close. `scroll` is
  excluded deliberately: a programmatic scroll is still `isTrusted`, so a future
  auto-scroll would read as a person.
- **The deadline is the server's, inside the signed payload.** Renewal is a
  request for a new cookie the server mints from its own clock, granted only to
  a session that is still valid. A client cannot edit, replay past, or assert its
  way through it, and a device that is switched off, offline or simply untouched
  lapses on its own.
- **Renewal is mounted where the authority applies, not on one page.** The PIN
  grants privilege across the kiosk *and* the roster wizard, and the wizard is
  reached by a full navigation. Mounting the listeners on the kiosk alone made
  the roster — the longest hut-leader task there is — the one screen that could
  not renew, and a timeout there destroyed unsaved work. One provider, mounted
  from the layout both pages share.
- **Twelve hours remains the absolute ceiling.** `iat` is carried and renewal is
  refused past `iat + 12h`, so an idle window cannot be walked forward
  indefinitely — which is also what bounds a session held open by OS-injected
  taps or a failing digitiser rather than by a person.
- **Lock clears the cookie in the responding browser and does NOT revoke
  server-side.** There is no session record to revoke against, so a copy taken
  before the lock survives to its own deadline. Stated here because the operator
  guide's "the tablet is an ordinary screen again immediately" is true of the
  tablet and not of the session.

**Id sequencing, and it is deliberate rather than an accident.** This rule was
written against `main`, whose highest `INV-PRIV` was 014. Epic #2943's kiosk
child (#3040) independently took **015** on `epic/2943-group-trip-hosting`, and
dense numbering permits no third option on either base. So whichever reaches
`main` second renumbers to **016** — including its `docs/DOMAIN_INVARIANTS.md`
row and every citation, because a stale citation still *resolves*, to the other
rule, and would hand a reader the wrong invariant while the index check stays
green.

## INV-PRIV-016

What the lodge kiosk may say about a Group Trip, and to whom (#3040, epic
#2943). Once separate bookings can share adult supervision (#3038) the kiosk
holds relationship information it never held before, and most of it belongs to
somebody else's account. The disclosure splits in three, and the split is
enforced by what the server BUILDS rather than by what a component renders.

- **Ordinary staying-guest tier: linkage only.** Anyone the kiosk shows the day
  list to may learn that two cards in front of them belong to one Group Trip.
  They may not learn who organised it, which booking or adult supplies the adult
  cover, or the group's join code. `KioskGroupTripLabel` is that tier's whole
  disclosure: a **1-based ordinal assigned per response**, in order of first
  appearance among the visible cards, emitted only where at least two visible
  cards share a trip. It is deliberately NOT `GroupBooking.id` — a durable
  container id is a handle a guest could carry to another surface and correlate
  across days, while the ordinal is meaningless outside the one response that
  built it. There is no id field to leak, which is `INV-SSOT`'s "unrepresentable
  beats policed" applied to a privacy boundary.

- **The linkage badge is NOT gated on the club's shared-cover option** (owner
  decision D1 on #3040, 1 Sep 2026). It appears wherever a club uses group
  bookings, whether or not `SAME_GROUP_TRIP` cover is switched on. The first
  build of this surface gated the whole kiosk — badge included — on the club's
  resolved `SAME_GROUP_TRIP` scope plus an active hosting mode, reading the
  epic's "clubs that leave the option OFF see no behaviour change" as binding on
  the badge too. It is not: group containers predate that scope (#796), and the
  badge says only "these guests arrived together", so making a roster label
  conditional on an unrelated adult-supervision setting is arbitrary. **The cost
  was accepted knowingly**: the "byte-identical payload when the option is off"
  property is gone, and a club that enabled nothing sees a new label after an
  upgrade. What survives is most of the cheapness — linkage is resolved from the
  identity relations the caller already selected with the booking, so an ordinary
  viewer's response issues **no extra query on a day list with no #738 split
  child on it, and exactly one bounded, indexed query when there is one**. Be
  precise about that second half: an earlier round of this work claimed zero
  unconditionally, and the claim was wrong twice over — a split child is created
  for ANY party mixing member and non-member guests, which is precisely the
  population the adult-supervision rule targets, and the identity read was then
  issued once per card. `readInheritedSplitPairGroupTrips` answers the whole day
  list in one read over already-loaded ids, which is what the issue's data
  contract asks for. Each tier now answers from its own data: linkage from group
  membership, organiser and cover source from their own capability, and cover
  source additionally from whether a hosting requirement exists to report
  (`INV-HOST-045`). Do not reinstate the gate; the tests that pinned the old
  behaviour were rewritten to pin this one, in both suites named below.

- **Two privileged capabilities, granted and consulted separately.**
  `kioskGroupTripCapabilities` (`src/lib/kiosk-access.ts`) is the ONE definition
  of who holds them, and the guest-list route asks it rather than restating the
  tier test. `organiser` gates the organiser's display name and which card is
  theirs; `coverSource` gates the canonical cover evidence (`INV-HOST-045`).
  They are two booleans gating two payload keys and two database reads, and they
  may not be collapsed into one flag however identical today's holders are —
  collapsing them makes granting one without the other impossible later. Both are
  held by `admin` and `hut-leader` only: deliberately the same tiers as
  `canManageRoster`, the narrower of the two capability sets that module already
  grants, and NOT the wider `canMarkAttendance` set that includes `lodge`,
  because a lodge wall device is shared and often unattended, and disclosure to
  an unattended screen is disclosure to everybody in the room. That "deliberately
  the same tiers" is a claim a test now checks across all five tiers, against
  `kioskTierManagesRoster` — the two stay separate expressions, so granting cover
  source to a non-roster tier later stays possible, but they cannot drift apart
  unnoticed. **The `/api/lodge/access` response does NOT report the two
  capabilities.** It briefly did; no client read them, and a flag telling a
  browser which keys it was not sent is one more place for the disclosure rule to
  drift from its definition, so the server simply omits what a viewer may not
  have.

- **Both privileged lines belong to a GROUP card.** The organiser line and the
  cover line are attached only where the booking has canonical Group Trip
  identity. #3040 opened the Group Trip surface and that is its boundary; a card
  in no group gets neither. The cover line was briefly attached to every card on
  the day list, which both went wider than owner decision D1 accepted and put the
  cover line's amber states on every ungrouped booking. Adult cover for an
  ungrouped booking is the admin review queue's job, not the kiosk's.

- **An absent capability means an ABSENT KEY, not a hidden one.** "Send the full
  Group Trip object and hide the private fields in JSX" was rejected by name.
  This is a Next.js application: anything reachable from a client component's
  props or an RSC flight payload is readable in the browser whether it is
  rendered or not. So the builder spreads only the permitted keys — there is no
  `null`, no empty string and no disabled flag — and the field name cannot appear
  in the serialized response at all. The reads are gated too: with `organiser`
  false no `GroupBooking` row is fetched, and with `coverSource` false neither
  the hosting policy nor a staleness signal is, so a capability nobody holds
  costs no query and has nothing to leak. The capability is tested BEFORE the
  policy read for that reason. **Nor through a tooltip or an accessible name:** the kiosk
  Group Trip card carries no `title`, `aria-label` or `data-*` attribute at all,
  because a screen-reader label is as readable as body text and gets less review.

- **`joinCode` is selected by no tier, in no query, in no DTO.**
  `GROUP_TRIP_IDENTITY_SELECT` already refuses it at the identity layer, and no
  kiosk surface names it.

- **The cover source is a CATEGORY, never a person.** The canonical snapshot
  carries the covering members' ids; the kiosk drops them. Which adult, on whose
  account, is supplying supervision is not a kiosk question, and naming them
  would disclose another account's participant to a screen the whole lodge reads.

- **Owner decision D1 on #3038 is NOT imported here.** That decision deliberately
  keeps the per-night cover CATEGORY in the member-facing booking-refusal body, on
  the reasoning that a member who has to fix the problem deserves the fullest
  explanation. It was about the refusal — addressed to the one member whose
  booking is affected — and the epic's kiosk contract is stricter: the ordinary
  kiosk tier sees linkage only. The two are not in conflict and the refusal's
  reasoning does not travel to a shared screen.

- **"The wall device is an ordinary viewer" is true of the ACCOUNT, not of the
  device.** A lodge account with no PIN session is the `lodge` tier and gets
  linkage only. But `checkLodgeAuth` returns the `hut-leader` tier for that same
  account while a hut leader's PIN session is active on it
  (`src/lib/lodge-auth.ts`), so during that session the wall device shows both
  privileged lines to whoever is standing in front of it. That is the intended
  behaviour — the leader signed in to do exactly this work — and it is why the
  PIN session's lifetime is a disclosure control rather than a convenience
  setting. Do not read the operator guide's sentence about the kiosk account as
  "the wall device never shows this"; how long such a session stays open is being
  settled on its own branch, outside this issue.

- **Withholding the Group Trip fields must never withhold the ROSTER.** The
  enrichment runs on an unattended wall tablet, on the one screen a hut leader
  uses to know who is in the building, and three of its reads were new to the
  ordinary tier. A database error in any of them is caught: the cards are
  returned exactly as they arrived, with no Group Trip fields at all, and the
  error is logged. A transient failure that blanks the day list for every tier is
  a worse outcome than a missing chip, and "fails closed" has to mean both
  halves.

- **Pinned, not left to a reviewer.**
  `src/lib/__tests__/kiosk-group-trip-privacy.test.ts` drives all four capability
  combinations and asserts on `JSON.stringify` of the built payload;
  `src/app/api/lodge/guests/[date]/__tests__/group-trip-tiers.test.ts` does the
  same on the route's real JSON body, once per tier; and a source fence fails any
  kiosk surface that names `joinCode`, resolves group identity without the
  canonical helpers, restates the tier test instead of asking for the
  capabilities, or puts a value in a `title` / `aria-label` / `data-*` attribute.
  Every one of those assertions names this id.

## INV-PRIV-017

What one member may learn about another from the lodge roster (#2942).

- **Off unless the club turns it on.** `memberLodgeRoster` defaults false;
  while false the page is Not Found and no roster row is read.
- **Names and nights only**, today through `ROSTER_WINDOW_DAYS` nights from
  `clubTime()`. No history, nothing that widens it.
- **Only lodges the viewer could already book**, resolved BEFORE any booking
  row is selected. A listing omits what they may not see rather than refusing.
- **A withheld field is an ABSENT KEY**, never a hidden one — no null, no empty
  string, nothing in a `title`, `aria-label` or `data-*`. The select's whole key
  set is pinned, because no denylist can safely forbid a bare `id`. No per-night
  occupancy total is returned.
- **Consulting is not disclosing.** `wholeLodgeHold` (is a party listed?) and
  a guest's `memberId` (is this guest the custodian?) are read and never reach
  the payload.
- **Whose name may appear.** Individual names only where
  `namesAllowedForBooking` allows, reduced by `reduceName` at
  `Lodge.rosterNameGranularity` (null means `FULL_NAME`, decision D2 —
  deliberately not the lobby display's default). A booking containing a minor
  names NOBODY in it, judged over the whole booking rather than the nights on
  screen.
- **No per-member opt-out** (decision D3); the module default and the dial
  bound that.
- **A custodian is SHOWN, not concealed** (owner decision, 15 Sep 2026):
  concealment made them the unexplained difference between two screens. A
  custodian who also books is listed once, as custodian, on their custodian
  nights (13 Oct 2026). A minor custodian is never named, and naming is
  all-or-nothing, so nobody is identified by elimination.
- **Held nights are SHOWN** (owner decision, 6 Oct 2026, #3474), via
  `getLodgeHeldNights`, as "reserved for a private booking"; the party gets no
  row, neither named nor counted. Reverses ADR-001 decision 6, roster only.
- Pinned by `src/lib/__tests__/member-lodge-roster-privacy.test.ts`.

## INV-PRIV-018

What a member reads of an audit row's FREE TEXT is a property of the event,
declared where the row is written and denied when nothing is declared. Owner
decision, 9 August 2026 (#2695). Reasoning: `src/lib/audit-member-disclosure.ts`.

- **A site declares, or the member reads nothing.**
  `memberDisclosure: { visibility: "member-facing", text }` or
  `{ visibility: "internal" }`. Both member-facing audit channels — the member
  timeline and `/api/member/data-export` — show that sentence or nothing, and
  neither reads `details`, `metadata` or either's shape.
  Omitting it means internal, so no writer can publish by forgetting.
- **The sentence is neither forgeable nor droppable.** One reserved `metadata`
  key `src/lib/audit.ts` owns: stripped from caller metadata, re-attached only
  from a declaration, after the payload is sanitised. So the metadata budget
  bounds the CALLER'S payload, not the stored column, which a sentence can
  exceed by the free-text limit.
- **Two things a member reads off a row are NOT this rule's.** The `summary`
  column: the short title on every row, derived from the row's columns and
  sanitised like `details` — denying its 188 writers is a readership change
  reserved to the owner. And the booking page's replay of two payment-failure
  `details` to the booking's own member, gated by `buildBookingHistoryItems`'s
  required audience argument (#3232 D4).
- **Adding a member-facing site widens member readership and is the owner's
  (`INV-PRIV-012`); removing one is not.** The six are pinned in
  `MEMBER_FACING_AUDIT_WRITERS_2695`. This decides TEXT; the category still
  decides whether the row reaches a timeline at all.
- **It reclassifies nothing**, so `INV-OPS-012` owes no backfill — and the cost
  falls both ways. A pre-release row declares nothing, so a member loses an older
  officer note — the point — and an older credit adjustment's recorded reason,
  which is not. Nothing is altered; a backfill would publish undeclared text, so
  it is the owner's call.

## INV-PRIV-019

An audit row's SUBJECT is a person. Where a booking is owned by an
organisation, the row records no subject member, and the booking carries the
identity through `entityType`/`entityId`. Decided on #3368 (stage 3 of
programme #2912) rather than left for stage 4 to settle by whatever a null
does.

- **`subjectMemberId` means "whose personal history is this?"** — it is what
  decides whether a row reaches a member's own timeline. An organisation has no
  timeline, no sign-in and no personal history, so putting its id there would be
  a category error before it was a privacy one.
- **Nothing is lost by leaving it unset.** Every one of these rows already
  carries the booking on `entityType: "Booking"` with its `entityId`, which is
  what an officer reads the row by, and a school's bookings are reachable
  through the organisation.
- **It widens no readership**, so `INV-PRIV-012` is untouched: a row with no
  subject member reaches strictly fewer member timelines, never more. The
  category still decides whether the row reaches a timeline at all.
- **It moves no row already written** (`INV-OPS-012`). Today every booking has a
  member and every such row has its subject; this rule governs only rows a
  future organisation-owned booking writes. No backfill is owed and no member's
  view of their own history changes.
- **The alternative was recording the school's invented member.** That member is
  exactly what stage 4 removes, so the subject would have pointed at a record
  nobody can sign in as and nobody is keeping.

## INV-PRIV-020

Every mutation of the encrypted integration-credential store names its writer,
and the writer is a person or a NAMED background actor, never an absence.
Decided on [#2723](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2723);
since [#3454](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3454)
the store holds the Xero OAuth token set. The two-factor secret and recovery
codes (`two-factor-audit.ts`) take bullets 1, 3, 5 and 6 (no expectation; members
act only on their own), and 2 for a job's write: `TWO_FACTOR_SYSTEM_ACTORS`.

1. **`actor` is a required argument on every mutator**, so a write with no
   attribution does not compile.
2. **A system write NAMES itself** from the closed `CREDENTIAL_SYSTEM_ACTORS`
   list. `assertCredentialActor` is the runtime half; an `admin` actor carries
   a non-empty member id.
3. **The secret and its audit row are ONE local transaction**, on the same
   client. A change caused by another (the Xero verify-reset) joins that
   write's transaction and names it as `cause`.
4. **A stale write LOSES.** Every set and delete declares what it expected, and
   a compare-and-set claims the exact `(ciphertext, iv, authTag)` tuple it
   read. A loser changes nothing and records nothing.
5. **A read records nothing**, nor does a delete matching no row or an
   unchanged freshness marker.
6. **No plaintext reaches audit, log or error output.** The payload type has no
   field a value fits into, and the store calls no logger (`INV-PRIV-011`).
7. **The proof is mechanical, over every DIRECT CALL.**
   `credential-actor-census.test.ts` walks the tree, and treats every `XeroToken`
   write as a bypass; `two-factor-secret-census.test.ts`
   pins every second-factor writer, nested relation writes included; its
   docblock lists the shapes no walk sees (spreads, computed keys, raw SQL). Scanner tests prove seeded bypasses are
   reported. A wrapper hides its callers soundly: it requires an actor.

## INV-PRIV-021

Issue-report screenshot PIXELS taken by a reporter who held admin access are
Full-Admin-only. The report's text and diagnostics keep the ordinary
`support:view` model, because `support` is a separate permission area from
`membership` and an image otherwise carries member records across that boundary.
Decided on [#2703](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2703).

- **Origin is DERIVED SERVER-SIDE AT CREATION and persisted** on
  `IssueReport.screenshotOrigin`, from the reporter's own stored access roles
  and signed session. The posted `pageUrl`, route-to-permission reconstruction,
  DOM masking, signed claimed URLs, reporter-permission replay and caller flags
  are each explicitly not authority, so forging a page address cannot move the
  classification.
- **NULL fails closed.** A row written before the column existed is read as
  admin-origin. There is no backfill; the 30-day retention sweep drains that
  population.
- **Every read path takes the same gate** — the list flag, the detail read and
  the action reply — so no payload announces or serves pixels its caller cannot
  open. A caller not admitted sees an authorised-withheld state carrying no
  pixels and nothing describing the image.
- **Full Admin means the `ADMIN` role**, read off the DB-verified roles the
  admin guard returns, never a JWT claim.
- **Deleting stays `support:edit`**: deletion shrinks the exposure, so gating it
  would keep pixels alive longer.
- **The audit distinguishes the outcomes** — viewed, withheld, expired, deleted
  — and records nothing captured. Each time an officer OPENS a report and is
  refused, a `privacy` row records the refusal; an action reply is not a view
  and is not audited as one.
- One home, `src/lib/issue-report-screenshot-access.ts`; proof in
  `issue-report-admin-origin-screenshots.test.ts`.

## INV-PRIV-022

Dietary/allergy information — the profile's `Member.dietaryRequirements`
(#2941) and each stay's `BookingGuest.dietaryRequirements` (#3029) — is ABSENT
unless `src/lib/member-dietary.ts` selects it for a grant holder.
Decisions: 20 Sep 2026 on
[#2941](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2941); the
[#3029](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3029) body.

- **Absent by construction.** Every application Prisma client omits both columns
  (`PRISMA_CLIENT_GLOBAL_OMIT`). The write half
  (`member-dietary-booking-writes.ts`) mints no grant; its fence is its closed
  importer list, and its fragment builders, which return the plain value, may
  appear only as a spread operand.
- **Profile audiences:** the subject (profile, onboarding) while ON; their own
  data export, ON or OFF; a DB-verified `membership` admin while ON; a Full
  Admin merge.
- **Booking audiences:** a DB-verified `bookings:view` admin (`bookings:edit` to
  change one row) and the kiosk's `admin` and `hut-leader` tiers, for that
  lodge's present guests that day, both while ON; the subject's export, for
  their own rows. So an admin who adds a member as a guest sees that member's
  current profile value there, audited. Grants never cross profile and booking.
- **Everyone else is denied, absent from the payload:** members (own booking,
  linked guests, the #2942 roster), family, other kiosk tiers and preview,
  rosters, the lobby, exports, reports, Xero, Stripe, analytics, notifications,
  logs and raw audit metadata.
- **OFF hides, never clears.** Only the export grant is issued; writers write
  nothing new. Default OFF, including on a read failure.
- **One shape.** Trimmed, blank null, at most 500 characters.
- **Records say THAT, never WHAT.** Audit rows name the field; the log redactor
  and audit sanitizer strip `dietary`/`allerg` values.
- **Merge fills if blank.** **Erasure clears** the profile and the subject's
  guest rows.
- Proof: `member-dietary-access-census.test.ts`, a text scan (no data-flow
  tracing), plus privacy, kiosk, route and real-database tests.
