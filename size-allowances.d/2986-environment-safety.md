# File-size allowances for epic #2986 (ENVIRONMENT SAFETY)

**One file for the whole epic, replacing `3034-environment-role.md` and
`3035-delivery-safety.md`.** This is deliberate and it is not the thing
`size-allowances.d/README.md` warns against. That rule — never edit another
change's allowance — exists so two concurrent branches never share a file. It
does not apply here, because #3034, #3035 and #3036 are *one* pull request as far
as `main` is concerned: an epic reaches `main` as a single merge, so the epic is
the change. Three per-child files describing one pull request's growth is the
stored-exception shape the gate was built to remove, and it has a mechanical
failure mode too — the gate enforces "one file, one allowance" across the whole
directory, so the moment a later child grows a file an earlier child already
declared, neither file can be made correct.

**The ratchet judges a pull request against `origin/main`, not against the branch
it targets** (`ci.yml`, `BUDGET_BASE`), so every length below is the file's final
length across all three children — never one child's increment.

**The files this epic actually invents are all well inside budget, and that is the
standard this list should be read against.** #3034: the resolver
(`environment-role.ts`, 435), its pure parser
(`environment-role-declaration.ts`, 143), the browser payload
(`environment-safety-admin-state.ts`, 257), the write path
(`environment-safety-override-write.ts`, 213), the withheld-email count
(`environment-safety-withheld.ts`, 199) and the API route
(`environment-safety/route.ts`, 127 against a 250 route-handler budget). #3035:
the delivery policy (`environment-delivery-policy.ts`, 453), the mailer's half of
the boundary (`email/environment-gate.ts`, 233), the Xero invoice-email wrapper
(`xero-invoice-email.ts`, 196) and the transport module it moved logging into
(`email/internal.ts`, 224). #3036: the policy half of the
containment gate (`xero-contact-containment.ts`, 249), the proof half
(`xero-contact-containment-proof.ts`, 570), the fail-closed write gate
(`xero-environment-write-gate.ts`, 149), the pure address leaf
(`xero-sandbox-contact-email.ts`, 196), the operator count
(`xero-contact-containment-status.ts`, 220) and the operator block it feeds
(`environment-xero-containment.tsx`, 275). Between them those seventeen modules
carry the whole of the new logic, so this feature creates no size debt of its own.

**Two of those files are splits the review round forced, and both were the right
answer rather than a way round the gate.** The containment module reached 785 of
700 once the freshness bound, the monotonicity comment and the non-funnel
invoice-operation gate landed, so it split along the line between a DECISION
(pure, synchronous, database-free once the role is read) and an ACT with provider
and database consequences — `xero-contact-containment.ts` and
`xero-contact-containment-proof.ts`. `environment-safety-panel.tsx` reached 724
of 700 once the Xero block gained its addressable list, and that block is a
separate subject from the rest of the panel: it moved whole into
`environment-xero-containment.tsx`, taking its own types and its census case with
it. Neither file needs an allowance, which is the point.

**Files that came close were COMPACTED rather than allowanced**, because an
allowance is explicitly not available to a file crossing its budget for the first
time. #3034's API route reached 270 of 250 once its review findings were folded
in, so the Serializable transaction and its audit row moved into
`environment-safety-override-write.ts` — the "`src/app` authorises, `src/lib` does
the work" split `docs/ARCHITECTURE.md` asks for anyway. #3035's `email/core.ts`
reached 720 of 700 when the capture-transport log line was added; that line and
its reasoning moved into `email/internal.ts`, the module that owns transports,
leaving the file at 695. `xero-group-settlement-invoices.ts` reached 712 when the
withhold-reason fix landed with its explanation; the explanation moved into
`resolveXeroInvoiceEmailPolicy`'s docblock — where the rule belongs, since it is
about what every caller of that function may report — leaving the file at 696. The
same shared helper is what kept the three invoice workflows out of this list in
the first place.

**`size-allowances.d/3000-club-time-zone.md` was deleted by #3034**, and that was
required rather than tidying: four of its five files are declared here too, and
the gate refuses two allowances for one file. That change's own work merged some
releases ago, so its lengths ARE the lengths on the base ref and its entries had
no remaining effect; `size-allowances.d/README.md` says a merged allowance is
inert and can be swept in bulk.

## #3034 — the environment role

file: src/lib/setup-readiness.ts
lines: 2194
reason: this is where a setup step is defined, and the seventeen already there
  are all in this file and assembled into the readiness report a few lines below
  them — the same argument #3000 made for the club-timezone step, which is the
  immediately preceding precedent. An eighteenth check in its own module would be
  the only one, splitting one contract across two places for the sake of a line
  count. Most of the growth is the wording rather than the logic: five states to
  distinguish, and each one has to say which of the two sources decided the
  answer, because an operator who repairs the wrong variable changes nothing and
  has no way to tell why. APP_RUNTIME_ROLE already exists, sits in the same
  Compose block, differs by one word, and holds the literal value "staging" on
  the staging stack, so every state names both variables explicitly. Review added
  the withheld-email line to the non-production branch — the one signal that
  separates a live club wrongly declared a copy from a copy nobody is using, and
  three renderable states because "none held back" and "not counted yet" look
  identical on a checklist and mean opposite things. A later round rendered that
  line for the UNDECLARED state too, which is the one a live installation reaches
  by upgrading without the declaration. #3035's review round added thirty-five
  more, and they are the fifth state finally getting a branch: a live site that
  ALSO declares a capture mailbox sends nothing at all, and this step used to
  report it "complete — emails go to real members". That branch is a warning with
  its own repair (the transport flags, not the declaration, which is correct
  there), so it cannot share the non-production wording, and it belongs beside the
  other four states of the same check.

file: src/instrumentation.node.ts
lines: 1618
reason: a boot-time advisory has to be at boot, beside the four best-effort
  blocks already there (Sentry, the email-palette prime, the config self-heal,
  the ignored-email-env warning) — it is the fifth of a kind, not a new kind.
  The growth is mostly the comment explaining WHY it sits in the first
  `NEXT_RUNTIME === "nodejs"` block rather than at the end of `register()`: the
  second such block returns early when CRON_ENABLED is false, which is exactly
  what app_blue and app_green set, so an advisory appended at the end of the
  function would never run on the containers that serve traffic. That is a
  measured fact about this file and it belongs in this file. Review added the
  confirmed-copy branch beside the UNKNOWN one, and the measurement behind its
  log LEVEL: at warn, `measurement/current-main-refresh/bin/analyse-log-noise.mjs`
  counts the line eleven times and fails MC-09, because eight of that harness's
  producers recreate the app inside their own log-capture window.

file: src/lib/admin-permissions.ts
lines: 788
reason: the two new prefixes belong in `ROUTE_AREA_PREFIXES` beside the
  `/admin/club-time` and `/admin/backups` entries, which already state the same
  rule this one needs — area registration for the route map, Full Admin enforced
  in the route itself. Splitting that table would put one area's routes away from
  every other area's, which is the drift the route-map guard exists to catch.
  Review corrected the comment: reading the role is available at `support:view`
  through the setup checklist, and only the WRITE is Full-Admin-only, so the
  boundary is now stated as it actually is rather than one tier too narrow.

file: src/lib/member-merge.ts
lines: 3761
reason: twelve lines, and they are the price of the new schema column rather than
  of this feature's logic. `EnvironmentSafetySettings.updatedByMemberId` is an
  FK-less actor column, so `member-merge-dmmf.test.ts` fails until it is
  classified as a merge snapshot; the entry has to sit in that hand-kept list,
  beside the `ClubTimeSettings.updatedByMemberId` it is identical in kind to. The
  comment explains why the loser's id stays as immutable history — the question
  the next reader of that list will have — and why a member merge must not move
  this particular column at all: this row decides whether real members can be
  emailed. #3036 adds nothing here, deliberately: its containment record is keyed
  on the Xero contact and carries no member id at all, so there is no relation for
  this list to classify.

file: src/components/admin-sidebar.tsx
lines: 1101
reason: the whole file is one declarative navigation table, and a menu entry
  cannot live anywhere else. The new item sits beside Access Roles, Export &
  Import and Club Time Zone because it shares their `fullAdminOnly: true` shape;
  the growth is that entry, its search keywords, and the comment saying why the
  page is Full-Admin while its permission area is `support`. The keywords are the
  words an operator would actually type — "staging", "test site", "copy", "live
  site" — none of which the label matches, and the command palette index is built
  from these entries.

## #3035 — the delivery boundary

file: src/lib/payment-link.ts
lines: 1228
reason: forty-eight lines across two sibling guards, and both fix defects rather
  than add features. The fresh-payment-link path ENUMERATED the untransmitted
  mailer outcomes and then returned `{ emailed: true }`, so #3035's new
  environment withhold would have reported a payment link as emailed when nothing
  left the building — and so would the next outcome added after it. The
  split-guest path then bucketed every non-send as `suppressed`, which the route
  turns into a 502 reading "your email address is undeliverable" — shown to a
  MEMBER, on this epic's headline case of a live club upgraded without the
  declaration. Both fixes have to sit beside the guards they complete: lifting
  them out would move the member-facing wording ("we could not email it") away
  from the link-minting it belongs to, and that wording is deliberately identical
  across all three so a member never learns which internal reason applied.

file: src/lib/xero-booking-invoices.ts
lines: 1366
reason: forty-two lines inside the invoice-email block that already holds two
  other non-send decisions — the booking's "No emails" switch and the
  unreadable-switch fault — and the new environment gate has to be read against
  both, because the whole point is that the three stay distinguishable. Splitting
  it would put the third reason in a different file from the two it must not be
  confused with. Most of the growth is the comment: it records that a re-drive
  short-circuits on `payment.xeroInvoiceId` and therefore never resends, so the
  truthful remediation for an unconfirmed role is to declare the role and send
  that one invoice from Xero by hand. The decision logic itself moved OUT, into
  `xero-invoice-email.ts`, which is why the other two invoice workflows grew by a
  handful of lines each and needed no allowance at all.

file: src/lib/booking-request-quotes.ts
lines: 1718
reason: twenty-four lines, all of them a defect fix in the one function that
  reports back to the officer who pressed Send. `sendBookingRequestQuote` treated
  every outcome the mailer RETURNS as a delivery, so an environment withhold gave
  that officer `emailDelivered: true` and wrote an audit row reading "Booking
  request quote sent" — for a quote the requester has never seen, whose response
  token is live in the database. The inspection has to sit where
  `emailDelivered` is computed, because that one variable feeds three things at
  once: the audit row's `outcome`, its summary sentence, and the value returned to
  the route. Splitting it would separate the three consumers of a single fact.

file: src/lib/email/booking.ts
lines: 1431
reason: four lines. `sendPreArrivalReminderEmail` swallowed the mailer's outcome,
  so the pre-arrival cron could not tell a send from a withhold — and that cron
  stamps `preArrivalReminderSentAt` BEFORE sending, with the selecting query
  filtered on that column being null, so the claim was consumed permanently for a
  message that never went. This message carries the lodge's door code and arrival
  instructions. The fix is `await sendEmail(...)` becoming `return sendEmail(...)`
  plus the comment saying why; it belongs in the sender it is about, and the other
  seventeen senders in this file already use the returning form.

## #3036 — Xero contact containment

file: src/lib/xero-contacts.ts
lines: 1876
reason: a hundred and seventy-six lines, and they are the whole reason the twelve document
  writers needed no change at all. `findOrCreateXeroContact` is the single funnel
  every Xero document writer resolves its contact through, so the gate belongs
  INSIDE it — gating the twelve call sites instead would have shipped with the two
  holes the first census of them missed, and would miss the thirteenth writer
  somebody adds next month. Most of the growth is comment, and it is comment that
  has to be here: the largest block explains the steady-state early return, which
  is the exact line a restored copy takes for every member and the reason this
  issue exists, and it can only be understood beside the code that returns from
  it. The three other blocks each sit at the one point they describe — the create
  payload builder, the create-or-match resolution, the contact update — and the
  decision logic itself all moved OUT into `xero-contact-containment.ts` and its
  proof half, plus `xero-sandbox-contact-email.ts`, which is why nothing else in
  the Xero subsystem needed an allowance. The last twenty-three of those lines are the
  review-round fix that wraps `createXeroContactForMember`'s containment in the
  partial-success phase this function already owns: a bare throw there loses the
  created contact id, so the admin route tells the operator nothing was recorded
  and pressing Create again is a dead end — the reservation refuses an
  already-linked member. That wrapper has to sit at the call, because the phase it
  raises is about this function's own commit sequence.

file: src/lib/xero-member-import.ts
lines: 1230
reason: twenty-one lines, and they close the inbound direction of the same rule.
  A contained address is a hash on a reserved domain; a Member created from one
  would read as REACHABLE on every screen — `isPlaceholderContactEmail`
  deliberately says nothing about that domain — while being able to receive
  nothing, which is the silent-unreachability defect #2716 exists to prevent
  arriving from a new direction. The check has to sit in the per-contact loop
  beside the archived-contact and no-address skips it is a sibling of, because
  what an operator reads is one skip report and the three reasons have to be
  tellable apart. Most of the growth is the added `reason` on the skip detail and
  the comment saying why "no email address" would have been a FALSE report here:
  the contact HAS an address, it simply cannot be used.

file: src/lib/xero-api-client.ts
lines: 782
reason: fourteen lines, and they are the difference between a claim and a
  guarantee. Seven operator-facing surfaces of this product asserted that an
  installation nobody has declared writes nothing to Xero, and that was false:
  the contact funnel refused, while every writer that does not go through it
  carried on — the membership-cancellation credit note, contact-group membership
  from `/api/profile`, archiving a contact, voiding an invoice, recording a
  payment, deallocating applied credit, re-pricing a booking invoice. `callXeroApi`
  is the single wrapper every provider call in this subsystem goes through, so the
  refusal belongs there and nowhere else: it has to sit ahead of the retry ladder
  and ahead of the usage row, because nothing was attempted and a refused call
  must not enter the quota ledger. The DECISION it consults is a leaf of its own
  (`xero-environment-write-gate.ts`, 149) precisely so this file gained a call and
  a comment rather than the policy; splitting the retry/metering wrapper itself to
  buy fourteen lines would separate the gate from the one place it must be
  unavoidable.

file: src/lib/membership-cancellation-xero.ts
lines: 1395
reason: twenty-three lines at the fifth credit-note creator — the one the
  original census of this issue got wrong. The other four resolve their contact
  through `findOrCreateXeroContact`, which contains it; this one takes its contact
  from the invoice it is crediting, so on a copy restored from the club's live
  database it raised a credit note against a contact nothing here had ever proved
  contained. The check must sit at this exact point, after the contact is resolved
  and before the credit note is raised, and most of the growth is the comment
  saying why it is not merely a consistency argument: the allocation is sized from
  Xero's `amountDue` read a moment earlier, so a concurrent partial payment or a
  failed allocation leaves the invoice outstanding against that contact, and Xero
  emails its reminders from its own servers with no API call from here. Lifting it
  out would put the reasoning somewhere other than the line it justifies.

file: src/lib/xero-applied-credit-deallocation.ts
lines: 992
reason: fifteen lines at the entry point, before the fence and before any local
  claim, so a refusal leaves nothing half-done. Deallocation REMOVES credit from
  an invoice and therefore raises what is outstanding on it, which is the one
  shape that can re-arm Xero's own reminders to a real member on a copy — and this
  path never touches the contact funnel. The comment is most of it and it has to
  be here: the reason this file needs a containment check at all is a property of
  what deallocation does to an invoice, which is not visible from the shared
  helper it calls. A third review round added twenty-two more: the contact this
  operation is about is the INVOICE's, not the member's — the two differ after a
  member merge or an admin re-link — and this module never reads the invoice, so
  it asks Xero which contact the invoice belongs to. That read is passed as a
  lazily-called function so the club's live site never spends it, and the comment
  carries why the member's link was the wrong contact, because the wrong version
  of this check read as coverage and gave none.

file: src/lib/xero-bulk-contact-sync.ts
lines: 725
reason: twenty lines, and they fix a FALSE operator report rather than adding a
  feature. On a copy every contained contact stops matching a member by email, and
  this file reported those as "No matching member by email" — the identical false
  reason this change fixed on the member-import path, left behind and then
  documented as "unaffected by design". The contact HAS an address; it simply
  cannot be used. The skip has to sit in the per-contact loop beside the reasons it
  is a sibling of, because an operator reads one report and the reasons have to be
  tellable apart, and the comment carries why the obvious wording would be a lie.

file: src/lib/xero-operation-outbox.ts
lines: 2452
reason: twenty-one lines, and twenty of them are comment. The outbox decides
  whether a FAILED operation may go back to PENDING by asking whether the error
  proves nothing was sent, and the environment-role gate added by this epic
  raises exactly such a refusal — pre-HTTP by construction, since the gate sits
  ahead of the retry ladder and the usage meter. Without its name in that
  predicate a refusal took the ordinary path, and twelve of the fifteen handlers
  have already written `status: FAILED` by then, so a whole in-flight cron batch
  was condemned to hand requeues: the exact defect the predicate exists to
  prevent (#2423 F2), reached through the gate added to prevent unattempted
  writes. The name has to be IN the predicate, and the reasoning has to be beside
  it — that function is three lines of condition carrying thirty lines of argument
  about which errors prove what, and a reader who cannot see why a name is in the
  list is a reader who removes it. Splitting a predicate away from the branch that
  consumes it is what made this class of defect possible in the first place.

file: src/app/api/admin/xero/import-member-contact/route.ts
lines: 353
reason: sixteen lines for the same inbound refusal at the single-contact import,
  and this one genuinely belongs in the route. It is a 422 with an
  operator-facing sentence, sitting immediately beside the existing 422 for a
  contact with no address at all — the two refusals are read together and their
  wording has to be read together. Lifting sixteen lines of `NextResponse.json`
  into `src/lib` would move a response shape away from the boundary that owns
  response shapes, to buy a line count on a file whose ceiling this epic did not
  push it past: it was already 337 against a 250 route-handler budget before this
  change.
