---
name: alpineclub-lifecycle-review
description: Lifecycle planning and review workflow for AlpineClubBookingsNZ. Use for booking, waitlist, membership application, nomination, cancellation, archive, delete, family/dependent, email retry, Xero outbox, and cron recovery state-machine reviews.
---

# AlpineClub Lifecycle Review

## Read First

- `AGENTS.md`, and the rows of its routing table that match the surfaces you
  touch.
- For a routed reference doc (`docs/STATE_MACHINES.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, `docs/ARCHITECTURE.md`), read its headings
  first, then only the section that matches; never the whole file.
- The invariant domain files this
  review actually needs: `docs/invariants/membership-lifecycle.md` (`INV-LIFE`),
  `docs/invariants/booking-modifications.md` (`INV-MOD`), and
  `docs/invariants/booking-dates-and-capacity.md` (`INV-DATE`, `INV-CAP`)

## Allowed Actions

- Trace state transitions and terminal states.
- Identify missing expiry, retry, admin visibility, and repair paths.
- Map needed tests and issue splits.

## Disallowed Actions

- Do not change application logic unless explicitly authorized by a focused
  issue.
- Do not widen scope into payment/provider/schema work unless the issue allows
  it.
- Do not use production data or live providers.
- Do not merge or close anything; merges follow `AGENTS.md` "Completion and
  Merge".

## Expected Output

- State-machine findings with affected paths.
- Open questions marked "to verify" when exact states are uncertain.
- Tests, validation, manual checks, and residual risk.

## Validation

Use targeted unit/service tests and safe static searches. For high-risk flows,
require human review before any implementation PR.
