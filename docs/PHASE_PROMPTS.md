# Claude Code Prompts for Each Phase

Copy-paste these into a new Claude Code CLI session to start work on each phase.

---

## Phase 1: Bug Fixes & Quick Wins

```
Work on Phase 1 (issue #48). Read the GitHub issue for acceptance criteria, then read the detailed plan at .claude/plans/moonlit-gathering-reddy.md for file paths and implementation details. Create a branch, implement all items, run tests and build to verify, then create a PR that closes #48.
```

## Phase 2: Booking List & Calendar Enhancements

```
Work on Phase 2 (issue #49). Read the GitHub issue for acceptance criteria, then read the detailed plan at .claude/plans/moonlit-gathering-reddy.md for file paths and implementation details. Create a branch, implement all items, run tests and build to verify, then create a PR that closes #49.
```

## Phase 3: Family Groups & INFANT Age Tier

This phase has 4 items. P3.3 (INFANT tier + dynamic validators) is the highest-touch change — touches 17+ files.

```
Work on Phase 3 (issue #50). This has 4 items — start with P3.3 (INFANT age tier + dynamic validators) as it's the highest-touch change. Read the GitHub issue for the 6-step approach, then read .claude/plans/moonlit-gathering-reddy.md for file paths and line numbers. Create a branch, implement all 4 items, run tests and build, then create a PR that closes #50.
```

## Phase 4: Member Address & Dependent Management

```
Work on Phase 4 (issue #51). Read the GitHub issue for acceptance criteria, then read the detailed plan at .claude/plans/moonlit-gathering-reddy.md for file paths and implementation details. Create a branch, implement all items, run tests and build to verify, then create a PR that closes #51.
```

## Phase 5: Pricing, Promos & Cancellation

This phase has 5 items and 3 schema migrations. P5.4 is a post-cancellation refund appeal workflow (not a replacement for auto-refunds).

```
Work on Phase 5 (issue #52). This has 5 items with 3 schema migrations. Read the GitHub issue carefully — P5.4 is a refund APPEAL workflow (post-cancellation), not a replacement for auto-refunds. Read .claude/plans/moonlit-gathering-reddy.md for file paths. Create a branch, implement all items, run tests and build, then create a PR that closes #52.
```

## Phase 6: Xero Item Codes & Entrance Fees

```
Work on Phase 6 (issue #53). Read the GitHub issue for acceptance criteria — note the Xero ItemCode vs AccountCode context section. Read .claude/plans/moonlit-gathering-reddy.md for file paths. Create a branch, implement all items, run tests and build, then create a PR that closes #53.
```

## Phase 7: Membership Nomination Workflow

This is the largest feature. Split across multiple sessions if needed.

### Session 1 — Schema + Form + Nominator Verification

```
Work on Phase 7 (issue #54), sub-phase A only: schema migration (MemberApplication + NominationToken models), public application form at /join/apply (under the (website) route group), and nominator email verification. Read the GitHub issue for full context. Create branch phase-7-nomination. Do NOT attempt the full workflow in one go — stop after the form submission and nominator email sending work. Run tests and build to verify.
```

### Session 2 — Nominator Confirmation + Admin Review

```
Continue Phase 7 (issue #54) on branch phase-7-nomination. Sub-phase B: nominator confirmation page (authenticated route where nominators log in and click "Agree to Nominate"), status transition to PENDING_ADMIN when both confirm, admin notification email, and admin review page at /admin/member-applications with approve/reject. Read the GitHub issue for full context. Run tests and build to verify.
```

### Session 3 — Approval Flow + Xero + Entrance Fee

```
Continue Phase 7 (issue #54) on branch phase-7-nomination. Sub-phase C: on admin approval — auto-create Member records (applicant + family), push contacts to Xero, generate entrance fee invoice (uses Phase 6 createXeroEntranceFeeInvoice), send welcome email. Add sidebar badge for pending applications. Run tests and build, then create a PR that closes #54.
```

## Phase 8: Hut Leader & Kiosk Improvements

```
Work on Phase 8 (issue #55). Read the GitHub issue for acceptance criteria. Note: P8.3 (PIN login) requires bcrypt-hashed PINs with rate limiting (5 attempts/min). Read .claude/plans/moonlit-gathering-reddy.md for file paths. Create a branch, implement all items, run tests and build, then create a PR that closes #55.
```

## Phase 9: Reports & Analytics Enhancements

```
Work on Phase 9 (issue #56). Read the GitHub issue for acceptance criteria. Note the dynamic granularity breakpoints: <=14 days = daily, 15-90 days = weekly, >90 days = monthly. Read .claude/plans/moonlit-gathering-reddy.md for file paths. Create a branch, implement all items, run tests and build, then create a PR that closes #56.
```

---

## After Each Phase is Merged

Update the status table in CLAUDE.md:

```
Update the Active Build Plan table in CLAUDE.md — mark Phase N as COMPLETE.
```
