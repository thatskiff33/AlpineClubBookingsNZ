# ADR-001: Interchange Format and Identity Strategy

## Status

Proposed (owner-reviewed direction, 2026-07-08; to be Accepted with the first
implementing PR). Feature issue: hoppers99/AlpineClubBookingsNZ#22.

## Context

Clubs need to move configuration, site content, and lodge setup between
instances (test → production, snapshot → restore, fresh-install bootstrap)
without hand-reconfiguring. A raw `pg_dump` cannot serve this: it is
ID-coupled (cuid foreign keys collide across instances), version-brittle
(any schema drift fails the restore), all-or-nothing, and carries every row
including member PII. The existing precedent for the right shape is the
admin member CSV export/import (`src/lib/member-csv-import.ts`): natural-key
matching (email), tolerant column mapping, upsert semantics.

A key-constraint audit of `prisma/schema.prisma` (2026-07-08) showed the
in-scope entities split into two tiers: those with DB-enforced natural keys
and those with **no enforced uniqueness at all** (Season, BookingPeriod,
MinimumStayPolicy, ChoreTemplate, InductionChecklistTemplate/Section/Item,
XeroContactGroupRule, CommitteeMember — whose only unique column is
nullable). Any identity strategy must not *assume* natural keys that the
schema does not enforce.

## Decision

### Bundle shape

One `.zip` file, deliberately hand-editable (extract → edit → re-zip):

- `manifest.json` — format version, exporting app version and Prisma
  migration head, generatedAt, **source Xero tenant id** (when connected),
  the included categories, and per-file row counts + SHA-256 checksums.
- **CSV** files for flat tabular entities (rooms, beds, rate rows, committee
  roles, mappings…).
- **JSON** files for singletons and structured "document" entities (module
  settings, theme, a page's fields, an induction template with its nested
  sections/items).
- `media/` — image bytes referenced by content, with a mapping file
  (original id → bundle filename) used for reference rewriting on import.

### Identity: natural keys only, two tiers

No database ids appear in the bundle. Foreign keys are expressed through the
parent's natural key (a bed row carries its lodge slug + room name).

- **Key-strong entities** (DB-enforced unique constraints) match silently:
  PageContent (`path`/`slug`), SiteContent (`key`), Lodge (`slug`),
  LodgeRoom (`[lodgeId, name]`), LodgeBed (`[roomId, name]`),
  LodgeInstruction (`[lodgeId, key]`), CancellationPolicy
  (`[lodgeId, daysBeforeStay]`), SeasonRate (`[seasonId, ageTier, isMember]`),
  AgeTierSetting (`tier`), EmailTemplateOverride (`templateName`),
  BookingMessageOverride (`messageKey`), CommitteeRole (`key`),
  XeroAccountMapping (`key`), XeroItemCodeMapping (composite uniques),
  AgeTierXeroAcceptedContactGroup (`groupId`), and the `id = "default"`
  settings singletons.
- **Key-weak entities** (no enforced unique) are exported as **document
  entities** and matched by candidate fields (name, date range, lodge scope):
  Season, BookingPeriod, MinimumStayPolicy, ChoreTemplate,
  InductionChecklistTemplate (with sections/items nested in its document),
  XeroContactGroupRule, CommitteeMember. A confident candidate match
  upserts; anything ambiguous is deferred to the interactive resolution step
  (ADR-002) — the importer never guesses.

Renames are handled by the interactive matcher (the user can point an
apparently-new row at an existing one); no separate stable alias identifier
is introduced unless practice shows it is needed.

### Media / images

Page HTML embeds images as `/api/images/<MediaImage id>` — the one place DB
ids leak into content. On export, referenced `MediaImage` rows' bytes are
bundled under `media/`; on import they are recreated and the references in
page HTML are **rewritten to the new ids** in the same transaction as the
page upsert. Idempotency without a schema change: candidate-match existing
images by `(filename, byteSize)` then byte-compare before creating.
Per-image size stays capped by `MAX_MEDIA_IMAGE_BYTES` (2 MB); the bundle
upload is streamed and capped (~50 MB for the MVP).

### Version tolerance

Import maps by column/field name: missing columns take defaults, unknown
columns are ignored with a warning surfaced in the plan. The manifest's
format version gates structural changes: same major → proceed;
newer-major bundle into an older app → refuse with a clear message.

### Category layout (per the feature issue)

Site content & appearance; club-wide settings; lodge configuration (lodges,
rooms, beds, per-lodge settings, seasons + rates, policies incl. club-default
rows, instructions, chore templates); committee (roles + legacy standalone
`CommitteeMember` only — the member-linked `CommitteeAssignment` style is
excluded so a transfer supports rather than fights the migration between the
two coexisting committee styles); induction checklist templates; Xero
configuration mappings (one category, stamped with the source tenant id).

Excluded permanently: members, transactional data, secrets, auth/role
fields, member-linked config, promos, Xero connection/runtime state,
SiteBanner. `Lodge.doorCode` / `EmailMessageSetting.doorCode` are excluded
by default and exported only on explicit opt-in (see ADR-002 Security
Considerations).

## Consequences

- Bundles survive instance moves and small version drift; hand-edits are
  possible and therefore the importer must treat every bundle as untrusted
  input (ADR-002).
- The two-tier identity model concentrates almost all matching complexity on
  seven key-weak entities, and makes the silent path provably safe (backed by
  real DB constraints).
- Document-style export of key-weak parents means child collections have no
  independent identity in the bundle; child reconciliation strategy (replace
  vs upsert-by-name) must respect external FKs — e.g. `ChoreAssignment →
  ChoreTemplate` is `onDelete: Restrict`, so children referenced by live rows
  are never deleted (verified per entity during implementation).
- Rewriting image references means imported page HTML differs from the
  bundle bytes — round-trip tests must compare semantically (references
  resolved), not byte-for-byte.

## Security Considerations

- No secrets, credentials, tokens, or member data can ever enter a bundle;
  the export serialisers operate off explicit per-entity field allowlists,
  never `SELECT *` shapes.
- `updatedByMemberId`-style audit columns are dropped on export and set to
  the importing admin on import.
- Door codes are physical-access information: excluded by default, opt-in
  export only, flagged in the export UI.
- The manifest's checksums let the import detect tampering/corruption, but
  are integrity aids, not authentication — bundles are untrusted regardless
  and fully validated + sanitised on import (ADR-002).
