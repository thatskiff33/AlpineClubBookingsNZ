# Paid future-booking import engine

Audience: Developer, Agent.

This engine carries over fully paid future stays at what the club actually
received, without charging or notifying anybody. It is child A of #5005;
there is deliberately no route, screen or operator command yet. Reversal is
child B; access, both officer permissions and the moving-in guide are child C;
refund as account credit is D; part-paid support is E, after #5008.

## File and preview

`parseBookingImportCsv` reads one row per guest, grouping by Booking Ref in
file order. The member import owns CSV/date reading;
`member-import-identity.ts` owns the shared `memberImportIdentityKey`; `parseDecimalDollarsToCents` owns amount reading.
Every guest supplies an amount, or the first guest supplies the whole total.
The latter is shared across guest-nights. A mix, a blank first amount or a
Nights mismatch refuses the booking. Balance Owing or Balance Due Date refuses
it with "part-paid bookings cannot be imported yet". Free stays explicitly
supply zero.

The parser retains valid dated demand even for refused rows, so the preview
shows beds already sold elsewhere. Malformed dates cannot contribute a known
night; malformed amounts cannot contribute a known value. Their refusal stays
visible. Resource bounds reuse the member import's row cap, bound individual
stays and their envelope, and reject a file total beyond integer-cent storage.

`planBookingImport` writes nothing. It matches owner and member guests by email
and names, refuses missing or ambiguous identities, checks the selected active
lodge, the club's day, live references and member-night conflicts, and calls
the shared hosting, supervision and capacity rules. Rule failures direct the
officer to Book on Behalf. Earlier accepted guests join later capacity proposals
through the canonical capacity engine; rejected proposals consume nothing.

Totals separate accepted and refused bookings, guests, guest-nights and cents.
Refused totals group by the first reason, so they sum to the overall refused
total; each row still carries every reason. Night rows show capacity, existing
occupancy, accepted beds, refused sold beds and projected occupancy from the
capacity engine (including custodian overlap). Current app rates and their
difference from the imported price are a typing check, never a refusal.

The batch key hashes the lodge and normalized parsed content. The digest also
binds the file's identity, row outcomes, refusal text, prices, guest-night demand
and nightly capacity figures. For resumability it counts an already imported
bed together with the batch's remaining proposed beds; that progress alone
cannot invalidate confirmation. Changed content or fresh preview figures returns
`stale` before any batch or booking is written.

## Confirmation and history

`confirmBookingImport` resolves journal tax context before opening a transaction;
a failed settings read stops before the first row. Each booking then takes the
[documented locks](../CONCURRENCY_AND_LOCKING.md#paid-future-booking-import-5005-child-a),
repeats the checks and claims its row. The booking starts PAYMENT_PENDING at
the imported price, with canonical EVEN_SPLIT guest-night rows. Beyond-family
member guests are officer assignments, never pending consent requests.

Paid rows call `settleImportedBookingInTransaction`, a sibling entry into the
one manual settlement body. Free rows use the existing zero-price confirmation
and ledger posting. Neither creates invoices, card objects, email or recovery
work. The shared `bookingHasExternalSettlement` fence also prevents a later
invoice queue or handler from minting a document for an imported free stay,
whose zero payment has no manual provenance; the Xero repair check and the
missing-invoices list read the same fence. A paid import is fenced by its manual
provenance alone, so once that settlement is reversed it is invoiceable like
any reversed cash booking. Automatic bed allocation is the ordinary lifecycle reconciliation. Events
commit with the booking; the hosting drain and audit run after commit.

The batch stores the confirming officer, time, original file totals and each
row's result. It stores no uploaded CSV or parsed identity payload. Actor ids
are plain audit snapshots. The per-lodge live-reference partial index backs
idempotency across batches. See the [batch lifecycle](../STATE_MACHINES.md#paid-booking-import-batch-lifecycle-5005-child-a).

Cancellation and edits use existing cash-booking behavior: cancellation raises
a manual refund task, and Mark paid back records its settlement. There is no
refund-as-credit choice in this child. The ledger projection/journal census is
exercised after import, free confirmation, cancellation, hand-back, edits and
member merge by `booking-import.realdb.test.ts`.

## Related contracts

- [Architecture](../ARCHITECTURE.md#paid-booking-import-engine)
- [Capacity](../CAPACITY_MODEL.md#imported-paid-future-bookings-5005)
- [Payment invariant INV-PAY-155](../invariants/payment-and-settlement.md#inv-pay-155)
- [Capacity invariant INV-CAP-040](../invariants/booking-dates-and-capacity.md#inv-cap-040)
- [Member-money journal](member-money-ledger.md)
