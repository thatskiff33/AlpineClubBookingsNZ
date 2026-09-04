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
  occupation; email; phone; credentials including hashed and second-factor ones;
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
  "who" has to be legible to the officer reviewing it; this schema holds no
  special-category data (a check across all 172 models found no medical,
  dietary, emergency-contact, next-of-kin or ethnicity field), and the file's own
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
category is a **permission decision written at the moment of the write**: it
picks which AI Diagnostics correlation entry can return the row, therefore which
admin areas an operator must hold, and — separately — whether the subject member
sees the row on their own activity timeline. It is stored on the row and never
recomputed at read time, so **changing the code changes only the rows written
afterwards**: the rows already written keep the superseded value, and a
classification decision therefore binds the club's history from that release
onward *until a backfill moves them*. **Moving them is not optional to decide in
silence — `INV-OPS-012` ([`operations.md`](operations.md)) requires the
reclassifying pull request to ship that backfill or file it as an issue, never
neither and never as prose.** Its one carve-out is the boundary the second bullet
below draws: a backfill that would cross the member-visible line in either
direction is the owner's decision rather than an automatic consequence, which is
why #2751's bed-allocation rows were rewritten (both categories member-invisible)
and #2763's bulk member-record rows were not.

- **Category follows the business domain affected. Never the initiator, never the
  route, and never the screen.** This is the owner's binding rule from #2581, and
  the two failures it exists to forbid have both happened here. The member-photo
  writers once read `category: actor.onBehalf ? "admin" : "account"` — the same
  act on the same record filed in two categories, read by two permission sets,
  according to who acted. And an officer editing a member's record was filed
  three ways according to which SCREEN they opened: `admin` from the member
  detail page, `account` and `security` from the bulk screen (#2755). One act
  filed several ways means a category-scoped reader is shown a fraction of the
  picture with nothing to tell them so. **Pass a literal category at each write
  site.** A conditional between literals is banned outright — the census contract
  pins zero of them — because that is the shape the actor-based defect took; where
  a site genuinely serves two domains, split it into two calls with two literals.
- **The member-visible set is a separate, explicit declaration — never a
  by-product of choosing a category.** `MEMBER_VISIBLE_AUDIT_CATEGORIES` in
  `src/lib/audit-query.ts` is a reviewed subset, deliberately hand-listed rather
  than derived, so adding a category to the canonical taxonomy cannot publish it
  to members as a side effect. Re-classifying an existing writer still can, and
  that is the crossing to argue for explicitly.
  **The test for whether a re-classification crosses that boundary is
  `buildMemberAuditLogWhere`, not the presence of a subject.** A row reaches the
  subject member's own timeline if it passes `subjectMemberId` for them, **or**
  leaves `subjectMemberId` null while passing `targetId`, `memberId` or
  `actorMemberId` for them — four legs, pinned in `src/lib/__tests__/audit.test.ts`.
  So a writer that passes no subject at all still reaches a member, which is
  precisely the case at the two bulk writers below; "it has no subject member" is
  not a reason to treat a move into `account`, `booking`, `payment`, `family`,
  `security`, `communication` or `privacy` as invisible.
  **Whether a member should see a given event is meant to be declared per event at
  the writing site and denied by default — that is DECIDED (#2695, 9 Aug 2026) and
  NOT YET BUILT.** No such mechanism exists in the tree today: member visibility is
  entirely a function of the category, so until #2695 lands the category is the
  only lever there is, and an event withdrawn by a re-classification has no
  declaration path in the meantime. Do not reach for a member-visible category in
  order to achieve visibility, and do not accept one as the price of tidying
  labels: audit rows are append-only, so publishing administrative activity to
  members cannot be quietly undone.
- **A ROW'S STORED `details` CAN BE READ SOMEWHERE OTHER THAN THE AUDIT LOG, AND
  THAT SECOND DOOR IS ITS OWN DECIDED READERSHIP** (#3232 D4, owner, 4 September
  2026). The category answers "who finds this row in the Audit Log, and does the
  subject member see it on their timeline". It does not answer "who can read the
  words in it", because a domain page may render an audit row's free text as part
  of the record it is about, under that page's own permission. The first such
  surface is the booking page: the two hosting-coverage incident actions
  (`booking.hostingCoverage.incidentOpened` / `.incidentUpdated`) are `admin` —
  Support only in the Audit Log — and their `details` is shown on the booking to
  anyone holding `bookings:edit`, which the page computes as `canSeeAdminTools`.
  The owner chose that over the narrower option of showing only the member's own
  recorded decision, because an officer following the queue's **Review booking**
  button must be able to see why a booking is flagged; the stated cost is that the
  text can be an officer's private override reason and a Booking Officer who could
  not find the row in the Audit Log can read it here. **Three things follow, and
  they bind the next such surface as much as this one.** The readership is
  DECIDED and WRITTEN DOWN, here and in
  [`guides/audit-log.md`](../guides/audit-log.md), rather than inferred from
  whatever query a page happens to run. It is enforced where it cannot be lost by
  editing that query: `buildBookingHistoryItems` takes a REQUIRED audience and
  drops the rows for a member, so the page's own gate is defence in depth rather
  than the only lock — a source-shaped guard on the query alone was measured to
  pass with the gate deleted and the word left in a comment. And the booking's own
  member is never a reader: this widens who may read the text sideways, never
  downwards.
- **All three writers of the SIX MEMBER-RECORD ACTIONS file `admin`, and the join
  is `admin` for that reason** (#2755). The six are `admin.member.updated` /
  `.deactivated` / `.reactivated` from the member detail page
  (`src/lib/admin-member-detail-service.ts`) and `member.bulk-set-role` /
  `member.bulk-deactivate` / `member.bulk-reactivate` from the bulk screen
  (`src/app/api/admin/members/bulk-update/route.ts`) — editing a member's fields,
  activating, deactivating, or changing what they may do. That is one business
  domain, the administration of that record, however many screens reach it. All
  three rows reach the subject member's own timeline (the detail writer by subject,
  the two bulk writers by the null-subject `targetId` leg), so unifying on either
  member-visible category the bulk screen used would have published an officer's
  edits to the member concerned. **The cost of choosing `admin` is stated rather
  than glossed, because this narrows in two directions at once:** the subject
  member no longer sees a bulk deactivation or bulk role change of their own
  account (they already saw nothing when an officer did the same thing from the
  member page, so the outcome is uniform invisibility rather than visibility
  decided by screen), and the two rows move from `support` + `membership` to
  `support` alone, so a support-only operator gains them — which is the gate the
  member-page equivalent has always answered to. Retention does not move: all six
  actions classify `critical` under the old and the new value alike. Rows already
  written keep their stored category, so nothing is withdrawn from a member who has
  already seen it, and bulk member-record history is split by date the way
  bed-allocation history was; the two backfills are separate questions and separate
  issues, because #2751's bed-allocation rows move between two member-invisible
  categories while these rows are member-visible today, so rewriting them would
  **withdraw** something a member can see (#2763). #2751's backfill has since
  shipped and closed its half of the split; #2763's is still open, and that
  asymmetry is the reason `INV-OPS-012` — which requires a reclassification to ship
  its backfill or file one — carves the member-visible boundary out as an owner
  decision rather than an automatic consequence.

  **This rule is scoped to those six actions. It is not "an officer acted, so
  `admin`",** and it must never be read that way, because "who acted" is the
  discriminator the first bullet forbids. The discriminator here is the artefact
  and the domain: administering somebody's membership record is `admin`; the
  member's own content and the member's own requests stay in the member's domain
  whoever touched them. Three shipped groups make the boundary concrete, and all
  three are deliberate:
  - **`/api/profile` is not part of the set.** A member editing their own record
    (`member.profile.updated`) files `account` and stays member-visible, because
    its actor IS its subject and there is no on-behalf path. Same fields,
    different business domain: self-service rather than administration. Filing it
    `admin` would hide a member's own action from their own timeline, a narrowing
    in the one direction nobody has argued for.
  - **The member-photo pair stays `account` and stays member-visible even when an
    officer does it for the member** (`member_photo.upload` / `.remove`,
    `src/app/api/members/[id]/photo/route.ts`). This is #2581's own worked example
    — the site that used to read `actor.onBehalf ? "admin" : "account"` — and its
    resolution was `account` unconditionally, on purpose, so the member sees an
    administrator's change to their photo. The artefact is the member's own photo
    whoever uploaded it. Note the coexistence, since it looks like a contradiction
    and is not: the admin member-detail page renders the photo editor in
    `mode="admin"`, so on one screen a field edit files `admin` and a photo change
    files `account`. That is the domain following the artefact rather than the
    screen.
  - **The officer-driven cancellation writers stay `account`**
    (`membership_cancellation.admin_requested`, `.approval_blocked`,
    `.participant_cancelled`, `.participant_rejected`,
    `.confirmation_token_reissued`). The member is party to the decision, usually
    having requested it, so the row belongs on their timeline for the same reason
    their own `membership_cancellation.requested` does.

  All of these are pinned from the tree in
  `OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755`
  (`scripts/audit/audit-writer-census-manifest.ts`), so citing this rule to move
  one of them to `admin` fails CI with the withdrawal named. Moving them is a
  readership change and needs the owner's decision, exactly as this one did — not
  a sweep, and not an inference from a rule that never covered them.
- **#2755 satisfies #2695's acceptance criterion 5 by re-classification, not by
  gating, and that is not the same thing.** #2695 lists `member.bulk-deactivate` —
  whose `details` is the plain sentence `Bulk deactivate: Jane Doe (jane@…)` — as
  one of three writers whose free text reaches a member timeline, and asks for it
  to stop. Filing the writer `admin` does stop it, because the row leaves the
  member-visible query altogether. But the mechanism #2695 is about is untouched:
  `src/lib/audit-query.ts` still returns `details` on a shape test
  (`hasLegacyMetadata ? null : log.details`) rather than an audience test, and
  `member.deletion_rejected` and `member.credit.adjustment.approve` still hand a
  member an administrator's free text. Do not treat that criterion as delivered.
- **Two groups stay `admin` as a recorded decision, not as an unexamined
  default.** #2730 reviewed all 118 writers that said `admin` and moved 22 to
  `lodge`; the rule it actually applied was *did this site split a subsystem* —
  did some other writer of the same objects already answer to a different gate,
  so that no operator could get a complete answer — and **not** *does it name a
  lodge* and **not** *is the route gated `lodge:edit`*. Under that rule these stay:
  - **The fifteen lodge-gated operational sites** — chores (3), lockers (4),
    `LODGE_INSTRUCTION_UPDATED` (2), `LODGE_SETTINGS_UPDATED` (1), the `LODGE_*`
    lodge records themselves — `LODGE_CREATED` and the `LODGE_UPDATED` /
    `LODGE_ACTIVATED` / `LODGE_DEACTIVATED` writer (2) — and work parties (3).
    They pass the surface
    tests — `entityType: "Lodge"` or a `lodge:*` route — but the group is
    **uniform** at `admin`, so moving it would not close a two-gates-for-one-thing
    split; it would open a fresh readership question of its own size, taking
    fifteen sites out of the support-only gate. `LODGE_DISPLAY_CONFIG_UPDATED`
    moved and `LODGE_UPDATED` did not for exactly that reason: the display writer
    had ten siblings already saying `lodge`. The cost of staying is a **silent
    absence** in the Lodge correlation entry, and it is closed rather than
    tolerated: both correlation entries' `scope` and the Lodge entry's
    `description` name this whole set as `admin`, so an empty lodge answer reads
    as a known gap rather than as evidence that nothing happened.
  - **`lockers` (4 of those fifteen) was settled separately (#2777): the four
    stay `admin`.** Its routes are gated `membership:*`, not `lodge:*`, and a
    locker is allocated to a named member, so a revisit of the group must still
    reason about `lockers` on its own terms — the rule, the declined alternative
    and the accepted cost are in `INV-PRIV-013`.

  Moving either group **to `lodge`** would be a **narrowing**, member-invisible in both
  directions and retention-neutral, which makes it a materially easier question
  than any widening — but it is still a readership change, so it needs a decision
  rather than a sweep. **That reading is scoped to `lodge` and does not travel to
  another destination:** for the `lockers` subgroup the membership correlation
  domain is measurably a widening, not a narrowing. The deciding rule and the
  `lockers` settlement are `INV-PRIV-013`;
  `docs/ai-diagnostics/audit-admin-category-review.md`
  carries the per-site verdict for all 118 and the alternative reading for each.

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
  the 307 unpinned write sites in `INV-OPS-012`.

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
