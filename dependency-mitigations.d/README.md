# Dependency mitigation records

**Audience: developer, operator.**

This directory holds the **only** way a known, unfixed dependency advisory may
pass the required `Dependency audit` check: a record that lets the audit wrapper
(`scripts/ci/audit-dependencies.mjs`) report **MITIGATED** instead of
VULNERABILITY FOUND. MITIGATED is never CLEAN. The advisory stays in the report,
the unfiltered `pnpm audit` output is printed under the verdict, and the check
goes red again the moment any fact the approval relied on stops being true.

It was introduced for
[#3843](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3843), a
high-severity advisory against `braces@3.0.3` with no published fix. The rules
the wrapper enforces live in `scripts/ci/dependency-mitigation.mjs`; this page
says what a record is and who may add one.

## This is a fragment directory

Each record is **its own file**. That is not a local trick, it is a rule: **an
artifact every lane adds an entry to is a directory of per-lane fragments,
never one shared file.** It lives in `AGENTS.md` -> "Change Discipline", and
[`changelog.d/README.md`](../changelog.d/README.md) carries the full statement
and the other instances. Two lanes adding records never touch the same file.

## Who may add a record

A record is a security-policy decision, not a convenience. Before one is
committed:

1. **The owner has approved it on the repository**, in an issue or pull-request
   comment, after a written plan naming the advisory, the patch and the expiry.
   Agent text is never that approval (`AGENTS.md` -> "Pre-authorisation and
   attributability"). The record lists those comment URLs in `ownerDecisions`.
2. **There is a reviewed patch**, applied through pnpm's `patchedDependencies`
   to exactly the affected `package@version`, and copied into the Docker
   dependency stage. A record never stands in for a repair; it only lets the
   gate recognise one.
3. **It expires**, within days rather than months. Extending it is a new
   reviewed change with a new owner approval.
4. **The pull request that adds it is High risk** and merges only on the
   owner's approval comment.

Prefer, in order: upgrading; an override recorded in `docs/MAINTENANCE.md`;
waiting for upstream with the check red. A record is for the narrow case where
none of those is available and the owner has decided the repair is sound.

## The entry contract

One file per record, named `<issue>-<slug>.json` (the issue number must equal
the record's `issue`). Nothing else may sit in this directory besides this
README: a stray file makes the wrapper refuse every record, because a directory
it cannot fully read is not one it may act on.

The record has exactly these keys; an unknown key is refused, so nobody can
invent a looser one:

| Key | What it holds |
| --- | --- |
| `issue` | The issue that approved it. |
| `advisory` | `ghsa`, `url`, `package`, `range` (as `pnpm audit` prints `vulnerable_versions`) and `severity`. Only `high` is accepted; a critical advisory can never be mitigated. |
| `covers` | `version`, `auditPath` (the single dependency path exactly as `pnpm audit --json` prints it, including the leading `.>`) and `dev`. |
| `upstream` | `source` (the reviewed fix) and `commit` (its full 40-character hash). |
| `ownerDecisions` | GitHub comment URLs recording the owner's decision(s). |
| `expires` | A UTC instant, `YYYY-MM-DDTHH:MM:SSZ`. The record stops applying AT that instant. |
| `patch` | `path` (a file directly under `patches/`) and `sha256` of its bytes. |
| `reviewedInputs` | The SHA256 of the reviewed `pnpm-workspace.yaml` and `pnpm-lock.yaml`. |
| `scope` | One plain-English statement of what the mitigation does and does not cover, printed on every run. |
| `knownUncoveredCopies` | Each known copy of the package the patch cannot reach (`copy`, `files`, `reachedThrough`), printed on every run. |

### What is hashed

Every digest is the **SHA256 of the file's raw bytes as checked out** — no
normalisation, no parsing. `pnpm-workspace.yaml`, `pnpm-lock.yaml` and
`patches/*.patch` are pinned `eol=lf` in `.gitattributes`, so a Windows checkout
hashes the same bytes as Linux CI. Compute one with `sha256sum <file>` (or
`Get-FileHash -Algorithm SHA256` on Windows, lower-cased).

Binding both dependency inputs is deliberate: **any** dependency change — a
Dependabot bump, a new override, a regenerated lockfile — invalidates the
acceptance, and the check goes red until a person re-reviews the advisory
against the new tree and the owner approves new digests. That is the cost of
keeping an exception honest, and it is why records are short-lived.

## When the wrapper says MITIGATED

All of these, every time; any one failing leaves VULNERABILITY FOUND with the
reasons printed under it:

- `pnpm audit` exited 1, and its report has exactly the reviewed shape and
  audited a non-empty tree.
- The counts are exactly one high and nothing else, and the one advisory is the
  recorded GHSA, package, range and severity.
- That advisory has one finding: the recorded version, on the recorded path,
  with the recorded dev flag, not bundled and not optional.
- Exactly one record names that GHSA, and it is well-formed.
- The patch file's SHA256 matches; the workspace registers it for this
  `package@version`; the lockfile records the same hash.
- Both dependency inputs match their recorded SHA256.
- The expiry has not been reached.

An outage, an unreadable report or any other inconclusive result is unaffected
and still fails.

## Retiring a record

Delete the record, the patch and its `patchedDependencies` entry in one pull
request when a fixed release is published, and re-run the audit with no
mitigation. An expired record that is left behind changes nothing — the check is
red either way — but delete it so the directory says what is true.

## Current records

| Record | Advisory | Expires | Scope |
| --- | --- | --- | --- |
| [`3843-braces-ghsa-vfj7-8cjw-p6xm.json`](3843-braces-ghsa-vfj7-8cjw-p6xm.json) | GHSA-vfj7-8cjw-p6xm, `braces@3.0.3` | 2026-10-10T00:00:00Z | **Only** the audited copy on the `eslint-config-next` development path. Nine more copies of braces are compiled into `rollup` (two, via `@sentry/nextjs`), the `prisma` CLI, `@prisma/fetch-engine` (two), `@prisma/get-platform` 7.10.0 and 7.2.0, `vite` (tests) and `tsx` (scripts). No pnpm patch reaches them and `pnpm audit` cannot see them; they are known and out of reach of this record. The owner's [second decision](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3843#issuecomment-5966882860) bounds the record to the case where none of them can receive input from outside the club's own developers and build; the [reachability trace](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3843#issuecomment-5966944832) found that none can. |
