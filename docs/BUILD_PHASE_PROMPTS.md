# TACBookings Build Phase Prompts

Use these prompts in Claude Code CLI to build each phase. Run them in order — each phase depends on the previous one being merged to main first.

---

## Phase A: Critical Bug Fixes

```
You are working on the TACBookings project. Read CLAUDE.md for full project context.

Your task is to implement all Phase A bug fixes from these GitHub issues:

1. #19 - Invalid promo code shows stale discount in booking modification UI
2. #20 - Lodge Kiosk login failure + missing admin management UI  
3. #21 - Kiosk date navigation timezone bug (formatDate uses UTC instead of local)
4. #22 - Hut Leader eligible members query excludes PAID bookings
5. #23 - Cron job Prisma failures + System Health truncated error messages
6. #30 - Add Sentry Session Replay integration

Read each GitHub issue for full implementation details including exact file paths, root causes, and code fixes needed.

## Development Workflow

Work on a new branch called `phase-a-bug-fixes` created from `main`.

For each issue:
1. Read the issue from GitHub for full context
2. Read the relevant source files before making changes
3. Implement the fix
4. Write/update tests
5. Commit with a message referencing the issue number (e.g. "Fix #19: ...")

## Verification (MANDATORY before proceeding to merge)

After ALL fixes are implemented, run these checks. ALL must pass before merging:

npm test          # All 948+ tests must pass
npm run build     # Must complete without errors

If tests fail or build breaks:
- Fix the issue
- Re-run both checks
- Do NOT proceed to merge until both pass cleanly

## Merge to Main (only after verification passes)

Once tests and build both pass:

1. Push the branch: `git push -u origin phase-a-bug-fixes`
2. Create a pull request using `gh pr create` with:
   - Title: "Phase A: Critical Bug Fixes (#19, #20, #21, #22, #23, #30)"
   - Body: Summary of all changes, test results, and build confirmation
3. Merge the PR into main: `gh pr merge --squash --delete-branch`
4. Switch to main and pull: `git checkout main && git pull origin main`
5. Confirm main is up to date: `git log --oneline -5`

## Safety Rules

- NEVER force push
- NEVER merge without tests and build passing
- If ANY test fails or build breaks after your changes, fix it before merging
- If you cannot fix a failing test, stop and report the issue — do NOT merge
- Each commit should be atomic and revertable
- The squash merge keeps main history clean
```

---

## Phase B1: Lodge Kiosk Tiered Access + Expected Arrival Time

```
You are working on the TACBookings project. Read CLAUDE.md for full project context.

Your task is to implement all Phase B1 features from these GitHub issues:

1. #24 - Lodge Kiosk tiered access model with 4 permission levels (Staying Guest read-only, Lodge, Hut Leader, Admin)
2. #31 - Expected Arrival Time on bookings with kiosk display (time picker with 30-min increments)

Read each GitHub issue for full implementation details including exact file paths, schema changes, access tier logic, and UI requirements.

## Development Workflow

Work on a new branch called `phase-b1-kiosk-access` created from `main`.

For each issue:
1. Read the issue from GitHub for full context
2. Read the relevant source files before making changes
3. Implement the feature
4. Write/update tests
5. Commit with a message referencing the issue number (e.g. "Implement #24: ...")

## Verification (MANDATORY before proceeding to merge)

After ALL features are implemented, run these checks. ALL must pass before merging:

npm test          # All tests must pass
npm run build     # Must complete without errors

If tests fail or build breaks:
- Fix the issue
- Re-run both checks
- Do NOT proceed to merge until both pass cleanly

## Merge to Main (only after verification passes)

Once tests and build both pass:

1. Push the branch: `git push -u origin phase-b1-kiosk-access`
2. Create a pull request using `gh pr create` with:
   - Title: "Phase B1: Lodge Kiosk Tiered Access + Expected Arrival Time (#24, #31)"
   - Body: Summary of all changes, test results, and build confirmation
3. Merge the PR into main: `gh pr merge --squash --delete-branch`
4. Switch to main and pull: `git checkout main && git pull origin main`
5. Confirm main is up to date: `git log --oneline -5`

## Safety Rules

- NEVER force push
- NEVER merge without tests and build passing
- If ANY test fails or build breaks after your changes, fix it before merging
- If you cannot fix a failing test, stop and report the issue — do NOT merge
- Each commit should be atomic and revertable
- The squash merge keeps main history clean
```

---

## Phase B2: Hut Leader Enhancements

```
You are working on the TACBookings project. Read CLAUDE.md for full project context.

Your task is to implement all Phase B2 features from this GitHub issue:

1. #25 - Hut Leader assignment enhancements: auto-suggest candidates, overlap validation (max 1 day), auto-assign when only 1 adult, admin dashboard notification for unassigned dates within 14 days

Read the GitHub issue for full implementation details including exact file paths, validation rules, cron job specs, and UI requirements.

## Development Workflow

Work on a new branch called `phase-b2-hut-leader` created from `main`.

For each feature within the issue:
1. Read the issue from GitHub for full context
2. Read the relevant source files before making changes
3. Implement the feature
4. Write/update tests
5. Commit with a descriptive message (e.g. "Add hut leader overlap validation for #25")

## Verification (MANDATORY before proceeding to merge)

After ALL features are implemented, run these checks. ALL must pass before merging:

npm test          # All tests must pass
npm run build     # Must complete without errors

If tests fail or build breaks:
- Fix the issue
- Re-run both checks
- Do NOT proceed to merge until both pass cleanly

## Merge to Main (only after verification passes)

Once tests and build both pass:

1. Push the branch: `git push -u origin phase-b2-hut-leader`
2. Create a pull request using `gh pr create` with:
   - Title: "Phase B2: Hut Leader Enhancements (#25)"
   - Body: Summary of all changes, test results, and build confirmation
3. Merge the PR into main: `gh pr merge --squash --delete-branch`
4. Switch to main and pull: `git checkout main && git pull origin main`
5. Confirm main is up to date: `git log --oneline -5`

## Safety Rules

- NEVER force push
- NEVER merge without tests and build passing
- If ANY test fails or build breaks after your changes, fix it before merging
- If you cannot fix a failing test, stop and report the issue — do NOT merge
- Each commit should be atomic and revertable
- The squash merge keeps main history clean
```

---

## Phase C1: Admin Payments + Xero UI Polish

```
You are working on the TACBookings project. Read CLAUDE.md for full project context.

Your task is to implement all Phase C1 features from these GitHub issues:

1. #26 - Admin Payments page: add clickable links for Xero invoices (show invoice number), Stripe payments (link to dashboard), and bookings (link to detail page)
2. #27 - Xero Account Mappings lock/edit mode to prevent accidental changes + Scan for Duplicates wording update for Family Groups
3. #32 - Admin Subscriptions: Xero invoice number as clickable link + member booking page shows Xero invoice payment link when subscription is unpaid

Read each GitHub issue for full implementation details including schema changes, API modifications, and UI requirements.

## Development Workflow

Work on a new branch called `phase-c1-admin-xero-polish` created from `main`.

For each issue:
1. Read the issue from GitHub for full context
2. Read the relevant source files before making changes
3. Implement the feature
4. Write/update tests
5. Commit with a message referencing the issue number (e.g. "Implement #26: ...")

## Verification (MANDATORY before proceeding to merge)

After ALL features are implemented, run these checks. ALL must pass before merging:

npm test          # All tests must pass
npm run build     # Must complete without errors

If tests fail or build breaks:
- Fix the issue
- Re-run both checks
- Do NOT proceed to merge until both pass cleanly

## Merge to Main (only after verification passes)

Once tests and build both pass:

1. Push the branch: `git push -u origin phase-c1-admin-xero-polish`
2. Create a pull request using `gh pr create` with:
   - Title: "Phase C1: Admin Payments + Xero UI Polish (#26, #27, #32)"
   - Body: Summary of all changes, test results, and build confirmation
3. Merge the PR into main: `gh pr merge --squash --delete-branch`
4. Switch to main and pull: `git checkout main && git pull origin main`
5. Confirm main is up to date: `git log --oneline -5`

## Safety Rules

- NEVER force push
- NEVER merge without tests and build passing
- If ANY test fails or build breaks after your changes, fix it before merging
- If you cannot fix a failing test, stop and report the issue — do NOT merge
- Each commit should be atomic and revertable
- The squash merge keeps main history clean
```

---

## Phase C2: Xero Sync, Linking & Reporting

```
You are working on the TACBookings project. Read CLAUDE.md for full project context.

Your task is to implement all Phase C2 features from these GitHub issues:

1. #28 - Xero import: show skipped no-email member names with clickable Xero links + manual Xero contact linking from Admin > Members + "Push to Xero" to create new contacts
2. #29 - Xero Contact Sync detailed reporting: categorized report showing created, updated, skipped (with reasons), and errors per contact

Read each GitHub issue for full implementation details including API endpoints, search dialog specs, and report structure.

## Development Workflow

Work on a new branch called `phase-c2-xero-sync` created from `main`.

For each issue:
1. Read the issue from GitHub for full context
2. Read the relevant source files before making changes
3. Implement the feature
4. Write/update tests
5. Commit with a message referencing the issue number (e.g. "Implement #28: ...")

## Verification (MANDATORY before proceeding to merge)

After ALL features are implemented, run these checks. ALL must pass before merging:

npm test          # All tests must pass
npm run build     # Must complete without errors

If tests fail or build breaks:
- Fix the issue
- Re-run both checks
- Do NOT proceed to merge until both pass cleanly

## Merge to Main (only after verification passes)

Once tests and build both pass:

1. Push the branch: `git push -u origin phase-c2-xero-sync`
2. Create a pull request using `gh pr create` with:
   - Title: "Phase C2: Xero Sync, Linking & Reporting (#28, #29)"
   - Body: Summary of all changes, test results, and build confirmation
3. Merge the PR into main: `gh pr merge --squash --delete-branch`
4. Switch to main and pull: `git checkout main && git pull origin main`
5. Confirm main is up to date: `git log --oneline -5`

## Safety Rules

- NEVER force push
- NEVER merge without tests and build passing
- If ANY test fails or build breaks after your changes, fix it before merging
- If you cannot fix a failing test, stop and report the issue — do NOT merge
- Each commit should be atomic and revertable
- The squash merge keeps main history clean
```

---

## Phase D: Admin UX Enhancements

```
You are working on the TACBookings project. Read CLAUDE.md for full project context.

Your task is to implement all Phase D features from these GitHub issues:

1. #33 - Admin Bookings Calendar View: month-view calendar with booking bars spanning date ranges, color-coded by status, with filters shared with existing table view below
2. #34 - Reports PDF generation: replace window.print() with proper PDF generation using jspdf + html2canvas, A4 format with TAC branding and date range header

Read each GitHub issue for full implementation details including library choices, component specs, and API changes.

## Development Workflow

Work on a new branch called `phase-d-admin-ux` created from `main`.

For each issue:
1. Read the issue from GitHub for full context
2. Read the relevant source files before making changes
3. Implement the feature
4. Write/update tests
5. Commit with a message referencing the issue number (e.g. "Implement #33: ...")

## Verification (MANDATORY before proceeding to merge)

After ALL features are implemented, run these checks. ALL must pass before merging:

npm test          # All tests must pass
npm run build     # Must complete without errors

If tests fail or build breaks:
- Fix the issue
- Re-run both checks
- Do NOT proceed to merge until both pass cleanly

## Merge to Main (only after verification passes)

Once tests and build both pass:

1. Push the branch: `git push -u origin phase-d-admin-ux`
2. Create a pull request using `gh pr create` with:
   - Title: "Phase D: Admin UX Enhancements (#33, #34)"
   - Body: Summary of all changes, test results, and build confirmation
3. Merge the PR into main: `gh pr merge --squash --delete-branch`
4. Switch to main and pull: `git checkout main && git pull origin main`
5. Confirm main is up to date: `git log --oneline -5`

## Safety Rules

- NEVER force push
- NEVER merge without tests and build passing
- If ANY test fails or build breaks after your changes, fix it before merging
- If you cannot fix a failing test, stop and report the issue — do NOT merge
- Each commit should be atomic and revertable
- The squash merge keeps main history clean
```
