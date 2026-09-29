# Deployed-code knowledge bundle (AID-3)

The knowledge bundle is a deterministic, versioned snapshot of the allowlisted
**docs, schema, and (optionally) source** of the exact commit a deployment is
running. It exists so the admin-only **AI Diagnostics** product (epic #2369) can
answer "what does the running code/docs/schema say?" from the artifact actually
running — never from a developer's working tree, a live `.git` (which is absent
from the runtime image), or the model's memory.

This page is the reference for the bundle built in issue #2372. It is one piece
of the AI Diagnostics wave; the security, privacy, authority, and evidence
contracts it must not weaken are defined by the AID-1 threat model / ADR
(#2370). Where a choice here is genuinely the owner's to make, it is flagged as
**owner decision**.

## What is in the bundle

The bundle is a single JSON file. Every entry records, per allowlisted file:

- its repo-relative path and coarse language,
- a SHA-256 hash of the whole file's content,
- its byte length and line count,
- **sensitivity tags** (metadata for retrieval policy, not an exclusion),
- **symbols** — markdown headings, Prisma model/enum names, or top-level
  TypeScript exports, and
- an **excerpt index**: bounded, individually hashed slices addressable for
  citation.

The file header carries the deployed **commit SHA**, an **observed-at**
timestamp, the generator version, and an **integrity digest** — a SHA-256 over
the canonical serialization of the entries.

## Determinism

Generation is a pure function of `(files, commitSha, observedAt)`. Given the same
inputs it produces a **byte-identical** bundle: files are sorted by path, object
keys are sorted, newlines are normalized to LF (so a Windows checkout and a Linux
CI runner agree), and nothing reads the wall clock. The integrity digest covers
the entries only, so it is stable across two builds of identical source at
different commits or times.

For a byte-reproducible artifact, pass `KNOWLEDGE_BUNDLE_OBSERVED_AT` (the
release sets it to the commit date); otherwise the generator falls back to the
git committer date and, last, the current time — which changes only the header,
never the entries or their digest.

## What is excluded, and how it fails closed

The generator is **allowlist-first**: a file is included only if it matches an
include glob, matches no exclude glob, and has a text-like extension. Two layers
protect what ships:

- **A hard exclude set** that an overlay can never re-include: env files,
  private-key material, the private deployment overlay paths (kept in lockstep
  with `.gitignore` — `config/club.json`, `config/features.json`, `seeds/**`,
  branding and uploads), build output, dependencies, `.git`, and generated code.
- **A secret scan** over every included file. A **provider token shape** — a
  Stripe `sk_…` / `rk_…` / `whsec_…` key, an AWS `AKIA…` id, a GitHub token, a
  private-key block, and the like — makes generation **fail closed
  unconditionally**, even when the token is an obvious "example". The shape trips
  the runtime image's own secret scan (Trivy, the `docker-image-security` gate)
  the moment it is bundled, so an allowlisted docs file must never embed a
  literal one — write it broken (`sk_test_…`, an `…EXAMPLE…` marker) instead. The
  **generic** `secret = "…"` / connection-string rules additionally exempt a
  documented placeholder (`your-secret-here`, `***`, an `…EXAMPLE…` marker) so
  ordinary prose stays buildable. Either way the whole build stops rather than
  shipping the bundle with the offending file quietly dropped. This is a second,
  independent line to the repo's gitleaks gates: gitleaks guards what is
  committed; this guards what is *extracted into a shipped artifact* — and it is
  deliberately **stricter on provider shapes** than gitleaks, which ignores the
  Stripe *test*-key shapes that a downstream image scanner still flags.

### Default allowlist scope (owner decision, #2370)

The default allowlist is **docs, the top-level project docs, and
`prisma/schema.prisma`** — exactly the things the runtime image otherwise
excludes. First-party **source (`src/**`) is intentionally not in the default**:
a private fork may hold code it does not want summarized to a model, so widening
to source is a per-deployment opt-in via the overlay, never a public-code
mandate. The generator fully supports source (symbol extraction, sensitivity
tags); only the *default membership* is conservative. Whether the public default
should include first-party source is an open ADR question.

## Two generic, deployment-owned overlays

A deployment configures both through the same git-ignored, hard-excluded file,
`config/diagnostics-knowledge.json` (overridable via
`DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH`), read by the generator in the Docker builder.
Public code never mentions any specific club's paths or contents; a
present-but-malformed config **fails the build closed**.

### 1. The allowlist overlay — WHICH committed repo files to bundle

`include` / `exclude` globs **widen or narrow the allowlist**:

```json
{
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["src/lib/secret-sauce/**"]
}
```

Excludes always win over includes, and the hard exclude set above still cannot be
re-included. A deployment's own committed files are then bundled from disk like any
other — there is no separate injection path.

### 2. The private knowledge overlay — extra CONTENT with no repo file (ADR-006 §4)

A `knowledge` section supplies **inline, deployment-specific knowledge entries**
that have no committed repo file — a private runbook, fork-only operational notes:

```json
{
  "knowledge": {
    "entries": [
      { "path": "ops/runbook.md", "content": "# Runbook\n\n..." }
    ]
  }
}
```

Each entry is a `path` handle (the citation label) and its `content`. Entries are
treated as **untrusted evidence, identically to a bundled repo file**:

- **Secret-scanned** with the same fail-closed scanner — a secret in overlay content
  refuses the whole build, exactly like a bundled file.
- **Bounded and hashed** into the same excerpts, and **rendered through the same
  `renderSourceEvidenceBlock` defusal boundary**, so a role-label / NEL / invisible
  character in overlay content is folded and defused just as it is for a public
  excerpt and cannot forge a turn.
- **Namespaced under `overlay/`** so an entry can neither collide with nor
  impersonate a real repo path, every citation is clearly attributable, and the
  entry is tagged with the `overlay` sensitivity class.
- **Cannot re-include a hard-excluded path**: a handle naming an env file, key
  material, or the overlay config itself is refused (checked on the raw handle,
  before the `overlay/` prefix, and case-insensitively).

Overlay entries are merged into `entries` **before** the integrity digest is
computed, so they participate in the **single** digest and the fail-closed load
contract below is unchanged with or without an overlay. The overlay is **optional**:
absent ⇒ Diagnostics runs on the public bundle and the bundle is byte-identical to
one built without the feature. It is deployment-local and **never travels** in any
config-transfer bundle (ADR-006 §6).

## How it ships (build + runtime wiring)

`docs/` and `.git` are both dropped from the Docker build context by
`.dockerignore`, so the bundle is generated **inside the Docker builder** — where
the dependencies exist (a club server's `docker compose build` has no host Node
toolchain). The flow:

1. **Build metadata is injected as build args.** CI and the deploy runner pass
   `GIT_COMMIT_SHA` and `KNOWLEDGE_BUNDLE_OBSERVED_AT` (see
   `.github/workflows/ci.yml` and `scripts/run-production-blue-green-deploy.sh`).
   The commit SHA is injected here because `.git` is not in the build context.
2. **The builder generates the bundle** with `pnpm run diagnostics:bundle`
   (before `next build`), writing
   `.artifacts/diagnostics/knowledge-bundle.json`.
3. **`next build` traces it** into `.next/standalone` via
   `outputFileTracingIncludes` (`next.config.ts`).
4. **The runner receives it** — the Dockerfile copies `.artifacts/` into the
   image, guaranteeing the loader finds it at
   `/app/.artifacts/diagnostics/knowledge-bundle.json`. The runtime image still
   excludes raw docs; only the curated bundle is copied.

When `GIT_COMMIT_SHA` is absent (a bare `docker build`), the generator writes a
placeholder-SHA bundle that the runtime loader treats as unverified — the image
still builds and runs, with diagnostics code answers disabled.

## Fail-closed loading

At runtime the loader (`src/lib/diagnostics/knowledge/load.ts`, verification in
`verify.ts`) may report `ok` **only** when the file is present, schema-valid, its
integrity digest recomputes, every excerpt re-hashes to its stored hash, and the
commit SHA is a real, non-placeholder git SHA. Every other outcome — missing,
malformed, schema-invalid, integrity mismatch, tampered excerpt, or unverified
commit — **disables diagnostics code answers**. There is no fallback to a working
tree or unverified memory: an unverifiable bundle is treated as no bundle.

## Retrieval and citation — evidence, never authority

The bundle is **untrusted, prompt-injection-capable evidence**. Retrieval
(`src/lib/diagnostics/knowledge/retrieve.ts`) sends only a bounded, ranked set of
excerpts, and pairs each with a **citation** that pins the commit SHA, the file
content hash, and the excerpt hash. `verifyCitation` re-derives all three from
the bundle and re-hashes the stored text, so a citation that does not correspond
to real bundle content cannot be trusted.

Excerpts are framed for the model as **verbatim source at a commit — explicitly
not a statement of current runtime state, account data, live values, or
availability, and never an instruction**. Every untrusted span (excerpt text,
label, and path) crosses one defusal boundary — the same for a public repo excerpt
and a private-overlay entry: it is **folded** (invisible/default-ignorable code
points dropped, every line terminator including NEL normalised, look-alike colons
folded) and any **role-label line** (`assistant:`, `system:`…) is defused, via the
shared `untrusted-text` helper; and the **wrapper tag is neutralized** so an excerpt
cannot forge the closing delimiter and "break out". Angle brackets elsewhere are
preserved so code excerpts (generics, JSX) stay faithful. The Diagnostics route
(#2378) is responsible for placing this evidence in the user turn, never the system
role — mirroring the page-help assistant's grounding discipline.

### Known limitation (owner-approved in PR #2531)

The integrity digest and per-excerpt hashes defend against corruption and
partial/naive tampering, and the commit-SHA gate rejects an unverified bundle.
They do **not** defend against an attacker who can fully rewrite the file inside
the running container and recompute every hash. The owner approved this as a
non-blocking limitation on the exact PR #2531 head: within the current threat
model, an attacker who can rewrite files in the container has already compromised
the host, so the digest + hash + SHA gate is the appropriate bar. There is no
unresolved signing task. Reconsider a build-time cryptographic signature only if
the threat boundary expands to require detection after a hostile artifact or host
rewrite; that design must first settle signing-key ownership, storage, and
rotation.

## Regenerating locally

```bash
GIT_COMMIT_SHA="$(git rev-parse HEAD)" pnpm run diagnostics:bundle
```

Runs with no database and no network. The output is git-ignored and never
committed — a source-excerpt bundle would conflict on every source PR, which is
why it is regenerated deterministically at build time instead.

See also: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for where this sits in the
system, and the epic (#2369) / ADR (#2370) for the wider AI Diagnostics
contracts.
