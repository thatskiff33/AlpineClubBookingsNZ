# Release notes

> Part of the [documentation hub](../README.md).

Per-release notes for AlpineClubBookingsNZ, plus the owner-review communication
drafts that accompany a release. Newest first.

## Published release notes

- [v0.14.0](v0.14.0.md) — 2026-11-17 minor public reference release.
- [v0.13.2](v0.13.2.md) — 2026-07-23 patch public reference release (deferred contract drop, backup re-home, provider wizards, AI help).
- [v0.13.1](v0.13.1.md) — 2026-07-22 patch public reference release (breaking contract migrations).
- [v0.13.0](v0.13.0.md) — 2026-07-21 minor public reference release.
- [v0.12.2](v0.12.2.md) — 2026-07-20 patch public reference release.
- [v0.12.1](v0.12.1.md) — 2026-07-19 patch public reference release.
- [v0.12.0](v0.12.0.md) — 2026-07-18 minor public reference release.
- [v0.11.0](v0.11.0.md) — 2026-07-13 minor public reference release.

## v0.10.0 communication drafts

These are **drafts, not releases**. They live in [`drafts/`](drafts/) so this
directory's top level holds published release notes only (#4978). Nothing here
is posted automatically. They are kept for the audit trail and as templates for
future releases.

- [v0.10.0 release notes (draft)](drafts/v0.10.0-release-notes-draft.md) — the
  release notes that were awaiting owner review.
- [v0.10.0 fork-communication drafts](drafts/v0.10.0-fork-comms-drafts.md) —
  messages for downstream deployment forks.
- [v0.10.0 committee heads-up (draft)](drafts/v0.10.0-committee-headsup-draft.md)
  — the cancellation-policy-change note for the club committee.

`pnpm run release:cut prepare` writes each new release's page as a stub and
lists it at the top of *Published release notes* (#4983). Finish the stub in the
release-prep pull request, deleting its unfinished marker, the stub note and
the placeholder paragraph: `release:cut publish` refuses while any of them is
there. The [documentation hub](../README.md) links this index rather than a
version, so a new release needs no edit there. The full order is the
[release checklist](../MAINTENANCE.md#public-reference-release-checklist).
