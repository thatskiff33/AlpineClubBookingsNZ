# ADR-003: Install-Time Bootstrap Integration (implemented)

## Status

**Implemented** (#1988, C9). Delivered after the import engine (ADR-002)
shipped and stabilised. The original "restore a `pg_dump` at install" idea
stays retired. Feature issue: hoppers99/AlpineClubBookingsNZ#22 (Phase 3).

Implementation: `src/lib/config-transfer/bootstrap-import.ts`
(`runConfigBootstrapImport`), wired into the boot hook
`src/instrumentation.node.ts` **after** the C2 config self-heal. Operator
runbook: `DEPLOYMENT.md` → "Config Bundle Auto-Import On Boot (DR / clone)".

## Context

The original motivation for this feature family was seeding a fresh install
from a known-good configuration instead of hand-configuring. The base seed
(`prisma/seed.ts`) is create-if-missing and env-driven. It is a separate
one-shot step after `migrate deploy`, never part of it: `docker compose run
--rm seed` on a Docker-only install, `pnpm run db:seed` on a developer
machine (#4977). A fresh site today is
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

## Trust model (as implemented)

Whoever writes `CONFIG_BUNDLE_IMPORT_PATH` and drops the bundle on a fresh
install **owns the club's identity and email routing** — this is equivalent to
writing `config/club.json` or setting install-time env, a first-install operator
capability, not a new privilege escalation. `publicUrl` and email sender are
**allowlisted non-secret** config; `FORBIDDEN_FIELD_PATTERNS`
(`src/lib/config-transfer/registry.ts`) bars secrets, auth material, and member
coupling from any bundle. The residual risk is a bundle applied to a NON-empty
DB, which the empty-target guard prevents.

### Refuted attacks

- **"An attacker hits `/admin/setup` to reconfigure a live club."** Refuted:
  `/admin` is auth-gated — `src/app/(admin)/layout.tsx` redirects unauthenticated
  visits and redirects members without the required admin-area access;
  `SEED_ADMIN_*` is always seeded so an admin exists. The bootstrap import adds no
  new HTTP surface: it runs only in the boot process, only from the
  operator-controlled env path.
- **"A crafted bundle leaks or injects secrets."** Refuted:
  `FORBIDDEN_FIELD_PATTERNS` makes every descriptor's allowlist disjoint from
  password/secret/token/apikey/totp/memberid patterns, and `parseSingleton`
  (`categories/club-settings.ts`) type-checks every field against the real Prisma
  DMMF before any write. The bootstrap path reuses this pipeline unchanged.
- **"A file dropped on disk silently overwrites a live club."** Refuted: the
  empty-target guard refuses any target that is not empty of non-seed
  configuration, and fails closed on any doubt (see below).

## Implementation notes (#1988)

- **Where it runs.** `runConfigBootstrapImport({ db })` is invoked from
  `src/instrumentation.node.ts` in the Node runtime, immediately AFTER the C2
  self-heal, inside the same best-effort guard. It is a no-op unless
  `CONFIG_BUNDLE_IMPORT_PATH` is set.
- **Untrusted file, shared pipeline.** The bundle bytes flow through the exact
  interactive import pipeline: `buildImportPlan` (which runs `readBundle`
  structural validation + resource caps + safe-path checks, then every category
  planner's allowlist + DMMF type-checks) → `applyConfigImport` (single-flight
  advisory lock, in-lock re-plan, fingerprint-drift refusal, atomic transaction,
  audit). Ordinary categories remain upsert-only; the booking-policy category uses
  its reviewed replace-set semantics for both its files, but an accepted
  empty-target bootstrap has
  no existing policies or hosting scopes to delete. The only deviation is the
  pre-apply backup
  (below).
- **Empty-target definition — precise ("no operator footprint", six signals).**
  The base seed (`prisma/seed.ts`) is create-if-missing and pre-populates the
  config singletons/keyed rows this importer touches, so a faithful club bundle
  applied to a freshly-seeded DB necessarily produces UPDATEs against seed
  placeholders. "Zero updates in the plan" is therefore NOT a usable
  empty-target signal on this codebase — it would refuse every legitimate
  bootstrap. Emptiness is instead defined as the absence of ANY operator
  footprint beyond the pristine post-seed state, probed positively
  (`assessBootstrapReadiness`) over state the seed never creates (the seed
  writes no `AuditLog` rows and no `SetupProgress` row; its only members are
  the ADMIN/LODGE system accounts):
  (1) no config bundle ever imported — no `configuration.imported`
  (interactive) or `configuration.bootstrap_imported` (this feature) audit row;
  (2) no bookings; (3) no non-system members (any `Member` whose role is not
  the seeded ADMIN/LODGE); (4) the setup wizard was never marked finished
  (`SetupProgress.completedAt` null); (5) the setup wizard was never even
  DRIVEN — no `SetupProgress` row has any completed or skipped step ids (step
  completes/skips leave `completedAt` null, so signal 4 alone would miss a club
  configured via `/admin/setup` without pressing "finish"); (6) no audit-log
  row has a MEMBER actor — no row whose `memberId` or `actorMemberId` is set
  to anything other than a `system:`-prefixed synthetic actor (admin
  configuration edits through the direct editors all audit with the admin's
  member id, so this catches a hand-configured club that has none of the other
  footprints). ALL six must be absent to apply. This is strictly safer than an
  update-count check because it also refuses a manually-configured club whose
  bundle keys collide with seed keys.
- **Fail closed.** A non-empty target, a probe query error, a plan with
  validation errors, a plan step needing an interactive rename decision (see
  the next bullet — this is reachable), an unreadable/oversized/non-regular
  bundle file, and any I/O or apply failure all REFUSE and leave the DB
  untouched (the apply transaction is atomic). Boot always continues — the
  function never throws.
- **Non-interactive rename abort — reachable on a post-seed target.** The seed
  creates key-weak rows (the default induction template, the example chore
  templates), so a bundle whose SOURCE club renamed those defaults produces
  rename candidates against a faithfully-seeded target, and the whole import
  aborts (`refused-invalid`, nothing written). This fail-closed abort is
  deliberate — auto-tolerating "seed-looking" rows would require inferring
  seed-ness and risks silently orphaning real data. The abort log enumerates
  the affected entities (e.g. `induction-template "Alpine Club Induction/2"`)
  and the documented fallback is the interactive import (Admin → Setup &
  Configuration → Export & Import), where a human resolves the renames.
- **Concurrency — probe re-run under the apply lock; marker is transactional.**
  The boot probe races concurrent writers (multi-replica blue/green boots, or
  an interactive import at the same instant). The SAME probe is therefore
  re-run INSIDE the apply transaction, immediately after the
  `pg_advisory_xact_lock` single-flight lock and before any write; if it finds
  the target configured, the transaction rolls back and the refusal is logged
  at INFO — the healthy expected outcome for every replica that lost the race.
  The `configuration.bootstrap_imported` marker is written on the SAME
  transaction as the config writes, so the import and its idempotence marker
  commit or roll back atomically: at most one bootstrap apply can ever commit,
  and a committed apply is always marked. (The pipeline's secondary
  `configuration.imported` audit row is still written post-commit, as on the
  interactive path.)
- **Backup waiver is type-enforced.** `applyConfigImport`'s skip variant is an
  object carrying a nominal `BootstrapEmptyTargetProof` that only a positive
  `assessBootstrapReadiness` probe can mint (the class is unexported, with a
  `#`-private brand); a bare string does not compile, so no other caller —
  including the interactive route — can waive the ADR-002 pre-apply backup.
- **Provenance guard deliberately NOT applied.** Unlike the self-heal, the
  bootstrap import is not gated on `clubConfigSource === "primary"`: the BUNDLE
  is the config source in the DR scenario, and `config/club.json` is often absent
  there, so provenance is typically `"safe-default"`. Gating on `"primary"` would
  disable the feature exactly when it is needed. The self-heal's hazard (freezing
  fallback values into create-if-absent rows) does not transfer, because this
  importer writes the BUNDLE's values, never the effective fallback config. On a
  SAFE_DEFAULT boot the self-heal skips (writing nothing) and this importer then
  populates the DB from the bundle — no conflict.
- **Self-heal interaction, pinned.** The self-heal runs first. The emptiness
  probe looks at operational footprint, NOT config-singleton presence, so
  self-healed rows never make a target look configured. If the self-heal created
  identity/age-tier rows (primary-config clone), this importer upserts the
  bundle's authoritative values over them; if it skipped (safe-default DR), this
  importer creates them. On the next boot the self-heal sees the rows present
  (skips) and this importer sees the `configuration.bootstrap_imported` marker
  (refuses). "At most one bootstrap apply ever commits" is a transactional
  guarantee (in-lock re-check + in-transaction marker, above), not merely a
  next-boot convention.
- **Write mode.** `overwrite`, so the bundle fully defines each record and a
  fresh install faithfully reproduces the source club (merge would leave seed
  placeholders showing through blanked source fields).
- **Pre-apply backup waived — only here.** `applyConfigImport` accepts a
  `preApplyBackup` object of kind `"skip-empty-bootstrap"`, used exclusively by
  this path: an empty database has no prior configuration to protect. Every
  other ADR-002 safeguard applies. The bypass is unreachable from the
  interactive route — and uncompilable from anywhere else, because the object
  requires the nominal `BootstrapEmptyTargetProof` (see "Backup waiver is
  type-enforced" above).
- **Audit shape.** On success the bootstrap writes a dedicated
  `configuration.bootstrap_imported` row INSIDE the apply transaction (system
  actor `system:config-bootstrap`, `severity: critical`, `outcome: success`,
  metadata: bundle sha256, provenance, mode, categories, totals, door-code
  slugs written) — that marker is what the emptiness probe keys on for
  idempotence, and it commits atomically with the config writes. The pipeline
  additionally writes its standard `configuration.imported` row after the
  transaction commits (same system actor, backup recorded as
  skipped-for-bootstrap), exactly as on the interactive path. The admin audit
  UI renders `system:`-prefixed actors as "System". Refusals (non-empty
  target) and failures are logged, not audited, to avoid an audit row on every
  boot while the env var stays set.
- **Idempotence.** A second boot with the same env var against the now-populated
  DB finds the `configuration.bootstrap_imported` marker → refuses calmly (INFO,
  "steady state"). A genuinely unexpected non-empty target (a manually-configured
  or in-use club) refuses at WARN.
