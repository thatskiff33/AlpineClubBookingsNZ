# ADR-003: Install-Time Bootstrap Integration (deferred)

## Status

Proposed — deliberately deferred until the import engine (ADR-002) has
shipped and stabilised. Recorded now so the earlier "restore a `pg_dump` at
install" idea stays retired and the intended shape is not re-litigated.
Feature issue: hoppers99/AlpineClubBookingsNZ#22 (Phase 3).

## Context

The original motivation for this feature family was seeding a fresh install
from a known-good configuration instead of hand-configuring. The base seed
(`prisma/seed.ts`, invoked via the `prisma.config.ts` seed hook during
`migrate deploy`) is create-if-missing and env-driven. A fresh site today is
bootstrapped by: migrations → base seed → manual configuration. With the
config-transfer importer available, "manual configuration" can be replaced
by importing a bundle.

## Decision (intended shape — to be confirmed when picked up)

- An env-configured path (e.g. `CONFIG_BUNDLE_IMPORT_PATH`) names a bundle
  file. During install (after migrations + base seed), if the path is set,
  the file exists, and the database is **empty of non-seed configuration**,
  the config-transfer importer applies the bundle non-interactively.
- Non-interactive safety substitutions: ambiguous matches are impossible on
  an empty target (everything is "create"), so the interactive resolve step
  degrades to nothing; any plan that would require a human answer aborts the
  bootstrap with a clear error rather than guessing.
- A non-empty target refuses the bootstrap import (no force flag at
  install time; established sites use the interactive UI instead).
- Secrets and club identity remain env/config-file concerns exactly as for
  the base seed: a bundle never substitutes for `SEED_*`, `AUTH_SECRET`,
  provider keys, or `config/club.json` boot identity.
- The pre-apply DB backup is skipped only in this bootstrap context (an
  empty database has nothing to protect); every other ADR-002 safeguard
  (validation, sanitisation, audit) applies.

## Consequences

- Fresh-site provisioning becomes: deploy env + bundle file → migrations →
  seed → bundle import → member CSV import → operational site.
- The importer gains one non-interactive execution mode whose correctness is
  guaranteed by the empty-target precondition rather than by human review.

## Security Considerations

- The bundle path is operator-controlled deployment configuration; the file
  is still treated as untrusted input (full validation + sanitisation).
- Refusing non-empty targets prevents this mode from ever being used to
  silently overwrite a live site from a file dropped on disk.
- Audit-log the bootstrap import like any other apply (who = system/deploy,
  bundle checksum, outcome).
