/**
 * The REVIEWED audit-writer census manifest (#2581).
 *
 * `audit-writer-census.ts` measures the tree. This file records what a human
 * decided about the measurement, and `src/lib/__tests__/audit-writer-census.test.ts`
 * fails when the two disagree. That is the whole mechanism: a new audit writer
 * that omits a category, an invented category value, a hand-written Prisma write
 * to `AuditLog`, or a wrapper that stops writing, all land as a named CI failure
 * instead of as a row nobody can filter for.
 *
 * WHY THE PINS ARE COUNTS AND IDENTITIES RATHER THAN A THRESHOLD. "No more than
 * 82" would let a new writer in every time an old one was fixed. The pin is the
 * exact SET of uncategorised writers, so fixing one and adding another is a
 * failure in both directions — the fix has to remove its entry here.
 *
 * IDENTITIES ARE SYMBOL-KEYED, NOT LINE-KEYED, deliberately. Line numbers in
 * this area move constantly: PR #2618 alone moved the deletion-request writers
 * from lines 131/403 to 293/649 without touching a single audit argument. An
 * identity is `<repo-relative path>::<enclosing symbol chain>#<ordinal among
 * sites sharing that symbol>`, which survives a reformat and a rebase. It does
 * NOT survive a new writer earlier in the same symbol, which renumbers the
 * ordinals after it — so the honest way to move this file is to run the census
 * and land what it reports, never to compute a delta by hand.
 *
 * WHAT CHILD 1 RECORDED AND CHILD 2 APPLIED. Child 1 measured 82 uncategorised
 * writers and carried a reviewed `proposedCategory` for each, deliberately
 * changing none of them: a recommendation cannot widen anybody's access, and
 * each site also changed the row's RETENTION, so each needed its transaction
 * and failure semantics reviewed per writer family. Child 2 did that review and
 * applied all 82. `UNCATEGORISED_AUDIT_WRITERS` is therefore empty and stays
 * pinned empty; the answers it used to carry now live in
 * `APPLIED_AUDIT_CATEGORIES`, which pins the per-site classification so a
 * SWAP between two categories cannot hide inside an unchanged distribution.
 */

/** A canonical audit category, as a plain string so this file needs no `src/` import. */
type ProposedCategory =
  | "account"
  | "booking"
  | "payment"
  | "family"
  | "admin"
  | "security"
  | "lodge"
  | "xero"
  | "communication"
  | "privacy"
  | "system"
  /** A dynamic action family whose category depends on the action (#2581 decision 6). */
  | "split";

/**
 * The measured shape of the census on this commit.
 *
 * These are the numbers #2581 argues from, and they are pinned because the issue
 * has already been argued from three stale ones: the title says 81, an earlier
 * comment says 350 total, and the Diagnostics docblock said "81 of ~350".
 */
export const AUDIT_CENSUS_TOTALS = {
  /**
   * Row-producing production write sites across `src/`, `scripts/` and `prisma/`.
   *
   * 418 -> 419 (#2627): releasing a started deletion approval writes
   * `member.deletion_approval_claim_released` with the awaited `createAuditLog`,
   * inside the release's own transaction, because that row is the only surviving
   * record of who held the claim the transition destroys. Categorised `privacy`
   * at the site, so it does not join `UNCATEGORISED_AUDIT_WRITERS` below.
   *
   * 419 -> 420 (#2623): the waitlist-confirm route records
   * `waitlist.confirm_offer_release_failed` when its compensating offer release
   * cannot run, because that state is operator-only — no cron sweeps it and the
   * member has nothing to retry — so the audit row IS the recovery surface. It is
   * categorised `booking`, `critical` severity, and carries `entityType`/`entityId`
   * so it correlates to the booking. (#2627 and #2623 landed in the same window and
   * both claimed 419; the pin has to count BOTH, which is exactly what this file
   * exists to catch.)
   *
   * 419 -> 420 (#2352 MC-03D): deleting a page-content page writes
   * `PAGE_CONTENT_DELETED` inside the delete's own transaction, because the row
   * carries the deleted page's whole `before` snapshot and is the only record of
   * what was removed. Written with `buildStructuredAuditLogCreateArgs` through
   * `tx.auditLog.create`, matching the three sibling writes already in that
   * route rather than introducing a fourth form; categorised `admin` at the
   * site, so it does not join `UNCATEGORISED_AUDIT_WRITERS` below.
   *
   * 420 -> 421 on the MERGE, and this is the gate earning its keep for the second
   * time in one window. #2623 and this change each measured 419 -> 420 against a
   * base without the other, so both literals read `420` — byte-identical, which
   * means git resolved the VALUE silently and only the comments above collided.
   * The merged tree has both writers, so the honest number is 421. It came from
   * running the census after the merge; adding the two deltas up would have got
   * there by luck, and reading either side's literal would have shipped a pin
   * that was quietly one short.
   *
   * 421 -> 423 (#2621): the expected-arrival-time route recorded nothing at all,
   * and a Booking Officer may set that field on ANY member's booking (#1313
   * option A2) — so a member seeing a time they did not set had no way to learn
   * who set it. Its PUT and its DELETE now each write one `logAudit` row
   * (`booking.expected_arrival_time.set` / `.cleared`), categorised `booking` at
   * the site, and both carry `entityType`/`entityId` so they correlate to the
   * booking; neither joins `UNCATEGORISED_AUDIT_WRITERS` below. (Re-measured on merged
   * tree, #2621: this branch's own pins were taken against a base that predated
   * #2352, #2623 and #2627, so the literals here come from running the census
   * after the merge rather than from adding the deltas up.)
   *
   * 421 -> 423 (#2595): the new `bed-allocation-move.ts` records the two things
   * a reviewed move does — `BED_ALLOCATION_MOVE_APPLIED` for the move itself and
   * `BED_ALLOCATION_PARTNERS_PROMOTED` for the partner rows it carries with it —
   * each with the awaited `createAuditLog` inside the move's own transaction, so
   * a rolled-back move records nothing. Both categorised `lodge` at the site, so
   * neither joins `UNCATEGORISED_AUDIT_WRITERS` below.
   *
   * And the gate fired a THIRD time on the merge of #2637 into this branch.
   * This branch measured 422 against a base holding #2623 and #2627 but not
   * #2352's `PAGE_CONTENT_DELETED`; #2352 measured 421 against a base holding
   * #2623 and #2627 but not the two move writes. Neither literal is the merged
   * tree, and the two differed, so this one at least conflicted visibly rather
   * than merging silently. Re-measured on the merged tree by RUNNING the census
   * (`npx tsx scripts/audit/audit-writer-census.ts`), never by adding branch
   * deltas: this figure and the ones below are what the tree reports.
   *
   * 423 -> 425 on the MERGE of #2621 into this branch, and this is the WORST
   * shape the gate has caught yet — worse than the 420 collision above, because
   * that one at least announced itself. #2595 measured 421 -> 423 against a base
   * holding #2352/#2623/#2627 but not the arrival-time writers; #2621 measured
   * 421 -> 423 against a base holding the same three but not the two move
   * writes. Two different +2s, one identical literal: `423`. Git had no textual
   * disagreement to report on the `writeSites` line at all, so it merged the
   * VALUE silently and only these comments conflicted — and a merge that took
   * either comment and kept the number would have shipped a pin two short with
   * a green diff. The sub-figures below are what saved it: `logAudit` 239 -> 241
   * and `createAuditLog` 102 -> 104 sit in different hunks and both survived the
   * merge, so `bySink` already summed to 425 while the total still said 423.
   * Re-measured on the merged tree by RUNNING the census, which reports 425.
   * A byte-identical pin across two branches is not agreement; it is a
   * collision that git cannot see.
   *
   * 425 -> 426 (#2649): the admin repair for a stranded zero-dollar waitlist
   * confirm writes `waitlist.returned_to_waitlist` with the awaited
   * `createAuditLog`, inside the claim's own transaction, because the row is the
   * other half of the `waitlist.confirm_offer_release_failed` trail #2648
   * opened — its metadata carries that row's id, so the strand and its repair
   * are linked in both directions. Categorised `booking` at the site, so it does
   * not join `UNCATEGORISED_AUDIT_WRITERS` below.
   *
   * AND THE GATE FIRED AGAIN ON #2649'S OWN MERGE, IN THE EXACT SHAPE THE
   * PARAGRAPH ABOVE DESCRIBES — a second time in one window, on a different
   * line. That branch pinned `createAuditLog: 104` (102 -> 103 for the repair
   * route, 103 -> 104 for the `logAudit` conversion below); #2595 pinned
   * `createAuditLog: 104` for its two reviewed-move writes. Two different +2s,
   * one identical literal, so git had nothing textual to report on the
   * `bySink.createAuditLog` line and merged the VALUE silently while only the
   * comments above it collided. That merged tree held all four writers, so the
   * honest figure was 106 and neither side's literal was it. Nor was
   * `writeSites` self-checking there: #2649's total moved 423 -> 424 (+1 net,
   * because the `logAudit` conversion moves a site between sinks rather than
   * adding one), main's moved 423 -> 425, and that merged truth was 426 — a
   * number reachable from neither literal alone.
   *
   * 426 -> 427 (#2581 child 2): the member bulk-update writer became TWO
   * writers. It was one call site emitting `member.bulk-${action}` over a
   * three-value enum whose members affect DIFFERENT domains — `set-role` is a
   * permissions change, `deactivate`/`reactivate` are account changes — so
   * decision 6 splits it. Written as two calls with LITERAL categories rather
   * than one conditional, because the "chooses no category by WHO ACTED" pin
   * allows no conditional at all and the honest way to satisfy it is to let
   * each branch state its own answer where a reader and the scanner can both
   * see it.
   *
   * AND IT FIRED ON THIS MERGE TOO, ON THE `writeSites` LINE ITSELF — the third
   * silent one, and recorded here rather than just corrected so the next lane
   * can see how routine this has become. #2649 measured 425 -> 426 against a
   * base without the bulk-update split. This branch measured 425 -> 426 against
   * a base without #2649's repair writer. Two different +1s, one identical
   * literal: `426`. Git had no textual disagreement to report on the
   * `writeSites` line, so it merged the VALUE silently and only these comments
   * collided — exactly the 420 and 423 shape above. The merged tree holds both
   * writers, so the honest number is one neither side stated. Both `bySink`
   * lines collided the same way (`createAuditLog: 106` on both sides from two
   * different +2s) and survived only because their `uncategorised` halves
   * differed, which is a property of THIS pair of branches and not a safeguard.
   * Re-measured on the merged tree by RUNNING `npm run audit:census`, never by
   * adding deltas: 427 row-producing sites, `logAudit` 241, `createAuditLog`
   * 108, `auditLog.create` 70, `booking` 101, uncategorised 0.
   *
   * 426 -> 426 (#2677), on `main`, and kept here because the lesson is this
   * manifest's and not that PR's. Recorded even though nothing moved, for the
   * same reason the view-only ledger records its no-op merges: "the figures did
   * not move" is worth something only when somebody RAN the census to find that
   * out. #2677 adds no audit writer, and the census on ITS merged tree reported
   * 426 / `logAudit` 240 / `createAuditLog` 106 / `auditLog.create` 72 /
   * `createStructuredAuditLog` 8 / uncategorised 82 — every pin unchanged there.
   *
   * But the collision fired anyway, on the PROSE half, which this manifest had
   * never covered. The total has THREE prose copies and no test reads any of
   * them: `docs/ai-diagnostics/tool-pack-support.md`,
   * `docs/guides/audit-log.md`, and the `support-correlation.ts` docblock.
   * #2677's branch had set all three to 425; #2649 on `main` corrected only the
   * first. So that merge conflicted on the one file both sides had edited — the
   * lucky case — and merged the other two CLEANLY at 425 against a tree that
   * said 426. Same shape as the byte-identical `bySink.createAuditLog` merge
   * above, minus the luck: there, two equal literals hid a real disagreement;
   * here, two unedited-on-`main` copies hid a real correction. The durable
   * lesson is the one this manifest already exists to teach, extended one file
   * class outward: a figure that no test reads WILL drift, and a clean merge of
   * a measured figure is not agreement.
   *
   * 427 -> 427 (#2677 merged into this branch). All three prose copies plus this
   * ledger conflicted on that merge — the lucky case in every file, because this
   * branch had rewritten each of them for the 82 -> 0 sweep while #2677 was
   * correcting the same sentences. Every conflict was resolved to this branch's
   * text, which already reads 427 / 0, and the result was re-measured by RUNNING
   * `npm run audit:census`: 427 row-producing sites, `logAudit` 241,
   * `createAuditLog` 108, `auditLog.create` 70, `createStructuredAuditLog` 8,
   * uncategorised 0 — unchanged, because #2670 and #2677 add no audit writer
   * between them. `filesScanned` moved 1894 -> 1895 for #2670's new module.
   *
   * 427 -> 428 (#2700): soft-deleting a cancelled booking now asks Stripe to
   * cancel the booking's in-flight PaymentIntents after the transaction
   * commits, and a cancellation that FAILS writes
   * `booking.delete.payment_intent_cancel.failed`. That outcome — the booking is
   * gone but money can still be captured against it — was previously visible
   * only in the server log, and the soft-delete's own audit entry is written
   * inside the transaction BEFORE Stripe is called, so it cannot carry it.
   * `logAudit`, because the whole cancellation path is deliberately
   * best-effort and auditing the failure must not become a new way for it to
   * throw. Categorised `payment` at the site, so it does not join
   * `UNCATEGORISED_AUDIT_WRITERS` below, and it carries
   * `entityType`/`entityId` so it correlates to the booking.
   *
   * 428 -> 429 (#2760): the automatic-refund record write can fail, and when it
   * does nothing else in the tree ever writes that row —
   * `handleCancelledBookingAdditionalPaymentSucceeded` answers 200 so the money
   * is not re-refunded, which means Stripe never redelivers and the bookkeeping
   * row is gone for good. `INV-ADDPAY-037` and the finance card both now assert
   * that the record is complete, so the gap has to be findable on the surface the
   * card itself names as the permanent record:
   * `booking.payment.auto_refund_record_failed`, `severity: "critical"`,
   * `outcome: "failure"`, categorised `payment` at the site and carrying
   * `entityType`/`entityId`. `logAudit` for the same reason #2700's sibling above
   * uses it: the block it sits in is already the handler's must-never-throw
   * region, and an audit write that threw would turn a lost row into a replayed
   * refund path.
   *
   * 429 -> 431 (#2773 / #2774), and the arithmetic is NOT "+2 new writers" — it is
   * one writer MOVING and two genuinely new ones, which nets to +2 and is spelt out
   * because the move renumbers a pinned ordinal (see the two entries at
   * `handleCancelledBookingAdditionalPaymentSucceeded` below).
   *
   * - MOVED: `booking.payment.auto_refund_record_failed` left
   *   `handleCancelledBookingAdditionalPaymentSucceeded` for
   *   `cancelled-booking-late-capture.ts::recordAutomaticLateCaptureRefund`. #2773
   *   routes the SECOND late-capture handler (a booking's own payment) through the
   *   same record-and-alert machinery, and copying twenty lines of catch-and-audit
   *   into it is the two-implementations-of-one-rule defect this repository keeps
   *   re-finding. So the epilogue is shared and the write site moved with it. Net
   *   zero on the total; not zero on the ordinals.
   * - NEW: `booking.payment.late_capture_refund_withheld`
   *   (`reportWithheldLateCaptureRefund`). #2774's fence: a `COMPLETED`
   *   `ManualRefundTask` means an operator already paid the member back by hand and
   *   `applyLocalRefundAllocation` recorded it, so Stripe's refund on top of it pays
   *   the member TWICE. The refund is withheld, and this row is how a person finds
   *   out. It deliberately is NOT
   *   `booking.payment.refunded_after_cancellation` — that action is named by the
   *   finance card as the permanent record of an automatic refund, and no refund
   *   happened. `severity: "critical"`, `outcome: "blocked"` (a guard refused an
   *   action; nothing failed).
   * - NEW: `booking.payment.late_capture_double_refund_suspected`
   *   (`announceAutomaticLateCaptureRefund`). The residue the fence cannot close: the
   *   hand-completion committed inside the webhook's own Stripe round trip, so the
   *   refund went out anyway and the member has probably been paid twice. Closing
   *   the window would mean holding `pg_advisory_xact_lock(1)` across a provider
   *   call, which `docs/CONCURRENCY_AND_LOCKING.md` forbids, so the exposure is
   *   shrunk to one Stripe call and the residue is reported rather than left silent.
   *   `severity: "critical"`, `outcome: "failure"`.
   *
   * Both new rows are `logAudit` for the reason the moved one is: they sit on paths
   * that must answer the webhook without throwing, and an awaited write that
   * rejected would replay a refund for the sake of recording something about a
   * refund. `filesScanned` moved 1895 -> 1901 across the merged tree.
   */
  // 428 -> 429 (#2760): `booking.payment.auto_refund_record_failed`, above.
  // 429 -> 432 (#2749): the three Other Lodges admin CRUD audit writers
  // (OTHER_LODGE_CREATED/UPDATED/DELETED), all `auditLog.create`, category
  // `admin`. Re-measured with `npm run audit:census` on the merged tree (432 TS
  // sites; the raw `sql.insert` seed row is tracked in `sqlStatements`, not here).
  // 432 -> 434 (#2773/#2774): the two late-capture writers this branch
  // adds. Re-measured with `npm run audit:census` on the merged tree.
  // 434 -> 435 (#2822): the email-inheritance effective-source change event
  // (`member.email-inheritance-source.changed`), one `createStructuredAuditLog`
  // inside the reconciler, category `family`. It records a real routing change,
  // so it is a categorised writer, not an `UNCATEGORISED_AUDIT_WRITERS` entry.
  // 435 -> 445 (#2780): the ten maintenance-report writers. Two QR-sign sites
  // (create/rotate and pause/resume, each a dynamic action pair), the settings
  // route's settings.updated / anonymous-enabled-or-disabled / questions.updated,
  // the queue's report.viewed / report.status_changed / report.photo_deleted, and
  // report.submitted on both the member and the anonymous submit route. All
  // `logAudit`, all category `lodge`. Re-measured with `npm run audit:census`.
  // 435 -> 439 (Alpine Central Server, PR #21): the four write sites the
  // integration adds, all `createAuditLog`, all categorised at the site so none
  // joins `UNCATEGORISED_AUDIT_WRITERS`. Three are `lodge` — the manual Other
  // Clubs upload and download, plus the shared failure row in
  // `alpine_server/sync-response.ts` that records a sync that could not run —
  // and one is `admin`, the connection-settings save. Re-measured with
  // `npm run audit:census` on the merged tree, not by adding branch deltas.
  // 439 -> 440 (PR #2949 review): the settings route now AUDITS a refused
  // non-Full-Admin attempt to move the central server address, categorised
  // `security` at the site. A refusal that leaves no trace is the one an
  // operator cannot investigate, and this is a privilege boundary.
  // 440 -> 443 (local database backups): the restore endpoint records THREE
  // rows — started, completed, failed — rather than one on success. A restore
  // overwrites the live database irreversibly and can die part-way, so the row
  // written BEFORE the attempt is the only one guaranteed to survive the
  // incident someone will need to reconstruct; "who asked for this, and which
  // file" must not depend on the restore finishing. All three are `security`.
  // 443 -> 453 (#2780 merged with main): main's three lines above and this
  // branch's ten maintenance writers are DISJOINT additions to the same base of
  // 435, so the merged total is 453. Taken from `npm run audit:census` run on
  // the merged tree rather than by adding one branch's delta to the other's
  // total, which is how a published count goes wrong in a merge.
  // 453 -> 454 (CT-1, #2989): `CLUB_TIME_ZONE_UPDATED`, the one writer on the
  // Full-Admin club-timezone maintenance route. It records the before and after
  // IANA identifier and nothing else — the issue's requirement 6 says in so many
  // words "do not audit unrelated settings payload" — inside the same
  // transaction as the `ClubTimeSettings` upsert, so a rolled-back save records
  // nothing and a pristine re-save (the dirty gate) never reaches the write at
  // all. Category `admin`, the same installation-configuration answer
  // `CLUB_IDENTITY_SETTINGS_UPDATED` gives, so it does not join
  // `UNCATEGORISED_AUDIT_WRITERS` below. Measured by RUNNING
  // `npx tsx scripts/audit/audit-writer-census.ts` on this tree (454 sites,
  // 2109 files scanned), not by adding one to the literal above — which is the
  // only way this file has ever been right after a merge.
  // 454 -> 455 (ENV-SAFETY 1, #3034): the environment-safety override writer.
  // `ENVIRONMENT_SAFETY_OVERRIDE_UPDATED` records who forced this installation to
  // be treated as a copy, or stopped forcing it, and the before/after value of the
  // one flag. Written with `buildStructuredAuditLogCreateArgs` through
  // `tx.auditLog.create` in the same Serializable transaction as the
  // `EnvironmentSafetySettings` upsert, so a rolled-back save records nothing and
  // a no-op (the dirty gate, which counts an absent row as `false`) never reaches
  // the write at all. Category `admin`, the same installation-configuration answer
  // `CLUB_TIME_ZONE_UPDATED` and `CLUB_IDENTITY_SETTINGS_UPDATED` give — NOT
  // `security`, because this changes what the installation DOES rather than who may
  // sign in or what they may reach; the read gate is identical for both anyway. So
  // it does not join `UNCATEGORISED_AUDIT_WRITERS` below. Measured by RUNNING
  // `npx tsx scripts/audit/audit-writer-census.ts` on this tree (455 sites, 2116
  // files scanned), not by adding one to the literal below.
  // 453 -> 459 (#2992 merged with main): the six club message board writers
  // (hide, show, edit, remove, retention settings, manual cleanup). Taken from
  // `npm run audit:census` on the MERGED tree, by the method the #2780 note
  // above sets out -- not by adding this branch's delta to main's total.
  // 459 -> 460 (epic #2992 federation): the board image upload writer.
  // 455/460 -> 462 (upstream merge, 25 Aug 2026): both lanes' additions are
  // disjoint -- upstream's two auditLog.create writers and this branch's seven
  // communication writers -- and the figure is from `npm run audit:census` on
  // the MERGED tree, the method this file prescribes.
  writeSites: 462,
  /**
   * Of those, sites whose event object carries no `category` key.
   *
   * 82 -> 0 (#2581 child 2). This is the number the issue exists for and it is
   * now closed: every production audit write records a canonical category, so
   * no new row is born selectable by no correlation tool and expiring never.
   * A new entry in `UNCATEGORISED_AUDIT_WRITERS` below is therefore no longer a
   * backlog item to be worked off — it is a regression.
   */
  uncategorised: 0,
  /** Per-sink totals, so a shift between forms cannot cancel out in the total. */
  bySink: {
    // 238 -> 239 (#2623): the waitlist-confirm recovery marker, fire-and-forget
    // outside every transaction because its own failure must not mask the strand.
    // 239 -> 241 (#2621): the two arrival-time writers, above (re-measured on
    // merged tree, #2621).
    // 241 -> 240 (#2649 review): that same #2623 marker moved OUT of this sink —
    // see `createAuditLog` below. Fire-and-forget was right while it was only a
    // notification and wrong once a repair depended on it.
    // 240 -> 241 (#2581 child 2): the bulk-update split, above.
    // 241 -> 242 (#2700): `booking.delete.payment_intent_cancel.failed`, above.
    // `logAudit` rather than an awaited `createAuditLog` on purpose, and the
    // reasoning is the inverse of #2649's conversion below: nothing depends on
    // this row existing before the response is written, and the block it sits
    // in is the one path in the delete that must never throw — the booking is
    // already durably deleted, so an error there would tell the admin the
    // deletion failed and invite a retry that answers 409.
    // 242 -> 243 (#2760): `booking.payment.auto_refund_record_failed`, above,
    // and the same reasoning applies twice over — it is written FROM a catch
    // block on a path that must answer 200, so an awaited write that rejected
    // would replay a refund for the sake of recording that a record was lost.
    // 243 -> 245 (#2773 / #2774): the two new late-capture rows above. The moved
    // one stayed in this sink, so the delta is the two additions and not three.
    // Both are `logAudit` on the same grounds as the row they sit beside — a
    // rejected audit write on either path would turn "a person needs to know about
    // this money" into a replayed refund.
    // 245 -> 255 (#2780): all ten maintenance-report writers use `logAudit` — QR
    // sign create/rotate/pause/resume, queue triage and photo disclosure/deletion,
    // and the two submit records. None sits inside the submit transaction, so a
    // failed audit write never fails a submitted report.
    // 255 -> 261 (#2992): all six club-post moderation writers use `logAudit`.
    logAudit: { total: 262, uncategorised: 0 },
    // 101 -> 102 (#2627): the deletion-approval release, above.
    // 102 -> 104 (#2595): the two reviewed-move writes, above.
    // 104 -> 105 (#2649): the return-to-waitlist repair, above.
    // 105 -> 106 (#2649 review): `waitlist.confirm_offer_release_failed` in
    // `waitlist-confirm/route.ts` converted from `logAudit` to an AWAITED
    // `createAuditLog` (still `.catch`-guarded, so a failed write logs and the
    // operator-door response is unchanged). The repair route refuses any booking
    // without an unresolved report — the free/`PAYMENT_PENDING`/no-payment shape
    // alone is reached by producers that were never on a waitlist — so a report
    // lost before it committed would leave a genuinely stranded member
    // repairable only from a database session. This is the line whose
    // byte-identical collision with #2595 the `writeSites` note above describes:
    // both sides said 104, that merged tree said 106.
    // 106 -> 108 (#2581 child 2): the two hand-built dependants writes moved
    // OFF `tx.auditLog.create` and onto `createAuditLog(params, tx)`. They kept
    // their transaction — the `tx` client is still passed — but they now go
    // through `buildAuditLogCreateData`, so they finally get metadata
    // sanitisation and a derived retention class. The row COUNT is unchanged;
    // only the FORM moved, which is exactly the shift this per-sink pin exists
    // to make visible.
    //
    // AND THIS LINE COLLIDED BYTE-IDENTICALLY TOO, on the merge that produced
    // the number above: #2649 pinned `106` from its repair-plus-conversion +2,
    // this branch pinned `106` from its two dependants writes. Git surfaced it
    // only because the `uncategorised` half of the same line differed (11 vs 0).
    // Had this change been a pure re-form with no category attached, the total
    // would have merged silently two short. The merged truth is 108, measured.
    // 108 -> 112 (Alpine Central Server, PR #21): all four of that change's new
    // write sites reach the sink through `createAuditLog`, matching the routes
    // around them rather than introducing another form.
    // 113 -> 116 (local database backups): the restore endpoint's three
    // rows, written through `createAuditLog` like the backups routes around
    // them rather than introducing another form.
    createAuditLog: { total: 116, uncategorised: 0 },
    // 8 -> 9 (#2581 child 2 review): `recordAgeUpParentEmailHandoffAudit`
    // moved off its hand-built `prisma.auditLog.create`, the last one in `src/`.
    // Same row, same dedupe keys (`action` + `subjectMemberId` + `outcome`) —
    // but it now derives `retentionClass: "critical"` and a seven-year
    // `expiresAt` instead of the NULL/NULL kept-forever shape, and its metadata
    // (which carries a recipient email address) goes through
    // `sanitizeAuditMetadata`. Again the row COUNT is unchanged and only the
    // FORM moved, which is what this per-sink pin exists to surface.
    // 9 -> 10 (#2822): the email-inheritance effective-source change event.
    createStructuredAuditLog: { total: 10, uncategorised: 0 },
    // 71 -> 72 (#2352 MC-03D): the page-content deletion, above.
    // 72 -> 70 (#2581 child 2): the two dependants writes, above.
    // 70 -> 69 (#2581 child 2 review): the age-up handoff write, above. No
    // hand-built `auditLog.create` remains outside a declared wrapper.
    // 69 -> 72 (#2749): the three Other Lodges admin CRUD writers, above.
    // 72 -> 73 (CT-1, #2989): the club-timezone writer. `tx.auditLog.create`
    // with `buildStructuredAuditLogCreateArgs`, matching the sibling settings
    // singleton it was cloned from (`/api/admin/club-identity`) rather than
    // introducing a fourth form on a route that does exactly the same job.
    // 73 -> 74 (ENV-SAFETY 1, #3034): the environment-safety override writer.
    // `tx.auditLog.create` with `buildStructuredAuditLogCreateArgs`, the same form
    // as the club-timezone writer beside it, inside the route's own Serializable
    // transaction — so the two-table contract that route's test enumerates stays
    // enumerable.
    "auditLog.create": { total: 74, uncategorised: 0 },
  },
  /**
   * Literal category values written, and by how many sites. The three `membership`
   * and one `auth` values that used to appear here were invented — never in the
   * taxonomy, selectable by no reader — and are corrected in this change
   * (#2581 decisions 1 and 2), which is why `account` is 15 rather than 10 and
   * `security` is 16 rather than 15.
   *
   * `booking` is 82 rather than 79: #2623 added the stranded waitlist-confirm
   * recovery marker above, and #2621 the two arrival-time rows below.
   * Correlation reads of `booking` require `support` plus
   * `bookings` (`AUDIT_CORRELATION_DOMAIN_AREAS`), which the lodge administrators
   * who have to act on that row already hold — so this adds no reader who could not
   * already see the booking the row names.
   *
   * #2581 CHILD 2 MOVES NINE OF THESE ELEVEN, because it is the change that
   * classifies the 82. Every delta below is a deliberate readership decision
   * and each one is named at its own writer; `APPLIED_AUDIT_CATEGORIES` records
   * which site got which answer, so any single classification can be reversed
   * without re-deriving the set.
   *
   * The two that do NOT move are the ones that matter most for "did this widen
   * anybody's access": `admin` and `system` are unchanged at 118 and 4. Not one
   * of the 82 was classified into the platform's catch-all, and the only
   * additions to the support-only gate are the three `security` credential and
   * role-change writers below.
   */
  categoryValues: {
    // 15 -> 20 (#2581 child 2): the four membership-application writers in
    // `nomination.ts`, plus the `member.bulk-deactivate`/`-reactivate` branch.
    // All five already reached the member self-timeline through the legacy
    // action inference for null-category rows, so none of them becomes visible
    // to a member who could not already see it.
    //
    // 20 -> 19 (#2755): that same `member.bulk-deactivate`/`-reactivate` branch
    // moved OUT, to `admin`, so all three officer-driven member-record writers
    // agree. THIS IS A NARROWING IN BOTH DIRECTIONS AT ONCE, which is why it is
    // spelt out rather than counted. The subject member stops seeing a bulk
    // deactivation of their own account on their own activity list — they already
    // saw nothing when an officer did the same thing from the member detail page,
    // so the outcome is uniform invisibility rather than visibility-by-screen. And
    // the row moves from `support` + `membership` to `support` alone, so a
    // support-only operator gains it: the same gate the member-page equivalent has
    // always answered to. Retention is unchanged (`critical` under both values —
    // no access-event word in the action, and no `severity: "info"` path).
    // See `admin` below for the whole decision and `INV-PRIV-012` for the rule.
    account: 19,
    // 80 -> 82 (#2621): `booking.expected_arrival_time.set` and `.cleared`. Read
    // with `support:view` plus `bookings:view`, like every other booking row
    // beside them — and the booking officers who can set this field already hold
    // both — so this widens nobody's access. (Re-measured on merged tree, #2621.)
    // 82 -> 83 (#2649): `waitlist.returned_to_waitlist`. The same category the
    // strand row it resolves already uses, and the same two reads — so it
    // reaches exactly the administrators who can already see the booking it
    // names, and nobody new.
    // 83 -> 101 (#2581 child 2): the ten booking-policy/booking-period/age-tier
    // writers and the eight season and promotional-code writers (decision 4).
    booking: 101,
    // 16 -> 33 (#2581 child 2): the seventeen money writers — subscription
    // billing, member credit, fee configuration, saved-card charges and the five
    // Stripe webhook outcomes. `payment` is `support` plus `finance`, the
    // narrowest genuine gate for money evidence.
    // 33 -> 34 (#2700): `booking.delete.payment_intent_cancel.failed`. The row
    // says money may still be capturable against a booking that no longer
    // exists, which is finance evidence rather than booking history, so it
    // takes the same `support` + `finance` gate as the other money rows. It
    // widens nobody's access: whoever has to act on it — cancel the intent by
    // hand in Stripe, or wait for the manual refund task the capture would
    // raise — already holds `finance`.
    // 34 -> 35 (#2760): `booking.payment.auto_refund_record_failed`. Same gate
    // and the same argument — the row says the club's own record of an automatic
    // refund was not written, which only a finance reader can act on (find the
    // `booking.payment.refunded_after_cancellation` entry beside it and reconcile
    // by hand), and every operator who could act on it already holds `finance`.
    // 35 -> 37 (#2773 / #2774): `booking.payment.late_capture_refund_withheld` and
    // `booking.payment.late_capture_double_refund_suspected`. The same gate again,
    // and here the argument is at its strongest: each row says money either did not
    // go back or went back twice, and the only person who can settle that is the one
    // who reconciles the club's money. `support` + `finance` is exactly who the
    // matching unmuteable alert is addressed to, so the audit trail and the mail
    // reach the same audience rather than one being visible to a wider set.
    payment: 37,
    // 27 -> 34 (#2581 child 2): the five family-group writers and the two
    // dependants writers. Both dependants writers also moved off a hand-built
    // Prisma literal and onto the audit boundary in the same change.
    // 34 -> 35 (#2822): the email-inheritance effective-source change event.
    // `family` because the affected domain is the family contact relationship,
    // NOT the initiator — so it correlates through membership, never the
    // support-only `admin`/`system` gate, and stays on the subject's timeline.
    family: 35,
    // 117 -> 118 (#2352 MC-03D): `PAGE_CONTENT_DELETED`. `admin` is the same
    // category the three sibling page-content writes already use, and it is
    // readable with support:view alone — so this widens nobody's access beyond
    // what the page-content create/update rows beside it already grant.
    // UNCHANGED by #2581 child 2, deliberately: `admin` is the platform's
    // catch-all and is read with `support:view` alone, so classifying anything
    // into it needed a written justification and none of the 82 earned one.
    //
    // 118 -> 96 (#2730): the FIRST review of the `admin` population itself.
    // #2676 classified the 82 that had no category and explicitly did not read
    // the 118 that already said `admin`; #2581's own readiness note says those
    // "cannot be assumed correct". Twenty-two of them were not: the twenty-one
    // admin-initiated bed-allocation writers and `LODGE_DISPLAY_CONFIG_UPDATED`
    // now say `lodge`, which is what every other writer of the same objects
    // already said. Two of them wrote an action name that a `lodge` writer also
    // wrote (`BED_ALLOCATION_PARTNER_PROMOTED`, `BED_ALLOCATION_PARTNERS_PROMOTED`),
    // so one action was answering to two permission gates.
    //
    // THIS IS A NARROWING, and it is the whole behaviour change: those 22 sites'
    // rows move from `support:view` alone to `support:view` plus `lodge:view`.
    // Neither category is member-visible, so no row reaches a member who could
    // not read it before, and `classifyAuditRetention` returns `critical` for
    // every one of the 22 under both the old and the new value — no row's
    // retention changes. It moved NO ROW ALREADY WRITTEN, which left
    // bed-allocation history split by DATE: that half is closed by #2751's
    // backfill (`20260810020000_backfill_bed_allocation_audit_category`), which
    // rewrote the pre-release rows to `lodge` and is why both correlation
    // entries' prose no longer names an older half. See
    // `docs/ai-diagnostics/audit-admin-category-review.md` for the per-site
    // verdict on all 118 — 22 moved, 87 kept, 9 held for an owner decision
    // because their destinations are member-visible. The 22 are pinned per site
    // in `REVIEWED_ADMIN_CATEGORIES_2730` below, because this count alone cannot
    // see a compensating swap.
    //
    // 96 -> 98 (#2755): the two `bulk-update/route.ts` branches moved IN, from
    // `security` and `account`. #2730 held the reverse question — should the member
    // detail writer leave `admin`? — and the answer was no: the two bulk branches
    // join it instead.
    //
    // THE DEFECT THIS CLOSES was that one business act was filed three ways
    // according to which SCREEN the officer opened. Deactivating one member from
    // the member page wrote `admin`; deactivating the same members from the bulk
    // screen wrote `account`; changing roles from the member page wrote `admin`
    // while the bulk screen wrote `security`. Category follows the business domain
    // affected, and editing, activating, deactivating or re-roling a member's
    // record from an officer screen is one domain.
    //
    // WHY THE JOIN IS `admin` RATHER THAN A MEMBER-VISIBLE CATEGORY. All three
    // rows reach the subject member's own timeline, and `account` and `security`
    // are both in `MEMBER_VISIBLE_AUDIT_CATEGORIES`, so unifying on either would
    // publish an officer's edits of a member's record to that member. The detail
    // writer reaches them by passing `subjectMemberId`; the two bulk writers pass
    // NO subject and reach them anyway, through `buildMemberAuditLogWhere`'s
    // null-subject `targetId` leg (`src/lib/audit-query.ts`, pinned in
    // `src/lib/__tests__/audit.test.ts`). Audit rows are append-only, so that is
    // not quietly reversible. Whether a member should see a given event is meant
    // to become an explicit per-event declaration at the writing site, denied by
    // default: #2695 DECIDED that on 9 Aug 2026 and it is NOT BUILT YET, so until
    // it lands the category is the only lever there is.
    //
    // ONE SITE DELIBERATELY DID NOT JOIN: `/api/profile` (`member.profile.updated`,
    // `account`), where the actor IS the subject. That is self-service, not
    // administration, and filing it `admin` would hide a member's own action from
    // their own timeline. #2755's issue body listed it as part of the split; it is
    // not, and the anchor it gave for the third site
    // (`api/admin/members/[id]/profile/route.ts`) does not exist in the tree.
    //
    // The three sites are pinned per site in `MEMBER_RECORD_ADMIN_CATEGORIES_2755`
    // below, with an action-name gate and a surface gate beside it, because this
    // count cannot see a compensating swap and cannot see a FOURTH member-record
    // screen arriving with a different answer. Full rule: `INV-PRIV-012`.
    // 98 -> 101 (#2749): the three Other Lodges admin CRUD writers. `admin` is
    // readable with support:view alone, so this widens the weakest-gate set by
    // three (the derived support:view total moves 120 -> 123) — the officers who
    // curate the Other Lodges registry, not a new class of reader.
    // 101 -> 102 (Alpine Central Server, PR #21): saving the central-server
    // connection settings. `admin` is readable with support:view alone, so the
    // derived weakest-gate total moves 123 -> 124 — by one operator-facing
    // configuration row, not a new class of reader. The API key itself is never
    // in an audit row (see docs/SECURITY-ATTACK-SURFACE.md), so this widens what
    // a support-only operator can correlate by the fact of a connection change,
    // never by its secret.
    // 102 -> 103 (CT-1, #2989): `CLUB_TIME_ZONE_UPDATED`. `admin` is the answer
    // the sibling club-identity settings writer already gives, and it is the
    // honest one: this is installation configuration, not a security event and
    // not a member's own business. It is readable with `support:view` alone, so
    // the derived weakest-gate total moves 128 -> 129 — by one row saying which
    // timezone the club now keeps, which is exactly what a support operator
    // investigating "why did the nightly job run an hour late" needs to find.
    // Retention is unchanged from every other `admin` row: `critical`, seven
    // years, because the action name normalises to no access-event word.
    // 103 -> 104 (ENV-SAFETY 1, #3034): ENVIRONMENT_SAFETY_OVERRIDE_UPDATED. THIS
    // IS A WIDENING OF WHO CAN READ WHAT, by one site, and it is stated rather than
    // counted: `admin` is readable with `support:view` ALONE, so one more write site
    // becomes correlatable at support level. What that row contains is the
    // before/after value of a boolean and the id of the administrator who changed
    // it — no member data, no environment values, no connection details — so the
    // widening is one operational configuration event, not a member-record
    // disclosure. `security` was considered and rejected: this changes what the
    // installation DOES, not who may sign in or what they may reach, and its read
    // gate is `support:view` either way.
    admin: 104,
    // 16 -> 19 (#2581 child 2): `member.password-reset-sent` and
    // `member.setup-invite-sent` (decision 3 — the affected domain is the
    // CREDENTIAL, not the mailing), plus the `member.bulk-set-role` branch
    // (decision 6). These three are the ONLY additions to the support-only
    // correlation gate in this change. Each is already readable by the same
    // operator in Admin > Audit Log, and the correlation projection returns no
    // `details` and no `metadata`, so the recipient addresses those rows carry
    // do not travel with them.
    //
    // 19 -> 18 (#2755): the `member.bulk-set-role` branch moved to `admin` with its
    // sibling — see `admin` above. Correlation-neutral, because `security` and
    // `admin` are both in the System entry and both read with `support:view` alone;
    // the change a reader can feel is that the row stops reaching the subject
    // member's own timeline, since `security` is member-visible and `admin` is not.
    // Retention is unchanged: `critical` under both values, because
    // `member.bulk-set-role` normalises to no access-event word, so the
    // `security`-plus-access-event `sensitive_access` branch never applied to it.
    // 18 -> 19 (PR #2949 review): the refused base-URL change. `security` is
    // readable with support:view alone, like `admin` — so the weakest-gate total
    // moves 124 -> 125 by one refusal record, which is evidence of an attempt to
    // cross a privilege boundary and belongs where a support operator can
    // correlate it.
    // 19 -> 22 (local database backups): the three restore rows. `security` is
    // right for all three — a restore is a privileged, destructive act on the
    // whole dataset, not an `admin` settings change — and `security` is readable
    // with support:view alone, so the weakest-gate total moves 125 -> 128. That
    // is a WIDENING of three, and deliberate: a support operator investigating a
    // sudden data loss should be able to see that a restore happened without
    // needing Full Admin to find out.
    security: 22,
    // 16 -> 18 (#2595): the two reviewed-move writes. `lodge` is the category
    // every other bed-allocation write already uses, and it is not one of the
    // three (`admin`, `security`, `system`) readable with support:view alone —
    // so the support-only population pinned below does not move.
    // 18 -> 30 (#2581 child 2): the nine lodge-display writers and the three
    // kiosk-account writers. This NARROWS nothing and widens only within the
    // lodge gate (`support` plus `lodge`).
    // 30 -> 52 (#2730): the twenty-one admin-initiated bed-allocation writers
    // and `LODGE_DISPLAY_CONFIG_UPDATED`, moved OUT of `admin` — see the note on
    // `admin` above for the readership and retention consequences. Bed
    // allocation is now wholly `lodge`: 28 sites, one gate, no action name
    // written into two.
    // 52 -> 62 (#2780): the ten maintenance-report writers. The QR-sign
    // management route writes four (`maintenance.qr_token.created/rotated/
    // paused/resumed`), the officer queue detail route writes the triage and
    // photo-disclosure/deletion set, and the member and anonymous submit routes
    // record a report received. All `lodge` — physical-lodge maintenance is Lodge
    // Operations — and `lodge` is not one of the three (`admin`, `security`,
    // `system`) readable with `support:view` alone, so the support-only
    // population pinned below does not move.
    // 52 -> 55 (Alpine Central Server, PR #21): the manual Other Clubs upload
    // and download, plus the shared failure row that records a sync which could
    // not run. They sit beside the Other Lodges CRUD writers they distribute, on
    // the same `support` + `lodge` gate, so no reader gains anything they could
    // not already see about that registry.
    // 55 -> 65 (#2780 merged with main): both additions are `lodge` and both are
    // disjoint, so the merged figure is 65. Measured, not added up.
    lodge: 65,
    // 19 -> 34 (#2581 child 2): the fifteen Xero settings, mapping, replay and
    // retry writers. `xero` is `support` plus `finance`.
    xero: 34,
    // 12 -> 14 (#2581 child 2): `BULK_COMMUNICATION_SENT` and
    // `EMAIL_SUPPRESSION_CLEARED`. Safe only BECAUSE child 1 moved
    // `communication` out of the support-only system entry into the membership
    // one (decision 7); under the old map this would have put bulk-email
    // evidence behind `support:view` alone.
    // 14 -> 20 (#2992): the six club message board writers. `communication` is
    // a membership+support read, so a member-visible board moderation record
    // lands where the other member-visible communication rows already are --
    // this widens nobody's access.
    // 20 -> 21 (epic #2992 federation): club_post_image.upload. Still a
    // membership+support read; it records only who uploaded and how many
    // bytes, never what the picture was of.
    communication: 21,
    // 14 -> 15 (#2627): `member.deletion_approval_claim_released`. Still a
    // membership+support read, like every other deletion-decision row beside it,
    // so this widens nobody's access.
    // 15 -> 19 (#2581 child 2): `member.deletion_rejected`,
    // `member.deletion_approved`, `member.deletion_requested` and
    // `issue.reported`. The issue report stays `privacy` rather than matching
    // its `/admin/issue-reports` support surface (decision 5) — moving it to
    // `admin` would have WIDENED a member's own report to `support:view` alone.
    privacy: 19,
    // UNCHANGED by #2581 child 2. `system` is for genuine platform events with
    // no narrower business domain, and none of the 82 was one.
    system: 4,
  },
} as const;

/**
 * Every production audit write that records NO category.
 *
 * EMPTY, AND THAT IS THE POINT (#2581 child 2). It held 82 entries when child 1
 * measured the tree — every one of them a row written with `category = NULL`,
 * selectable by no Diagnostics correlation tool, and (because
 * `buildAuditLogCreateData` derives retention only when a category, severity or
 * retention class is present) written with `retentionClass = NULL` and
 * `expiresAt = NULL` as well, i.e. kept forever. Child 2 classified all 82 at
 * the source. `APPLIED_AUDIT_CATEGORIES` below records which answer each site
 * got.
 *
 * THE LIST STAYS, AND STAYS PINNED, because the contract test compares it for
 * SET EQUALITY against the measured census. An empty pin means a new
 * uncategorised writer fails CI by name rather than being tolerated under a
 * ceiling — and it means nobody can quietly re-open the backlog by adding an
 * entry here instead of a category at the site. An addition to this object is
 * now a regression under review, not a to-do.
 *
 * WHAT THIS GATE STILL CATCHES NOW THE TYPE IS MANDATORY. `AuditLogParams.category`
 * and `StructuredAuditEvent.category` are both required and non-null, so an
 * omitting TypeScript writer no longer compiles — which means this census is no
 * longer the FIRST thing to notice one, and should not be read as if it were.
 * It remains the gate for the three cases the compiler cannot see:
 *
 *   - raw `INSERT INTO "AuditLog"` in a migration (`APPROVED_MIGRATION_AUDIT_SQL`
 *     already pins five);
 *   - a `.mjs`/`.cjs` script or any writer reaching the table outside the typed
 *     boundary;
 *   - the type mandate itself being reverted, which would make every omitting
 *     writer compile again at once.
 *
 * So the three layers are: the type refuses omission at compile time, the
 * runtime assertion in both builders refuses it for anything that reaches the
 * helper through a cast or from untyped code, and this census refuses it for
 * writers neither of those can see.
 *
 * AND THE THIRD LAYER IS A HEURISTIC, not a proof — worth stating here because
 * the first draft of the docs said the gap "cannot re-open", which was more than
 * the tree enforced. A review ran the shipped scanner over a synthetic tree and
 * produced SIX writers it reported clean: a delegate parked in a local, one
 * renamed out of a destructure, one reached by element access, raw SQL DML from
 * TypeScript, a `createMany` whose non-first elements omitted the category, a
 * schema-qualified migration INSERT, and a migration INSERT naming `"category"`
 * while supplying NULL. All are closed and fixtured in
 * `src/lib/__tests__/audit-writer-census-scanner.test.ts`; the residuals that
 * remain open are named in the scanner's own header. Read this gate as "a new
 * uncategorised writer written the ordinary way fails CI by name", not as a
 * closure proof.
 *
 * THE RETENTION CONSEQUENCE OF EMPTYING IT, measured rather than assumed,
 * because it is the reason this was not a metadata-only sweep. Adding a category
 * makes `classifyAuditRetention` run, and it falls through to `critical` for
 * every one of these actions — a seven-year expiry. So 82 write paths moved from
 * "no retention class, no expiry, kept forever" to "critical, expires seven
 * years after the event". `family-group.login-holder-swapped` was the one site
 * whose class depended on the answer: its action normalises to a string
 * containing "login", so `security` or `admin` would have made it
 * `sensitive_access` at 24 months. It was classified `family`, so it keeps the
 * seven years a membership dispute needs.
 */
export const UNCATEGORISED_AUDIT_WRITERS: Readonly<
  Record<string, { action: string; proposedCategory: ProposedCategory }>
> = {};

/**
 * The category #2581's second child applied at each of the sites child 1 found
 * uncategorised, plus the one site the split created.
 *
 * WHY THIS EXISTS ON TOP OF `categoryValues`. The distribution pin catches a
 * category gaining or losing sites. It does NOT catch a SWAP: moving one writer
 * from `booking` to `payment` and another from `payment` to `booking` leaves
 * every count identical while changing who can read both rows. This pins the
 * per-site answer, so a reclassification of any one of these 83 writers is a
 * named diff in this file rather than an invisible one in a route.
 *
 * IT IS ALSO THE REVERSAL RECORD. Each entry is one decision, reversible on its
 * own: change the literal at the site, change it here, and the changelog entry
 * for #2581 names what the row's readership and retention were before.
 *
 * SCOPE, deliberately narrow: only the sites this child classified. The other
 * ~340 writers were categorised at the time they were written and are covered by
 * `categoryValues` plus the canonical-value gate; pinning all of them would make
 * every new feature that records something edit a 400-line literal.
 */
export const APPLIED_AUDIT_CATEGORIES: Readonly<Record<string, string>> = {
  // ─── Booking policy, booking periods and age tiers → `booking` ──────────────
  // Booking-eligibility and booking-price RULES, so they follow the booking
  // domain rather than the admin surface that edits them. Read with
  // `support:view` plus `bookings:view`.
  "src/app/api/admin/age-tier-settings/route.ts::PUT#0": "booking",
  "src/app/api/admin/booking-policies/adult-member-hosting/route.ts::PUT#0": "booking",
  "src/app/api/admin/booking-policies/cancellation/route.ts::PUT#0": "booking",
  "src/app/api/admin/booking-policies/group-discount/route.ts::PUT#0": "booking",
  "src/app/api/admin/booking-policies/minimum-stay/[id]/route.ts::DELETE#0": "booking",
  "src/app/api/admin/booking-policies/minimum-stay/[id]/route.ts::PUT#0": "booking",
  "src/app/api/admin/booking-policies/minimum-stay/route.ts::POST#0": "booking",
  "src/app/api/admin/booking-policies/periods/[id]/route.ts::DELETE#0": "booking",
  "src/app/api/admin/booking-policies/periods/[id]/route.ts::PUT#0": "booking",
  "src/app/api/admin/booking-policies/periods/route.ts::POST#0": "booking",

  // ─── Seasons and promotional codes → `booking` (#2581 decision 4) ───────────
  // The recorded trade-off: a promotional code carries a discount amount, so
  // price-affecting evidence sits behind `bookings:view` rather than
  // `finance:view`. Taken anyway, because the OBJECT is a booking-eligibility
  // rule; the rejected alternative was `payment`, which would have hidden the
  // rule from the booking officers who administer it.
  "src/app/api/admin/promo-codes/[id]/route.ts::DELETE#0": "booking",
  "src/app/api/admin/promo-codes/[id]/route.ts::DELETE#1": "booking",
  "src/app/api/admin/promo-codes/[id]/route.ts::PATCH#0": "booking",
  "src/app/api/admin/promo-codes/[id]/route.ts::PUT#0": "booking",
  "src/app/api/admin/promo-codes/route.ts::POST#0": "booking",
  "src/app/api/admin/seasons/[id]/route.ts::DELETE#0": "booking",
  "src/app/api/admin/seasons/[id]/route.ts::PUT#0": "booking",
  "src/app/api/admin/seasons/route.ts::POST#0": "booking",

  // ─── Money → `payment` ─────────────────────────────────────────────────────
  // Charges, credits, fees and card results, read with `support:view` plus
  // `finance:view`. The five `booking.payment.*` actions are payment OUTCOMES on
  // a booking, not booking-lifecycle events, so they follow the money.
  "src/app/api/admin/fee-configuration/route.ts::POST#0": "payment",
  "src/app/api/admin/subscription-billing/route.ts::POST#0": "payment",
  "src/app/api/admin/subscription-billing/route.ts::POST#1": "payment",
  "src/app/api/admin/subscription-billing/route.ts::POST#2": "payment",
  "src/app/api/admin/subscription-billing/route.ts::POST#3": "payment",
  "src/app/api/admin/subscription-billing/route.ts::POST#4": "payment",
  "src/app/api/payments/charge-saved-method/route.ts::POST#0": "payment",
  "src/app/api/payments/charge-saved-method/route.ts::POST#1": "payment",
  "src/lib/member-credit.ts::createAdminAdjustmentRequest.request#0": "payment",
  "src/lib/member-credit.ts::reviewAdminAdjustmentRequest.result#0": "payment",
  "src/lib/member-credit.ts::reviewAdminAdjustmentRequest.result#1": "payment",
  "src/lib/membership-subscription-billing.ts::confirmSubscriptionBillingPreview#0": "payment",
  // #2760 INSERTED A WRITER AHEAD OF THE ONE THAT USED TO BE `#0` HERE, which is
  // the renumbering hazard this file's header warns about: `#0` was
  // `booking.payment.refunded_after_cancellation` and became
  // `booking.payment.auto_refund_record_failed`, with the refund row pushed to
  // `#1`. Both are `payment`, so the identity pin would have passed while silently
  // meaning something else — which is why #2760 listed BOTH ordinals.
  //
  // #2773 MOVED THAT WRITER OUT AGAIN, so `#0` HERE HAS REVERTED TO MEANING
  // `booking.payment.refunded_after_cancellation` AND `#1` NO LONGER EXISTS. Said
  // out loud because it is the same hazard in reverse and it is just as silent: the
  // category never changed, so nothing in this map could have caught it. The writer
  // now lives at `recordAutomaticLateCaptureRefund` below, shared by BOTH
  // late-capture handlers — the whole point of #2773 is that there is one
  // implementation of this record rather than a copy per handler.
  "src/lib/stripe-webhook-service.ts::handleCancelledBookingAdditionalPaymentSucceeded#0": "payment",
  // Untouched by #2773, and worth stating because the sibling above moved: this
  // handler gained NO audit write. Its record failure is audited by the shared
  // epilogue, not inline, so `#0` still means
  // `booking.payment.refunded_after_cancellation` exactly as it did before #2760.
  "src/lib/stripe-webhook-service.ts::handleCancelledBookingPaymentSucceeded#0": "payment",
  /*
    #2773 / #2774 — the three write sites of the shared late-capture epilogue,
    pinned on arrival rather than left unlisted.

    They are new rather than #2581 classifications, so nothing forced them into this
    map. They are here because all three are `payment` — money evidence on a
    Critical webhook path — and this map is the only place a category drift at a
    named site fails a test. One site per symbol today, so no ordinal hazard yet;
    listing them is what makes the NEXT insertion at any of the three say so out
    loud, which is the lesson the two entries above were bought with.

    None of the three reaches a member self-timeline. That query
    (`buildMemberVisibleAuditLogWhere` -> `buildMemberAuditLogWhere`) needs the row
    to carry the member in `subjectMemberId`, `actorMemberId`, `memberId` or
    `targetId`; all three carry a BOOKING id in `targetId` and no member column at
    all, and each `details` is a JSON object, which the member projection suppresses
    entirely. Same shape as the `booking.payment.refunded_after_cancellation` rows
    above.
  */
  "src/lib/cancelled-booking-late-capture.ts::recordAutomaticLateCaptureRefund#0": "payment",
  "src/lib/cancelled-booking-late-capture.ts::reportWithheldLateCaptureRefund#0": "payment",
  "src/lib/cancelled-booking-late-capture.ts::announceAutomaticLateCaptureRefund#0": "payment",
  "src/lib/stripe-webhook-service.ts::handlePaymentIntentCanceled#0": "payment",
  "src/lib/stripe-webhook-service.ts::handlePaymentIntentFailed#0": "payment",
  "src/lib/stripe-webhook-service.ts::refundSupersededGroupSettlementIntent#0": "payment",

  // ─── Xero settings, mappings, replay, retry and maintenance → `xero` ───────
  "src/app/api/admin/xero/account-mappings/route.ts::PUT#0": "xero",
  "src/app/api/admin/xero/inbound-events/[id]/replay/route.ts::POST#0": "xero",
  "src/app/api/admin/xero/item-code-mappings/route.ts::PUT#0": "xero",
  "src/app/api/admin/xero/link-maintenance/route.ts::POST#0": "xero",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#0": "xero",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#1": "xero",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#2": "xero",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#3": "xero",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#4": "xero",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#5": "xero",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#6": "xero",
  "src/app/api/admin/xero/operations/[id]/requeue/route.ts::POST#0": "xero",
  "src/app/api/admin/xero/operations/[id]/retry/route.ts::POST#0": "xero",
  "src/app/api/admin/xero/operations/reset-stale-running/route.ts::POST#0": "xero",
  "src/app/api/admin/xero/operations/retry-all/route.ts::POST#0": "xero",

  // ─── Lodge display configuration and kiosk accounts → `lodge` ──────────────
  // The three `admin/lodge/route.ts` writers manage kiosk `Member` rows with
  // `role: "LODGE"`, not `Lodge` rows — the local variable is called `lodge` but
  // holds a Member. They carry `entityType: "Member"` for that reason;
  // `entityType: "Lodge"` already means a real Lodge id elsewhere in the tree.
  "src/app/api/admin/display/devices/[id]/revoke/route.ts::POST#0": "lodge",
  "src/app/api/admin/display/devices/[id]/route.ts::PATCH#0": "lodge",
  "src/app/api/admin/display/devices/[id]/route.ts::PATCH#1": "lodge",
  "src/app/api/admin/display/layouts/[id]/route.ts::DELETE#0": "lodge",
  "src/app/api/admin/display/layouts/[id]/route.ts::PUT#0": "lodge",
  "src/app/api/admin/display/layouts/route.ts::POST#0": "lodge",
  "src/app/api/admin/display/templates/[id]/route.ts::DELETE#0": "lodge",
  "src/app/api/admin/display/templates/[id]/route.ts::PUT#0": "lodge",
  "src/app/api/admin/display/templates/route.ts::POST#0": "lodge",
  "src/app/api/admin/lodge/route.ts::GET#0": "lodge",
  "src/app/api/admin/lodge/route.ts::POST#0": "lodge",
  "src/app/api/admin/lodge/route.ts::PUT#0": "lodge",

  // ─── Family groups, login holder and dependants → `family` ─────────────────
  // The two dependants writers were hand-built `tx.auditLog.create` literals
  // that bypassed `buildAuditLogCreateData` entirely. They now go through
  // `createAuditLog(params, tx)`, so they keep their transaction and gain the
  // sanitisation and retention derivation a category alone would not have given
  // them.
  "src/app/api/admin/family-groups/[id]/login-holder/route.ts::POST.result#0": "family",
  "src/app/api/admin/family-groups/[id]/route.ts::DELETE#0": "family",
  "src/app/api/admin/family-groups/[id]/route.ts::PUT#0": "family",
  "src/app/api/admin/family-groups/route.ts::POST#0": "family",
  "src/app/api/admin/family-suggestions/route.ts::POST#0": "family",
  "src/app/api/admin/members/[id]/dependents/[dependentId]/route.ts::DELETE.result#0": "family",
  "src/app/api/admin/members/[id]/dependents/link/route.ts::POST.linkedMember#0": "family",

  // ─── Membership applications → `account` ───────────────────────────────────
  // The same destination child 1 gave the three nomination writers it corrected
  // off the invented `membership` value, so the whole family is consistent.
  "src/lib/nomination.ts::approveMemberApplication#2": "account",
  "src/lib/nomination.ts::confirmNomination#0": "account",
  "src/lib/nomination.ts::createMemberApplication#0": "account",
  "src/lib/nomination.ts::rejectMemberApplication#0": "account",

  // ─── Credential delivery → `security` (#2581 decision 3) ───────────────────
  // The affected domain is the CREDENTIAL, not the mailing: both actions hand
  // somebody a way to take over an account. Rejected alternative:
  // `communication`, which would have filed a credential issue under bulk email.
  // The trade-off taken: `security` reads with `support:view` alone, the wider
  // of the two — but it is the same gate Admin > Audit Log already needs for
  // these rows, and the correlation projection carries no `details`, which is
  // where the recipient address lives.
  "src/app/api/admin/members/send-password-reset/route.ts::POST#0": "security",
  "src/app/api/admin/members/send-setup-invite/route.ts::POST.batchResults#0": "security",

  // ─── Member bulk lifecycle → `admin` (#2581 decision 6, REVISED by #2755) ──
  // Child 2 split this one call site into two, by affected domain: `set-role`
  // changes what a member may do (`security`), `deactivate`/`reactivate` change
  // the account (`account`). Read on its own that was defensible. Read against
  // the rest of the tree it was not — the SAME two acts performed from the member
  // detail page wrote `admin` — so #2755 unified all three officer-driven
  // member-record writers on `admin`, which is the only join that does not
  // publish an officer's edits of a member's record to that member's own
  // timeline. Both entries are the reversal record for that: change the literal
  // at the site and the value here, and `INV-PRIV-012` states what moves.
  //
  // Still TWO sites, not one. The two `details` strings genuinely differ (the
  // set-role branch records the roles assigned), and the census contract forbids
  // a conditional category — so the branch stays and both halves say `admin`.
  "src/app/api/admin/members/bulk-update/route.ts::POST#0": "admin",
  "src/app/api/admin/members/bulk-update/route.ts::POST#1": "admin",

  // ─── Privacy decisions and issue reports → `privacy` ───────────────────────
  // `issue.reported` stays `privacy` despite `/admin/issue-reports` being a
  // `support` surface (#2581 decision 5). Matching the surface would have meant
  // `admin`, which reads with `support:view` alone — a widening of a member's own
  // report, and it was refused. The accepted cost: a support-only operator
  // correlates issue reports in Admin > Audit Log rather than in Diagnostics.
  "src/app/api/admin/deletion-requests/[id]/route.ts::POST#1": "privacy",
  "src/app/api/admin/deletion-requests/[id]/route.ts::POST#4": "privacy",
  "src/app/api/issue-reports/route.ts::POST#0": "privacy",
  "src/app/api/member/request-deletion/route.ts::POST#0": "privacy",

  // ─── Communication → `communication` ───────────────────────────────────────
  // Safe only BECAUSE child 1 moved `communication` out of the support-only
  // system correlation entry into the membership one (#2581 decision 7). Under
  // the previous map, `BULK_COMMUNICATION_SENT` would have put bulk-email
  // evidence behind `support:view` alone.
  "src/app/api/admin/communications/send/route.ts::POST#0": "communication",
  "src/app/api/admin/email-suppressions/[id]/clear/route.ts::POST#0": "communication",
};

/**
 * The category #2730 RE-classified at each site it moved out of `admin`.
 *
 * WHY A SECOND MAP RATHER THAN MORE ROWS IN `APPLIED_AUDIT_CATEGORIES`. That one
 * is #2581 child 2's reversal record — the sites that had NO category and were
 * given one — and three assertions read it as exactly that population: the swap
 * gate, the 56/27 member-visibility split, and the no-entity-identifier
 * allowlist. Folding 22 unrelated sites in would move all three numbers for a
 * reason none of their comments describes. These sites are a different decision
 * with a different before-state (`admin`, not null), so they get their own
 * record and their own assertion.
 *
 * WHY IT EXISTS AT ALL. `categoryValues` is a DISTRIBUTION, and a distribution
 * cannot see a swap: move one of these 22 back to `admin` and any one `admin`
 * site into `lodge`, and every count in the census is identical while two rows
 * changed who may read them. #2730's whole thesis is that unreviewed `admin`
 * classifications drift silently, so its own corrections are pinned per site
 * rather than left under an aggregate that a compensating pair defeats.
 *
 * ALL 22 MOVED `admin` -> `lodge`, and the direction matters twice over. Neither
 * category is member-visible, so no row crossed the member self-timeline
 * boundary in either direction — which is why this pin does not need a
 * visible/hidden split the way #2581's does. And `classifyAuditRetention`
 * returns `critical` for every one of these actions under BOTH values, so the
 * move changed no row's expiry.
 *
 * ROWS ALREADY WRITTEN ARE COVERED NOW, and they were not when #2730 shipped. A
 * stored row keeps the category it was written with, so bed-allocation history
 * was split by DATE until #2751's backfill
 * (`prisma/migrations/20260810020000_backfill_bed_allocation_audit_category`)
 * rewrote the pre-release rows to `lodge`. No census gate can see a stored row,
 * which is why the two are tied together by a test instead:
 * `src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts` fails if a
 * site is added to this map whose action the backfill does not name, or if the
 * backfill names an action no site here writes. That is the mechanical half of
 * INV-OPS-012 — adding a 23rd site without extending the backfill fails CI by
 * name rather than re-opening the split silently.
 */
export const REVIEWED_ADMIN_CATEGORIES_2730: Readonly<Record<string, string>> = {
  // ─── Bed allocation: 21 admin-initiated writers → `lodge` ──────────────────
  // The affected domain is a bed in a lodge room on a lodge night, whoever moved
  // it. Before this, `BED_ALLOCATION_PARTNER_PROMOTED` and
  // `BED_ALLOCATION_PARTNERS_PROMOTED` were each written into TWO permission
  // gates depending on whether an administrator or the lifecycle wrote them, so
  // neither correlation entry could return a whole night.
  "src/app/api/admin/bed-allocation/allocations/bulk/route.ts::POST#0": "lodge",
  "src/app/api/admin/bed-allocation/allocations/bulk/route.ts::POST#1": "lodge",
  "src/app/api/admin/bed-allocation/allocations/route.ts::POST#0": "lodge",
  "src/app/api/admin/bed-allocation/allocations/route.ts::POST#1": "lodge",
  "src/app/api/admin/bed-allocation/auto-allocate/route.ts::POST#0": "lodge",
  "src/app/api/admin/bed-allocation/beds/[id]/route.ts::DELETE#0": "lodge",
  "src/app/api/admin/bed-allocation/beds/[id]/route.ts::PATCH#0": "lodge",
  "src/app/api/admin/bed-allocation/beds/route.ts::POST#0": "lodge",
  "src/app/api/admin/bed-allocation/rooms/[id]/route.ts::DELETE#0": "lodge",
  "src/app/api/admin/bed-allocation/rooms/[id]/route.ts::PATCH#0": "lodge",
  "src/app/api/admin/bed-allocation/rooms/bulk/route.ts::POST#0": "lodge",
  "src/app/api/admin/bed-allocation/rooms/import-from-config/route.ts::POST#0":
    "lodge",
  "src/app/api/admin/bed-allocation/rooms/route.ts::POST#0": "lodge",
  "src/app/api/admin/bed-allocation/settings/route.ts::PUT#0": "lodge",
  "src/lib/bed-allocation-approval.ts::approveBedAllocations#0": "lodge",
  "src/lib/bed-allocation-manual-writes.ts::moveBedAllocationsSameDateWithLocksHeld.moveUnderLock#0":
    "lodge",
  "src/lib/bed-allocation-manual-writes.ts::moveBedAllocationsSameDateWithLocksHeld.moveUnderLock#1":
    "lodge",
  "src/lib/bed-allocation-range-audit.ts::recordRangeAssignAudit#0": "lodge",
  "src/lib/bed-allocation-range-audit.ts::recordRangeAssignAudit#1": "lodge",
  "src/lib/bed-allocation-removal.ts::applyBedAllocationRemoval#0": "lodge",
  "src/lib/bed-allocation-removal.ts::applyBedAllocationRemoval#1": "lodge",

  // ─── The last lodge-display writer → `lodge` ───────────────────────────────
  // Moved because it SPLIT a subsystem: ten siblings under `/api/admin/display/**`
  // already said `lodge`. The other `entityType: "Lodge"` writers (`LODGE_CREATED`,
  // `LODGE_UPDATED`, `LODGE_SETTINGS_UPDATED`, `LODGE_INSTRUCTION_UPDATED`) are
  // uniform at `admin` and stay there — see the comment at this route.
  "src/app/api/admin/display/lodge-config/route.ts::PUT#0": "lodge",
};

/**
 * Every writer of the SIX MEMBER-RECORD ACTIONS below — an officer editing,
 * activating, deactivating or re-roling a member's record — and the single
 * category all of them file (#2755).
 *
 * WHAT THIS MAP IS NOT. It is not "every writer that records an officer acting on
 * somebody else's member record", and reading it that way is how this pin would
 * grow a false claim of its own. Other officer-driven writers deliberately file
 * MEMBER-VISIBLE categories, by earlier reviewed decisions, and they are pinned
 * separately in `OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755` below — the
 * member-photo pair (#2581 chose `account` for the on-behalf branch on purpose,
 * transparently) and the officer-driven membership-cancellation writers. The rule
 * in `INV-PRIV-012` is scoped to the six action families named in
 * `MEMBER_RECORD_ADMIN_ACTIONS_2755`, not to "officer acted", because "who acted"
 * is the discriminator that rule exists to forbid.
 *
 * WHY THIS IS ITS OWN MAP. The three sites were split across the two maps above
 * and the unpinned remainder: two of them are `APPLIED_AUDIT_CATEGORIES` entries
 * and the third — `admin-member-detail-service.ts` — was one of the 118 that
 * already said `admin`, was one of the nine #2730 HELD rather than moved, and so
 * carried no per-site pin at all. Nothing tied the three together, which is
 * exactly how they came to disagree: each was reviewed against its own
 * neighbours and never against each other.
 *
 * WHAT IT PINS THAT THE OTHER GATES CANNOT. `categoryValues` is a distribution
 * and cannot see a swap. `APPLIED_AUDIT_CATEGORIES` pins two of the three but not
 * the third, so it would pass while the pair and the detail page disagreed again.
 * And neither can see the failure that actually happened here — a FOURTH screen
 * for the same act, reviewed on its own and given its own answer. Hence the
 * action-name family below beside the site map: the census test measures both.
 *
 * ALL THREE SAY `admin`, AND THAT IS LOAD-BEARING RATHER THAN INCIDENTAL. All
 * three rows reach the subject member's own timeline, and `account` and
 * `security` — the two the bulk screen used to use — are both in
 * `MEMBER_VISIBLE_AUDIT_CATEGORIES`. So unifying on either would have published an
 * officer's edits of a member's record on that member's own timeline, and audit
 * rows are append-only. The census test asserts the destination is
 * member-INVISIBLE as a property, not just that the three agree, because "all
 * three agree" is also true of the wrong answer.
 *
 * HOW THEY REACH THAT TIMELINE IS NOT UNIFORM, and the difference matters to
 * anyone applying the rule to a new writer. The detail-service writer passes
 * `subjectMemberId`. The two bulk writers pass NO subject at all — only
 * `memberId` (the officer) and `targetId` (the member) — and reach the member
 * anyway, through `buildMemberAuditLogWhere`'s null-subject `targetId` leg
 * (`src/lib/audit-query.ts`, pinned in `src/lib/__tests__/audit.test.ts`). "Does
 * it pass a subject?" is therefore NOT the test for whether a re-classification
 * crosses the member boundary; `INV-PRIV-012` states the real predicate.
 *
 * NOT IN THIS SET, deliberately:
 *
 *  - `src/app/api/profile/route.ts::PUT#0` (`member.profile.updated`, `account`).
 *    Its actor IS its subject — a member editing their own record, with no
 *    on-behalf path — so it is self-service rather than administration, and filing
 *    it `admin` would hide a member's own action from them. #2755's issue body
 *    listed it among the split sites; the anchor it gave for that third site does
 *    not exist in the tree.
 *  - The member-photo pair and the cancellation-review writers, which record an
 *    officer acting on somebody else's record and stay MEMBER-VISIBLE on purpose.
 *    The photo pair even coexists with this set on ONE screen: the admin member
 *    detail page renders `MemberPhotoEditor` in `mode="admin"`, so a field edit
 *    there files `admin` and a photo change there files `account`. That is not an
 *    oversight — see `OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755`.
 *
 * WHAT IT DOES NOT COVER: rows already written. A stored row keeps the category it
 * was written with, so bulk member-record history is split by date — the older
 * half carries `account`/`security` and stays member-visible and Membership-gated.
 * It is a data question rather than a writer question, so no census gate can see
 * it, and it is filed as #2763. NOT #2751: that issue's scope is the 23
 * bed-allocation actions plus `LODGE_DISPLAY_CONFIG_UPDATED`, where both the old
 * and new categories are member-invisible, so nothing a member can see moves —
 * which is exactly what makes this population a different decision.
 */
export const MEMBER_RECORD_ADMIN_CATEGORIES_2755: Readonly<
  Record<string, string>
> = {
  // The member detail page: one member, every editable field, plus activate and
  // deactivate. `admin` before #2755 and `admin` after — this is the site the
  // other two joined.
  "src/lib/admin-member-detail-service.ts::updateAdminMember.updated#0": "admin",
  // The bulk screen, same acts across a selection. `security` before #2755.
  "src/app/api/admin/members/bulk-update/route.ts::POST#0": "admin",
  // The bulk screen's deactivate/reactivate branch. `account` before #2755.
  "src/app/api/admin/members/bulk-update/route.ts::POST#1": "admin",
};

/**
 * Every action name the sites above can write.
 *
 * WHY BY NAME AS WELL AS BY SITE. The site map catches an existing writer
 * changing its answer. It cannot catch a NEW screen for the same act — a quick
 * edit on the members list, an importer that reactivates — written with a literal
 * `admin.member.deactivated` and `category: "account"` because its author read
 * only its own neighbours. That is precisely how the three sites here diverged,
 * so the census test also asserts that no OTHER writer in the tree records one of
 * these action names under a different category.
 *
 * NEITHER SITE WRITES A LITERAL, which is why this list is maintained here rather
 * than measured. The detail service returns one of the three `admin.member.*`
 * names from `getAdminMemberAuditAction`; the bulk route interpolates
 * `member.bulk-${action}` over a zod enum. The census test derives the bulk half
 * from that enum in the route's own source, so adding a fourth bulk action fails
 * here by name instead of quietly minting an unpinned member-record action.
 *
 * EXACTLY WHAT THE NAME GATE CATCHES, stated because the first version of this
 * comment claimed more than it delivered. The census resolves a non-literal action
 * to `(dynamic) <expression>`, so a writer whose action comes from a constant —
 * the house style at a dozen sites — was invisible to a gate that compared action
 * strings. Three mechanisms now stand behind the claim, and a fourth screen has to
 * clear all three:
 *
 *  1. the site map above, measured from the tree, so moving or re-answering one of
 *     the three pinned sites fails;
 *  2. this name list, matched against each site's action with ONE level of
 *     same-file `const` indirection resolved, so `const A = "admin.member.
 *     deactivated"` no longer hides a writer;
 *  3. a corpus gate: every non-test file in the census's own scan that NAMES one
 *     of these action literals must be a reviewed file
 *     (`MEMBER_RECORD_ACTION_LITERAL_FILES_2755`), which catches a new writer
 *     however it assembles the string — including from an imported constant.
 *
 * What still escapes all three is a fourth screen that invents a NEW action name
 * for the same act (`admin.member.archived`, say). That is what the surface gate
 * below is for on the officer surfaces it covers; off those surfaces it remains a
 * review question, not a mechanical one.
 */
export const MEMBER_RECORD_ADMIN_ACTIONS_2755: readonly string[] = [
  "admin.member.updated",
  "admin.member.deactivated",
  "admin.member.reactivated",
  "member.bulk-deactivate",
  "member.bulk-reactivate",
  "member.bulk-set-role",
];

/**
 * Non-test files in the census's own scan corpus that may name one of the six
 * action literals above (#2755).
 *
 * A new entry here is the whole point: it means somebody wrote one of these action
 * names in a new place, and a reviewer has to answer whether that place is a
 * writer and whether it files `admin`. The two writer files name their own
 * actions; the two service files also name each other's in the comments that
 * record the unification; this manifest names all six.
 */
export const MEMBER_RECORD_ACTION_LITERAL_FILES_2755: readonly string[] = [
  "scripts/audit/audit-writer-census-manifest.ts",
  "src/app/api/admin/members/bulk-update/route.ts",
  "src/lib/admin-member-detail-service.ts",
];

/**
 * The officer-facing member-record surfaces, measured EXHAUSTIVELY for
 * member-visible writers (#2755).
 *
 * The name gate above is keyed on six action names. This one is keyed on WHERE the
 * writer lives, so a fourth screen that invents a new action name for the same act
 * — `admin.member.archived` on a quick-action route — cannot slip past by simply
 * not being on the list. Every census site under these path prefixes that files a
 * member-visible category must be named in
 * `OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755`, so a NEW one fails by name with
 * the readership question stated, instead of only nudging the `account` count in
 * `AUDIT_CENSUS_TOTALS` — a nudge whose failure message invites a lane to bump the
 * number and move on.
 */
export const MEMBER_RECORD_ADMIN_SURFACES_2755: readonly string[] = [
  "src/app/api/admin/members/",
  "src/lib/admin-member-",
];

/**
 * Writers that record an officer acting on ANOTHER member's record and file a
 * MEMBER-VISIBLE category on purpose (#2755).
 *
 * WHY THIS EXISTS. `INV-PRIV-012` unified six member-record actions on `admin`
 * because `account` and `security` are member-visible. Read as "officer acted ⇒
 * `admin`" that would condemn the writers below, which are shipped, reviewed, and
 * deliberately the other way — and it would hand a future lane a citation for
 * withdrawing them from members' timelines. So the rule is scoped to the six
 * actions, and these are pinned as the named exceptions: measured from the tree, so
 * moving one of them to `admin` fails here with the withdrawal named, and a NEW
 * member-visible writer on the officer surfaces fails too.
 *
 * WHAT IT IS AND IS NOT. Exhaustive for the surfaces in
 * `MEMBER_RECORD_ADMIN_SURFACES_2755`, because the census test measures those
 * paths and requires every member-visible site there to appear here. Off those
 * surfaces it is the invariant's named-exception list, not a tree-wide census of
 * member-visible writers — other officer-driven member-visible writers exist (the
 * `member_lifecycle.delete_*` group is held at `admin` on #2730, member credit
 * adjustments are `payment`), and this map does not claim otherwise.
 *
 * THE REASON THESE STAY MEMBER-VISIBLE, per group, since a pin without a reason is
 * just a number to be adjusted:
 *
 *  - The **member-photo pair** is #2581's own worked example, and it went the other
 *    way ON PURPOSE: the writer used to read `actor.onBehalf ? "admin" : "account"`
 *    and now reads `account` unconditionally, so a member sees an administrator's
 *    change to their photo in their own timeline. The artefact is the member's own
 *    photo whoever uploaded it. Note the coexistence: the admin member-detail page
 *    renders the photo editor in `mode="admin"`, so on ONE screen a field edit is
 *    `admin` and a photo change is `account`. That is domain following the
 *    ARTEFACT rather than the screen, which is the rule working, not failing.
 *  - The **cancellation writers** record an officer's decision on a membership
 *    cancellation. The member is party to that decision — usually they requested
 *    it — so the row belongs on their timeline for the same reason the member's own
 *    `membership_cancellation.requested` does. Withdrawing it would tell a member
 *    less about their own cancellation than they knew when they asked for it.
 *  - The **remaining member-admin surface writers** are each about a specific
 *    narrower domain that already answers to its own gate: a dependant link is
 *    `family`, an export is `privacy`, and a credential email is `security` by
 *    #2581 decision 3 (the domain is the CREDENTIAL, not the mailing).
 *
 * None of that is settled beyond challenge — it is recorded so a challenge has to
 * argue with a reason instead of citing a rule that never meant to cover it.
 */
export const OFFICER_DRIVEN_MEMBER_VISIBLE_WRITERS_2755: Readonly<
  Record<string, string>
> = {
  // ─── On the member-record admin surfaces (this half is exhaustive) ──────────
  "src/app/api/admin/members/[id]/dependents/[dependentId]/route.ts::DELETE.result#0":
    "family",
  "src/app/api/admin/members/[id]/dependents/link/route.ts::POST.linkedMember#0":
    "family",
  "src/app/api/admin/members/export/route.ts::GET#0": "privacy",
  "src/app/api/admin/members/send-password-reset/route.ts::POST#0": "security",
  "src/app/api/admin/members/send-setup-invite/route.ts::POST.batchResults#0":
    "security",

  // ─── The named exceptions off those surfaces ────────────────────────────────
  // The member's own photo, changed by an officer on their behalf (#2581).
  "src/app/api/members/[id]/photo/route.ts::POST#0": "account",
  "src/app/api/members/[id]/photo/route.ts::DELETE#0": "account",
  // An officer's decisions on a member's cancellation, and an officer-initiated
  // cancellation of a member's membership.
  "src/lib/membership-cancellation-admin.ts::reviewMembershipCancellationParticipant#0":
    "account",
  "src/lib/membership-cancellation-admin.ts::reviewMembershipCancellationParticipant#1":
    "account",
  "src/lib/membership-cancellation-admin.ts::reviewMembershipCancellationParticipant#2":
    "account",
  "src/lib/membership-cancellation-requests.ts::createAdminMembershipCancellationRequest#0":
    "account",
  "src/lib/membership-cancellation-requests.ts::reissueParticipantConfirmationToken#0":
    "account",
};

/**
 * The lodge-gated operational sites pinned at `admin`: the FIFTEEN that #2730 and
 * #2755 read and #2765 kept, plus later arrivals classified under the same rule
 * on arrival (#2749's other-lodges trio is the first). Pinned per site so the
 * next sweep cannot move any of them silently.
 *
 * WHY THEY STAY, IN ONE SENTENCE. The test both passes actually applied was *did
 * this site SPLIT a subsystem* — did some other writer of the same objects already
 * answer to a different gate, so that no operator could get a complete answer —
 * and this group is UNIFORM at `admin`, so there is no split to close.
 * `INV-PRIV-013` states the test and why it is the test; do not re-derive it from
 * "does the route say `lodge`", which is the surface reading that keeps proposing
 * this move.
 *
 * WHY A MAP RATHER THAN A SENTENCE. A distribution cannot see a swap, and prose in
 * a closed issue is not reachable at the moment somebody needs it — this group has
 * been re-proposed twice. Measured from the tree, so editing a ROUTE fails this,
 * not only editing the table.
 *
 * WHAT THE ASSERTIONS BESIDE IT ESTABLISH, so the keep is a property and not a
 * claim: every pinned site records `admin`; `admin` is member-INVISIBLE, so
 * nothing here reaches a member timeline through the category; and
 * `classifyAuditRetention` returns `critical` for every pinned action under
 * `admin` AND under `lodge`, so the retention-neutrality that makes the move
 * "easy" is measured rather than asserted.
 *
 * FOURTEEN ARE GATED `lodge:*` AND FOUR ARE GATED `membership:*`, and the census
 * test measures that split from the routes' own source rather than trusting this
 * comment. The four are the lockers, listed again in
 * `MEMBERSHIP_GATED_LOCKER_SITES_2765` because they were settled on their own
 * reasoning (#2777, 11 August 2026: they stay `admin`), not by inheriting the
 * group's.
 */
export const LODGE_GATED_ADMIN_CATEGORIES_2765: Readonly<
  Record<string, string>
> = {
  // ─── Chores: the roster templates an officer maintains (gated `lodge:edit`) ──
  // The nearest thing here to a split: `lodge.chore.completed` is written `lodge`
  // from `src/app/api/lodge/roster/[date]/route.ts`. It is a different act on a
  // different object (completing tonight's chore, versus editing the template), so
  // #2730 read it as adjacency rather than as one subsystem filed two ways.
  "src/app/api/admin/chores/route.ts::POST#0": "admin",
  "src/app/api/admin/chores/[id]/route.ts::PUT#0": "admin",
  "src/app/api/admin/chores/[id]/route.ts::DELETE#0": "admin",

  // ─── Lockers (gated `membership:*`, NOT `lodge:*`) — settled at `admin`, #2777
  "src/app/api/admin/lockers/route.ts::POST.locker#0": "admin",
  "src/app/api/admin/lockers/[id]/route.ts::PUT.locker#0": "admin",
  "src/app/api/admin/lockers/[id]/route.ts::DELETE#0": "admin",
  "src/app/api/admin/lockers/bulk/route.ts::POST.created#0": "admin",

  // ─── Lodge instructions, lodge settings (gated `lodge:edit`) ────────────────
  "src/app/api/admin/lodge-instructions/route.ts::PUT#0": "admin",
  "src/app/api/admin/lodge-instructions/route.ts::PUT#1": "admin",
  "src/app/api/admin/lodge-settings/route.ts::PUT#0": "admin",

  // ─── The `LODGE_*` lodge records themselves (gated `lodge:edit`) ────────────
  // `LODGE_DISPLAY_CONFIG_UPDATED` moved to `lodge` in #2730 and these did not,
  // which looks inconsistent and is not: the display writer had ten siblings
  // already saying `lodge`, so it WAS a split. These two have none.
  "src/app/api/admin/lodges/route.ts::POST.created#0": "admin",
  "src/app/api/admin/lodges/[id]/route.ts::PATCH.updated#0": "admin",

  // ─── Work parties (gated `lodge:edit`) ──────────────────────────────────────
  "src/app/api/admin/work-parties/route.ts::POST#0": "admin",
  "src/app/api/admin/work-parties/[id]/route.ts::PUT#0": "admin",
  "src/app/api/admin/work-parties/[id]/route.ts::DELETE#0": "admin",

  // ─── Other-lodges registry (#2749, arrived after the #2765 decision) ────────
  // Classified under INV-PRIV-013's rule rather than re-decided, and not merely
  // because it is new and uniform: its nearest analogue, the club's own lodge
  // records (`admin/lodges/**`), files `admin` — so filing this registry `lodge`
  // would itself OPEN a split of exactly the kind the rule exists to close.
  // Gated `lodge:view`/`lodge:edit`, filing `admin`. Pinned on arrival so the
  // next change is deliberate.
  "src/app/api/admin/other-lodges/route.ts::POST#0": "admin",
  "src/app/api/admin/other-lodges/[id]/route.ts::PATCH#0": "admin",
  "src/app/api/admin/other-lodges/[id]/route.ts::DELETE#0": "admin",
};

/**
 * The four locker writers, named again as the subgroup whose category was decided
 * separately: #2765 refused the `membership` move on measurement, and #2777
 * settled them at `admin` on 11 August 2026.
 *
 * WHY THEY WERE NOT SETTLED WITH THE OTHER ELEVEN. Their routes are gated
 * `membership:view` / `membership:edit`, not `lodge:*`, and a locker is allocated
 * to a NAMED MEMBER rather than to a building — so "lodge infrastructure" is not
 * obviously their domain, and unlike the other eleven the surface reading and the
 * access model disagree.
 *
 * WHY THE ANSWER `membership` COULD NOT SIMPLY BE APPLIED: `membership` is a
 * permission area and a correlation domain here, not an audit category, and every
 * category that does route to the membership correlation entry is member-visible.
 * The measurement, the declined alternative and the accepted cost are recorded
 * once, in `INV-PRIV-013` (narrative on #2777). The census test asserts the
 * load-bearing facts rather than trusting this comment: `isAuditCategory
 * ("membership")` is pinned false, and "member-invisible categories in the
 * membership correlation domain" is pinned as an empty set, so if that ever stops
 * being true the failure message says the question has become answerable.
 */
export const MEMBERSHIP_GATED_LOCKER_SITES_2765: readonly string[] = [
  "src/app/api/admin/lockers/route.ts::POST.locker#0",
  "src/app/api/admin/lockers/[id]/route.ts::PUT.locker#0",
  "src/app/api/admin/lockers/[id]/route.ts::DELETE#0",
  "src/app/api/admin/lockers/bulk/route.ts::POST.created#0",
];

/**
 * Every action name the sites above write, for the retention assertion
 * (#2765; the #2749 other-lodges trio arrived later and is derived the same way).
 *
 * DERIVED FROM THE CENSUS, NOT HAND-MAINTAINED — the census test asserts set
 * equality between this list and the actions the pinned sites actually write, so
 * a renamed action fails by name rather than dropping silently out of the
 * retention evidence. That gate is the whole reason this list can be trusted:
 * before it existed, renaming one of these to something access-shaped (say
 * `workparty.access_granted`) left the retention loop asserting `critical` for a
 * name no site writes, while the site that does exist expired at 24 months
 * instead of seven years and nothing objected — `classifyAuditRetention` reads
 * the ACTION as well as the category.
 *
 * ONE of the pinned sites resolves its action from an expression rather than a
 * literal — the lodge PATCH writer, which picks between `LODGE_UPDATED` /
 * `LODGE_ACTIVATED` / `LODGE_DEACTIVATED` — so the census reports it as
 * `(dynamic) …` and the test unfolds that one ternary from the route's own source.
 * Everything else is a literal; the two lodge-instruction writers share the one
 * literal name `LODGE_INSTRUCTION_UPDATED`, which is a shared name rather than an
 * expression.
 */
export const LODGE_GATED_ADMIN_ACTIONS_2765: readonly string[] = [
  "CHORE_TEMPLATE_CREATED",
  "CHORE_TEMPLATE_UPDATED",
  "CHORE_TEMPLATE_DELETED",
  "locker.created",
  "locker.updated",
  "locker.deleted",
  "locker.bulk_created",
  "LODGE_INSTRUCTION_UPDATED",
  "LODGE_SETTINGS_UPDATED",
  "LODGE_CREATED",
  "LODGE_UPDATED",
  "LODGE_ACTIVATED",
  "LODGE_DEACTIVATED",
  "workparty.create",
  "workparty.update",
  "workparty.delete",
  "OTHER_LODGE_CREATED",
  "OTHER_LODGE_UPDATED",
  "OTHER_LODGE_DELETED",
];

/**
 * The admin route directories the keep speaks for (six from #2765, plus the
 * #2749 other-lodges registry), so the UNIFORMITY premise is measured rather
 * than assumed.
 *
 * WHY THIS EXISTS. `INV-PRIV-013`'s whole argument is that this group is *uniform*
 * at `admin`, so there is no split to close. That premise is a fact about the tree,
 * and until this list existed nothing checked it: the per-site map's assertions are
 * computed over the map's OWN keys, so a NEW writer in one of these
 * subsystems filing `lodge` would create exactly the split the invariant says does
 * not exist, with every test green. The census test asserts that every audit write
 * site under these prefixes is in `LODGE_GATED_ADMIN_CATEGORIES_2765` at `admin`.
 *
 * NOT the same thing as "every `lodge:edit` route": `src/app/api/admin/display/**`
 * and `src/app/api/admin/lodge/route.ts` are also gated `lodge:edit` and correctly
 * file `lodge` — the display family was #2730's split-closing move. The uniformity
 * claim is per subsystem, which is why this is a list of directories rather than a
 * permission test; the census test covers the other direction separately, by
 * requiring every `lodge:*` gated admin writer that files `admin` to be pinned in
 * the map. The known adjacency in the other direction is `lodge.chore.completed`
 * in `src/app/api/lodge/roster/[date]/route.ts`: a different act (completing
 * tonight's chore) on a different object, outside these prefixes by design.
 */
export const LODGE_GATED_ADMIN_SUBSYSTEM_PREFIXES_2765: readonly string[] = [
  "src/app/api/admin/chores/",
  "src/app/api/admin/lockers/",
  "src/app/api/admin/lodge-instructions/",
  "src/app/api/admin/lodge-settings/",
  "src/app/api/admin/lodges/",
  "src/app/api/admin/other-lodges/",
  "src/app/api/admin/work-parties/",
];

/**
 * The word each pinned subsystem must appear under in the correlation entries'
 * evidence-scope strings, keyed by the SAME prefixes as the uniformity gate.
 *
 * WHY IT IS KEYED, NOT LISTED. `INV-PRIV-013`'s naming obligation follows the
 * map, and the map is open-ended: a later arrival is pinned here on
 * classification (#2749 was the first). A hand-typed word list in the scope test
 * would let that arrival be pinned with every census assertion green while both
 * correlation entries stay silent about it — the exact silent absence the
 * obligation exists to prevent. The scope test asserts this record's keys equal
 * `LODGE_GATED_ADMIN_SUBSYSTEM_PREFIXES_2765`, so adding a prefix without a
 * naming word fails by name, and then asserts every value appears in all three
 * pinned strings.
 */
export const LODGE_GATED_ADMIN_SUBSYSTEM_NAMING_2765: Readonly<
  Record<string, string>
> = {
  "src/app/api/admin/chores/": "chore",
  "src/app/api/admin/lockers/": "locker",
  "src/app/api/admin/lodge-instructions/": "lodge instruction",
  "src/app/api/admin/lodge-settings/": "lodge setting",
  "src/app/api/admin/lodges/": "the lodge records",
  "src/app/api/admin/other-lodges/": "other-lodges registry",
  "src/app/api/admin/work-parties/": "work part",
};

/**
 * Sites among `APPLIED_AUDIT_CATEGORIES` that still carry NO entity identifier,
 * with the reason.
 *
 * WHY AN ALLOWLIST RATHER THAN A COUNT. Child 1 measured that only 9 of the 82
 * passed an `entityType` or `entityId`, which is the "missing entity identifiers
 * that prevent bounded correlation" case the owner named as in-scope. Child 2
 * added them at 67 of the 83 sites. The remaining 16 are not oversights: each one
 * affects a COLLECTION rather than a record, or has no record id in scope, and
 * inventing an id — or reaching for the acting administrator's member id, which
 * is the tempting wrong answer — would put a false reference into the club's
 * audit trail. Recording them by name is what stops the next site being added
 * quietly.
 *
 * ONE OF THE 16 IS A CARRY-FORWARD RATHER THAN A JUDGEMENT:
 * `charge-saved-method`'s failure writer sits in an outer `catch` where the
 * booking and its id are block-scoped inside the `try`. Giving it an identifier
 * means hoisting a mutable binding across the boundary of a payment path, which
 * is more than a classification change should do; it is recorded here and in the
 * pull request rather than improvised.
 */
export const AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER: Readonly<
  Record<string, string>
> = {
  "src/app/api/admin/age-tier-settings/route.ts::PUT#0":
    "Upserts every AgeTierSetting row and deletes the removed tiers in one transaction; no single affected row, and the upserts discard their ids.",
  "src/app/api/admin/booking-policies/cancellation/route.ts::PUT#0":
    "deleteMany + createMany replace of a whole CancellationPolicy partition; the created rows' ids never reach the site.",
  "src/app/api/admin/communications/send/route.ts::POST#0":
    "A bulk send targets a recipient FILTER, not a record. `details` already carries the filter and the counts.",
  "src/app/api/admin/fee-configuration/route.ts::POST#0":
    "One writer serving eight actions whose target is a different model each time (MembershipAnnualFee, JoiningFee, FamilyGroup, Member), chosen by a branch above the call.",
  "src/app/api/admin/subscription-billing/route.ts::POST#0":
    "Upserts the singleton MembershipSubscriptionBillingSettings row; a club-wide settings write, not a record in the money domain.",
  "src/app/api/admin/subscription-billing/route.ts::POST#4":
    "A whole-season reconciliation sweep across many exception rows.",
  "src/app/api/admin/xero/account-mappings/route.ts::PUT#0":
    "Upserts an arbitrary subset of XeroAccountMapping keyed by mapping key, not by row id.",
  "src/app/api/admin/xero/item-code-mappings/route.ts::PUT#0":
    "The same shape across XeroItemCodeMapping hut-fee and joining-fee rows.",
  "src/app/api/admin/xero/link-maintenance/route.ts::POST#0":
    "Backfills and deactivates many XeroObjectLink rows in one run.",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#0":
    "The singleton XeroGroupingSettings row is id `default`, a constant rather than a record identifier.",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#5":
    "A bulk resync spanning many members; the dry-run id stays in `details`.",
  "src/app/api/admin/xero/member-grouping/route.ts::POST#6":
    "The same bulk resync, on the accepted path.",
  "src/app/api/admin/xero/operations/reset-stale-running/route.ts::POST#0":
    "An updateMany over every stale RUNNING operation.",
  "src/app/api/admin/xero/operations/retry-all/route.ts::POST#0":
    "Enqueues retries for up to 200 operations.",
  "src/app/api/payments/charge-saved-method/route.ts::POST#1":
    "The failure writer lives in the outer catch, where the booking, its id and the parsed body are all block-scoped inside the try. Capturing one would mean adding a mutable binding across the boundary, which is more than this change should do to a payment path — carried forward rather than improvised.",
  "src/lib/membership-subscription-billing.ts::confirmSubscriptionBillingPreview#0":
    "The confirm creates N charges for a season; `targetId` is the season year and no single record id exists.",
};

/**
 * Functions that write an audit row on a caller's behalf.
 *
 * Why they need declaring at all: a wrapper is one syntactic write site standing
 * for many logical events, so the site-level census under-counts them, and a
 * wrapper that quietly stopped passing a category would take every caller with
 * it. Pinning the wrapper's own category evidence means a change to it is a diff
 * in this file.
 *
 * `recordAgeUpParentEmailHandoffAudit` used to be the awkward one: a hand-built
 * Prisma `create` that wrote `communication` but bypassed
 * `buildAuditLogCreateData`, so its row got no metadata sanitisation and no
 * retention derivation — kept forever, with a recipient email address in its
 * metadata. #2581 child 2's review moved it onto `createStructuredAuditLog`.
 * Every wrapper in this list now reaches the table through the audit boundary,
 * which is what lets the docs say the boundary decides retention for every row
 * the platform writes rather than for most of them.
 */
export const AUDIT_WRITER_WRAPPERS: Readonly<
  Record<string, { sink: string; category: string }>
> = {
  "src/lib/booking-cancel.ts::logBookingCancellationAudit#0": {
    sink: "logAudit",
    category: "booking",
  },
  "src/lib/booking-cancel.ts::logBookingCancellationAudit#1": {
    sink: "logAudit",
    category: "booking",
  },
  // `admin` -> `lodge` in #2730, with the other nineteen admin-initiated
  // bed-allocation writers. This wrapper matters more than most: it stands for
  // every range assignment the club makes, and `recordRangeAssignAudit#1` writes
  // `BED_ALLOCATION_PARTNERS_PROMOTED` — an action name the automatic path in
  // `bed-allocation-move.ts` already wrote as `lodge`, so this one wrapper was
  // half of a same-action, two-permission-gate split.
  "src/lib/bed-allocation-range-audit.ts::recordRangeAssignAudit#0": {
    sink: "createAuditLog",
    category: "lodge",
  },
  "src/lib/bed-allocation-range-audit.ts::recordRangeAssignAudit#1": {
    sink: "createAuditLog",
    category: "lodge",
  },
  "src/lib/adult-member-hosting-coverage-incidents.ts::recordIncidentAudit#0": {
    sink: "createAuditLog",
    category: "booking",
  },
  "src/lib/bed-allocation-lifecycle.ts::recordPartnerPromotionAudit#0": {
    sink: "createAuditLog",
    category: "lodge",
  },
  "src/lib/bed-allocation-lifecycle.ts::recordBedDisplacementAudit#0": {
    sink: "createAuditLog",
    category: "lodge",
  },
  "src/lib/bed-allocation-lifecycle.ts::recordPartnerShareSweepAudits#0": {
    sink: "createAuditLog",
    category: "lodge",
  },
  "src/lib/cron-policy-exception-hold-reaper.ts::recordExpiryAudit#0": {
    sink: "createAuditLog",
    category: "booking",
  },
  "src/lib/google-oauth.ts::auditGoogleLink#0": {
    sink: "auditLog.create",
    category: "forwarded:buildStructuredAuditLogCreateArgs(event)",
  },
  "src/lib/member-guest-find-service.ts::auditMemberGuestResolve#0": {
    sink: "createStructuredAuditLog",
    category: "privacy",
  },
  "src/lib/member-guest-find-service.ts::auditMemberGuestSearch#0": {
    sink: "createStructuredAuditLog",
    category: "privacy",
  },
  "src/lib/diagnostics/tools/audit.ts::recordDiagnosticsToolAudit#0": {
    sink: "createStructuredAuditLog",
    category: "security",
  },
  "src/lib/xero-inbound/audit.ts::writeXeroInboundAuditLogs#0": {
    sink: "createAuditLog",
    category: "xero",
  },
  "src/lib/xero-bulk-contact-sync.ts::writeXeroContactSyncAudit#0": {
    sink: "createAuditLog",
    category: "xero",
  },
  "src/lib/cron-age-up.ts::recordAgeUpParentEmailHandoffAudit#0": {
    sink: "createStructuredAuditLog",
    category: "communication",
  },
};

/**
 * `auditLog` statements that do not produce a row, and are therefore approved
 * NOT to carry a category.
 *
 * Today these are the three retention statements only: the archive `updateMany`,
 * the prune `deleteMany`, and the request-data anonymisation `updateMany`. They
 * mutate or remove rows that already have whatever category they were written
 * with, so "why does this not set a category" has an answer, and the answer is
 * recorded here rather than assumed by a scan that skips non-`create` methods.
 *
 * A new entry here is a hand-written mutation of the platform's audit trail and
 * needs the same scrutiny as a new writer.
 */
export const APPROVED_NON_PRODUCING_AUDIT_DML: Readonly<Record<string, string>> = {
  "src/lib/audit-retention.ts::archiveEligibleAuditLogs#0":
    "Retention archive: stamps `archivedAt` on rows past their archive threshold.",
  "src/lib/audit-retention.ts::pruneExpiredAuditLogs#0":
    // Corrected in #2581 child 2, because this change is what makes it matter:
    // `incidentPreserved` is NOT in the prune predicate. It guards only
    // `anonymizeExpiredAuditRequestData` and the archive's request-data copy, so
    // there is no per-row exemption from deletion. Every one of the 83 sites this
    // change classifies lands in `critical`, whose branch is `createdAt < cutoff`
    // AND `expiresAt < now` — unconditional at seven years.
    "Retention prune: deletes rows past `expiresAt` (for `critical`, also past " +
      "the seven-year `createdAt` cutoff). There is no incident-preservation " +
      "exemption from this statement.",
  "src/lib/audit-retention.ts::anonymizeExpiredAuditRequestData#0":
    "Retention anonymisation: clears `ipAddress`/`userAgent` on rows past the request-data window.",
};

/**
 * Raw-SQL DML against `"AuditLog"` inside committed migrations.
 *
 * WHY THIS LIST EXISTS RATHER THAN AN ASSERTION THAT `prisma/` IS CLEAN. It is
 * not clean, and a TypeScript-only census would have said it was: two migrations
 * write the audit table directly, bypassing `audit.ts` and everything it
 * guarantees — no `sanitizeAuditMetadata`, no retention derivation, no closed
 * category type. Both are legitimate and both are reviewed; the point is that a
 * THIRD one has to be reviewed too, and a census that could not see them would
 * have let it through while reporting a clean tree.
 *
 * An `INSERT` here is a row-producing write and its column list is checked for
 * `"category"` — the email-override migration names it and passes `'admin'`.
 * `UPDATE` and `DELETE` mutate rows that already carry whatever category they were
 * written with, so they are the SQL counterpart of
 * `APPROVED_NON_PRODUCING_AUDIT_DML`.
 *
 * Committed migrations are immutable, so this list only ever grows, and every
 * addition is a deliberate change to the club's audit history.
 */
export const APPROVED_MIGRATION_AUDIT_SQL: Readonly<Record<string, string>> = {
  "prisma/migrations/20260710000100_redact_audit_log_door_codes/migration.sql::update#0":
    "Door-code redaction (#2115): removes leaked lodge door codes from historical audit summaries.",
  "prisma/migrations/20260710000100_redact_audit_log_door_codes/migration.sql::update#1":
    "Door-code redaction: the same sweep over `details`.",
  "prisma/migrations/20260710000100_redact_audit_log_door_codes/migration.sql::update#2":
    "Door-code redaction: the same sweep over `metadata`.",
  "prisma/migrations/20260710000100_redact_audit_log_door_codes/migration.sql::update#3":
    "Door-code redaction: the final sweep pass.",
  "prisma/migrations/20260801150000_strip_email_override_bracket_annotations/migration.sql::insert#0":
    "Email-override cleanup: records one EMAIL_TEMPLATE_OVERRIDE_UPDATED row per template the upgrade rewrote. Names `\"category\"` and writes `admin`, plus an explicit severity, retentionClass and expiresAt.",
  "prisma/migrations/20260810020000_backfill_bed_allocation_audit_category/migration.sql::update#0":
    "The #2751 backfill: rewrites `category` from `admin` to `lodge` on the bed-allocation and lodge-display rows written before #2730 moved their writers, matched by an EXACT literal list of the 18 action names those 22 sites write (never a prefix). It is the only column in the SET clause, so severity, retentionClass, expiresAt, createdAt, details, metadata and every actor column keep the bytes they were written with — and retention cannot move, because prune and archive select on the stored retentionClass/expiresAt and never read `category`. Pinned against `REVIEWED_ADMIN_CATEGORIES_2730` by src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts and executed against a real PostgreSQL by its verification fixture.",
  "prisma/migrations/20260810020000_backfill_bed_allocation_audit_category/migration.sql::insert#0":
    "The same backfill's record of itself: one AUDIT_CATEGORY_BACKFILLED row carrying the before/after counts decision B asked for, written only when rows actually moved so a replay appends nothing. Names `\"category\"` and writes `admin` — the support-only category, on purpose, so the operator who just lost these rows from their system correlation entry can see in that entry why — plus an explicit severity, retentionClass and expiresAt.",
};

/**
 * Row-producing sites whose category is decided somewhere other than the call.
 *
 * Exactly one today, and it is safe for a specific reason rather than by
 * convention: `auditGoogleLink` takes a whole `StructuredAuditEvent` and forwards
 * it, and `StructuredAuditEvent.category` is REQUIRED and closed, so every one of
 * its five callers must supply a canonical value (all five supply `security`).
 * A new entry here is a wrapper that can smuggle a missing or invented category
 * past the type system, which is why the list is pinned rather than tolerated.
 */
export const APPROVED_FORWARDED_CATEGORY_SITES: Readonly<Record<string, string>> = {
  "src/lib/google-oauth.ts::auditGoogleLink#0":
    "Forwards a caller-supplied StructuredAuditEvent, whose `category` is required and closed; all five callers pass `security`.",
};
