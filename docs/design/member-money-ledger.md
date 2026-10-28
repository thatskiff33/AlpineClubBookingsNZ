# Member money ledger — design

Audience: Developer, Agent. The opening section also explains the proposal for
an operator. Canonical home: [contributor documentation](../contributors/README.md).

## 1. Purpose, authority and scope

Members should have one explainable answer to what they owe and what the club
owes them. This design for [#4461](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4461)
extends the [booking ledger](booking-ledger.md) into a balanced journal for all
member money. It changes no code, schema, migration, money policy or deployed
behaviour. Implementation children below are proposals for owner approval;
none is filed by this document.

The settled contract is all member money, optional Xero, two-way sync, and the
ledger switch before individual mirror-drift fixes. Sources are the owner
records on [#4450](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4450)
and [#4461's bank-transfer decision](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4461#issuecomment-6415213385).
Without Xero, the app shows configured club bank details and a unique payment
reference; a finance officer records the receipt. With Xero connected, its
receipt can enter through the same journal command. Bank reconciliation,
sending accounting statements and invoices, GST returns, expenses, payroll and
profit-and-loss stay in Xero. The app still supplies its booking confirmations,
payment instructions and member money views.

This extends #3527/#3532; it does not discard their posted history. The 27 Oct
scope decision supersedes D-3532-4's bookings-only limit, while subscription
charge snapshots remain immutable (`INV-MONEY-008`). D-3532-1's whole-history
proof, D-3532-2's eventual column removal and D-3532-3's charge descriptions
remain. The [#3584 blueprint](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3584#issuecomment-5985615635)
remains the reader contract: reversible surface changes, unchanged template
pins, instrument-sourced payable asks, preserved history anchors, officer-only
verdicts and explicit approval for changed figures. Recommendations in its
question list are not decisions. Its latest recorded production proof is still
[gate closed](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3584#issuecomment-6405174317);
this design neither opens that gate nor authorises production access.

The alternatives already rejected on #4461 remain rejected: making Xero
read-only would prevent the treasurer's chosen workflow; building a full
accounting package would exceed the scope. Another set of guarded totals would
retain the drift. Instead each economic event posts once, corrections reverse
and re-post, and both systems render or ingest those identified facts.

The design preserves the exact refund-answer and failed-refund decisions on
[#4361](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4361#issuecomment-6390676570)
and its [coding, locked-period and void decisions](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4361#issuecomment-6391255474).
It also preserves [#4219's outside-spend and automatic-email decisions](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4219#issuecomment-6265621107).
No cancellation tier, fee exemption, credit election, refund entitlement or
collection policy changes here. Genuine choices appear in section 10.

## 2. Accounts and settings

The books balance even when no accounting provider is connected. Internal
account identities are stable enums; Xero codes are deployment settings, never
identities or hard-coded club policy. Dr increases assets/expenses; Cr increases
liabilities/revenue. A correction swaps the original entry's debits and credits.

| Internal account | Normal side and purpose | Xero mapping in settings |
| --- | --- | --- |
| `MEMBER_RECEIVABLE` | Dr; charges less settlements, per debtor and obligation | Proposed `memberReceivable`: Xero system receivables control, implemented through invoices/allocations rather than a direct journal to a system account |
| `STRIPE_CLEARING` | Dr; gross captures less refunds, fees and payouts | Existing `stripeBankAccount` (BANK); do not substitute the club bank account |
| `BANK` | Dr; member receipts and completed bank hand-backs, per configured bank | Proposed `memberReceiptsBankAccount` (BANK); reuse `bankTransferRefundAccount` for outbound bank refunds when configured |
| `CASH` | Dr; officer-evidenced cash receipts | Proposed `memberCashAccount` (ASSET); explicit clearing/cash account |
| `MEMBER_CREDIT` | Cr; spendable liability, per member, funding lot and origin | Proposed `memberCreditLiability` (LIABILITY); Xero adapter uses credit notes and allocations with a documented control-account bridge |
| `REFUND_PAYABLE` | Cr; club owes an exact refund obligation, not yet paid | Proposed `memberRefundPayable` (LIABILITY); outstanding refund documents/bridge, never a bank payment without evidence |
| `BOOKING_REVENUE` | Cr; sold guest-nights, with lodge and rate dimensions | Existing `hutFeesIncome`; negative booking adjustments use `hutFeeRefunds` and the same economic category |
| `SUBSCRIPTION_REVENUE` | Cr; immutable subscription components | Existing `subscriptionIncome`, with the charge's frozen per-component overrides |
| `JOINING_FEE_REVENUE` | Cr; type-driven joining fees | Proposed `joiningFeeIncome` (REVENUE); preserve existing joining-fee item account resolution |
| `FEE_REVENUE` | Cr; change, cancellation and other configured member fees, separately categorised | Proposed `memberFeesIncome` (REVENUE), registered fallback to `hutFeesIncome` for existing booking fees |
| `GST_PAYABLE` | Cr; tax component, reversed with its original charge | Proposed `memberGstPayable`: Xero system tax control via tax-coded documents, not a direct system-account write |
| `STRIPE_FEES` | Dr; actual provider fee, never netted from a member receipt | Existing `stripeFees` (EXPENSE); pending mapping holds export, not local capture posting |
| `GOODWILL` | Dr; approved discretionary credit/write-off | Existing `goodwillWriteOffs`, including its registered `hutFeeRefunds` fallback |
| `EXTERNAL_CONTROL` | Either; explained member-credit use on Xero-only business outside the app | Proposed `memberExternalControl` (configured clearing account); imported source references make each amount accountable without importing general accounting |
| `OPENING_CONTROL` | Either; evidenced historical opening amounts where full reconstruction is unavailable | Proposed `memberOpeningControl` (clearing/equity account chosen by Finance); never used to plug an unexplained difference |

Mapping means the adapter can explain how an internal account reaches Xero,
not that every internal leg becomes a Xero manual-journal line. Xero owns its
receivables and tax control accounts. Credit notes can affect Xero receivables
where the app carries a credit liability: the adapter's control bridge must
prove equality of the combined member position, and must not create both a
credit note and another credit for the same liability. System-account mappings
are validated against the provider's chart; user-selectable mappings enforce
account class/type. An item must resolve to the frozen account and tax treatment
or export conflicts visibly. No guessed account code is sent.

Extend the existing registry in `src/lib/xero-account-mapping-keys.ts`; its
settings, resolver, API, defaults and warnings stay one source (`INV-SSOT-001`,
`INV-INT-021`). New keys above are proposals, not implemented settings. With
Xero disabled no code mapping is required. Connecting it later validates the
mappings and creates an export baseline; existing invoices and notes are adopted
by exact identity and coverage before any missing document is rendered. History
already in Xero is never invoiced again. An unset new mapping leaves affected
exports visibly pending; the existing bank-refund unset behaviour remains an
unsettled note, never a payment from Stripe. A mapping change affects future
render plans; replay uses its frozen mapping version.

Tax is recorded in integer cents with the charge: gross = net + tax, and
reversal uses those exact cents, tax code and coding version. Use the existing
money boundary helpers (`INV-MONEY-001`, `INV-MONEY-003`); do not calculate tax
with new floating-point arithmetic. Preserve current inclusive tax treatment
and subscription component rounding. Section 10 asks how the journal's tax and
recognition settings should cover clubs with different accounting policies.

## 3. Journal model and enforcement

A posted event is an indivisible, balanced batch. The following are proposed
records and constraints, not a Prisma schema to apply in this documentation PR.

| Record | Contract |
| --- | --- |
| `MemberMoneyEvent` | Immutable kind enum, origin enum, source identity/version, deterministic event key, payload hash, actor, reason, effective instant/date and recording time; links a journal batch, including explicit zero-money events |
| `MemberMoneyJournal` | One immutable header per event/batch, currency, policy/coding version, expected line count and optional unique reversal target; no editable draft or balance column |
| `MemberMoneyLine` | Header, account enum, Dr/Cr enum, positive integer cents, member/debtor, obligation, booking/lodge where applicable, credit lot, charge/refund identity, original posting reference, tax and frozen descriptive evidence |
| `MemberMoneyObligation` | Exact charge/refund identity and source, immutable face terms; settlements and reductions refer to it explicitly; remaining amount is derived |
| `MemberMoneyApplication` | Immutable attribution of a receipt/refund/credit to an obligation, amount, and optional unique reversal target; no timing/amount heuristic |
| `MemberMoneySourceLink` | Durable link from existing booking line, credit row, subscription component, capture, refund or Xero fact to the event; unique per source fact, not per coincident amount |
| Export manifest | Immutable render revision, payload hash, frozen mapping and exact posting/application coverage identities; retries preserve this evidence |
| Inbox, object head and export delivery | Mutable delivery/workflow records with enum statuses and guarded claims; contain no authoritative money balance; delivery attempts refer to an immutable manifest |

One batch can have several obligations and members, as for a group receipt, but
its debits equal its credits **per currency**. Currency is the club's configured
currency, not an FX feature. Cross-currency provider facts conflict; no silent
conversion. Member-credit transfers cannot change the debtor implicitly. A group
records one cash receipt and exact applications to child obligations; it never
records that full receipt on each child. Family subscription coverage similarly
names one debtor and several covered members, not several copies of revenue.

`BookingLedgerLine` remains the booking event evidence and compatibility view.
Existing line ids, reversal chains, posting keys, night prices, names and
`BookingModification.priceLines` survive. A bridge maps every existing line to
its journal event and legs. When an event is eligible for both representations,
the command writes them in one transaction until booking readers move. R01's
pre-payment payable obligation initially exists only in the new journal:
`INV-MONEY-032`/`033` still fence legacy charge lines at confirmation. At that
later confirmation, the compatibility lines link to the already-posted charge
components; they create no second journal charge. Edits before confirmation
update the journal through R02 while the eventual legacy confirmation represents
the surviving charge. The bridge compares the same eligible population at each
stage, explicitly separating pending journal obligations from legacy confirmed
charges; it does not move legacy reader timing or waive unexplained differences.
Do not independently reprice either side or double-post cash because both a
booking line and a refund row name it.
The existing booking balance helper becomes a projection of these same economic
facts; the bridge proves its charge/settlement/adjustment signs agree. Once
there are no old readers or writers, compatibility posting can retire; posted
legacy lines remain retained evidence.

### Database refusal and mandatory posting

A failed posting rolls back the business event as well. Extend #4453's
least-privilege provisioning to every new immutable money table: the application
has INSERT/SELECT only, no UPDATE, DELETE, TRUNCATE, ownership, role escalation,
mutable view or privileged routine escape. Migration and operator roles remain
separate; the audit-retention connection gains no money-table rights. Verify
the effective grants at rollout: #4453 is opt-in, so merely merging its code is
not proof a deployment uses the restricted role.

Use CHECKs for positive integer cents and valid line shape, enum domains,
unique event/source/reversal keys, and deferred constraint triggers for
cross-row balance. A journal header records its creating transaction identity;
line inserts must belong to that same transaction. A later INSERT into an old
batch is refused, closing the hole that INSERT-only grants alone leave open.
At commit, every header must have its declared complete line set, balanced
accounts, valid tax split and consistent currency. A non-zero event has at least
two legs; an explicit zero event has no legs. Partial batches cannot commit.
An exact reversal copies all original legs with Dr/Cr swapped, references that
batch uniquely, and cannot be reversed twice; a new correction event follows.

During expansion legacy source records may lack links. For each migrated
writer cohort, durable source events require a non-null journal reference and
a deferred database check verifies the event kind and amount against its
complete batch. Mandatory links become universal after backfill and old-worker
drain; do not claim a nullable FK enforces universal posting. A durable refund
request before a provider call is an obligation/reservation, not a cash refund.
The later accepted cash fact, application, reversal if failed, compatibility
projection and outbox insert commit together. No caller may catch a refused
posting and commit its business mutation anyway.

On a replay, reserve the deterministic event key with conflict-do-nothing, read
the winner and require identical canonical payload/hash and source links. An
identical replay returns that complete batch. A reused key with different cents
or coding is a conflict, not a successful skip. No per-line skipping can leave
half a journal. Event keys include source event/attempt identity and revision;
they never use wall-clock arrival time, equal amounts or array position.

Foreign keys from posted records use RESTRICT for financial parents and stable
identities, without update cascades or set-null rewrites. #4453 protects booking
and lodge ids but [#4482](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4482)
shows parent DELETE can still erase legacy booking lines. Section 10 proposes
archiving financial parents and RESTRICT for that existing cascade too. Until
that decision is approved and delivered, append-only enforcement is incomplete
and the ledger cut-over remains blocked. Personal-data erasure must use the
retention design; it cannot erase economic postings by deleting their parent.

### Module boundary and transactions

Callers express a business event through a small public API. Proposed
`src/lib/member-money/index.ts` exposes typed commands, read projections and
transaction participants; `internal/` owns posting, key construction, account
rules, source linkage and stores. Provider adapters call commands with evidence,
never Prisma money delegates. Pure planning/ownership modules import no database
or provider client. Routes, cron and admin code cannot import internal stores.

An error-level import rule allows money-writer Prisma access only inside this
boundary and refuses deep imports, re-export bypasses, dynamic imports and raw
SQL escapes elsewhere. Existing writers are named, temporary migration
exceptions removed cohort by cohort. Shared Prisma transaction access is not
itself a capability boundary: restricted delegates/typed participants keep money
tables out of caller clients, and an AST census covers delegate and SQL writes.
Tests exercise the real import rule with prohibited examples and mutation probes;
the database balance/refusal tests cover what lint cannot prove (`INV-SSOT-004`).

Use the existing lock classification, never a new generic journal advisory key.
Settlement/lifecycle commands take global `lock(1)` under `INV-LOCK-001`; capacity
composition adds sorted lodge keys from `acquireLodgeCapacityLock`, then member
keys. Credit-only adjustments keep the member-credit tier; #4219 applied-credit
release takes global then member, while free-lot #4270 mirroring takes member
only. `INV-LOCK-002` fixes order and key minting; `INV-LOCK-003` requires registry
updates. Re-read mutable inputs after locks and win a status/version-guarded
claim before side effects. Provider calls stay outside the transaction.

For new inbound settlement and export-result recording, use one order: applicable
advisory tiers, mutable business/payment rows, object-head rows in sorted order,
then export/link rows. Do not lock immutable lines (`SELECT FOR UPDATE` requires
UPDATE privilege). Credit-only object processing never later escalates to a
global-key command: defer it and restart with the required tiers. The inbound
void and outbound completion both use this order, replacing the legacy
link-first/Payment-first inversion. Old writers must drain before the new order
is enabled. Each writer child reconciles open PRs and the last ten merged PRs
for its subsystem, registers participants, and proves its races on PostgreSQL;
this documentation PR introduces no transaction or lock site.

## 4. Posting rules for today's money events

The event records what happened; a document does not prove money moved. In this
table `AR` means `MEMBER_RECEIVABLE`, `Credit` means `MEMBER_CREDIT`, and `RP`
means `REFUND_PAYABLE`. Each slash-separated revenue/tax leg uses the original
frozen cents, not today's rates. All amounts below are integer cents. Source
modules identify today's doors; their future writes converge on section 3's API.

| Rule | Event and current source | Balanced posting and exact attribution |
| --- | --- | --- |
| R01 | Booking priced and committed as a payable obligation; `booking-create`, request approval, draft/waitlist confirmation, group children | Dr AR, Cr booking revenue/GST for priced nights plus the signed promotion once, reusing the existing confirmation planner's arithmetic. Today's `discountCents` projects that promotion; it is not a second reduction. A separate group-discount leg requires an independently evidenced component. Post when a binding payable obligation is issued, before its bank-transfer invoice; a draft/quote/unused hold is not a sale. Keep current capacity/confirmation timing through section 3's bridge. Later settlement never charges those nights again. |
| R02 | Date, guest, party, rate, whole-lodge or promotion edit; modification services and `BookingModification.priceLines` | Reverse affected live charge components, then post their exact replacements through R01. Promotion reductions Dr revenue/GST, Cr AR; price-raising promotions reverse that direction. Preserve per-code and per-night evidence. Non-refundable policy-retained edit amounts are explicit retained-charge components, not unexplained negative debt. |
| R03 | Change fee; `booking-modify-settlement` | Dr AR, Cr fee revenue/GST, keyed to the modification's fee component. One fee has one document-coverage identity, regardless of primary/supplementary invoice replacement. No second fee when an ask is replaced. |
| R04 | Paid/unpaid cancellation, hold expiry, capacity cancellation; `booking-cancel`, `group-cancel`, payment cron | Reverse extinguished charge components; post the frozen policy's retained fee/charges, preserving non-refundable change fees without duplication. Only the approved policy's give-back creates an RP obligation (R05) or credit (R09). Unpaid invoice clearing reverses the charge, not a receipt. A pending partial-payment review preserves the recorded cash and its task; it never assumes full receipt or entitlement. |
| R05 | Refund entitlement from reduction, cancellation, appeal, review or duplicate/superseded capture; refund planners | After the price/retention decision, move the exact refundable negative AR to its own obligation: Dr AR, Cr RP. No bank/Stripe leg yet. An approved appeal posts its explicit additional concession against original revenue/tax or approved goodwill before this transfer. Reserve each refund attempt against this obligation so concurrent doors cannot both spend it. |
| R06 | Card capture, including additional payment; `payment-reconciliation`, `stripe-webhook-service`, recovery | Dr Stripe clearing, Cr AR for gross provider-evidenced capture, keyed to that capture. Applications name the obligation(s) collected. A Stripe fee is R16, never a smaller member receipt. A second instrument still records real cash and raises the existing conflict/refund workflow. |
| R07 | Bank receipt, partial/overpayment, manual payment in Xero; inbound invoice/payment reconciliation | Dr Bank, Cr AR for each identified payment object, with exact applications. Invoice `PAID`, amount due zero, or a credit-note allocation alone is not receipt evidence. Overpayment remains unapplied money due to the member until an explicit credit/refund decision; it is not revenue. Removing/voiding a Xero-owned payment reverses that receipt once, reopening its obligation. |
| R08 | Officer cash/off-Xero bank receipt and reversal; manual mark-paid, subscription manual payment | Dr Cash or Bank, Cr AR for the officer's audited receipt. Preserve existing eligibility, expected amount, covered-addition question and refusal rules. Split primary/additional applications, not the actual cash. An allowed reversal swaps exactly those receipt legs, restores the affected instrument state and posts no new charge. |
| R09 | Cancellation/reduction credited to account; `member-credit` and cancellation writers | Move the eligible give-back to the named funding lot: Dr AR (or RP if entitlement already moved there), Cr Credit. Never create both versions. Credit is a liability, not cash paid back. Cancellation tier determines the amount; original method does not choose a new policy. |
| R10 | Account credit applied, clamp give-back, election and tiered restoration; `member-credit`, credit-election and cancellation | Apply: Dr Credit, Cr AR, tied to lot and booking. Give-back: reverse the exact released application. Cancellation restore: Dr AR/RP, Cr Credit for only the frozen tier's restore, tagged `RESTORE` and linked to the original application. It is distinct from newly issued cancellation credit even on the same date; a partial restore is not a full reversal. Election/reservation without consumption has no money legs. |
| R11 | Approved manual account credit/debit; `AdminCreditAdjustmentRequest` approval | Credit grant: Dr Goodwill, Cr Credit once at approval, with requester, approver and reason. Debit reverses identified grant legs or posts the approved write-down against its documented counterpart. No unapproved balancing adjustment or automatic debt write-off. Spending uses R10 and the same funding note; it never grants again. |
| R12 | Successful/accepted recorded card refund, from app or Stripe dashboard; `PaymentRefund` | Dr RP, Cr Stripe clearing for the exact recorded provider refund, linked to its obligation/application and attempt. A refund initiated but not yet recorded by Stripe is only a reservation. Retain today's provider-status predicate for counted refunds and reverse it if Stripe later fails it. A dashboard refund is recorded regardless of whether its answer is known; an unmatched amount is an unapplied member refund, never guessed onto a debt. |
| R13 | Card refund refused or failed later; recovery and Stripe events | Before a counted refund exists: release the reservation, no cash posting. After R12: reverse the actual cash batch once. An attributed refund reverses Dr Stripe clearing, Cr RP; an unmatched refund reverses Dr Stripe clearing, Cr unapplied AR. Reverse any intervening attribution/reclassification as well, so only an actually answered obligation reopens. Follow #4361's hold and exact-answer rules; no automatic re-send after a paid-another-way close. A Xero event cannot restore Stripe-refunded truth. |
| R14 | Bank hand-back, cash hand-back, refund request completion, paid-another-way full/part close; task resolution | Dr RP, Cr Bank/Cash for only the completed/evidenced transfer, with exact task, refund obligation and close-share identity. An unpaid credit note or task creation does not post this. A part close leaves the remainder payable; a later close settles only that remainder. |
| R15 | Group organiser settlement/refund; `group-settlement`, organiser child refund executor | R06/R07 records one organiser receipt. Exact frozen child shares apply it to each child's R01 obligation; transfers between internal debtor accounts have equal Dr/Cr AR legs. Child edit/cancel refunds create and settle child RP obligations from the one original instrument. Sum of shares/refunds cannot exceed the source receipt/entitlement. Never repeat the full receipt per child or credit a separate invoice for an organiser-paid child. |
| R16 | Stripe processing/refund fee and fee reversal; provider balance transaction | Dr Stripe fees, Cr Stripe clearing for actual fee evidence, keyed to balance-transaction component; reverse on actual provider reversal. Fee tax, if any, follows evidenced/configured tax treatment, not the booking tax assumption. Pending fee discovery does not delay the gross receipt. |
| R17 | Stripe payout/return of payout affecting member clearing | Dr Bank, Cr Stripe clearing for the evidenced transfer, opposite on return. Not revenue or another member payment. Post only the transfer needed to reconcile this clearing subledger; general bank reconciliation remains in Xero. |
| R18 | Subscription confirmation/approval billing, family invoice, annual components; membership billing | Dr AR to the frozen billing recipient, Cr subscription/component revenue/GST from immutable `MembershipSubscriptionChargeComponent` rows. Coverage does not multiply the charge. `NO_INVOICE`/exempt zero outcomes record explicit zero events. Receipt/reversal is R07/R08, not a new subscription charge. Joining fees use R19. |
| R19 | Joining fee or configured member fee due; nomination/fee invoice worker | Dr AR, Cr joining-fee or fee revenue/GST, from the authoritative fee resolution and unique charge identity. Preserve type/tier, exemptions and existing member-unique joining-fee reference/adoption rules. A retry cannot resolve a new fee and bill it again. |
| R20 | Membership cancellation/unpaid subscription void or approved charge correction | Reverse only the waived/unpaid charge components under the existing cancellation decision. Paid money is retained unless existing policy explicitly refunds it; any approved refund follows R05/R09/R12/R14. A Xero void of the invoice alone is a document fact and a task for an app-owned charge, not permission to waive it. Subscription paid-up/access policy stays in its own resolver. |
| R21 | Legacy financial review close, agreed adjustment, price rebase or dismissal | Use the booking-grain stand-in/rebase rules in booking-ledger section 5.3: reverse a superseded stand-in once; post an agreed charge/concession only where the reprice does not already carry it. Cash, credit and asks use their own rules. Dismissal posts nothing. No sibling review can count the same give-back twice. |
| R22 | Xero outside spend/un-spend of member credit; #4219/#4270 | Free lot: Dr Credit, Cr External control for the explained spend; exact reverse for an undone spend, capped by what was written down. If an unreceived booking application must release, reverse that R10 application (Dr booking AR, Cr Credit), then write down the released lot. Net free member credit is unchanged for that release; the booking owes again. No Xero write, no newly granted note. Unexplained shortfall/in-flight operations defer or task, never auto-write-down. |
| R23 | Xero credit-note allocation, allocation removal, note/payment void, hand-made note adoption | Post/reverse the specific Xero-owned application or settlement fact through section 6, using its object/version and original links. An allocation changes which debt is settled; it never posts Bank/Stripe cash without a payment fact. App-origin echoes acknowledge coverage only. A void reverses the provider-owned fact once and creates one treasurer task where an app obligation/document still needs resolution. Never reverse an independently evidenced Stripe/officer cash fact just because its note was voided. Legacy note-derived bank hand-backs use section 10's explicit decision. |
| R24 | Late, superseded, duplicate or deleted-booking capture, retained or refunded | Record actual cash by R06 even if the booking is archived. Automatic return/approval creates RP by R05 and pays it by R12. Held money stays a liability/unapplied negative AR, not income. A keep decision applies it to an existing charge or creates the explicitly retained charge once; rendering uses that charge's invoice. Refunding an unexported/unbilled capture creates no credit against an unrelated booking invoice. |
| R25 | Ask raised/replaced/carried/withdrawn; intent setup/cancel; reminder; invoice delivery/retry; source-only name/date correction | No new money legs. Instruments name obligations and collectible slices; withdrawing an instrument leaves debt. A real price change is R02. Preserve #3340's collection scope: no automatic catch-up billing of historical under-collection, no card ask for a bank invoice already collecting it. |
| R26 | Historical import, back-post and correction | Link existing booking lines, credit lots, subscription snapshots, provider receipts and refund facts once. Reconstruct exact event pairs where evidence allows; otherwise an approved, explicitly labelled opening event uses Opening control. Unknown cents/attribution remain a blocking finding, never zero or an invented receipt. Corrections reverse/re-post with provenance; historical export coverage is adopted, not resent. |

The application store enforces conservation in the same locked transaction:
net applications cannot exceed a source receipt, credit lot, refund obligation
or source capture's refundable cash, and every application refers to the
correct member/currency/instrument. Refund attempts reserve that capacity
before provider calls; duplicate provider responses collapse on source identity.
A balanced but wrongly attributed batch fails these checks. An unmatched
dashboard refund posts Dr unapplied member AR, Cr Stripe clearing until its
answer is known; an exact answer reclassifies that Dr to RP without moving cash
again. It cannot consume an arbitrary open refund obligation. #4361's dashboard
rule holds re-sends, adopts only the single exact matching debt automatically,
and otherwise asks once with Undo. Equal refunds at identical timestamps remain
distinct facts and answers; timestamp ordering never decides whose debt is paid.
Attribution and failure processing share the guarded refund/source claim: a
failed refund cannot later acquire a live application. If attribution preceded
failure, reverse that reclassification and its application with the cash batch
in one transaction; if no attribution existed, failure creates no RP obligation.

For example, a 20000-cent charge posts Dr AR 20000, Cr revenue/tax 20000. A
capture posts Dr Stripe clearing 20000, Cr AR 20000. An approved 8000-cent price
reduction posts Dr original revenue/tax 8000, Cr AR 8000, then Dr AR 8000, Cr RP
8000. Paying it posts Dr RP 8000, Cr Stripe clearing 8000. If Stripe fails that
refund later, reverse only the last entry: RP is owed again. A 300-cent Stripe
fee is separately Dr fees 300, Cr clearing 300; it changes no member balance.

## 5. One ownership table

Two-way sync works because each fact has one authority. Implement this table as
one typed, exhaustive registry consumed by inbound classification and outbound
planning (`INV-SSOT-001`); do not create competing direction-specific lists.
“Xero owns” means an accepted, evidenced Xero fact becomes an immutable app
posting. It does not grant Xero a general write to member money.

| Fact | Authority | Inbound action | Outbound action |
| --- | --- | --- | --- |
| Booking prices, fees, promotions, policy retention, subscription/joining charges and approved concessions | App pricing/policy/approval snapshots | Invoice-line/amount/tax edits create one treasurer conflict task; never reprice, waive debt or change entitlement | Render charge/correction slice once |
| Stripe captures, counted refunds, failures, processing fees and payouts | Stripe source identity and lifecycle | Xero payment/note echo acknowledges its manifest; a mismatch tasks, never changes card cash | Render exact receipt/refund/fee/failure slice |
| Officer-recorded cash or off-Xero bank receipt/hand-back | App audited receipt/close | Adopt an explicitly matched Xero counterpart as coverage, no new cash; amount/reference coincidence alone cannot match | Preserve existing manual-settle no-mint policy; explicit export/adoption only when that workflow permits |
| Bank receipts, manual bank payments/refunds recorded in Xero, their correction/void | Xero payment objects | R07/R14 or exact reversal, against identified obligations; unresolved member/source goes to task | Do not send the same fact back as a second payment |
| Member credit grant, application election, policy restore and approved adjustment | App, with source lots and approvals | Echo acknowledges the exact note/application; an unexplained provider difference tasks | Render/adopt the grant once, and allocate the same lot when spent |
| Credit-note outside spend/un-spend, provider allocation/removal and document lifecycle | Xero, within the named fact's scope | R22/R23; terminal void remains terminal; never invent cash or a new grant | Never undo a treasurer's outside spend; no automatic reissue of their void |
| Refund entitlement, which obligation an answer settles, keep/paid-another-way decision | App policy/officer, with #4361's narrow exact dashboard rule | Match exact source/application or ask once; no time/amount inference | Render money facts independently of inferred debt pairing |
| Contact/provider identity and document ids/status/coverage | Provider identity plus exact app manifest association | Record identity/lifecycle and guard stale results | Reuse or adopt exact object; do not create by display amount/reference alone |
| Membership eligibility, family coverage, paid-up interpretation | Existing membership rules; journal supplies settlement evidence | Payment posts can update a derived subscription state through its existing lifecycle; invoice editing cannot change membership type | Frozen subscription snapshot and covered-member list |
| Bank reconciliation, accounting-only invoices/expenses, returns and P&L | Xero | Import only scoped member settlement/outside-spend facts; other accounting stays outside this ledger | No general-accounting engine |

When an officer receipt later appears in Xero, a durable explicit source-link
association records that these are one receipt. If there is no such identity,
quarantine the apparent second receipt for Finance; do not deduplicate using
amount/date/reference, and do not apply both to the member automatically. The
same unique payment reference can identify the debt, but cannot prove that two
actual transfers are one payment.

## 6. One inbound door

A webhook, cursor sync, manual refresh, allocation refusal or repair tool must
all submit the same evidence to proposed `ingestXeroMemberMoneyChange`. None may
recount or update a running total. Transport receipt deduplication is separate
from economic fact idempotency.

1. Verify the webhook and durably record receipt through the existing inbound
   infrastructure. Fetch the current provider object outside all database locks;
   webhook payloads alone do not carry enough accounting evidence. Cursor sync
   and manual replay use the same normaliser and command.
2. Normalise the full object into cents, stable component identities, provider
   status and `UpdatedDateUTC`. The economic inbox unique key is **connection /
   tenant + object type + Xero object id + provider update timestamp**. Preserve
   timestamp precision; arrival time is never substituted. Missing timestamp,
   currency mismatch, ambiguous member/lot or same-version contradictory body
   means defer/refetch or task, no money. Reconnecting the same tenant preserves
   its source namespace; another tenant cannot adopt its facts.
3. Use section 5's registry to classify facts. Resolve existing export/source
   links first: a known app-origin echo records acknowledgement, not a posting.
   For nested payments/allocations without an independent update stamp, use the
   containing object's version, stable component ids and its accepted full set;
   never manufacture ids from array order. Invoice and credit-note deliveries
   observing the same allocation converge on one canonical component identity.
4. Enter the appropriate transaction/locks from section 3. Re-read the mutable
   business rows and object head, then win a guarded inbox claim. A second
   worker's lost claim runs no posting or side effect. Claims whose workers die
   are retryable under their attempt token; an applied event is never replayed
   as unprocessed because response bookkeeping failed.
5. Compare with the latest accepted object version **under these locks**.
   Older live snapshots are acknowledged as stale with no posting. Equal
   timestamp plus equal fingerprint is a replay; unequal fingerprint is a
   conflict. VOIDED/DELETED is terminal even if a stale live reading arrives
   later. A missing intermediate version is safe: compute the difference between
   the last accepted full fact set and this full set, not between arrivals.
   A partial/unreadable child list cannot be interpreted as removal.
6. Post the newly evidenced facts and exact reversals of removed/replaced
   provider-owned facts (R07, R14, R22, R23). Batch/source/application uniqueness
   also deduplicates one payment observed through several objects. For a changed
   amount reverse the old batch and post the new one. An invoice-line edit to
   an app charge records a conflict instead. Unexplained outside-spend deltas,
   inflight allocation/deallocation or unavailable evidence defer; #4219's
   allocation-refusal fallback still requires its confirming read.
7. Commit the journal, source/application links, object-head version, inbox
   outcome, audit, one conflict task if needed, derived lifecycle transition
   and any permitted outbox intent together. A guarded lost outcome cannot
   publish an active link to a voided object. A task is unique to the source
   fact/conflict, so repeated events do not ask the treasurer repeatedly.

For example, receiving an unpaid invoice with a voided edit note can reverse
that note's provider application, but R07 has no bank payment to post. It cannot
become paid by subtraction. Receiving an allocation removal reverses that
allocation's contribution; it cannot erase a separately evidenced card refund.
The views show cash returned and credit allocated as separate fields. A legacy
“refunded total” compatibility view may combine them during migration, but it
must sum their exact surviving components, including earlier edit notes; no
single latest-note overwrite is allowed.

Outside-spend convergence preserves #4219's automatic pay-link email through
the existing `INV-ADDPAY` flow, including COMPLETED-booking support and its stop
condition. It settles the existing invoice and creates no new charge. Free-lot
write-downs under #4270 retain their no-member-email rule. Delivery uses an
outbox after commit; no email or provider call is inside the posting transaction.

## 7. Outbound rendering and optional Xero

Sending to Xero describes posted facts; it cannot create an economic fact.
A pure planner takes an immutable ledger slice, its identity/descriptive
snapshots, the ownership registry, frozen account/tax settings and accepted
provider coverage. It returns a document/payment/allocation plan, or an explicit
conflict. It reads no mutable `Payment` total, current rate table or current
member name to decide historical money. Existing stored edit descriptions and
per-code promotion evidence stay render inputs; missing historical detail never
gets fabricated by repricing.

Each export manifest links exact posting components and applications to document
roles, source invoice and provider objects, with signed covered cents. It has
an immutable render revision, payload hash, frozen mapping and legacy key where
one already exists. A separate mutable delivery record owns attempts and enum
statuses. Active coverage uniqueness prevents a charge/fee component being billed
twice in the same role, while allowing a charge invoice and its distinct payment
record. A replacement after a genuine void is a new explicit render revision;
retrying a lost response always uses the original manifest and key. Never derive
a retry key from the current refund watermark or current set of voids.

| Rendered object | Ledger slice and coverage rule |
| --- | --- |
| Primary, supplementary or combined group invoice | Exact issued charge components, including fee coverage assigned once. Combined invoices consume child charge coverage; individual child invoices cannot consume it again. Pending bank-transfer obligations already have R01 postings. |
| Reduction, cancellation or clearing credit note | Exact negative charge components; clearing an unpaid invoice carries no payment. A clearing note is a rendering of R04, not a refund event. |
| Account-credit note and allocation | Original R09/R11 grant/restore lot and R10 applications, subject to the existing restore/noteless policy. Approval of a manual grant creates one note; later spend uses that note. An already-exported grant cannot become a second expense at spend. |
| Refund note and its payment | Charge reversal/entitlement plus R12/R14 cash slice, linked separately so a composite note cannot double-count the price reduction. Never one invoice-applied edit credit plus another full credit for that same reduction. A note can remain outstanding before hand-back; only the cash slice creates its payment. |
| Capture receipt, including late/change capture | R06 applications across the invoices actually billing those obligations. A capture of 8000 with only 5000 room on one invoice is fully recorded through valid remaining targets; unexplained room is a task/unapplied receipt, never silently clipped. No invented second revenue charge to fit the cash. |
| Failed-later refund reversal | R13, rendered using #4361: full reversal invoice coded like its credit note, paid into Stripe, never emailed/allocated. Date is the failure day or first open day after Xero's lock; reference retains the actual failure day. Its void raises one task and never automatically recreates it. |
| Stripe fee/payout | R16/R17 provider balance facts; no second fee where Xero's connected feed already covers the exact transaction. Missing external identity is a conflict to resolve, not amount-based adoption. |

A component may be covered partly by more than one provider document, but the
sum of live coverage cannot exceed it. Refund notes are capped by the recorded
cash/charge slice they actually answer, per capture and target, not a booking's
unrelated invoice. Thus a partially exported 8000-cent capture with only 5000
recorded gets at most 5000 of refund documentation against that recorded slice;
its remaining receipt/refund pair must be rendered or adopted together. A
5000-cent late capture and refund can be exported as that matched pair, net
zero, without disturbing the cancelled booking invoice. If neither reached Xero,
no credit is raised against that unrelated invoice. Preserve existing legacy
no-receipt/record-by-hand handling until exact coverage has been established;
new paired rendering requires the approved child and round-trip proof.

The dispatcher commits a guarded attempt claim, calls Xero outside the
transaction, then records object identity/coverage under section 3's order.
An ambiguous create response is reconciled by that same manifest's identity,
not blindly retried with another key after provider key expiry. A rejected or
lost claim may retain the returned object as evidence, but cannot mark its
coverage live against a newer void. A crash after create, payment or link commit
resumes the remaining manifest steps, not a fresh document. Existing amount-based
and joining-fee keys are retained for adopted/in-flight legacy operations; new
manifest keys begin only after their old producers drain.

With Xero off, all local posting, receipts, balances and refund obligations
still work. The app does not call a provider or depend on an invoice id to
record bank money. Unique opaque payment references identify obligations;
finance:edit receipt recording is audited and idempotent, permits partial
receipts, and never asks an officer to edit a running total. Existing manual
mark-paid refuses invoiced bookings as before; the new receipt workflow is a
separate proposed child with its own permission/UI contract.

Connecting Xero later starts with exact adoption and a Finance-reviewed baseline
of journal slices already represented there. Export only uncovered slices;
opening history cannot be both an opening balance and replayed revenue. A
currency or control-account bridge discrepancy holds activation/export until
resolved. Disconnection stops delivery, not journalling. Reconnection resumes
manifests under the same source namespace.

## 8. Cut-over, proof and retirement

Change authority only after the evidence is complete. This is a programme of
independently useful releases, not an atomic epic and not a timed shadow period.
No schema change is made here. Implementation follows the
[blue/green sequence](../BLUE_GREEN_MIGRATION_POLICY.md#required-sequence), with
old-code rehearsals, rollback evidence and owner-only production operations.

| Step | Shippable outcome and gate | Modules and invariants that change or retire |
| --- | --- | --- |
| A. Expand and protect | Add inert journal, accounts, source bridge, constraints, restricted grants, ownership registry and read-only verifier. Resolve section 10's retention decision; close #4482 before claiming durable append-only storage. No reader/provider change. | Keep all existing repair and census modules. Extend `INV-MONEY-032`/`033` to journal immutability and whole-batch keys; preserve the booking confirmation fence. No invariant retires. |
| B. Post every event and reconstruct history | Cohort-by-cohort adapters post alongside existing source writes in their transactions, including pre-settlement payable bank charges and subscriptions. Backfill deterministically through the same planners. Require full population coverage, conservation, source uniqueness and exact historical provider coverage. The existing seven-identity census must be `GATE_OPEN`; the journal adds its own per-account/obligation/lot proof. | `booking-ledger-*-sync.ts`, `member-credit.ts`, `payment-transactions.ts`, subscription/fee writers remain compatibility participants. Preserve `INV-MONEY-008`/`009` snapshots; restate `INV-MONEY-034`–`036` as source-to-journal contracts. `rate-derived-night-price-backfill`, `stored-night-price-repair*` and orphaned-credit backfills stay available for evidenced history resolution, not auto-run. No general deletion of repairs. |
| C. Switch inbound authority | After #4460 proofs and old-worker drain, all Xero sources use section 6, and compatibility projections are written only by the journal adapter. Deploy restricted writer capability/import rules with an explicit shrinking legacy allowlist. No mixed old recount/new posting workers. | Retire money-mutation arms of `xero-inbound/credit-note-repairs.ts`, `recount-left-unsettled.ts`, `kept-settle-correction-recount.ts` and the old inbound paths into `reconcilePaymentAggregates`; retain transport, identity lookup and audit responsibilities. Fold `xero-credit-note-spent-outside-app.ts` and `xero-credit-note-mirror*.ts` economic planning into R22, preserving refusal/sweep triggers. Replace `INV-ADDPAY-021`'s Xero-to-card-total raise/floor logic with fact ownership. Preserve `INV-MONEY-007` approvals/outside-spend exceptions. |
| D. Move readers, one reversible surface per PR | #3584 foundation and officer panel → member panel → history → confirmation → finance → modification email, plus its separately scoped data export. Columns still written and compared. Corpus pins and whole-history surface parity gate each move; classified differences need existing approval or the owner. | Readers use one projection/store, extending #3584 rather than maintaining another balance helper. `INV-PAY-020` reads journal settlement evidence; `INV-MONEY-030`/`031` preserve provenance and officer-only verdicts. No writer policy or repair retires merely because a screen moved. |
| E. Switch outbound and provider coverage | Fold #3585 into section 7's rendering child: cover booking, group, subscription, fee, credit, refund and Stripe documents, including in-flight/adopted operations. Enable only proved document cohorts. Xero-off bank receipt workflow may ship after B/D independently. | Retire fee-gap reconstruction in `xero-primary-invoice-fee-gap.ts`/`xero-primary-invoice-fee-at-link.ts` once explicit fee coverage replaces it. Replace refund watermark/gap inference with manifest coverage; retain old-key reconciliation for unresolved operations. `INV-PAY-050`, `070`, `101`, `119`, `144` become exact coverage/method contracts; provider idempotency remains. #4361 stage-2 markers and no-historical-document stop conditions remain until their own approved transition. |
| F. Move remaining decision inputs and drain legacy operations | Separately move #3586 blueprint groups B–E: non-line Xero amounts, lists/queues/SQL filters/previews, refund sizing, ask/recovery sizing, cancellation/settle inputs, diagnostics and operator scripts. Prove no active reader depends on a mirror; exact #4361 answers replace inference only after legacy cases are resolved. | `payment-reconciliation.ts` remains the settlement lifecycle, not a repair to delete. `reconcilePaymentAggregates` loses economic decision authority; any instrument/status projection stays explicitly named. Replace only recount/reconstruction arms of `xero-booking-repair-*`, `xero-refund-note-link-repair.ts`, `xero-applied-credit-allocation-repair.ts` and `cron-credit-reconciliation.ts` with coverage/task checks. Retain provider failure recovery, missing-document delivery and fraud/double-instrument controls. Restate `INV-PAY-046`/`047` race guards on obligation/instrument revisions. |
| G. Stop writing obsolete totals | After F deploys and drains, an expand relaxes required legacy columns; code ignores them and removes writes. Census stops comparing abandoned totals, keeps coverage/integrity and adds trial balance/application conservation. Rehearse both colours. | Retire the Payment-mirror half of `INV-PAY-103`, construction/mirror arithmetic of `INV-PAY-047`, mirror-only `INV-PAY-037` clauses, `refunded-total-shortfall-audit.ts` and `payments:audit-refunded-total`, `bookingLedgerCensusSql` and mirror-residual audit scripts. `INV-MONEY-037` becomes a structural coverage monitor. Retire column-only `REFUND_MIRROR_*` classes after every instance is resolved/acknowledged; preserve retired acknowledgement compatibility. |
| H. Contract on the owner's timing | In a later release after all older colours drain, #3586 drops its six columns. Rollback restores schema only; returning to pre-G readers requires a proved reconstruction and parity, not merely re-adding columns. Subsequent compatibility removal has a separate gate. | Drop `Payment.amountCents`, `creditAppliedCents`, `refundedAmountCents`, `additionalAmountCents`, `changeFeeCents`, `Booking.finalPriceCents`. Retire only mirror clauses of `INV-PAY-018`, `046`, `047`, `INV-MOD-002`/`038`, `INV-ADDPAY-015`; retain captured-truth, traceability and refund-cap equivalents. Legacy backfill/repair entry points retire only after their population is empty, evidence retained and rollback window closed. |

The [#3586 blueprint](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3586#issuecomment-6005385405)
corrects the old “two migrations and done” assumption: readers and writers'
decision inputs move first, then stop-writing with a compatible expand, then
contract in another release. It also inventories raw SQL, backup sentinels and
diagnostics grants that must move. Nothing here authorises deleting transaction
refund fields or booking build-up evidence simply because their names resemble
the six columns. `MemberCredit` becomes a journal-backed compatibility view
before any further removal; it cannot remain a second independently writable
balance after the switch (`INV-PAY-019`).

`ib-hold-clearing*-audit.ts`, cancelled-payment flattening and orphaned
applied-credit backfills stop repairing monetary copies only after their historic
population is discharged and replacement charge/application coverage checks
exist. Sold-night provenance/reconciliation, tax checks, capacity, provider
recovery and security checks survive. No “about 70 modules” deletion by filename:
the implementing child records each exported function as retired, retained or
replaced, and removes its callers/tests/docs together. A mixed-responsibility
module can shrink without being deleted. Permanent invariant ids become
retirement stubs pointing here, never disappear or get reused.

### Evidence required before a switch

Proof must cover the whole population and both directions, not just balanced
sums. Extend #3583's read-only RepeatableRead census and #3584's corpus rather
than creating a competing definition. Require zero unexplained differences,
zero missing sources, unique applications, exact tax/coding sums, per-member
credit conservation, group/family conservation and agreement between legacy
booking lines and journal projections. An acknowledgement is specific to its
booking/field/cents; it cannot waive an unbalanced journal or fabricate missing
cash. The owner resolves the already-open private history decisions and runs
production proof privately; agents use only synthetic fixtures here.

[#4460](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4460)'s stateful
Xero/Stripe fakes are prerequisites for activating each provider pair. Test
render → ingest → no new economic posting, and inbound fact → render → echo →
no duplicate, for **every** row of sections 4/7 and section 9. Contract fixtures
must exercise actual provider object shape/status restrictions; no live provider
is used. Generated sequences include duplicate delivery, reversed order, equal
stamps/amounts, partial payments, failed-later refunds, outside spend/undo,
allocations removed, locked periods, disconnect/reconnect and crashes before or
after every external/local commit. Compare economic projections and exact
source/coverage identities, not local ids generated on each run.

PostgreSQL tests must refuse unbalanced/incomplete/extended batches, duplicate
source/reversal attempts, forbidden direct/import/SQL writes and all parent
cascade paths. Race proofs include inbound void against outbound completion,
receipt against cancel, two credit spenders, two refund answers and old/new
worker drain. Mutation probes remove a balancing leg, source key, claim, version
check, terminal-void rule or import restriction and must fail meaningfully.
These are requirements for implementation children, not tests run by this
documentation task.

During B–F rollback can revert readers while journal-backed compatibility remains
complete; inbound authority must not be rolled back to stale legacy recounts.
Rebuild their projections under a controlled drain before that boundary is
crossed. Before G save durable per-row legacy values and ship a dry-run-first
reconstruction tool, prove it with post-switch events and parity. After H a
schema rollback alone does not restore money. Never restore a production backup
as an automatic downgrade and lose intervening events.

## 9. Parked-bug acceptance matrix

Every original triage scenario remains an executable acceptance requirement,
even if a narrow fix has since shipped. This table is the complete 33-row list
from [#4461's test-list comment](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4461#issuecomment-6415525566),
which [#4451](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4451)
identifies as “removed by the ledger switch”. A rule makes the erroneous
representation impossible only when its writer, constraints, source links and
rendering are active and its test passes; this design closes no bug by itself.

| Bug | Scenario required | Posting rule and structural reason |
| --- | --- | --- |
| #3879 | Cancelled-booking credit restore stays a restore whatever its date | R10: original-application link and `RESTORE` event kind, never a date-based cancellation-credit classifier |
| #3911 | Voiding an edit credit on an unpaid bank booking leaves it unpaid with no cash | R07/R23: reverse only the identified application; no Bank receipt exists to count |
| #3992 | One change fee appears on one document after primary void/reissue | R03: unique fee component and section 7's signed live coverage; replacement transfers coverage, never creates another fee |
| #3993 | A card-refunded reduction creates one credit and no nightly missing-credit finding | R02/R05/R12: one reduction/refund identity; composite document coverage prevents two credits and the coverage monitor sees the same manifest |
| #4051 | Retried late-capture note counts once; voided note stops counting | R24/R23: exact source/manifest identity, terminal tombstone and signed coverage, not succeeded-operation sums |
| #4069 | Unpaid bank amount stays owing regardless of booking status | R01/R07: derive obligation outstanding from charge minus applications; operational booking status cannot zero AR |
| #4200 | Inbound void and new refund-note recording finish without deadlock or loss | R23 and section 3's common business-row-before-object order; journal and coverage outcome commit under one guarded claim |
| #4219 | Outside spend writes credit down and releases booking credit as owed | R22: exact release plus lot write-down in one transaction, unchanged free balance, no duplicate Xero grant |
| #4279 | A repair losing its claim after a void cannot leave a live link | R23: object-head terminal check and guarded export completion; returned id is evidence, not active coverage |
| #4284 | Two equal simultaneous refunds settle their own debts consistently | R12/R14: exact obligation/application ids, no amount/time matching or unstable ordering |
| #4286 | Hand-made Xero refund-request note is recorded once and clears finding | R23: exact task/manifest adoption through the inbound door; coverage rather than another refund posting clears the monitor |
| #4292 | Bank group child refund credits the combined invoice once | R15/R14: child obligation traces to organiser receipt and combined charge coverage, not a child invoice |
| #4315 | Bank edit hand-back counts as refunded only after payment | R05/R14: payable at entitlement, Bank leg only at evidenced completion; note arrival cannot pay it |
| #4322 | Hand-refunding card money never received by Xero creates no booking-invoice credit | R24/R12: no coverage of that receipt means no credit against that invoice; preserve legacy record-by-hand handling |
| #4324 | Kept 8000-cent change capture appears once on its change invoice | R03/R24/R06: exact change obligation and receipt application; no second kept-charge invoice where already billed (`INV-PAY-144`) |
| #4328 | Several bank refund notes summing to refunds show no mismatch | R14/R23: sum distinct signed coverage/application components, never compare each note to a whole-payment total |
| #4336 | Old live reading cannot revive a voided refund note | R23 and section 6: terminal tombstone before timestamp comparison |
| #4347 | Old reading cannot revive/count a voided account-credit note | R09/R23: same object-head terminal rule; grant liability and document coverage stay distinct |
| #4362 | Fully-credit-paid or zero-priced booking posts charges and balances zero | R01/R10: charges are independent of cash settle; credit applies equal liability, explicit zero event needs no fake receipt |
| #4369 | Failed card refund then bank hand-back shows Stripe return and separate bank payment | R13 reverses the card refund; R14 pays the same RP by bank; section 7 renders #4361's reversal plus bank note |
| #4370 | Later Xero note cannot make failed card refund count again | R13/R23 and ownership: Stripe owns card cash; Xero changes coverage/applications only |
| #4380 | Late 5000-cent capture/refund on cancelled booking leaves matching Xero pair, net zero | R24/R06/R12: matched source pair and per-capture manifest; no unrelated cancellation invoice credit |
| #4381 | Paid-another-way close records kept 8000-cent change once on invoice already billing it | R24/R14: distinct retained receipt and bank hand-back with exact obligation/coverage; no repeated change revenue |
| #4382 | Kept capture survives a failure after the keep step | R24: keep decision, posting and export intent are atomic; durable manifest resumes missing provider step |
| #4383 | Refund note for 8000-cent capture with 5000 recorded never exceeds recorded slice | R12 and section 7: source-specific 5000 coverage cap; remaining receipt/refund pair requires its own proved export |
| #4391 | Voided request note reverses once and asks the treasurer once | R23: unique reversal of provider-owned application/legacy fact and unique conflict task; independent cash is not silently reversed (section 10) |
| #4413 | Repaired invoice for unpaid supplementary request reaches Xero unpaid | R02/R25/R07: charge exists, receipt does not; rendering cannot infer payment from booking status |
| #4431 | Manual credit has one note at approval and spend uses it | R11 then R10: grant event and funding-note identity, no delayed second grant at consumption |
| #4434 | 8000-cent capture with only 5000 room is recorded fully across correct invoices | R06 plus section 7: applications/coverage sum to 8000; 3000 cannot disappear into an AmountDue clamp |
| #4435 | Crash retry records its own receipt despite sweep using same reference | R06/R07: capture/payment source id and manifest identity, not shared invoice reference/amount |
| #4444 | Card refunded display retains earlier edit credit after any later Xero event | R12/R23: compatibility display sums distinct cash and application components; later snapshot cannot overwrite another source's posting |
| #4447 | Removing an allocation lowers its contribution to refunded display | R23: exact application reversal; independent cash-return component remains unchanged |
| #4449 | Cancel racing bank settle sees invoice-correction contribution | R04/R07/R23: common locking/claim transaction commits source application, projection and settlement together; cancel re-reads after locking |

## 10. Decisions

The scope, two-way direction, ledger-first priority and bank-transfer method
were settled on 27 Oct 2026. The three narrower choices below were decided by the
owner on 28 Oct 2026 (decision pop-ups in the Sekreton orchestrator session,
[recorded on #4461](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4461#issuecomment-6472136228)).

### D1. Financial history when a booking is deleted (#4482): keep it

Financial records outlive the booking's operational use. The legacy and new
financial relationships use RESTRICT; a booking that has money is archived or
soft-deleted, never hard-deleted; and immutable economic identities are retained.
Personal-data minimisation and erasure follow the separate retention schedule
(#4457), including the existing decision about copied charge descriptions.
Not taken: a parent-delete trigger, or permitting financial-history deletion.

### D2. Legacy bank hand-backs inferred from a voided Xero note: keep the cash, ask once

Actual Stripe or officer cash evidence is preserved. Only the voided
provider-owned application, or the legacy note-derived fact, is reversed. An
officer is asked once whether each inferred hand-back really occurred, and
further automatic payout on that obligation is held until they answer. A
confirmed transfer becomes a separately sourced fact, not a revival of the
voided note. No migration may mark legacy void scenarios #4391/#4315 passed by
silently choosing a meaning for "refunded". New views distinguish cash
returned, credit applied and payable. Not taken: applying the legacy "void
undoes hand-back" rule to independently evidenced bank payments.

### D3. Tax and recognition: keep each charge's actual treatment

Each existing charge keeps its actual tax treatment and date. Future treatment
and recognition are club settings, defaulted from the existing Xero document
policy where Xero is connected, and from a global app setting where it is not.
**History must establish the split** (owner): the back-post derives each
historical charge's tax cents from the club's GST registration and the tax code
in force on the charge date, including card charges never invoiced in Xero and
group payments split across places. A charge whose split cannot be derived is
a defect to fix before that cohort activates, never a guess and never a
permanent block. Receipts and refunds post their full known gross cents. The
scope still excludes GST returns and does not assume every adopting club is
GST-registered. Not taken: a new universal tax or recognition basis.

## 11. Proposed children, in shipping order

The owner approves this design before these issues are filed or built. Labels
M1–M18 below are local proposal ids, not issue numbers. Each row can remain on
`main` indefinitely with a complete outcome; inactive posting/verification is
useful evidence without requiring its consumers to ship simultaneously. A row
that names existing work updates that work's contract after approval rather
than opening a competing implementation lane.

| Order / proposed title | Scope and independently shippable outcome | Dependencies | Risk |
| --- | --- | --- | --- |
| M1 — Protect and verify balanced member journals | Add inert journal/events/applications/source bridge, balance/seal/mandatory-link constraints, account registry, grants and verifier; prove direct SQL refusal and no late batch extension. Extend #4453 provisioning. | Design approval; D1 (decided: RESTRICT and archive) for deletion contract; #4453 available | High: schema/security |
| M2 — Retain ledger history across booking deletion | Deliver chosen #4482 solution for old booking lines and new financial parents; update archive/erase flows, retained identity and adopter notes. Prove every parent DELETE/UPDATE route. | M1, D1, approved retention compatibility | High: lifecycle/schema |
| M3 — Post payable booking charges and edits once | R01–R04/R21 with existing line/source bridge, draft/quote boundary, bank-transfer-before-settle charges, fees and promotion evidence; comparison report, no reader change. | M1 | High: prices/lifecycle |
| M4 — Post captures, refund obligations and exact cash answers | R05–R08/R12–R14/R24, provider-status reversals, durable attempts and application caps; preserve #4361 holds/answers/keys and markers. Keep old decision projections. | M1, M3; reconcile current #4361 children | Critical: payout/double-pay |
| M5 — Post member credit through one liability | R09–R11/R22 planning, funding lots, approvals, restore provenance and compatibility `MemberCredit` linkage; conservation report, no new provider authority. | M1, M3; M4 for refund-to-credit obligations | High: credit/money |
| M6 — Post organiser receipts and child obligations | R15 with combined invoice/source coverage, one cash receipt and frozen child applications/refunds; prove group sums and avoid child double counting. | M3–M5 | High: group settlement |
| M7 — Post subscriptions and joining/member fees | R18–R20 from immutable snapshots, family recipient/coverage, manual-paid/cancellation behaviour; local charge evidence works without Xero delivery. | M1; M4 for settlement adapters; D3 before tax activation | High: membership/money |
| M8 — Record provider fees and clearing transfers | R16/R17, source-identity fee/payout evidence and reversal, settings/account coding; clearing report without bank-reconciliation UI. | M1, M4; #4460 contract fixtures before provider activation | High: provider/accounting |
| M9 — Prove and back-post the complete journal | R26 dry-run/apply tool, exact adopted provider coverage, missing-source report and structural/legacy parity census, owner-run command card and tested rollback reconstruction. No read switch. | M2–M8; D3; discharge original #3584 history blockers | High: historical money |
| M10 — Route every Xero member-money change through one door | Versioned inbox/object heads, ownership registry, echo/stale/void handling, outside-spend/reversal and tasks; cohort activation plus old-worker drain and journal-derived compatibility. Remove replaced recount mutations. | M4–M9, D2/D3, #4460 proofs for each pair | Critical: inbound authority/concurrency |
| M11 — Establish #3584 reader projections and parity | Shared pure statement/balance/store and golden corpus, extend existing parity census to journal accounts without moving a surface. | M9; existing whole-history `GATE_OPEN` | High: reader correctness |
| M12 — Move #3584 surfaces in their approved order | Separate reader PRs: officer panel, member panel, history, confirmation, finance, modification email and data export. Preserve blueprint pins, instrument reads and approval rules; each surface reverts alone. | M11; each surface's parity/decision gates; M10 before exposing newly accepted inbound facts | High: member-visible money |
| M13 — Render all Xero member-money documents from manifests | Fold #3585 into pure rendering/coverage/adoption for bookings, groups, credit, subscriptions, fees and Stripe events. Ship separate document cohorts with legacy-key continuity and complete round-trip proof. | M9–M11, M10, #4460, D3; relevant #4361 stage approvals | Critical: external accounting |
| M14 — Receive internet-banking payments without Xero | Configured bank details, stable unique references, finance permission/audit receipt workflow, partial receipt and duplicate/source association; journal-derived status and member instructions. No statement/invoice sending engine. | M4, M7, M11 and applicable M12 views; independent of M13 | High: money/auth/UI |
| M15 — Move the remaining financial decision inputs | #3586 blueprint's C5b/C6b/C5c scopes: extra screens/SQL, Xero non-line amounts, refund/cancel/ask decisions, diagnostics, backup sentinels, operator tools; one cohort per PR, preserved collection policy and exact legacy-case resolution. | M10–M13, all relevant reader proof; reconcile #4361 exact-answer migration | Critical: decisions from money |
| M16 — Stop writing mirrors and retire reconstruction | #3586 stop-writing release: compatible nullable/ignored columns, remove writes and mirror-only guards, contract census, remove drained repair arms, executable reconstruction/downgrade rehearsal and operator rollback records. | M15 deployed/drained, M14 behaviour covered or no old IB dependency, all source/repair inventories closed | Critical: blue/green money |
| M17 — Drop six obsolete money columns | #3586 contract release, migration ledger/rollback, old-client rehearsal; no unrelated transaction-field or build-up deletion. | M16 deployed, old colours drained, owner timing | Critical: destructive schema |
| M18 — Retire drained compatibility and legacy backfills | Remove old writable credit/booking compatibility plumbing and obsolete repair/backfill exports after proving zero callers, unresolved legacy operations or rollback dependency; retain posted history and coverage monitor. Further schema contracts are separate later releases. | M17, closed rollback window and per-module evidence | High: cleanup/data retention |

M12 is the existing explicitly multi-PR reader programme; M13 and M15 likewise
split by complete document/decision cohorts when filed. Each PR must have one
bounded owner-approved issue scope, independently useful output and its own
rollback. The ordering does not authorise parallel writers on a shared financial
invariant. #4451 group-1 harm fixes continue under their own authority; parked
bugs close only when their section 9 scenarios actually pass through the real
new writers, PostgreSQL and #4460 fakes.

## 12. Related references

The current implementation remains governed by its existing invariants until
an approved child updates them in lockstep. Start with the
[documentation hub](../README.md), [booking-ledger design](booking-ledger.md),
[Xero architecture](../xero/ARCHITECTURE.md),
[payment and settlement invariants](../invariants/payment-and-settlement.md),
[money invariants](../invariants/money.md),
[locking guide](../CONCURRENCY_AND_LOCKING.md) and
[fee authorities](../AUTHORITATIVE_FEES.md).

Read the complete threads before implementing: [#3527](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3527),
[#3532](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3532),
[#3584](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3584),
[#3585](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3585),
[#3586](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3586),
[#4219](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4219),
[#4361](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4361),
[#4450](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4450),
[#4451](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4451),
[#4453](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4453),
[#4460](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4460),
[#4461](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4461) and
[#4482](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4482).
