# Scoped Agent Context

Audience: Developer, Agent.

Use the scoped context command when the always-read core and routed documents
identify the rules but the code or data-model neighbourhood is still unclear.
It creates a small local locator for either Codex or Claude Code; it is not a
repository dump and it is never injected into a conversation automatically.

## Run it

Use the same one-line command in PowerShell, Git Bash, or a POSIX shell:

```text
pnpm run agent:context --base <ref> --entry <tracked-path> [--entry <tracked-path> ...] [--model <PrismaModel> ...] [--depth 1|2] [--max-chars 32000]
```

Under pnpm no separator is needed in either shell, because pnpm hands every
option after the script name to the script. Keep the command on one line: `\`
continuations are a POSIX form that PowerShell does not accept.

`--base` and at least one `--entry` are required. Depth defaults to one and is
limited to one or two hops. The combined cap defaults to 32,000 characters and
counts all four files, including the manifest.

For example:

```text
pnpm run agent:context --base origin/main --entry src/lib/addy-address.ts --model AuditLog
```

Quote any entry containing `[` or `]` — a dynamic route such as
`"src/app/api/bookings/[id]/modify/route.ts"` — so PowerShell does not treat it
as a wildcard.

Scope narrowly. A hub module or a central Prisma model exceeds the default cap
on its own: `src/lib/prisma.ts` selects roughly a thousand importers at depth
one, and `--model Booking` expands to most of the schema through its relation
neighbours. That is the cap working, not a fault. The failure names the dominant
section, the number of selected nodes, and the widest fan-out, so use those to
pick a narrower entrypoint rather than raising `--max-chars`.

On success the terminal prints only the output location and each file's
character count. Read the smallest section that answers the current question;
do not paste the whole artifact into a prompt.

## What it writes

The command publishes one fingerprinted directory:

```text
.artifacts/agent-context/<head>-<scope-hash>/
  manifest.json
  overview.md
  typescript.md
  prisma.md
```

- `manifest.json` records the resolved base/head, normalized entries, requested
  models, depth, cap, deterministic fingerprint, and exact section sizes.
- `overview.md` gives a two-level count of the tracked tree, then complete paths
  only for selected entries and tracked paths changed from the base.
- `typescript.md` gives the bounded import/importer neighbourhood and nearby
  tests for TypeScript entries.
- `prisma.md` indexes every Prisma model compactly and includes complete blocks
  only for requested models and their direct relation neighbours.

`.artifacts/` is ignored. Do not commit these files, attach them to a public
artifact, or add a Claude/Codex hook that injects them. Regenerate after the
scope or relevant working contents change.

## Tracked-path and graph contract

Inventory and content come only from `git ls-files`. Entry paths are normalized
to repository-relative forward-slash form, so `src\\lib\\example.ts` and
`src/lib/example.ts` select the same tracked file. Absolute paths, `..` escapes,
untracked paths, and tracked paths missing from the working tree are refused.
An untracked secret-like file therefore cannot enter any section or its
fingerprint.

The TypeScript graph uses the compiler parser and follows these static forms:

- relative `import` and `export ... from` declarations;
- the repository's `@/` alias;
- string-literal `import()` calls;
- TypeScript external-module `import =` declarations;
- reverse importers of those forms.

It does not guess computed dynamic imports, `require()` calls, package `exports`
maps, arbitrary `tsconfig` path maps, generated module resolvers, JavaScript
files, or imports through an untracked file. Bare package imports and unresolved
static specifiers are listed but not traversed. If one of those forms is central
to the task, inspect it directly and state that limit in the handoff.

"Nearby tests" means tracked TypeScript test/spec files that share the module's
base name and sit either in its own directory or in that directory's `__tests__`
child — `foo.ts` finds `foo.test.ts` and `__tests__/foo.test.ts`, not every other
file beside them. It is a locator, not a coverage claim; `pnpm run test:related`
and the routed testing rules remain the validation authority, and a test that
covers a module under a different name will not appear here.

## Identity, cap, and atomic publication

Artifact identity includes the base argument and resolved commit, normalized
entries, requested models, depth, explicit cap, and the full working contents of
selected graph files, changed tracked files, and `prisma/schema.prisma`.
Identical inputs produce the same sorted output directory and byte-for-byte
contents; a relevant dirty edit changes the fingerprint even when it does not
change an import edge.

All sections are constructed in memory. Requested model names and the combined
character cap are validated before an output root is created. Publication then
writes a temporary sibling directory and renames it into place, so an oversized
or invalid scope leaves no partial artifact. If the cap is exceeded, narrow the
entries, model list, or depth; raise `--max-chars` only when the extra context is
deliberate.

## Related links

- Start with the shared [agent contract](../../AGENTS.md).
- Follow the [Codex workflow](CODEX_WORKFLOW.md) for worktree and validation
  setup.
- Return to the [documentation hub](../README.md).
