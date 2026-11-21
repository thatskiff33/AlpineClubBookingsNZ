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
high-severity advisory against `braces@3.0.3` with no published fix. That
record and its patch were retired in
[#3851](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3851) after
GitHub withdrew the advisory on 23 Oct 2026.
[#5252](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5252)
widened one rule, by owner decision on 18 Nov 2026: a record may cover an
advisory reported against more than one installed copy, when every copy is an
exact, patched `package@version` the record lists with its exact dependency
paths. That record, for `picomatch` (GHSA-fc5q-39xc-vjpf), and its two
patches were retired in
[#5293](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5293) after
GitHub withdrew the advisory on 18 Nov 2026; there are no live records now (see
"Current records" below), and the mechanism, with the widened rule, stays for
the next case. This page
is the **one home** for what a record is, who may add one, exactly when the
wrapper accepts it, and how to retire it; `scripts/ci/dependency-mitigation.mjs`
implements those rules and every other document links here.

## This is a fragment directory

Each record is **its own file**. That is not a local trick, it is a rule: **an
artifact every lane adds an entry to is a directory of per-lane fragments,
never one shared file.** It lives in `AGENTS.md` -> "Change discipline", and
[`changelog.d/README.md`](../changelog.d/README.md) carries the full statement
and the other instances. Two lanes adding records never touch the same file.

## Who may add a record

A record is a security-policy decision, not a convenience. Before one is
committed:

1. **It merges under the agent merge gate, not on an owner comment** (owner
   decision, 27 Oct 2026, #4473). This replaces the earlier rule that an owner
   approval comment authorised every record (#3843). The pull request needs:
   - the `AGENTS.md` merge gate (#3959);
   - one **security lens**, named in the ready comment with its head SHA. It
     checks the advisory, the patch and the expiry.

   The record's `ownerDecisions` cite the **decision records**: the issue
   comments that set down the plan, the patch review and the expiry. Each new
   or extended record is listed in the owner's twice-daily queue
   ([`SEKRETON_ORCHESTRATOR.md`](../docs/agents/SEKRETON_ORCHESTRATOR.md)) for
   visibility, not approval.
2. **There is a reviewed patch for every covered copy**, each applied through
   pnpm's `patchedDependencies` to exactly one affected `package@version`, and
   copied into the Docker dependency stage. A record never stands in for a
   repair; it only lets the gate recognise one.
3. **It expires within 14 days.** The wrapper refuses a record whose expiry is
   more than 14 days after the moment it runs. Extending it is a new reviewed
   change under the same gate.
4. **The pull request that adds it is High risk**, and merges under the
   `AGENTS.md` merge gate (#3959) with the security lens above.

Prefer, in order: upgrading; an override recorded in `docs/MAINTENANCE.md`;
waiting for upstream with the check red. A record is for the narrow case where
none of those is available and the reviewed patch is sound.

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
| `covers` | A non-empty list, one entry per installed copy the audit reports, each with exactly: `version` (one exact version, never a range; no version twice); `dev` (the finding's dev flag); `patch` (`path`, a file directly under `patches/`, and `sha256` of its bytes; each copy its own file); and `auditPaths` (every dependency path the audit reports for that version, exactly as `pnpm audit --json` prints it with the leading `.>`, ending at the package, sorted, no duplicates). |
| `upstream` | `source` (the reviewed fix) and `commit` (its full 40-character hash). |
| `ownerDecisions` | GitHub comment URLs of the decision records — evidence for a reviewer, not the authorisation (see "Who may add a record"). |
| `expires` | A UTC instant, `YYYY-MM-DDTHH:MM:SSZ`. The record stops applying AT that instant. |
| `reviewedInputs` | The SHA256 of the reviewed `pnpm-workspace.yaml` and `pnpm-lock.yaml`. |
| `scope` | One plain-English statement of what the mitigation does and does not cover, printed on every run. |
| `knownUncoveredCopies` | Each known copy of the package the patch cannot reach (`copy`, `files`, `reachedThrough`), printed on every run. |

There is **one shape**. The single-copy shape #3843 used (`covers` an object
with one `auditPath`, beside a top-level `patch`) is refused, never read as a
one-element list; no record used it after #3851.

**Why the paths are listed, not hashed.** A copy can have dozens of paths
(74 for `picomatch@4.0.7` in #5252), and a SHA256 over them would keep the
record short. But a hash can only say *that* the tree changed. The list lets
the refusal name each path **added** and each path **removed**, which is what a
reviewer needs to decide whether the change matters, and it keeps the record
the reviewable statement of exactly which paths were accepted. Generate it
from the report, sorted (`[...paths].sort()` in Node, which is what the wrapper
checks against).

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

This list is the one statement of the conditions; the module docblock, the
maintenance guide and the attack-surface notes link here rather than repeat it.
All of these, every time; any one failing leaves VULNERABILITY FOUND with the
reasons printed under it and a pointer back to this page:

- **The report is complete and is exactly the reviewed one.** `pnpm audit`
  exited 1, and its report has exactly the measured pnpm shape (an unfamiliar
  shape is refused, never guessed at) and audited a non-empty tree.
- **It holds one advisory and nothing else.** The counts are non-negative
  integers totalling one high, with no critical; the one advisory is the
  recorded GHSA, package, range and severity. A second advisory at any severity
  means the report is no longer the one the owner looked at.
- **Only the covered copies are affected, on exactly the recorded paths.** The
  advisory's findings are exactly the record's covered copies: one finding
  per covered version, no version the record does not list, none it lists
  missing. Each finding has the reviewed shape, is not bundled and not
  optional, carries the recorded dev flag, and reports exactly the recorded
  set of dependency paths (order aside; a path listed twice is refused). A
  mismatch names each path added and each removed.
- **No duplicated key hides a finding.** `JSON.parse` keeps only the last of
  two duplicate keys, so the raw report is also scanned for keys: `"findings"`
  must be a key exactly once, and `"version"` exactly once per finding. Only
  strings in key position count, so free text that quotes those words changes
  nothing. Real pnpm output never repeats a key; this is defence in depth
  (#5252 security lens).
- **The record is well-formed and unique.** Exact key set (an unknown key is
  refused, so nobody can invent a looser one), and exactly one record names
  that GHSA. A stray file in this directory refuses every record.
- **Every covered copy's patch is the reviewed patch, and pnpm applies it.**
  For each copy: the patch file's SHA256 matches; `pnpm-workspace.yaml`
  registers that file for exactly that `package@version`; `pnpm-lock.yaml`
  records the same hash.
- **Nothing else about the dependency inputs moved.** Both
  `pnpm-workspace.yaml` and `pnpm-lock.yaml` match their recorded SHA256.
- **The approval is current and short-lived.** The expiry has not been reached,
  and is no more than 14 days away (the clock is passed in, never read by the
  module).

A MITIGATED pass exits 0, prints **MITIGATED — NOT CLEAN** with the advisory,
the record's scope, every copy it does not cover and the unfiltered pnpm
report, and raises a GitHub Actions warning annotation
(`Dependency audit MITIGATED (NOT CLEAN)`) on the run so it never reads as a
plain green tick. An outage, an unreadable report or any other inconclusive
result is unaffected and still fails.

## Retiring a record

Retire a record when a fixed release is published or the advisory is
withdrawn (the #3843 and #5252 records were both retired on a withdrawal, in
[#3851](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3851) and
[#5293](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5293)),
and delete an expired one rather than leave it: an expired record changes
nothing — the check is red either way — but the directory should say what is
true. One pull request, under the `AGENTS.md` merge gate (no owner comment
needed, #4473):

1. Upgrade to the fixed release (or, if the advisory was withdrawn, confirm the
   audit no longer reports it; if retiring with neither, accept the red check).
2. Delete the record from this directory, each covered copy's patch from
   `patches/`, and each patch's line under `patchedDependencies` in
   `pnpm-workspace.yaml` (remove the key, and its comment, too if it is left
   empty). Delete any test that pins the patch's behaviour (#5293 deleted
   #5252's `scripts/ci/picomatch-redos-patch.test.ts`). Lower
   `MAX_OWNED_OUTSIDE_SRC_LIB` in `src/lib/__tests__/codeowners-census.test.ts`
   by the number of files removed here, which that census owns.
3. Run `pnpm install` to re-lock, so `pnpm-lock.yaml` no longer records the
   patch hash.
4. Leave `patches/.gitkeep` in place: the Docker `deps` stage copies
   `patches/` before its frozen install, and git does not keep an empty
   directory.
5. Remove the record's row from "Current records" below.
6. Re-run `pnpm run audit:deps` and confirm the verdict is CLEAN with no
   mitigation.
7. Where the fix is a release, also re-check the bundling tools the record
   lists in `knownUncoveredCopies` for releases that carry it. A withdrawn
   advisory leaves nothing to track there (#3851).

Nothing else needs to change: the wrapper and its tests run unchanged with no
record in this directory (the tests use a synthetic fixture under
`scripts/ci/fixtures/dependency-mitigation/`).

## Current records

This table is the one list of live records; other documents link here rather
than restate a record. Each record's own `knownUncoveredCopies` is the one list
of the copies it does not cover.

There are no live records. The last one,
`5252-picomatch-ghsa-fc5q-39xc-vjpf.json` (GHSA-fc5q-39xc-vjpf, `picomatch@4.0.7`
and `picomatch@2.3.2`), was retired with its two patches in
[#5293](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5293) after
GitHub withdrew the advisory on 18 Nov 2026. The one before it,
`3843-braces-ghsa-vfj7-8cjw-p6xm.json` (GHSA-vfj7-8cjw-p6xm, `braces@3.0.3`),
was retired with its patch in
[#3851](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3851) after
GitHub withdrew that advisory on 23 Oct 2026.

When a record is added, list it here:

| Record | Advisory | Expires | Scope | Retirement |
| --- | --- | --- | --- | --- |
