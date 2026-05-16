# Phase 9 Migration Plan

Phase 9 is the repository split cutover. This PR prepares the plan and helper
script only; it does not create the private repository, rewrite history, flip
repository visibility, or deploy production.

## Goals

- Preserve the current repository state in a local backup before any split work.
- Create a private deployment fork containing the current club overlay.
- Remove the club overlay from tracking in the public-bound repository while
  keeping the files present locally for the private deployment fork.
- Verify that the private fork can pull future public upstream changes without
  overwriting its private configuration and branding.

## Non-Goals

- Do not run Phase 10 history rewriting.
- Do not make the public repository public.
- Do not run production deployment scripts as part of the split script.
- Do not force-push or bypass branch protection.
- Do not delete local secrets or environment files.

## Preconditions

- Phases 2 through 8 and Phase 12 have merged to `origin/main`.
- GitHub CLI authentication has permission to create the private repository
  under `thatskiff33`.
- `/home/ubuntu/TACBookings` is a clean checkout of the latest `origin/main`.
- The private repository name and local private worktree path have been
  confirmed with the repository owner.
- There is enough local disk space to copy `/home/ubuntu/TACBookings` to
  `/home/ubuntu/TACBookings.backup-pre-split`.
- A human has approved the production deploy window that happens after the split
  verification, if a deploy is required.

## Current Overlay Inventory

The current public-bound repository intentionally still tracks the club overlay
until Phase 9 is executed:

- `config/club.json`
- `public/branding/favicon.ico`
- `public/branding/logo.png`
- `public/branding/og-image.png`
- `public/branding/lodge.jpg`
- `public/branding/ski-field.jpg`
- `public/branding/snowboarder.jpg`
- `public/branding/sunset.jpg`

The public repository must keep the reusable examples tracked:

- `config/club.example.json`
- `public/branding/favicon.example.ico`
- `public/branding/favicon.example.png`
- `public/branding/logo.example.png`
- `public/branding/og-image.example.png`
- `public/branding/lodge.example.png`
- `public/branding/ski-field.example.png`
- `public/branding/snowboarder.example.png`
- `public/branding/sunset.example.png`

The script also prepares ignore entries for future private-only paths:

- `config/features.json`
- `public/branding/favicon.png`
- `seeds/tokoroa/`

## Cutover Sequence

1. Confirm the public checkout is clean and current:

   ```bash
   cd /home/ubuntu/TACBookings
   git fetch origin main
   git status --short --branch
   ```

2. Review the helper script without executing it:

   ```bash
   sed -n '1,240p' scripts/phase-9-split.sh
   ```

3. Run the helper script only after the repository owner approves the cutover:

   ```bash
   bash scripts/phase-9-split.sh --execute
   ```

   The script refuses to run without `--execute`.

4. Review the generated public repository diff. It should only untrack the
   private overlay files and add the Phase 9 ignore block.

5. Push the public split branch or commit through the normal protected-branch
   process. Do not bypass reviews or red CI.

6. In the private fork, verify upstream sync:

   ```bash
   cd /home/ubuntu/TACBookings-tokoroa
   git fetch upstream main
   git pull upstream main
   git status --short
   npm ci
   npx prisma generate
   npm run lint
   DATABASE_URL="postgresql://user:pass@localhost:5432/tacbookings" npx prisma validate
   npm test
   npm run build
   ```

7. Confirm the private fork still has its real `config/club.json` and private
   branding files after pulling upstream.

8. Deploy only from the private fork and only in an approved deployment window.

## Rollback Plan

- If the private repository push fails before public changes are committed,
  stop and keep using the original `/home/ubuntu/TACBookings` checkout.
- If the public overlay-removal commit is wrong, revert that commit before any
  visibility change.
- If the local working tree is damaged, restore from
  `/home/ubuntu/TACBookings.backup-pre-split`.
- If production verification fails, keep the public repository private and
  continue deploying from the known-good checkout until the private fork is
  repaired.

## Issue Checklist Mapping

- Backup created: completed by the script before any repository mutation.
- Private repo exists and pushed: completed by the script after backup.
- Public overlay ignored and examples kept: completed by the script's public
  repository change.
- `git pull upstream main` works in the fork: human verification after script
  completion.
- Production deploys cleanly from the fork: human verification in an approved
  deployment window.
