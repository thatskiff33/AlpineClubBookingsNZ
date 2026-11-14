# Release notes

> Part of the [documentation hub](../README.md).

Per-release notes for AlpineClubBookingsNZ, plus the owner-review communication
drafts that accompany a release. Newest first.

## Published release notes

- [v0.13.2](v0.13.2.md) — 2026-07-23 patch public reference release (deferred contract drop, backup re-home, provider wizards, AI help).
- [v0.13.1](v0.13.1.md) — 2026-07-22 patch public reference release (breaking contract migrations).
- [v0.13.0](v0.13.0.md) — 2026-07-21 minor public reference release.
- [v0.12.2](v0.12.2.md) — 2026-07-20 patch public reference release.
- [v0.12.1](v0.12.1.md) — 2026-07-19 patch public reference release.
- [v0.12.0](v0.12.0.md) — 2026-07-18 minor public reference release.
- [v0.11.0](v0.11.0.md) — 2026-07-13 minor public reference release.

## v0.10.0 communication drafts

These are **drafts for the owner to review and send** — nothing here is posted
automatically. They are kept for the audit trail and as templates for future
releases.

- [v0.10.0 release notes (draft)](v0.10.0-release-notes-draft.md) — the release
  notes awaiting owner review.
- [v0.10.0 fork-communication drafts](v0.10.0-fork-comms-drafts.md) — messages
  for downstream deployment forks.
- [v0.10.0 committee heads-up (draft)](v0.10.0-committee-headsup-draft.md) — the
  cancellation-policy-change note for the club committee.

`pnpm run release:cut prepare` writes each new release's page as a stub and
lists it at the top of *Published release notes* (#4983). Finish the stub in the
release-prep pull request and delete its unfinished marker:
`release:cut publish` refuses while the marker is there. The
[documentation hub](../README.md) links this index rather than a version, so a
new release needs no edit there. The full order is the
[release checklist](../MAINTENANCE.md#public-reference-release-checklist).
