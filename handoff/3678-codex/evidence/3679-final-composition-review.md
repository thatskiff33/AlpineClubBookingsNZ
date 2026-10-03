# Final composition review, lens 1

Reviewed head: `7ce3bb1eaa65e45e32185cefc7af93400ab2d763`.
Comparison base: `0678af38bf5947faca72111fdf4b08af27b75158`.
Worktree: `[dedicated worktree]`.
Mode: independent source review of cross-child composition, not a repeat of the children or an owner approval.

## Finding F1 — Medium: inherited explanations contradict accepted-state ownership

This is a confirmed documentation/source-comment finding; I found no associated executable regression in the inspected paths. It should be corrected in the compose lane before the final handoff because it directs the next writer to undo the composed lifecycle contract.

- `src/lib/booking-request-quotes.ts`, comments immediately after the MODIFY/QUERY request claim (at reviewed head, 1513–1536), describe the fourth writer as deliberately unfenced, excluding only DECLINED/CANCELLED and permitting correction resurrection. The actual branch takes the global lifecycle lock, verifies the loaded version and SENT quote, verifies QUOTE_SENT and no accepted pointer, and claims exactly those request facts (1458–1503). Its quote claim is SENT alone, although the comment describes DRAFT/SENT.
- The acceptance comments (1581–1620) require notIn guards, PRICED re-arming from CONVERTED/APPROVED, and a not-retired quote set. Actual acceptance requires SENT, a live AWAITING_REVIEW hold, QUOTE_SENT, null accepted and converted pointers; it atomically claims ACCEPTED, with no conversion. The already-accepted retry is read-only at 1292–1316. Approval retains the conversion authority.
- `docs/STATE_MACHINES.md`, Public Booking Request Quote Lifecycle, retains historical paragraphs saying the fourth writer is deliberately unfenced, accept-wins first converts a live PENDING booking, and double acceptance re-arms PRICED. A later #3415 update states the new response guard, leaving mutually inconsistent present-tense contracts.
- `docs/invariants/booking-requests.md`, INV-REQ-009, still describes the fourth writer as deliberately left unfenced. INV-REQ-010 also attributes accepted-hold protection to requireRequestHold refusing a requester-accepted hold. Acceptance now retains AWAITING_REVIEW; correction is refused by its request status, generic cancellation checks ACCEPTED under the global lock, and officer decline is permitted to retire that request before releasing its hold. Reconcile that causality without changing behavior.

Provenance: `git blame` shows the disputed comments inherited from main commits `c3c1666ff6`, `b79cc95d9b`, and `314755b560`, while child commits `885a6f7227`/`61b2275676` changed the acceptance and response claims. This is newly stale through composition, rather than a request to remove all historical notes.

Recommended correction: replace these present-tense explanations with the implemented exact SENT/QUOTE_SENT pair, global serialization, atomic ACCEPTED transition, read-only retry, and officer-owned conversion/decline contract. Keep historical rationale only where clearly labelled as superseded.

## Cross-child conclusions

No additional confirmed finding in the inspected executable intersections:

- #3415 acceptance retains the AWAITING_REVIEW hold, writes request/quote acceptance atomically, and does not create a payment or invoke either approval service. Accepted retry is read-only. Cron expiry re-reads both request and quote and requires QUOTE_SENT/SENT with no accepted pointer. Generic no-payment cancellation refuses an ACCEPTED linked request under the global lock.
- #3413/#3794 anonymous adults remain capacity-only rows. Capacity imports one pending-adult counter into the canonical occupancy calculation and excludes the held booking's own reservation term where relevant. Naming acquires global then immutable lodge, re-reads state/version, proves reservation nights, claims before writes, and releases/recreates remaining reservations in that transaction. Partial naming requires old runtimes stopped even when the admission switch is off.
- Naming and later held school approval share `readAcceptedSchoolTerms` and `planAcceptedSchoolHeldPrices`. The plan proves accepted ordinals, unique name/tier mappings, member links, complete half-open nights, and refuses NULL night prices. Approval reorders guest plans by proved held guest IDs before the common reassignment writer; accepted unequal cents survive the request-order insertion of newly named adults. Naming preserves existing night IDs; approval's common reassignment intentionally rebuilds night rows while retaining guest IDs and bed keys. No duplicate accepted-party authority found.
- Member identity refusal uses canonical seasonal membership policies as well as canLogin. A nonlogin MEMBER_RATE identity cannot be silently named as a nonmember; incoming legitimate anonymous adults have no member identity or consent record.
- #3416 samples one booking-policy setting before approval's transaction. OFF still creates real teacher contact records and OrganisationContact rows, keeps teacher guests, and reconciles the organisation using contact IDs independently of assignments; assignment/PIN generation and PIN mail are conditional. ON assignments carry SCHOOL_BOOKING source, concrete lodge, and no bedId. Neither policy setting changes the guest ADULT tier or consent; main's canonical adult-supervision predicate remains based on operational presence, not a hut-leader assignment. No duplicate supervision rule added by this composition.
- #3414 MoneyInput uses canonical unsigned/signed exact parsers for stepping, preserves caller-owned invalid draft text, and delegates save validation to callers. The shared officer quote panel validates through parseDecimalDollarsToCents before fetch; accepted state exposes naming plus approve/decline, and approval is disabled with pending adults. No MoneyInput conversion or invented zero in the inspected shared path.

## Scoped source and evidence

Inspected integration deltas/source: booking-request-quotes, booking-request, school-booking-request, booking-request-corrections, booking-request-pending-adult-reservations, school-pending-adult-resolution, school-pending-adult-price-plan, pending-school-adults-gate, capacity, booking-cancel, cron-quote-expiry-reminders, booking-request-shared, adult-supervision, MoneyInput and canonical money parsers, officer request panel, and admin request approval route.

Read regression witnesses (not executed by this reviewer): school-pending-adult-resolution unit/realdb tests, school-booking-request policy/consent tests, pending-school-adults-gate tests. The disposable PostgreSQL witness explicitly checks unequal per-person cents and original guest IDs through partial naming and approval, with linked-child consent/dietary fields, as well as night-ID preservation during naming and statement grouping over different stay lengths.

Policy context consulted: AGENTS.md, DOMAIN_INVARIANTS index; relevant sections of money, capacity/dates, booking requests, operations/locking, single-source-of-truth, state machines, capacity model, testing, and ISSUE_WORKFLOW final-composition contract. Root-provided thread captures for #3678, #3679, and #3794 were treated as task data, with rules and code verified in the pinned source tree.

## Limits

- Source review only: no installs, tests, full suite, browser/server, credentials, production data, or provider calls. Root's reported PASS counts and CI state were not independently reproduced and are not this review's test evidence.
- Did not repeat the entire epic diff or child reviews; did not independently re-review all migrations, Xero/provider paths, UI caller migrations, security changes, or every conflict resolution. Those remain with child evidence, the other compose lens, and root's main-sync reviews.
- The routed-document consultation was scoped to these reviewed intersections; this report does not certify full-document re-reading of every route applicable to the entire epic.
- F1 remains open at this reviewed SHA. Any correction must receive delta review; this report approves neither a subsequent head nor a merge.

