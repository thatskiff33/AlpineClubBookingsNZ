# ADR-002: Import Semantics and Safety Model

## Status

Proposed (owner-reviewed direction, 2026-07-08; to be Accepted with the first
implementing PR). Feature issue: hoppers99/AlpineClubBookingsNZ#22.

## Context

An import can rewrite club-wide behaviour (module flags, capacities, booking
policies) and content on a live site. Interactive decisions are required for
ambiguous matches (ADR-001's key-weak entities) and for conflicts, but user
interaction cannot happen inside a database transaction. The bundle is
hand-editable and therefore untrusted. The club owner's requirements:
idempotent imports, a mandatory dry-run with a full itemised preview, an
automatic database backup before apply, and user-driven resolution of
anything uncertain or destructive.

## Decision

### Upsert-only, never delete

For every row: match by natural key (or candidate match for key-weak
entities) → update if found, create if not. **Import never deletes.**
Importing a two-lodge bundle twice yields two lodges; importing a one-lodge
bundle into a two-lodge site updates the matching lodge (or creates a third),
never removes one. A mirror/replace mode is explicitly deferred; if ever
added it must be reference-aware (refuse to delete config referenced by live
rows — e.g. `ChoreAssignment → ChoreTemplate` is `onDelete: Restrict`).

**Stated limitation (must appear in UI copy):** because import never
deletes, "restoring a snapshot" is approximate — anything added after the
snapshot survives. True point-in-time rollback is the automatic pre-apply
database backup, not this tool.

### Plan → resolve → apply

1. **Plan (dry-run, mandatory).** Parse and validate the bundle; compute and
   **persist a plan**: every action (create / update / unchanged / skip +
   field-level diffs) and every open question. The plan is bound to the
   bundle's checksum and to a **fingerprint of current DB state** for the
   touched categories.
2. **Resolve.** The admin answers the open questions in the UI:
   - ambiguous candidate match → *match to existing X* or *create new*
     (this is also the rename path);
   - conflicting values → *overwrite with imported*, *keep existing*, or
     *merge* where meaningful;
   - singletons → shown as a field diff; apply mode is chosen per object:
     **replace-present / keep-omitted** (default; an older bundle cannot
     wipe newer fields) or **full row replace** (bundle fully defines the
     object; omitted fields reset to defaults);
   - Xero category → if the manifest's source tenant id differs from the
     connected org (or none is connected), a prominent warning with
     *apply anyway* / *skip category*.
3. **Apply.** Take the automatic DB backup, re-verify the DB fingerprint
   (**drift → refuse and re-plan**, never apply a stale plan), execute the
   fully-resolved plan inside a transaction in dependency order (lodges →
   rooms → beds → per-lodge config; singletons independently), then write
   the plan + outcomes to the audit log. Confident, non-destructive changes
   are not individually prompted — they are visible in the preview and
   covered by the single final confirm.

### Concurrency and access

- Imports are single-flight: apply takes a dedicated advisory lock (new lock
  family, registered in `docs/CONCURRENCY_AND_LOCKING.md` per that
  document's rule) so two admins cannot apply concurrently.
- The entire surface (export and import) is **full-admin only** — not a
  matrix-permission area, and deliberately **not a ClubModuleSettings
  module**: modules gate member-facing features, and an import can itself
  change module flags, so a module gating this tool would be
  self-referential. The later install-time hook (ADR-003) is deploy-level
  configuration, not a module.

### Selection

Per-category selection on both export and import (tick the categories to
include/apply). Per-item control is provided by the resolve step, not by
item-level tick lists.

## Consequences

- The persisted plan is simultaneously the dry-run artefact, the resolution
  worksheet, and the audit record — one model serves all three.
- Re-planning on DB drift trades a little admin friction for the guarantee
  that what was previewed is exactly what is applied.
- The pre-apply `pg_dump` backup (reusing `src/lib/backup.ts`) bounds the
  blast radius of any importer bug to "restore the backup" — this is what
  makes an interactive, behaviour-changing tool acceptable to ship
  incrementally.
- Never-delete keeps live references safe by construction, at the cost of
  the approximate-restore limitation above.

## Security Considerations

- **Untrusted input:** bundles may be hand-edited. Every file is schema/shape
  validated; page HTML passes through the same sanitiser the CMS uses;
  natural-key integrity and reference resolution are enforced before
  planning; the upload is streamed with a hard size cap.
- **Privilege boundary:** full-admin only, because import can flip module
  flags, change booking/capacity behaviour, and rewrite public content. No
  matrix role may reach it. The import can never write members, auth/role
  fields, or secrets — those fields simply do not exist in the format
  (ADR-001 allowlists).
- **Behaviour-change warnings:** the preview explicitly flags settings whose
  change alters live booking behaviour (module toggles, capacities,
  policies) so an admin cannot apply them unknowingly on an active site.
- **Auditability:** every apply records who, when, the bundle checksum, the
  per-category diff, and each resolution choice; failed/refused applies
  (fingerprint drift, validation failure) are also audit-logged.
- **Door codes:** absent by default; when the exporting admin opts in, the
  export UI labels the bundle as carrying physical-access information.
- **Denial-of-service:** size caps, streaming parse, and row-count limits
  per category protect the server from hostile bundles.
