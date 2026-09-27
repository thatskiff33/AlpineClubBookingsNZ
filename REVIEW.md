# Production-Hardening Review — Findings Report

**Branch:** `review/production-hardening` · **Base:** `origin/main @ 297216a7`
**Date:** 2026-07-15 · **Reviewer:** multi-agent adversarial audit
**Status:** Awaiting owner approval — **no application code has been changed.**

> **Disclosure note.** These findings are unpatched and this repository is public.
> This report is written at **remediation altitude**: it names each defect's location,
> class, impact, and fix direction — but omits the step-by-step concurrency interleavings
> and reproduction sequences. The full exploit-level detail (precise race orderings,
> attacker-reproducible steps) is held in a **private artifact** and is available to
> implementers on request; it is deliberately not committed to this public repo until the
> P0 fixes have landed. Each GitHub issue links the private detail rather than restating it.

---

## 1. Executive summary

The codebase is already heavily hardened. The July audit (epic #1348) closed the classic
vulnerability classes, and a fresh sweep of the ~757 non-test source files and 40 migrations
landed since that cut (`e2a51e76`) found **no open critical vulnerability** — no auth bypass,
no injection, no secret leak, no unguarded route (the CI route-boundary test genuinely
prevents that class). Stripe/Xero/SNS signature verification, per-provider webhook
idempotency, and the CI security gate set (Semgrep, gitleaks×2, Trivy, npm audit, knip) are
all real and enforced.

The residual risk is concentrated and coherent. **One structural regression dominates:** the
multi-lodge migration replaced the club-wide `pg_advisory_xact_lock(1)` with per-lodge locks
for capacity claims — but a family of money and status-claim writers (cancel, hold-release,
group-settlement reaper, Stripe capture) kept the global lock while their counterparties moved
to the per-lodge key. **They no longer mutually exclude.** Code comments and
`docs/CONCURRENCY_AND_LOCKING.md` still assert the old "same lock" guarantee, so these paths
read as safe but are not. This one event produced the majority of the High-severity findings,
all in gated areas (money / capacity).

For the **100-concurrent-user target**, the binding constraint is not the database but the
active web slot's **5-connection pool**: booking transactions hold a connection while waiting
on the advisory lock, so a single-lodge booking burst can exhaust the pool and stall other
traffic (and degrade the rate limiter). This is a documented-config fix, not an architecture
change — the right scale of intervention for the target.

### Methodology

Two audit waves, 126 agents, each finding produced by a finder then attacked by 1–2
independent adversarial verifiers. **29 candidate findings were refuted and dropped** (§7) —
including both auth findings and a PIN brute-force finding, shown to be already mitigated. A
completeness critic identified 8 blind spots, all closed in wave 2. **45 distinct findings
survived** verification, and a sample of the Highs was re-checked against live code.

### Severity profile

| Severity | Count | Gated (owner-approval to merge) |
|---|---|---|
| High | 8 | 8 |
| Medium | 24 | 15 |
| Low | 13 | 3 |
| **Total** | **45** | **26** |

No Critical (nothing is exploitable for loss *today* absent a concurrency race or operator
misconfiguration). The 8 Highs are money/capacity correctness under concurrency — defects that
stay invisible until load, which is exactly the production bar here.

---

## 2. Priority waves (proposed execution order)

- **W1 — Concurrency & money correctness (P0, one coordinated lane, all gated).** The
  lock-topology cluster (F1–F5, F8–F15) plus the non-lock money defects (F6, F7, F16–F23).
  These touch a small shared set of files and the fixes interact, so they are **not run in
  parallel** — a single "lock topology" restoration plus per-site status guards.
- **W2 — Scale & stability for 100 users (P0–P1).** Pool sizing (F17), admin-list unbounded
  load (F24), and the **k6 harness + 100-VU evidence run**.
- **W3 — Correctness edges & tests (P1).** NZ date one-day-off (F8), email suppression/retry
  (F25, F26, F33), cron step-isolation (F27), season billing timeout (F12), silent test (F28).
- **W4 — UI/UX & accessibility (P2, parallel-safe).** Form-error announcement (F30), segment
  error/not-found boundaries (F35), finance loading skeleton (F36).
- **W5 — Docs, ops & onboarding (P2–P3, parallel-safe).** Concurrency-doc refresh (F37),
  compose project-name drift (F40), dead env vars (F41), backup retention (F42), health doc
  (F43).
- **W6 — Close-out.** Re-run k6 post-pool-fix; final report; epic close.

---

## 3. High-severity findings (all gated — owner approval required to merge)

> **Shared root, shared fix.** F1–F5 and F8-adjacent lock findings stem from one regression.
> The recommended remedy is a single **lock-topology restoration**: writers that mutate the
> same row family must share a key, using the in-tree precedent (`invoice-paid-effects.ts` —
> global lock *then* per-lodge lock, in that order, to stay deadlock-safe). Each site
> additionally gets a **status-guarded write** (`updateMany({ where: { id, status: <expected> }
> })`, bail on count 0) so a lost race is a no-op regardless of lock key. Stale comments and
> `docs/CONCURRENCY_AND_LOCKING.md` are corrected in the same lane.

| ID | Location | Defect (class) | Impact | Fix direction |
|---|---|---|---|---|
| **F1** | `src/lib/payment-reconciliation.ts:107` | Stripe capture (per-lodge lock) no longer serializes against cancel/release (global lock) | A booking can settle **PAID after its cancellation side effects already ran** (credit restored, Xero note issued, beds released) → member charged *and* credited | Capture/settle also take the global lock; status-guard the claim writes; fix false comments |
| **F2** | `src/lib/cron-group-settlement-reaper.ts:343` | Settlement reaper (global lock) vs settle path (per-lodge key) | Paid group children reverted and later cancelled **without refund**; SUCCEEDED settlement overwritten FAILED | Share a key; make reaper child-reverts status-guarded |
| **F3** | `src/lib/booking-request.ts:1054` | Quote-accept (per-lodge lock) vs hold cancel/expiry (global lock) — reopens `#1406`/`#1311` | Accepted booking silently cancelled, or released hold resurrected → beds double-promised | Accept takes global lock first; status-guard all hold-release writes |
| **F4** | `src/lib/booking-guest-removal-service.ts:274` | Modification services (per-lodge lock) vs cancel/expiry (global lock) on the same Booking/Payment rows | Refund/credit **computed and issued twice** against one payment | Shared per-booking serialization or status-guarded commits |
| **F5** | `src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts:180,304,393` | Admin capacity claim uses the retired global lock, not per-lodge | **Overbook** — the check can't see a concurrent per-lodge claim | Replace the three `pg_advisory_xact_lock(1)` with `acquireLodgeCapacityLock` |
| **F6** | `src/lib/group-settlement.ts:207` | Refunded group-settlement intent re-admittable (group analogue of `#1765`); settlement row never marked after refund | Children settled **at zero net cash** (money already refunded) | Mark settlement post-refund; refuse intents with refund history; propagate real outcome |
| **F7** | `src/lib/xero-operation-retry.ts:849` | Admin retry drops `recordPayment=false` | **Phantom Xero cash payment** booked for an uncaptured IB invoice; clearing account overstated | Thread `recordPayment` through the retry branch; regression test |
| **F8** | `src/lib/nzst-date.ts:41` | `getNZSTToday/Tomorrow` build NZ-local-midnight instants; under the `TZ=Pacific/Auckland` pin they serialize as **yesterday** for `@db.Date` | Four crons (complete-bookings, check-in reminders, capacity warnings, hut-leader auto-assign) run **one day off** in production | Switch to `getTodayDateOnly()`/`addDaysDateOnly` from `date-only.ts`; fix the test that pins the bug |

*(F1 capture-key, F5 lock calls, and F8 date construction + the `TZ=Pacific/Auckland` pin were
spot-verified against live code during this review.)*

---

## 4. Medium-severity findings

**Concurrency cluster (gated):**
- **F9** `booking-create.ts:265` — club-wide member-night invariant now serialised only
  per-lodge → same member double-booked across two lodges for one night. Fix: per-member lock.
- **F10** `xero-inbound/credit-note-repairs.ts:524` — BOOKING_APPLIED credit-ledger written
  under the global lock while the spend engine uses the per-member ledger lock → double-count.
- **F11** `bookings/[id]/waitlist-confirm/route.ts:96` — $0 branch claims capacity in a
  lockless second transaction, no re-check, no status guard → overbook.
- **F13** `waitlist.ts:691` — offer-expiry cron locks only the default lodge and reverts
  unguarded; accept consumes a stale snapshot → accepted offer clobbered / re-offered.
- **F14** `payments/switch-to-internet-banking/route.ts:242` — claims from a stale pre-lock
  snapshot, no under-lock re-read → overbook / resurrect a cancelled booking.
- **F15** `group-cancel.ts:216` — settlement flipped FAILED unguarded from a stale read → a
  concurrent settlement success loses the organiser's refund.

**Money / provider (gated):**
- **F12** `membership-subscription-billing.ts:443` — whole-club season billing runs in a
  default-5s transaction with N+1 fee lookups → P2028 rollback for larger clubs, season can't
  be invoiced. Fix: explicit `{ timeout }` + hoist the fee lookup.
- **F16** `stripe-webhook-service.ts:65` — dedup claim has two lost-event windows (crash
  before completion; concurrent redelivery ACKed while the in-flight attempt later fails). Fix:
  status + lease on `ProcessedWebhookEvent`.
- **F17** `payment-reconciliation.ts:366` — capacity-race auto-refund has no durable recovery;
  a failed Stripe refund strands money behind one best-effort email. Fix: enqueue the existing
  refund-recovery op.
- **F18** `xero-inbound/invoice-paid-effects.ts:1206` — group-settlement apply errors swallowed
  → inbound event marked PROCESSED, no retry. Fix: rethrow (the `#1435` pattern).
- **F19** `xero-operation-outbox.ts:1151` — WAITING_PAYMENT reap has no age floor → races a
  same-intent successful retry → captured money with no Xero invoice.
- **F20** `payments/create-payment-intent/route.ts:137` — pre-payment modification can drop
  price below applied credit → booking dead-ends unpayable, credit over-consumed.
- **F21** `xero-operation-outbox.ts:158` — entrance-fee invoice can be minted twice (dedup keyed
  on amount/category; worker never adopts by reference).
- **F22** `nomination.ts:1516` — entrance-fee invoice lost if the process dies before the
  post-commit enqueue; no reconciliation surface. Fix: enqueue inside the approval transaction.
- **F23** `member-lifecycle-actions.ts:1094` — review approve/reject race; neither path
  re-claims REQUESTED status → a member can be hard-deleted after another admin rejected.

**Stability / correctness / tests / a11y:**
- **F24** `admin-bookings-service.ts:768` — admin bookings list loads every matching row (+8
  relation includes) into JS for filters/sort → multi-second query, possible OOM of the active
  slot after a few seasons. Fix: push filters into SQL; id-page; cap.
- **F25** `cron-email-retry.ts:77` — retry re-sends without re-checking the SES suppression
  list. Fix: check `getActiveEmailSuppression` before send.
- **F26** `waitlist.ts:465` / `payment-link.ts:316` / `internet-banking-payment-cron.ts:318` —
  suppressed money-adjacent mail (waitlist offer, IB hold-expiry, payment-link reissue) reports
  success while the member is never notified and the obligation keeps ticking. Fix: inspect the
  `EmailSendOutcome`; raise an admin signal on `suppressed`.
- **F27** `instrumentation.node.ts:563` — data-pruning cron has no per-step isolation; an early
  failure starves expired security-token pruning. Fix: per-step try/catch.
- **F28** `booking-guest-range-triggers.test.ts:9` — real-DB envelope-trigger suite is a
  permanent silent no-op in CI (env gate set by no job). Fix: wire it in migration-drift.
- **F29** `config-transfer/apply.ts:93` — config import accepts a non-durable (local-only)
  backup as its ADR-002 safety gate, auditing it as real. Fix: treat `!uploadedToS3` as a
  failed gate when `BACKUP_ENABLED`.
- **F30** `join/apply` + booking-requests + 3 admin forms — validation/submission errors not
  announced to assistive tech (no `aria-invalid`/`aria-describedby`; error containers lack
  `role="alert"`). Fix: standard field-error + live-region pattern.

---

## 5. Low-severity findings

- **F31** `confirm-payment/route.ts:229` (+~36 routes) — raw `err.message` returned to
  authenticated clients in money-route fallback catches. Fix: generic to client, raw to pino.
- **F32** `school-attendee-confirmation.ts:50` (+4) — raw `new Date()` vs `@db.Date` shifts
  window boundaries by a day for ~13h each NZ day. Fix: `date-only` helpers.
- **F33** `cron-email-retry.ts:85` — email retry has no send idempotency; a crash between SMTP
  accept and DB ack duplicates money-adjacent mail. Fix: claim-before-send.
- **F34** `member-lifecycle-actions.ts:287` — member delete misses the
  `MembershipSubscriptionCharge.recipientMemberId` RESTRICT FK → raw FK 500 instead of a clean
  blocker.
- **F35** `src/app/not-found.tsx` — `notFound()` in authenticated/admin routes falls through to
  the marketing 404. Fix: segment `not-found.tsx`.
- **F36** `(finance)/finance/page.tsx` — no `loading.tsx`; blank gap during the full aggregate.
  Fix: one Skeleton-based `loading.tsx`. (Lodge routes are client-fetched — do not add there.)
- **F37** `docs/CONCURRENCY_AND_LOCKING.md` — stale vs actual lock keys. Fix: refresh in the
  F1–F5 lane.
- **F38** schema/safety-ledger comment drift (phantom Booking FK; stale "nothing reads
  queueType" claim the outbox scan now depends on). Fix: correct comments.
- **F39** `docs/END_TO_END_TEST_MATRIX.md:26` — declares email-code 2FA a coverage gap a spec
  already covers.
- **F40** compose project-name drift (README vs IMPLEMENTATION_GUIDE) → orphaned staging stack.
- **F41** docker-compose injects seven dead `FEATURE_*` env vars no code reads.
- **F42** `BACKUP_RETENTION_DAYS` prunes only tmpfs; S3 backups grow forever. Fix: document the
  S3 lifecycle requirement.
- **F43** `DEPLOYMENT.md:330` points at `/api/health` for a signal that lives on
  `/api/admin/health`.

---

## 6. Needs a human decision

1. **Node engine pin `>=24 <25`** (`package.json:15`). Biggest clone-to-run tripwire for
   contributors on Node 20/22 LTS. Widen the range (and test on 22), or keep the pin and
   surface a prominent `nvm use` gate in the README quickstart. Support-surface trade-off.
2. **Connection-pool sizing target** (F17 lane). Recommended web slots `connection_limit=10`,
   cron-leader 5, migrate 2, vs `max_connections=30`. The k6 run will inform the final ceiling.
3. **Whether any lock fix warrants a DB-level backstop** (partial unique index) vs
   advisory-lock + status-guard only. The member-night invariant (F9) *cannot* be a DB
   constraint (#1039); others could. Recommend advisory-lock + status-guard unless the race
   tests argue otherwise.

---

## 7. Deliberately dropped (refuted by verification) — do not re-file

- **PIN brute-force / lockout** — bcrypt cost + per-IP throttle + layered controls make the
  distributed-guess scenario impractical; no per-account lockout is a defensible design here.
- **Both auth findings** (admin permission-header degradation; rate-limit boundary burst) — the
  proxy matcher unconditionally injects/overwrites the path header for every `/api/admin/*`
  route, and the boundary burst is backstopped by per-account 2FA lockout.
- **Credit-restore double-restore** — **closed by `#1636`** (`restoredFromBookingId` nullable
  unique + `ON CONFLICT DO NOTHING`). This is why F1's damage is the *other* side effects.
- **Manual `/api/cron` bypassing the in-process overlap guard** — every cron task is already
  idempotent under concurrency; the guard is an optimization, not a correctness invariant.
- Several diff-sweep dimensions (admin UI, member/public pages, scripts/CI, lib subsystems)
  returned **zero** findings — those post-audit areas are genuinely sound.

The full 17-site lock-inventory matrix confirmed the credit-restore family, the per-member
ledger family, and the `invoice-paid-effects` two-lock composition are sound; the findings
above are the *only* unmatched writer-pairs.

---

## 8. Deliberately left alone (in scope, not recommended for change)

- **CSP `style-src 'unsafe-inline'` / `img-src https:`** — documented interim; sanitize-html
  covers the CMS surface; a separate hardening pass, not a finding.
- **Fixed-window rate limiter** — the 2× boundary burst is inconsequential given per-account
  lockouts; a sliding window is over-engineering for the target.
- **HSTS max-age mismatch** between `csp.ts` and Caddyfile — cosmetic; both valid.
- **Redis / caching / queue infrastructure** — out of scope for 100 users; the pool-sizing fix
  is sufficient.
- **Per-route body-size normalization** (~30 admin routes on raw `request.json()`) — all
  authenticated and zod-validated; low-value.

---

## 9. Verification plan (Phase 3–4)

Every fix PR carries proof from this run, not assertion:
- **Race fixes (F1–F15):** a real-DB concurrency test on a throwaway Postgres (**never** port
  5432) that reproduces the interleaving *red* before the fix, *green* after — plus the
  `review-findings-contracts` static guard re-tightened to require the correct lock key (it
  currently accepts either marker, which is why the regression slipped).
- **NZ date (F8):** unit test asserting `@db.Date` serialization equals the NZ calendar date
  under `TZ=Pacific/Auckland`, red→green.
- **Money/provider (F6, F7, F12, F16–F23):** targeted vitest reproducing the failure.
- **Scale (F17, F24):** k6 at 100+ VUs against the local Docker e2e stack (throwaway DB,
  pre-flight asserts the target is not `:5432`); re-run after the pool fix.
- **A11y (F30):** `@axe-core/playwright` scan wired into the e2e job.
- **Per PR:** `pnpm run lint`, `db:generate`, `typecheck`, targeted `vitest` locally; full suite
  + migration-drift + Playwright arbitrated by CI, links quoted in the PR body.

---

*This report changed no application code. Full exploit-level detail is held privately per the
disclosure note. On approval, findings become a GitHub epic + one self-contained issue per
finding (or batch), executed in the wave order above via the AGENTS.md orchestrator/subagent
contract, with owner approval gating every merge in a gated area.*
