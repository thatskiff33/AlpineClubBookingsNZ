## #3413 naming repair blueprint for renewed owner plan review

Composition review at 9ada2fe44 found that choosing a differently priced second quote option, or accepting a revised quote that reused held beds, leaves provisional held guest prices from earlier terms. Naming currently rejects that hold and prevents conversion. The existing blueprint's stop condition requires renewed owner review when naming would change price/consent; this repair would update provisional held price rows while preserving the immutable accepted price and consent.

### Proposed repair

Use the existing accepted-name-resolution transaction and its global → lodge lock order. Re-read the request, hold and immutable accepted snapshot; preserve the version/status claim, held-party identity, lodge/date envelope, exact unnamed-night reservations, conversion gate and accepted quote/option/price/snapshot. Validate a mapping from the original quote's named rows and pending-slot ordinals to the current party, including adults resolved in earlier partial calls. Refuse missing, ambiguous or inconsistent mappings before writes.

After a successful claim, reconcile existing held named guest and guest-night cents, plus held booking total/final cents, to the selected accepted snapshot. Preserve guest IDs, linked member/rate type, consent, dietary and bed identities. Then materialize the submitted pending-adult slice at those accepted cents and swap its reservations atomically. An error rolls back the claim, repricing, names and reservations together. A lost claim performs no side effect. No invoice, payment, provider call, new advisory key, migration or accepted-terms rewrite is added.

The alternative is repricing during requester acceptance, which would add a lodge-tier and held-price writer to an operation that currently claims request/quote state. I recommend repairing the existing naming writer because it already holds both tiers and materializes these accepted prices.

### Related identity correction

The current member-match check uses canLogin as a membership proxy. Use the canonical seasonal membership-type policy for all active name/email matches; stop for review of genuine MEMBER_RATE identities even with login disabled, retain existing login/consent protection, and allow legitimate nonlogin NON_MEMBER/SCHOOL contacts. This implements the already approved stop-for-member-terms rule; it does not infer new member links or reprice an accepted person.

### Validation and recovery

- Real-PostgreSQL send → accept nonfirst option → partial/full naming → officer approval, with exact capacity and accepted snapshot/cents preserved.
- Revised quote with an existing hold, then accept → name → approve.
- Unequal per-guest cents and resolved-adult index shifts; malformed or ambiguous snapshots; a failed claim and injected mid-transaction failure produce no persisted mutation.
- Login-disabled MEMBER_RATE match is refused; legitimate nonlogin NON_MEMBER contact remains resolvable.
- Re-run affected money/guest-night/lock/occupancy censuses and update the existing naming-writer inventory; exact-head CI and final compose review remain required.

The existing maintenance-window cutover and zero-pending-count/zero-reservation rollback remain binding. No production operation is authorized. Stop for review if this needs an accepted-terms/consent change, settlement mutation, a different lock topology, or a guessed identity mapping. PR #3719 auto-merge is disabled until the repair is reviewed and validated. Regression preparation and the already approved identity guard can proceed; provisional price-writer implementation waits for owner plan review.
