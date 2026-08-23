# Maintenance

Audience: Developer, Agent

This document describes the public maintenance baseline for AlpineClubBookingsNZ.

## Required Gates

Run the fast local gates before pushing application changes. `test:related` is
mandatory because it follows the module graph to adjacent suites that a
filename-only selection misses; add focused tests for the contracts you changed.

```bash
npm run db:generate
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npm run typecheck
npm run test:related -- $(git diff --name-only main...HEAD)
npm test -- path/to/focused.test.ts
npm run knip                 # when files or exports change
npm run docs:linkcheck       # when docs change
npm run docs:indexcheck      # when docs change or INV-* ids are cited
npm run quality:budget
npm run ci:workflowcheck     # when .github/workflows/ changes
git diff --check
```

The blocking `verify` job owns the full `npm test` and the production build; the
dependency audit is its own blocking job beside it (`Dependency audit`, #2946)
so an advisory cannot skip the gates behind it. Do not duplicate the full suite
locally unless diagnosing CI or CI is unavailable. `npm test` includes property-based tests (fast-check) for the pure money math —
pricing, promo discounts, refund tiers, change fees, member credit, and the
Xero booking-edit settlement classifier — in
`src/lib/policies/__tests__/*.property.test.ts` and
`src/lib/__tests__/xero-settlement.property.test.ts`. They enforce the
`DOMAIN_INVARIANTS.md` "Money" rules as universally-quantified properties
(integer cents, refund + retained = paid, deterministic repricing, no negative
charge or refund totals — booking-edit components stay signed and sum to the
net, #1356).

Migration/schema parity is enforced by a dedicated check. The committed
migrations in `prisma/migrations` must reproduce `prisma/schema.prisma` exactly,
or the blue/green deploy migration-safety gate aborts. Run it locally against a
throwaway database (`SHADOW_DATABASE_URL` must point at an empty, existing DB
that Prisma resets):

```bash
SHADOW_DATABASE_URL=postgresql://user:pass@localhost:5432/drift_shadow \
  npm run db:check-drift   # exit 0 = in sync, 2 = drift
```

CI also runs independent static and container checks:

- `npm audit --audit-level=high` in its own blocking `Dependency audit` job, on
  pull requests and on pushes to `main`. It runs from a bare checkout with no
  `npm ci`: measured on npm 11.16.0 / Node 24 the audit builds its tree from
  `package-lock.json` and returns the same verdict with or without
  `node_modules`, and skipping the install keeps a required supply-chain gate
  from reddening for anything except an advisory
- `npm audit --audit-level=high --package-lock-only` again in the advisory,
  pull-request-only `dependency-review` job. That one carries a job-level `if:`,
  which is exactly why it can never be a required check
- Semgrep with Next.js, TypeScript, JavaScript and React registry rules, **plus
  the repository's own rules in `.semgrep/rules/`** for the two boundaries no
  registry pack can know about — a `"use client"` module importing server-only
  code, and interpolated SQL reaching `$queryRawUnsafe`/`$executeRawUnsafe`.
  Each custom rule ships must-fail and must-pass fixtures in `.semgrep/tests/`,
  which the same job runs before the scan (#2686)
- gitleaks in one pinned container over **three** scopes — the pull request's own
  commits, the history of `main`, and the checked-out tree — preceded by
  `scripts/ci/gitleaks-selftest.sh`, which plants a credential and proves the
  scanner still reports it. `Secret scan (gitleaks)` (#2686; **pending** as a
  required check, see `AGENTS.md` for the rollout order)
- TypeScript, test, and Docker image build validation
- Migration drift check (`migration-drift` job) running `db:check-drift` against
  a throwaway Postgres, so schema-vs-migration drift fails the PR rather than the
  deploy
- Trivy critical vulnerability gate with high-severity warnings, as
  `Image security gate (Trivy CRITICAL)` (#2686; **pending** as a required
  check)
- CodeQL, as **advisory** analysis via GitHub code scanning **default setup**
  (repository settings, not a workflow file — languages `actions`, `javascript`,
  `javascript-typescript`, `typescript`; default query suite; weekly schedule
  plus every push and pull request on `main`). It is deliberately not a required
  check, and it does not report on pull requests from forks

## Dependency Policy

- Keep `package-lock.json` committed.
- Prefer small dependency update PRs with explicit validation results.
- Keep the `overrides` block in `package.json` to the minimum that is still
  load-bearing, and retire an entry as soon as the upstream dependency graph no
  longer needs it. `package.json` is strict JSON and cannot carry a comment, so
  the register below — not the manifest — is where an override records why it
  exists and when it retires. Adding an override means adding a row.
- Use test or demo credentials for Stripe, Xero, SES, and Sentry in local and
  CI environments.

### Why a stale override is not harmless

A transitive dependency normally maintains itself: when a Dependabot group PR
bumps a parent, npm re-resolves and every child floats up to the newest version
its parent's range allows. An **exact** override switches that off for one
package permanently, so the package silently stops being maintained by the
system and becomes ours to carry. Prefer a `^` floor over an exact pin — the
lockfile still pins one resolved version, so nothing about build or deploy
determinism changes, but the package can drift upward within the range instead
of freezing.

This is not theoretical. #2863 found eleven of thirteen overrides had outlived
the advisories that prompted them, two of them holding a package back a full
minor version and two more pinning packages that had left the dependency tree
altogether.

### The override register

Every row below was verified by removing that entry and re-resolving (#2863). All
four are load-bearing; none is inert.

| override | why it exists | retires when |
| --- | --- | --- |
| `sharp` (`$sharp`) | **Security.** Removing it lets `next` nest `sharp@0.34.5`, which carries two high-severity advisories. Forces every copy onto the `^0.35.3` declared in `dependencies`. Added in `83b25035d`. | `next` requires sharp 0.35.3 or later. |
| `postcss` (`^8.5.26`) | **Security.** `next` requires postcss at **exactly `8.4.31`**, which carries four advisories including a high. An exact upstream pin cannot be lifted by drift, so this override is the only thing keeping the nested copy safe. | `next` moves its own postcss pin to 8.5.26 or later. |
| `next-auth` → `nodemailer` (`$nodemailer`) | **Resolution.** `next-auth@5.0.0-beta.32` declares `peerOptional nodemailer@"^7.0.7 \|\| ^8.0.5"`, which conflicts with the `^9.0.1` in `dependencies`; without the override `npm install` fails outright with `ERESOLVE`. Added in `8f366a08c` (#1182). | `next-auth` widens its peer range to admit nodemailer 9. |
| `eslint-plugin-react-hooks` | **Compatibility hold**, not security — `b1989558f` introduced it as "hold eslint-plugin-react-hooks at 7.0.1", and it has since been stepped forward to 7.1.1. Currently non-binding: natural resolution lands on 7.1.1 with or without it. | The hold is reviewed and lifted on purpose. |

### Checking whether an override still earns its place

`npm audit` answers this directly, and it is worth running whenever the block is
touched. Strip the candidate entries in a scratch copy — never in the worktree —
regenerate, and audit:

```bash
mkdir -p /tmp/ovcheck && cp package.json package-lock.json /tmp/ovcheck/
cd /tmp/ovcheck && cp package-lock.json lock-before.json

# remove the override(s) under test from package.json, then re-resolve from
# scratch — deleting the lockfile is what forces npm to answer "where would
# this land on its own?" rather than preserving what is already pinned.
rm package-lock.json
npm install --package-lock-only --ignore-scripts --no-audit
npm audit --package-lock-only --audit-level=high
```

Anything the audit reports is still load-bearing and stays. Anything it does not
report has been fixed upstream and the override should go.

Compare `lock-before.json` against the regenerated lockfile as well, because the
audit alone does not distinguish an inert override from a harmful one. An entry
that resolves to a **lower** version once removed is doing real work; one that
resolves to the **same** version is inert; one that resolves **higher** was
actively holding the package back.

Two cautions. `npm audit` reflects today's advisory database, so this measures
whether upstream has caught up as of now, not for all time. And an override may
exist for a non-security reason that no audit can see — check `git log -S` for
the entry before removing it, as a hold or a peer-conflict fix will look inert
to this procedure while still being load-bearing.

## Supply-Chain And Deployment Security Policy

- Keep GitHub Actions default permissions at `contents: read`. Grant elevated
  permissions only on the job that needs them, such as `packages: write` for
  GHCR publishing on `main`.
- Do not reference GitHub Actions by default branches such as `master` or
  `main`. Use released major tags for trusted first-party and widely used
  actions that Dependabot can track, and use explicit release tags for scanner
  actions or images where drift would change gate behavior.
- Keep scanner container inputs isolated. Source checkouts mounted into scanner
  containers should be read-only unless the scanner must write to the source
  tree; write artifacts to `$RUNNER_TEMP` or another dedicated output mount.
- Keep production image tags commit-SHA based. Operators should deploy the app
  and migration images that match the resolved `origin/main` commit.
- Keep GHCR host tokens read-only. Production hosts need `read:packages`; CI
  publishing uses the workflow `GITHUB_TOKEN` in the publish job only.
- Treat Docker image security as two gates: CRITICAL Trivy findings fail the PR,
  while HIGH findings are warning-only until reviewed and promoted to a blocking
  policy. Since #2686 the CRITICAL half is intended as a **required**
  protected-branch check (`Image security gate (Trivy CRITICAL)`), so it blocks
  the merge rather than only turning a job red; the HIGH step keeps
  `continue-on-error: true` and the two steps are named "REQUIRED" and
  "ADVISORY" so the distinction is readable from the checks list.
- Keep a scanner's configuration file honest about what it actually enables. A
  `.gitleaks.toml` without `[extend] useDefault = true` REPLACES the built-in
  rule set instead of adding to it, and this repository shipped exactly that for
  months: both gitleaks jobs ran green over a rule set with nothing in it
  (#2686). Whenever a scanner config changes, prove the scanner still fails on a
  deliberate violation before trusting the green —
  `bash scripts/ci/gitleaks-selftest.sh` is that proof, and it runs in CI ahead
  of the scans it vouches for.
- Keep gitleaks allowlists CONTENT-scoped **and pinned to exact literals**. A
  global `[[allowlists]]` entry carrying `paths` suppresses everything under
  those paths in gitleaks 8.28.0 whatever else the entry says, and
  `matchCondition = "AND"` does not narrow it. A global allowlist also applies to
  every RULE, not the one its description names, so a SHAPE — a UUID, a
  `sk_test_` prefix — silences rules nobody considered: measured, the UUID shape
  dropped `heroku-api-key` and a UUID `CRON_SECRET`. `targetRules` is not the fix
  either; in 8.28.0 it silently voids the allowlist entirely.

### Two Semgrep scans run per pull request, and only one of them blocks

This trips up every reader of a `nosemgrep` annotation, so it is written down
rather than inferred:

- **`Static analysis gate`** (`ci.yml` → `static-analysis`) is the blocking one.
  It runs `p/nextjs`, `p/typescript`, `p/javascript`, `p/react` and
  `.semgrep/rules/`, and nothing else.
- **`semgrep-cloud-platform/scan`** is a Semgrep AppSec Platform GitHub App
  check. Its ruleset is configured at semgrep.dev, not in this repository, it
  costs no GitHub Actions time, and it is advisory.

Measured at 527eb74fc by re-running the exact blocking invocation with
`--disable-nosem`: **the blocking rule set produces exactly ONE finding in the
whole repository**, `acb-unsafe-raw-sql` at `src/lib/audit-retention.ts`. So
exactly one of this repository's `nosemgrep` annotations is live against the
gate that can stop a merge. The other 87 name ids from `p/default` /
`p/security-audit` — packs the blocking scan does not run — and serve the cloud
scan.

They are deliberately **not** pruned. Their effect is only observable in a scan
whose ruleset this repository does not control, so "these suppress nothing"
cannot be verified from here, and deleting 87 annotations on that assumption
would be a blind change to a security surface. Two things follow for anyone
adding or reading one:

- say which scan an annotation is for. If it names a `javascript.…` /
  `generic.…` registry id, it is for the cloud scan and the blocking gate will
  never emit it;
- Semgrep matches `nosemgrep: <id>` by **exact suffix**, so a rule-id variant is
  a different id. The 41 `path-traversal.path-join-resolve-traversal`
  annotations do not suppress an `express-path-join-resolve-traversal` finding,
  and a rename upstream silently un-suppresses every one of them.

### Break-glass: a new CRITICAL image finding with no code change

Trivy scans the built image against a vulnerability database that moves on its
own. A newly published CRITICAL against the `node:24.15-alpine` base therefore
turns `Image security gate (Trivy CRITICAL)` red on **every** open pull request,
including the one that would fix it, with nobody having changed a line. Branch
protection has `enforce_admins` off, so the owner can force a merge through; an
agent cannot, and must not try. Do this instead, in order:

1. **Rebuild first.** If the base image has already been patched upstream, a
   fresh `docker build` picks it up and the finding disappears. Check the
   advisory for a fixed version before anything else.
2. **If there is no fix yet, add a dated `.trivyignore` entry** at the
   repository root, one CVE per line, each with a comment giving the CVE, the
   date, why the application is not exposed, and the issue tracking removal:

   ```
   # CVE-2026-12345 — added 2026-08-14. openssl in node:24.15-alpine; no fixed
   # version published yet. Reachable only from the TLS client path, which this
   # image does not use at build time. Remove when 24.15.x ships the fix.
   # Tracked by #NNNN.
   CVE-2026-12345
   ```

3. **File the removal issue in the same pull request**, never as prose. An
   undated, untracked `.trivyignore` entry is a permanently disabled gate.
4. **Owner admin-merge is the last resort**, and it is an owner action: an agent
   escalates by commenting, and waits.

Review `.trivyignore` whenever the base image moves, and delete every entry whose
advisory now has a fixed version.

### The repository-wide secret sweep

`Secret scan (gitleaks)` is deliberately scoped to `main`, not to every branch:
`git log --all` walks every `refs/remotes/origin/*` that `fetch-depth: 0`
materialised, so one leak on anybody's abandoned branch would turn a REQUIRED
check red on every open pull request, unfixable from the author's own branch.
A wider sweep is still worth running — a secret on an unmerged branch is public
on a public repository — but it belongs in a scheduled, non-blocking job where a
finding is a task rather than a merge freeze. Until that job exists, run it by
hand when a branch is abandoned:

```bash
docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.28.0 \
  git /repo --log-opts="--diff-merges=first-parent --all" --exit-code=1 --redact
```

Accepted residual risk:

- Most GitHub Actions remain pinned to released major tags rather than full
  commit SHAs so Dependabot and upstream patch releases can keep routine
  maintenance low-friction.
- The project does not yet publish signed image attestations or SBOM artifacts;
  image provenance is currently the commit-SHA tag, protected PR checks, and the
  GHCR package publish job.
- The `npm audit --audit-level=high` gate keeps high/critical npm advisories
  blocking, while lower severity advisories remain review-driven.
- Until `Dependency audit` is added to branch protection it is a red check
  rather than a merge block (#2946). Adding the context before the job exists on
  `main` would leave every open pull request waiting forever on a check that has
  never reported, so the order in `AGENTS.md` -> "Completion and Merge" applies:
  merge first, add the context second, rebase open pull requests third.

## Image Uploads Storage

Admin Image Manager uploads are written at runtime under `public/images` (served
at `/images/...`). The deployed app runs with a read-only root filesystem and
multiple replicas (blue/green), so this path must be a persistent, writable,
shared volume:

- `docker-compose.yml` mounts the `image_uploads` named volume at
  `/app/public/images` for every app replica, so uploads survive redeploys and
  are visible to all instances.
- The app runs as uid 1001. The `Dockerfile` creates `public/images` owned by
  uid 1001 so a freshly-initialised named volume inherits writable ownership.
- Relocate storage at the deployment layer by bind-mounting your chosen path at
  `/app/public/images`. The application path stays `public/images` (a trusted
  constant), which keeps the upload path-traversal checks statically verifiable.
- When the volume is missing or not writable, upload and create-directory
  requests return a clear "image storage directory is not writable" message
  (with the underlying error code) instead of a generic failure, and the cause
  is logged server-side.

## Maintainability Budgets

The budgets below are the long-term target for every production source file:

- Route handlers (`src/app/.../route.ts`) should stay under 250 LOC.
- App Router page shells (`src/app/.../page.tsx`) should stay under 500 LOC.
- New domain modules (`src/lib/...`, `src/components/...`) should stay under
  700 LOC.
- No new production `any`, type suppression (`@ts-ignore`,
  `@ts-expect-error`, `@ts-nocheck`), or `eslint-disable` without a
  short inline comment explaining the local justification.

The first three are enforced, as a **regression ratchet** rather than a
flag-day hard gate (#2687). When a file is already over budget, prefer
extracting cohesive helpers into a focused module rather than adding more to
the existing surface.

### File-size budget ratchet

The tree does not meet the budgets today and will not for some time. Measured
on 21 Aug 2026: 283 of 2,036 production files are over budget, carrying 122,887
lines of size debt. That is an anchored measurement, not an acceptance constant
— run `npm run quality:budget -- --report` for the current tree, which is now
the only place the figure lives. Failing all that debt at once would produce
either a permanently red gate or a mass exception list, and both are worse than
no gate, because they look like enforcement while providing none. So the rule CI
enforces is:

> Current size debt may stay. New debt and debt growth may not appear silently.

**No ceiling is written down.** For each file a change touches, the check reads
how long that file was on `origin/main` and compares. From that:

- a file that was **within** its budget may not go over it;
- a file that was **already over** may not exceed the length it had on
  `origin/main`;
- shrinking is always allowed, and needs no follow-up: the smaller number is
  what the next change is measured against, because that is what `origin/main`
  will then carry;
- a file the change did not touch is not judged at all — it cannot have grown;
- an already-over-budget file **may** grow if the change says so out loud, in a
  per-pull-request allowance that names the file, its new length and why
  splitting is worse — see "When a file legitimately has to grow" below;
- a file **renamed within** the budgeted scope keeps its predecessor's ceiling,
  so moving an oversized module does not read as a pile of brand-new debt. A
  file renamed **into** the scope from outside it — from `prisma/`, `scripts/`,
  or a `__tests__/` path — has no ceiling to inherit and is judged as **new**,
  so it must meet its budget outright. Otherwise "move it into `src/`" would be
  a way to arrive over budget with the gate green, and moving it out and back
  again would be a way to launder any amount of growth in two steps;
- if the base cannot be read, the check **fails**. An enforcement tool that
  cannot see what it is comparing against must say so rather than report a pass
  it has not earned, which is the same rule `npm run pr:check` follows for an
  unfetched `origin/main`. The same goes for a run that finds **no production
  files at all**: "scanned and found nothing wrong" and "scanned nothing" are
  the same empty result and must not be the same message.

```bash
npm run quality:budget                    # verify (also a step in CI's `verify` job)
npm run quality:budget -- --base <ref>    # compare against something other than origin/main
npm run quality:budget -- --report        # the whole tree's debt, on demand
```

All three read `git` and the working tree only: no network, no database, no
build. A full run is well under a second.

**"On `origin/main`" means at the point this branch was cut from it** — the
merge base of `origin/main` and `HEAD`, not the tip. Otherwise a branch is
measured against whatever has landed on `main` since, and `main`'s own edits
read as the branch's. That was measured while building this: `origin/main` had
moved ahead by one merged pull request and `git diff origin/main` reported seven
`src/` files as changed that the branch had never touched. They happened to be
shrinks, so nothing failed — but had that pull request *split* a file, the local
run would have gone red for somebody else's edit.

**In CI the two readings are the same commit**, so this choice costs and buys
nothing there. A `pull_request` run checks out `refs/pull/N/merge`, a merge
commit whose first parent is the base tip, so the merge base *is* the tip — and
the merge tree already carries `main`'s version of every untouched file, so the
seven files above could not have appeared under either reading. The difference
is entirely about running the check locally on a branch that has not merged
`main` in.

**What it costs locally, stated plainly.** The merge base is not uniformly the
stricter reading. If `main` *shrinks* a file after the branch point, the branch
is still judged against the larger pre-split length: measured, a 1,200-line
module that `main` splits to 300 can be re-inflated to 1,199 on a stale branch
and the local run passes, where the tip reading would have failed it at 700. The
gap closes as soon as `main` is merged in — the merge base then moves to the
split — and it never opens in CI.

**On a push to `main` the default base is not usable at all**, and the `verify`
job passes an explicit one. There, `origin/main` *is* the commit being tested:
the merge base is `HEAD`, the diff is empty, and the check would report "0
production files changed" whatever the tree holds. Two branches that each add
sixty lines to a six-hundred-line file both pass their own pull-request run,
merge cleanly to 720 against a 700 budget, and nothing would ever say so — after
which the next change to that file is measured against 720. The workflow
therefore passes the push event's own pre-push commit as `--base`, and keys that
on the event name, because a `pull_request` payload carries a `before` field too
and it means something else entirely.

Most of the time that run says exactly what the pull-request run already said,
against exactly the same base — for a branch that was up to date, the merge
commit's tree is the tree CI already tested. It differs in two situations, and
both are worth knowing. If `main` moved between a branch's last run and its
merge, the push run is the first thing to see the combined result, which is the
whole point. And if an accepted increase is ever landed by merging a red pull
request, the push run goes red once as well; it clears on the next push, and
while it is red it is reporting what `main` now holds rather than a fault in the
merge.

This is also why CI's `verify` job must keep `fetch-depth: 0` — for a quieter
reason than "a shallow clone has no merge base", which is not true. A depth-1
clone resolves `origin/main` perfectly well, returns `HEAD` as the merge base,
and reports **OK** over a tree holding a 1,300-line module. Truncated history
narrows the diff silently rather than failing, which is the worse of the two.

#### Why there is no longer a baseline file (#2979)

Until August 2026 the previous length came from a checked-in ledger,
`scripts/quality/file-size-baseline.txt`, listing every over-budget file and its
ceiling. The rule was right; the file was the problem.

Every change that grew a listed file rewrote the same line, so the next change
to merge re-conflicted it, forever. On the 21 Aug 2026 wave, **five of nine**
parallel lanes touched it, and `.gitattributes` gives it no merge driver —
`CHANGELOG.md` is the file's only `merge=` entry — so every collision was a real
three-way conflict that somebody resolved by hand. Twice, that hand resolution
shipped a wrong number:

- two lanes both raised the ceiling for `src/proxy.ts`; their code changes
  merged cleanly in different regions, and the merged file was 1,329 lines while
  the recorded ceiling read either 1,320 or 1,208, whichever side won;
- one recorded 1,101 for a file whose untouched length on `main` was already
  1,104 — a ledger the tree violated the moment it landed.

Two loopholes closed with it, both recorded against the old ratchet. A `.ts` to
`.js` rename used to pass, because the ledger was keyed by path and the new path
was simply unlisted; the previous length is now looked up under the old path git
reports, so the allowance follows the file. And a stored ceiling could drift
above the file's real size, letting removed lines come back unnoticed; the
ceiling is now the base ref itself, so drift is not prevented so much as
unrepresentable.

**Scope.** Tracked source under `src/` only, tests excluded, in any of
`.ts .tsx .mts .cts .js .jsx .mjs .cjs`. Everything outside `src/` —
`scripts/`, `prisma/`, `e2e/`, `load/`, and a temporary `measurement/` tree —
is outside the file-size policy by definition. That scope is stated once, in
the tool, rather than as a per-issue exemption; adding or deleting a
measurement tree is a non-event for this gate.

An **untracked** new file under `src/` is judged too, even before `git add`.
`git diff` cannot see one, so without that a brand-new 900-line module would be
checked by nobody until somebody staged it — and whoever runs the check before
staging is exactly the person who most needs the answer. A file git is
**ignoring** stays ignored.

The extension list is checked rather than trusted. A tracked file under `src/`
whose extension is in neither the source set nor the tool's short list of
declared non-source kinds (`.css`, `.md`, `.json`, images, fonts) **fails the
check**, naming the file and asking for it to be classified. Without that, the
scope silently narrows the first time a new file kind lands, and a narrowing
scope in a ratchet looks exactly like progress: renaming `src/lib/audit.ts` to
`audit.js` once removed it from the gate entirely and reported the removal as a
45-line *reduction* in accepted debt. That is the shape this section teaches
reviewers to read as a split going well.

#### When a file legitimately has to grow

**Splitting the file is the preferred answer, and stays the preferred answer.**
Where a cohesive helper can come out into a focused module, take that — it is
the outcome the budgets exist to produce, and it lowers the ceiling for everyone
who comes next.

Where the split is genuinely worse — the rule and its exception belong in one
place, or the seam does not exist yet and inventing one for this change would
make the code harder to follow — say so out loud, in a file of your own:

```markdown
size-allowances.d/2980-membership-type-policy.md

file: src/lib/membership-type-policy.ts
lines: 1509
reason: the school-teacher discriminator has to sit beside the policy it
  guards; splitting it would put the rule and its exception in different files.
```

That is **one new file per pull request**, at a path no other pull request
touches, which is the same shape `changelog.d/` uses and for exactly the same
reason: a shared list is what made this gate a treadmill in the first place.
[`size-allowances.d/README.md`](../size-allowances.d/README.md) is the full
format and the rules. In short:

- it names the **file**, its **new length** and the **reason**, because a bare
  "allow growth" marker is not something a reviewer can weigh;
- the recorded length must be the file's **real** length. The check fails if it
  is not, which is what stops an allowance drifting away from the tree the way
  the old ledger did, and stops one being written once and reached for later;
- it is **one-shot**. It only has effect on the change that introduces it, so
  after merge it is inert — the grown length *is* the base ref by then, and the
  file can be swept out of the directory in bulk whenever somebody tidies, the
  same way compiled changelog fragments are;
- an allowance the check **did not need** fails too, rather than passing
  quietly. That is either a mistake or a file that shrank, and leaving one lying
  around is how a per-change note turns back into a stored exceptions list;
- it may **not** cover a new file, a file renamed into the budgeted scope, or a
  file crossing its budget for the first time. Each is refused by name. An
  allowance lets an already-over-budget file grow; it is not a way to arrive
  over budget.

**`npm run quality:budget:update` is gone** (#2979) — if you remember typing it,
or find it in an old branch or an old pull request comment, the allowance above
is what replaced it. It regenerated the deleted baseline file; running it now
prints an explanation rather than doing nothing quietly.

What this arrangement buys, stated plainly: an accepted increase is still
machine-checked and still visible in a diff, but **no other pull request pays
for the decision**. The old escape hatch was a single shared file that every
concurrent branch had to re-resolve, which is what made it a treadmill rather
than a control.

- **A split or a thinning** lowers the ceiling automatically on the next change,
  because `origin/main` then carries the smaller file. Nothing to regenerate and
  no way to leave the old number behind.
- **A rebase or a merge from `main`** does not conflict on anything belonging to
  this gate, because no two branches write the same path.
- **A deliberate increase** is one disposable file, reviewed on its own terms.
  There is still no exceptions list and no shared allow-list to hand-edit into a
  laxer ceiling.

If you want the aggregate figure for context — how many files are over budget
and by how much in total — run `npm run quality:budget -- --report`, or read the
`File-size budget ratchet` section of `npm run quality:report`. Both compute it
from the tree through the same function, so neither can drift from the other or
from the gate.

### Quality report

Run the local maintainability report before opening broad refactor PRs, after
splitting a large surface, and when reviewing a PR that adds substantial
production code:

```bash
npm run quality:report
```

The script scans tracked files via `git ls-files` and prints a markdown
summary of:

- largest production files
- the whole tree's size debt, and any scope hole in the gate's classifier
- largest oversized files, largest route handlers and App Router pages
- largest test files
- production `any` / type-suppression hotspots
- production `eslint-disable` hotspots
- test `as any` totals

It uses only existing repo tooling, runs without external service
credentials or network access, and is advisory: it warns and informs rather
than failing the build. The `Over budget` column is a review prompt: `yes`
means the file exceeds the route-handler, page-shell, or new-domain-module
budget. The `File-size budget ratchet` section reports the population the
blocking gate enforces its rule over, and both read it from the same function —
so the report and the gate cannot disagree about which files are over budget.
The report itself never fails; `npm run quality:budget` is the half that does.

### Refactor history and split guidance

There is no ledger of accepted size debt any more (#2979) — the current figure
is whatever `npm run quality:budget -- --report` measures. This table is not a
ledger and is not an allow-list: it is the standing guidance for a handful of
surfaces whose split axis was decided once and should not be relitigated. It
carries no line counts,
because a hand-maintained count is exactly what went stale here before — the
nine files this table used to list were presented as *the* over-budget
population while the real figure was in the hundreds, and three of the counts
were off by two orders of magnitude.

| File | Disposition |
| --- | --- |
| `src/lib/xero-inbound-reconciliation.ts` | Split (#1270, #1208 item 1) into a re-export barrel over cohesive `src/lib/xero-inbound/` modules (`types`, `constants`, `amounts`, `object-links`, `audit`, `incremental-reconciliation`, `contact`, `payment`, `invoice-paid-effects`, `invoice`, `credit-note-repairs`, `credit-note`, `event-processing`). Behavior-preserving verbatim motion with an acyclic import graph (`types`/`constants` are leaves; the `event-processing` worker sits on top); the barrel re-exports the unchanged public surface (3 functions + 5 result types + `XeroInboundReplayError`). |
| `src/lib/xero-booking-repair.ts` | Accepted as-is for now: operator repair tool, documented separately, not normal request-path code. |
| `src/lib/xero-operation-outbox.ts` | Queued for future split when queue dispatch, release, or retry policy changes next land (PR-b of #1272 co-locates the replay stack). |
| `src/lib/email-templates.ts` (deleted) | Split (#2689) into 19 cohesive family/content modules under `src/lib/email-templates/`, plus the shared `layout` shell and `escape` leaf (21 files altogether), with **no compatibility barrel** — callers import the family module directly. Fourteen modules mirror sender families in `src/lib/email/`; `communications` and `refunds` cover senders outside that tree; and `booking-reminders`, `booking-exceptions`, and `admin-xero-reports` keep large families within budget. The domain-only money rows and netting arithmetic live separately at `src/lib/booking-money-lines.ts`, shared by renderers, booking settlement reads, and the Xero drift checker. Largest rendering module 581 LOC, inside the 700 budget. The render-equivalence gate pins 219 complete outputs and discovers template modules from the directory, so a new renderer cannot arrive uncovered. Three former send-site bodies under two registry keys (`website-contact` and `admin-email-failure`) were brought under that gate, then deliberately moved onto the standard club shell; recipient, template, and booking values are escaped at the rendering edge. The old `adminXeroRepeatedFailureTemplate:minimal` pin was stale: the exact pre-split head renders 5,799 bytes with sha256 `f7a72f30fc8250c8ff75ca1417b9251541f5a06664e7d5c4fe3b8b171b9f6d4d`, byte-identical to the split head, rather than its recorded 5,802-byte hash. The split corrected that one pin row; it did not change that body. Mutation proofs cover byte-neutral body drift, module omissions, duplicate export names, duplicate case and pin IDs, and removed escaping. |
| `src/lib/contextual-help.ts` (deleted) | Split (#2689) into 16 modules under `src/lib/contextual-help/`. `index.ts` **is** the registry (path matching, longest-prefix resolution, fallbacks, question attachment) rather than a barrel, and keeps the same three exported accessors; entry content sits in one module per **admin sidebar section** (`admin/*.ts`, matching `navSections` in `admin-sidebar.tsx`) — plus one `appearance-and-website` module split off Setup & Configuration, because `/admin/appearance` is an item in that section rather than a section of its own and folding its seven pages back would take that module to ~810 lines, over budget — with `finance.ts`, `questions-*.ts`, `fallbacks.ts`, and the two leaves `types.ts` and `booking-status-glossary.ts`. Content stayed TypeScript by owner decision — the typed shape is the schema check. Largest module 580 LOC. The structural move was proved value-for-value for every one of the 68 resolved paths: a JSON dump keyed by path — both scopes, both fallbacks, nested resolution and `normalisePath` — was byte-identical before and after (106,917 bytes, same sha256). The same PR then reconciled the shadowed second `/admin/notifications` entry against the live page and folded its accurate delivery-mode field into the surviving entry. The registry now has 68 entries with 68 unique paths (67 admin, one finance), and a permanent test rejects any future duplicate as unreachable text. |
| `src/lib/admin-bed-allocation.ts` (deleted) | Split (#2688) into eighteen modules named for one responsibility each, all under the 700-LOC budget, with **no barrel** — every one of its 31 non-test importers names the module it depends on, because a re-export facade would have left the monolith in place under a new name and recreated the same dependency magnet. The two barrel rows in this table are precedents for a *published API*, not for hiding a split. It had grown to 55 exports over 80 functions covering room and bed inventory, board assembly, allocation writing, range assignment, audit recording and date arithmetic. The modules, by concern: leaves `-admin-contract` (shared error and db-client types), `-display-names` (how a member and a guest are named), `-admin-settings` (the settings read/write bound to `prisma`), `-date-range` (the board's lodge-night range and its parse); wire shapes `-board-payload` (types only) and `-range-report` (client-safe); pure `-warnings` (the board's warnings); reads `-board-records` (queries and DTO serialisers) and `-board` (payload assembly, officer-card counter); writers `-placement` (the shared write chokepoint all three manual paths pass through, carrying the D-12 consent refusal and the ADR-001 whole-lodge-hold refusal), `-manual-writes` (single night, bulk nights, same-date move, delete), `-range-assign` (#2251 range assignment) with `-range-audit` (its audit record, which stores counts, night runs and booking ids but never other bookings' guest or member names), `-auto-allocate` ("Run auto allocation"), `-approval` (approval plus the #776 booking row lock), `-bunk-pairing` (the #1675 bunk rule and its room-row lock), `-rooms` (room inventory, config import, delete guards) and `-beds` (bed inventory, retire/delete guards). Every function body moved verbatim; the live sizes are whatever the tree currently carries, not a number recorded here. |
| `src/lib/bed-allocation.ts` | **Accepted, oversized, and deliberately not split** (owner decision, 9 Aug 2026, #2688). It is 13 exports across 69 functions: a small public surface around one first-fit allocation algorithm whose function bodies are long because the algorithm is. That is cohesion, not sprawl, and the budget is a signal about sprawl. Splitting it would produce files that must be read together to follow one algorithm, which makes capacity code — money code — harder to reason about, not easier. The sibling that WAS split, `admin-bed-allocation.ts`, was the opposite shape: 55 exports over 80 functions of unrelated responsibilities. Grow this file only with the algorithm; a genuinely independent concern with its own API and tests may still be extracted, and anything else is a reason to re-read this row rather than to add here. The ratchet holds its ceiling at whatever length `origin/main` currently carries for it. |
| `src/lib/email.ts` | Split (#1137) into a re-export facade over cohesive `src/lib/email/` modules (`core`, `admin-alerts`, `account`, `booking`, `membership`, `family`, `waitlist`, `groups`, `booking-requests`, `chores`, `ses-feedback`, plus non-re-exported `internal` plumbing). The `admin-alerts` surface was itself split (#1210) by **domain/source** — `admin-alerts.ts` is now a barrel re-exporting `admin-alerts-shared` (plumbing + `getAdminEmails`), `admin-alerts-booking`, `admin-alerts-membership`, `admin-alerts-finance`, and `admin-alerts-ops`. When an alerts/email module next exceeds the ~700 LOC soft cap, split it along the **domain axis** (booking/capacity, membership lifecycle, finance/Xero/payments, ops) — not by audience, which is fuzzy because most alerts fan out to all admins — and keep the facade barrel's exports byte-identical so `src/lib/email.ts` and every importer keep resolving. |
| `src/lib/xero-hardening.ts` | Accepted as-is for now: central Xero hardening policy and diagnostics boundary. The `xero-hardening-canonical-links.ts` ↔ `xero-hardening-report.ts` clone pair (112 duplicated lines / 2 clones, jscpd 2026-07-07) is recorded as accepted under this same disposition (#1524 C4, owner-ticked 2026-07; same subsystem call as #1208 items 5/6). |
| `src/lib/finance-sync-xero-datasets.ts` | Split (#1531, #1524 C3) into a re-export barrel over cohesive `src/lib/finance-sync-xero-datasets/` modules (`constants`, `types`, `date-format`, `report-snapshot`, `invoice-helpers`, `open-invoices`, `aged-invoices-snapshot`, `open-invoices-snapshot`, `report-sync`, `monthly-facts`, `chart-of-accounts`, `invoice-sync`). Behavior-preserving verbatim motion with an acyclic import graph (`constants`/`types`/`date-format` are leaves; the sync orchestrators sit on top); the barrel re-exports the unchanged public surface (29 functions/consts + the `FinanceMonthlyFactsWindowInput` type). The self-duplicated clone regions were deduped: the accounts-receivable and accounts-payable invoice builders now share one generic `buildFinanceOpenInvoicesSnapshot` (each snapshot's persisted invoice shape is supplied verbatim by the caller, keeping `expectedPaymentDate`/`plannedPaymentDate` divergent), and the aged + open-invoice builders share `updateContactDueDateRange`/`compareOpenInvoicePayloadsByDueDate`/`deriveSnapshotCurrency`. jscpd (min-tokens 70) dropped from 186 duplicated lines / 7 clones to 38 / 3 (2026-07-08); the 3 residual clones are the intentionally-separate AR-vs-AP payload literals plus two short prefix regions whose further extraction would over-abstract. |
| `src/app/(admin)/admin/members/[id]/page.tsx` | Queued for future route-shell thinning as member-detail sections continue to move local state out. |
| `src/app/(admin)/admin/family-groups/page.tsx` | Route-shell thinning completed (#1530, closes the #1524 C2 carry-over). The request-review duplication with `src/components/admin/family-group-editor.tsx` was extracted to a shared `FamilyGroupRequestReviewSection` (`src/components/admin/family-groups/request-review-section.tsx`) that both the admin page and the editor render; the per-request state and the approve/reject/search handlers now live there once (behaviour-preserving — the two prior copies differed only by a `member`/`adult` noun and their refresh callback, now props). jscpd (min-tokens 70) across the pair drops from the catalogued 225 duplicated lines / 7 clones to 29 lines / 3 clones — the residue is the unavoidable shared UI-import block plus the create/edit member-search combobox, left inline because its surrounding selected-member badges differ between the two forms. page.tsx thinned 786 → 565 LOC; editor 715 → 499 LOC. |

## Operational Repair Tools

### Recover a stranded $0 waitlist confirm (#2623)

Admin -> Audit log, filtered to action `waitlist.confirm_offer_release_failed`
(category `booking`, severity `critical`), lists free bookings whose waitlist
confirm got half-way and could not undo itself. It is rare by construction and
needs no script, but it will not clear on its own — no cron sweeps
`PAYMENT_PENDING`, and the member has no offer left to retry.

What happened: the confirm's first phase committed the booking to
`PAYMENT_PENDING` and consumed the waitlist offer; its second phase (the $0
`PAYMENT_PENDING -> PAID` claim) then lost its locks, and the compensating
release back to `WAITLISTED` lost its locks too. The booking therefore holds no
bed, has no payment path (it costs nothing) and has no offer to replay. The
member was told exactly this and told **not** to confirm again.

The audit row's metadata carries the lodge, the stay dates, `finalPriceCents`
and both underlying error codes (`claimErrorCode`, `releaseErrorCode`). Open the
booking from Admin -> Bookings and pick the outcome:

- **Put them back in the queue** — the repair the failed compensation would have
  made, and the one that keeps the promise the member was given. Open the
  booking from Admin -> Bookings and press **Return to waitlist** in the Admin
  tools card (#2649). Correct whenever the bed that prompted the offer has since
  gone. It needs `bookings: edit`, the same access Force Confirm needs.

  In one locked transaction it sets the booking back to `WAITLISTED`, clears the
  consumed offer (`waitlistOfferedAt`, `waitlistOfferExpiresAt`,
  `waitlistOfferedLodgeId`, `waitlistOfferedPriceCents`) and the stale queue
  position, releases any admin capacity hold or exclusive whole-lodge hold on the
  booking, and reconciles the bed allocations. Afterwards it hands the freed
  nights back to the ordinary offer worker and tells the member their waitlist
  place is back at position N — unless the booking's **No emails** switch is on,
  in which case the send is withheld and listed on the booking for you to relay.
  The member's email says their place was restored and that their offer did
  **not** run out; it is a separate message from the offer-expiry one, because
  they confirmed in time and it was our system that failed.
  It records a `waitlist.returned_to_waitlist` audit row whose metadata names
  the `waitlist.confirm_offer_release_failed` row it resolves — closing the trail
  at both ends — plus anything it released (`releasedAdminCapacityHold`,
  `releasedWholeLodgeHold`), so freed nights are never a silent side effect.
  If the booking carried a hold, the confirmation dialog says so before you
  press: set the hold again afterwards if you still need it.

  **The button appears only where the audit log proves a waitlist confirmation
  stranded the booking** — an unresolved `waitlist.confirm_offer_release_failed`
  report — on top of `PAYMENT_PENDING`, free, and no payment record. Those last
  three are deliberately not enough: **six** ordinary paths leave a free booking
  in Payment pending with no payment row — a date change that reprices to
  nothing, an admin date shift or a guest being added that releases a free
  booking's non-member hold, an admin approving a booking that was waiting on
  review, the group settlement reaper reverting a never-billed group member, and
  a free booking created between April and May 2026 that the May status backfill
  moved. None of those members was ever in a queue, so returning one of them to
  the waitlist would un-confirm a booking that was simply waiting to be paid.
  The
  route re-checks every condition under its locks, so a booking that someone else
  confirms or cancels in the same moment is refused in plain words rather than
  clobbered. If it reports that something else is holding the booking, nothing
  was changed — wait a moment and press it again.

  **Finding them.** There is no dashboard card for this state; it is rare enough
  that the audit log is the queue. Filter Admin -> Audit log to action
  `waitlist.confirm_offer_release_failed`, and treat any entry with no later
  `waitlist.returned_to_waitlist` on the same booking as outstanding. A booking
  stranded before #2648 shipped has no report and so no button — that one still
  needs a database session, and is the only remaining case that does. (The report
  is written and awaited inside the failing request, so a live strand cannot
  lose it to process teardown; if the write itself fails, the server log carries
  "the admin repair button will not appear for this booking".)
- **Cancel and have them rejoin** — reachable entirely from the admin UI, and the
  right choice when nobody can safely touch the database. Cancel the booking from
  Admin -> Bookings and ask the member to rejoin the waitlist for those nights.

Do **not** try Record payment: the dialog deliberately refuses a booking with
nothing owing ("use Force confirm / Confirm pending guests instead"), and do not
hand-write a `Payment` row — a $0 confirm mints its own and `Payment.bookingId`
is unique, so a hand-written row permanently blocks the real one.

Either way, tell the member. Their offer is gone, and their place in the queue is
the outcome they were promised.

### Record a trusted legacy induction baseline (#2361)

`npm run induction:baseline` is a one-off, dry-run-first maintenance command
for a committee-authorised legacy New Member induction baseline. It never
belongs in normal setup or deployment flows. A dry run requires an active,
login-enabled Full Admin actor member ID, one New Zealand date-only baseline
date, and a stable provenance note:

```bash
IFS= read -r ACTOR_MEMBER_ID < /protected/path/actor-member-id
IFS= read -r BASELINE_DATE < /protected/path/baseline-date
IFS= read -r PROVENANCE_NOTE < /protected/path/provenance-note

npm run induction:baseline -- \
  --actor-member-id "$ACTOR_MEMBER_ID" \
  --baseline-date "$BASELINE_DATE" \
  --provenance-note "$PROVENANCE_NOTE"
```

The protected files must pass the runbook's exact one-line validation; embedded
newlines are forbidden. Keep the variables unexported and quoted so club and
provenance text remains literal data rather than executable shell syntax.
Apply additionally requires `--apply` plus the exact `PLAN DIGEST`, club name,
parsed database host, and parsed database name from the reviewed dry-run
report. The digest binds the complete safe plan and is compared after apply
takes the induction table lock and rebuilds that plan, but before the blocker,
no-op, or write branches. A mismatch prints the refreshed safe report, writes
nothing, and requires a fresh dry run. Apply preserves all existing induction
rows, blocks on every eligible Draft or In Progress workflow, and commits the
new rows plus a digest-bearing audit event atomically under a PostgreSQL lock
against direct `MemberInduction` DML. The lock does not freeze the wider member
population or the actor: from the final dry run through the post-apply
verification dry run, pause membership approvals, member creation/import,
group-booking join acceptance/token claims that can create an active `USER`,
changes to the chosen actor's `canLogin`, access roles, or account lifecycle,
induction writes, and member lifecycle writes. These writers are operationally
frozen; the database lock still covers direct `MemberInduction` DML only. See
the full
[trusted legacy induction baseline runbook](INDUCTION_BASELINE_RUNBOOK.md)
before using it. Do not expose `DATABASE_URL` or credentials in an operator
report.

### Reconcile booking and Xero records

`scripts/xero-booking-repair.ts` is a targeted booking/Xero reconciliation
helper. Keep it out of normal setup and deployment flows. Use it only when an
operator needs to inspect or repair known booking-payment/Xero mismatches after
reviewing the affected bookings.

Always start with a dry run:

```bash
npx tsx scripts/xero-booking-repair.ts --dry-run
npx tsx scripts/xero-booking-repair.ts --booking <bookingId> --dry-run
npx tsx scripts/xero-booking-repair.ts --from <YYYY-MM-DD> --to <YYYY-MM-DD> --dry-run
```

`--from`/`--to` are **inclusive club calendar days**, and a booking is swept if
its check-in night, its creation, its last update, or any of its modifications
falls inside them. The report header echoes back the two days you asked for, so
check it against what you typed before reading the findings. Both dates must be
real calendar days: `--to 2026-04-31` is refused rather than quietly read as
1 May, which is what it used to do.

**Reading an archived report from before #2868.** Only the CHECK-IN half of the
window was wrong, and this matters because the error does not go the way the
header suggests. The window was built as midnight in the server's own time zone
and bound unchanged against both the date-only `checkIn` column and the three
timestamp columns beside it. Under the `TZ=Pacific/Auckland` pin, that instant
is the previous UTC day, so for a sweep asked to run 1-31 July the report
actually covered:

- `checkIn` between **30 June and 30 July** inclusive — one day early at both
  ends, so it both missed 31 July check-ins and pulled in 30 June ones; and
- created, last updated, or modified between **1 July 00:00 and 1 August 00:00
  NZ** — that is, exactly the club days that were asked for. **This half was
  correct**, because the server's local midnight IS the start of the club day
  whenever the server is pinned to the club's zone.

The header printed the shifted dates for both, so it understated the coverage of
the second half. Do not read "the window started 30 June" as meaning a booking
CREATED on 30 June was covered — it was not. Re-run any sweep whose check-in
dates mattered; the created/updated/modified findings in an archived report can
be taken at face value.

Only use `--apply` after the dry-run report has been reviewed. Do not run it
with live Xero, Stripe, SES, Sentry, or production database credentials during
exploratory work; use a staging database and Xero demo tenant where possible.
`XERO_AMOUNT_MISMATCH` findings are manual-review only: the tool reports stored
Xero operation/link amount evidence that disagrees with local cents, but it
does not auto-adjust financial amounts. Since #1427,
`MISSING_MODIFICATION_CREDIT_NOTE` and `MISSING_CREDIT_NOTE_ALLOCATION` are
also manual-review (not auto-queued) when the payment captured money and no
stored evidence records the policy-limited settlement — the report tells you
to size the credit note (or confirm the note's total) by hand from the
cancellation-policy history before acting; `--apply` will not touch these.
Since #1491, `LATE_CAPTURE_AFTER_CANCELLATION` is also never auto-applied:
it now fires only when a cancelled booking retains captured value with NO
recorded cancellation-refund decision (no cancellation credit, no
booking-cancel refund recovery operation), which is either a genuine late
capture or a deliberate 0%-tier policy retention. After verifying it is a
genuine late capture, execute exactly that refund with
`--apply --apply-action <actionKey>` (the key is printed next to the planned
action in the human summary and in the JSON report; combine with
`--booking <id>` to keep the rest of the apply run scoped, and note the run
warns about forced keys that matched nothing); if it is a deliberate
retention, leave it. If a multi-slice refund fails partway (one captured
Stripe intent refunds and records, a later one declines), the action reports
`failed`, but the Xero refund credit note is still queued for exactly the
slices that actually refunded — sized from the recorded refund ledger, not the
requested total — so Xero never understates the refund (#1495). Re-run
`--apply-action` with the new, smaller remainder key the report now prints (it
embeds the still-outstanding cents): it refunds only the remainder and queues a
note for exactly that delta under a distinct cumulative-watermark correlation
key, never re-noting the completed slices. Tiered cancels that
deliberately retained a policy penalty produce no finding at all — their
books are correct.

### Backfill cancel-flattened payment statuses (#1473 / #1506)

`scripts/backfill-cancel-flattened-payments.ts` is a one-off, idempotent,
local-only cleanup for the residual left by PR #1489. Before #1489,
`cancelBooking` overwrote every non-SUCCEEDED payment's aggregate `status` to
`FAILED` — including captured `(PARTIALLY_)REFUNDED` payments — while leaving
`refundedAmountCents` and the `PaymentTransaction` ledger intact. #1489 stopped
the overwrite going forward but did not backfill rows already flattened. The
read path is already correct (the booking-vs-Xero repair pass synthesizes the
captured status from the intact STRIPE mirror / ledger), so this only restores
the stored `status` field for cleanliness.

It identifies `FAILED` payments on `CANCELLED` bookings that carry capture
evidence per the exact #1489 discriminator — a captured `PaymentTransaction`
row, or (for pre-ledger STRIPE rows) `refundedAmountCents > 0` — and restores
`status` to the same value the repair pass already derives
(`PARTIALLY_REFUNDED` / `REFUNDED`, or `SUCCEEDED` for a captured-ledger row
with no refund). It deliberately skips folded never-captured internet-banking
payments (mirror refund with no captured ledger row: correctly `FAILED`) and
the narrow unrecoverable residual (no ledger, `refundedAmountCents == 0`: no
truth to restore). It makes ZERO Xero/Stripe calls, touches only `status`, and
a second run finds nothing.

Always start with a dry run (the default) against a non-production copy:

```bash
DATABASE_URL=<non-prod copy> npx tsx scripts/backfill-cancel-flattened-payments.ts
# or: npm run payments:backfill-cancel-flattened
```

Only after reviewing the dry-run report, apply inside a transaction:

```bash
DATABASE_URL=<non-prod copy> npx tsx scripts/backfill-cancel-flattened-payments.ts --apply
```

### Backfill orphaned applied credit (#1547)

`scripts/backfill-orphaned-applied-credits.ts` is a one-off, idempotent,
local-only heal for account credit a member applied to a booking that was never
restored when the booking was cancelled. Before #1547, applying credit to a
booking, abandoning payment, then cancelling left the negative `BOOKING_APPLIED`
`MemberCredit` row on the ledger — the credit was permanently lost, and the
delete guard then blocked deletion on that very row. #1547 fixed the cancel
paths going forward (every branch now restores applied credit); this heals rows
orphaned before the fix.

It detects, per `CANCELLED` booking (including soft-deleted): a `BOOKING_APPLIED`
row with NO matching `CANCELLATION_REFUND` row and (no payment, or a payment
with no capture evidence per the shared discriminator AND an aggregate status
other than `SUCCEEDED`). The absence-of-refund clause excludes healthy restores
and held-as-credit cancels; the capture clause excludes the legitimately
unrestored captured shapes (0%-tier paid cancels and held-credit refunds); the
`SUCCEEDED` clause excludes settlement without cash (a fully-credit-covered $0
payment settles the booking, and its 0%-tier cancel legitimately retains the
credit). Known false negative, conservative by design: a pre-fix orphan whose
cancelled booking later received late cash carries an inbound-minted
`CANCELLATION_REFUND` row that compensates the cash, not the applied credit —
the predicate skips it (a missed heal, never a double restore); such bookings
need manual review. It restores 100% of
the applied credit (ledger truth), writing a `CANCELLATION_REFUND` reversal row,
a critical finance audit row, and a `CREDITED` booking event — each booking in
its own transaction under the member's credit-ledger advisory lock, re-checking
the predicate under that lock so a re-run heals nothing. It makes ZERO
Xero/Stripe/SES calls. The daily credit-reconciliation cron also alerts
(alert-only, no auto-heal) under the tag
`credit-reconciliation:orphaned-applied-credits`; a post-fix hit means a NEW
regression — diagnose before running this script.

Always start with a dry run (the default) against a non-production copy:

```bash
DATABASE_URL=<non-prod copy> npx tsx scripts/backfill-orphaned-applied-credits.ts
```

Only after reviewing the dry-run report, apply (each booking in its own
transaction):

```bash
DATABASE_URL=<non-prod copy> npx tsx scripts/backfill-orphaned-applied-credits.ts --apply
```

### Audit IB hold-expiry invoice under-clears (#1597)

`scripts/audit-ib-hold-clearing.ts` is a READ-ONLY audit — it never writes and
never calls a live provider, and it has no `--apply` by design (owner decision,
2026-07-08). Before #1597, the Internet-Banking hold-expiry release
(`internet-banking-payment-cron.ts`) sized its invoice-clearing credit note at
`payment.amountCents` — the credit-REDUCED effectivePriceCents — while the
booking invoice is raised at the FULL finalPriceCents. Where a released hold
carried an issued invoice AND applied credit, the invoice was left open by
exactly the applied-credit slice. #1597 fixed the sizing going forward (it now
clears `max(0, finalPrice + changeFee − Xero-allocated applied credit)` and skips
entirely when the payment has no issued invoice).

The script scans every released IB hold, mirrors the corrected #1597 formula, and
lists each booking whose clearing note was under-sized: booking id, invoice ref,
expected clearing, actual (enqueued) clearing, and the open delta. It reads only
local rows (no Xero calls); "actual" is `payment.amountCents`, frozen once the
hold released, which is exactly what the pre-fix release enqueued.

```bash
DATABASE_URL=<non-prod copy> npx tsx scripts/audit-ib-hold-clearing.ts
DATABASE_URL=<non-prod copy> npx tsx scripts/audit-ib-hold-clearing.ts --json
```

**The existing `xero-booking-repair.ts` CLI cannot express this repair.** Its
`CANCELLED_BOOKING_OPEN_INVOICE` finding sizes a FULL clearing note
(`getUnpaidCancellationClearingAmountCents` → `max(amountCents − refunded,
finalPrice + changeFee)`) and recognizes only a `MODIFICATION_CREDIT_NOTE`, not
the `REFUND_CREDIT_NOTE` the release already issued — so `--apply` would queue a
full-finalPrice note on top of the partly-cleared invoice and OVER-allocate
(Xero rejects over-allocation, poisoning the op). Repair each finding by hand
instead: issue a supplementary credit note for exactly the reported open delta
against the named invoice, then confirm the invoice reaches a zero balance in
Xero. Do **not** run `xero-booking-repair.ts --apply` on these bookings.

Note: because Internet-Banking bed-holding is off by default
(`DOMAIN_INVARIANTS.md`), and the two hold-slots paths that reach release either
carry no invoice (create-time, skipped by the fix) or already clear the full
finalPrice (switch-to-IB, where `amountCents` equals finalPrice), this audit is
expected to report zero on most tenants. A non-empty result means a hold-slots
booking reached release with both an issued invoice and a credit-reduced
`amountCents` (e.g. an operator-created invoice on a credit-carrying hold).

The same script also prints a second, separate **#1620 applied-credit strand
enumeration** (also read-only): every non-cancelled Internet-Banking payment
whose booking still carries UN-allocated applied credit (a `BOOKING_APPLIED`
ledger row not yet stamped with an allocated Xero note), split into REALIZED
(payment captured — the member already double-paid the full invoice) and PENDING
(not yet paid). CANCELLED bookings are excluded (the #1547 restore domain).
Repair guidance under the #1620 allocate-existing mechanism:

- **PENDING** rows are fixed forward automatically: the applied-credit allocation
  op reduces their already-raised invoice to the effective amount. If a legacy
  PENDING row predates the fix and never got an allocation op, re-running the
  raise path (or re-enqueuing `enqueueXeroAppliedCreditAllocationOperation`)
  allocates it.
- **REALIZED** rows already paid the full invoice in cash, so allocating a credit
  note now would over-pay the invoice. The repair is a LOCAL credit restore for
  the strand amount (a Xero credit note does not refund cash already sent);
  handle by hand per the reported per-row figures.

The same script also prints a third, separate **#1641 card applied-credit
double-pay enumeration** (read-only): every captured (SUCCEEDED) non-Internet-
Banking card payment whose booking still carries UN-allocated applied credit AND
whose mirror shows the pre-fix full-price shape — `creditAppliedCents = 0` and
`amountCents = booking.finalPriceCents`. Before #1641 the card intent was minted at
the full price while the applied credit was consumed at booking-create, so these
members were double-charged by the applied slice. A #1641-fixed card booking is
charged the EFFECTIVE amount with a positive `creditAppliedCents` mirror and its
`BOOKING_APPLIED` rows stamped, so it fails every discriminating clause and never
appears. CANCELLED bookings are excluded (the #1547 restore domain). Every finding
is REALIZED (a card capture already moved cash), so the repair is an operator-
reviewed LOCAL credit restore for the reported per-row amount (a Xero credit note
does not refund cash already captured). Not-yet-captured legacy card intents need no
repair here: the next `create-payment-intent` call supersedes the stale full-price
intent and re-mints at the effective amount.

## Quarterly Backup Restore Drill

A backup you have never restored is a hope, not a backup. `scripts/backup-restore-drill.sh`
is a self-contained fire drill that proves a `pg_dump` artifact can actually be
restored, that Prisma migrations still run forward on the restored data, and
that the restored rows still satisfy the money-in-integer-cents invariants.

The drill produces the same artifact shape as the automated backup pipeline
(`src/lib/backup.ts`): a plain `pg_dump` piped through `gzip` (a `.sql.gz`
file). All work happens in a throwaway Postgres 16 container bound to
`127.0.0.1:55441`. **The drill never connects to production Postgres on port
5432, never fetches from S3, and never reads live provider credentials.**

### When to run it

- Every quarter, as a standing operations task.
- After any change to the backup pipeline (`src/lib/backup.ts`, the backup cron,
  the in-app backup configuration at `/admin/backups`, the database schema, or
  the Postgres major version).
- Any time you need confidence that a specific backup file is restorable.

### Local self-contained mode (default)

No arguments, no production data. The script starts the container, seeds a
source database, dumps it, restores the dump into a second database, runs
`prisma migrate deploy` forward on the restore, and checks every assertion:

```bash
bash scripts/backup-restore-drill.sh
```

Requirements: Docker with the `postgres:16` image available, plus the repo
dependencies installed (`npm ci`). The container is removed on exit even if the
drill fails. The script prints a PASS/FAIL summary suitable for pasting into an
operations log.

### Operator mode with a real backup (`--from-dump`)

Use this to prove that an actual production backup restores. **You** obtain the
dump file first; the script never touches S3 itself.

To fetch a backup safely, use read-only S3 credentials from a workstation (never
the production host) to copy one object out of the backup bucket. The backups
live under the `tacbookings_s3backup/` prefix of the configured bucket. Read the
destination **bucket** and **region** from **Admin → Integrations → Database
Backups** (`/admin/backups`) — since #2095 the backup configuration lives in the
encrypted in-app store, not in `BACKUP_S3_*` environment variables. Use your OWN
read-only S3 credentials (from your operator secret store) rather than the app's
stored write credentials. Set the values as local shell variables and copy a
single `.sql.gz` object to a local scratch path — do not print or paste
credential values, and do not run this on a production host:

```bash
# BUCKET/REGION are read from Admin -> Backups; the AWS creds are your own
# read-only workstation credentials from your operator secret store. Never echo.
aws s3 cp "s3://$BUCKET/tacbookings_s3backup/<backup-file>.sql.gz" \
  /tmp/restore-check.sql.gz --region "$REGION"

bash scripts/backup-restore-drill.sh --from-dump /tmp/restore-check.sql.gz
```

In `--from-dump` mode the source-fidelity comparisons are reported as `SKIP`
(there is no local source to compare against); the sentinel and migration
assertions still run against the restored database. Delete the downloaded dump
when you are done.

### What the assertions prove

- **Restore fidelity** (local mode only): row counts for `Member`, `Booking`,
  `Payment`, `BookingGuest`, and `BookingGuestNight` match the source exactly,
  and `SUM("finalPriceCents")` over `Booking` and `SUM("amountCents")` over
  `Payment` match the source exactly as integers. This proves the dump/restore
  round-trip loses no rows and no cents.
- **Sentinel invariants** (both modes): the restored database has zero `Booking`
  rows with a `NULL` or negative `finalPriceCents` and zero `Payment` rows with a
  `NULL` or negative `amountCents`. This proves the money-in-integer-cents
  invariant survives the round-trip.
- **Migration health** (both modes): after `prisma migrate deploy`, the
  `_prisma_migrations` table has zero rows still in progress (`finished_at IS
  NULL AND rolled_back_at IS NULL`). This proves migrations run forward cleanly
  on top of the restored data.

### On failure

A failing drill is a **backup-pipeline incident**, not a routine test flake:

1. Do **not** overwrite, prune, or re-run the backup job — preserve every
   existing backup artifact as evidence.
2. Capture the full drill summary output.
3. Escalate to the owner before taking any corrective action on the backup
   pipeline. Restoring or repairing production data is an owner-approved,
   high-risk operation.

## Public Reference Release Checklist

Before cutting a public reference release:

1. Create a release-prep branch from fresh `origin/main`.
2. Update `package.json` and `package-lock.json` for the release version, then
   compile the changelog:

   ```bash
   node scripts/release/compile-changelog.mjs 0.14.0 --dry-run   # show the plan
   node scripts/release/compile-changelog.mjs 0.14.0             # write it
   ```

   That adds `## <version> - <date>` to `CHANGELOG.md` from the per-PR fragments
   in `changelog.d/` (plus any entry still written directly under
   `## Unreleased`), deletes the fragments it consumed, and leaves the
   `## Unreleased` heading and its sentinel-marked pointer note in place. Commit
   the compiled `CHANGELOG.md` and the fragment deletions together, then read the
   new section end to end and edit it for order and duplication before pushing —
   `changelog.d/README.md` documents the convention. If the run prints
   `WARNING: unrecognised content left under "## Unreleased"`, resolve that
   first: the text it echoes was neither released nor deleted.
3. Check `README.md`, `DEPLOYMENT.md`, `CONFIGURATION.md`, this maintenance
   guide, and `docs/ARCHITECTURE.md` for dependency, release, GHCR, migration,
   validation, and public/private workflow drift.
4. Confirm any new or changed migrations that touch hot tables or potentially
   breaking SQL are represented in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, or
   document why no ledger entry is needed.
5. Run local release validation without live provider credentials, then rely on
   GitHub Actions for Docker image build, static analysis, secret scanning,
   dependency review, and GHCR publication.
6. After merge, create the annotated release tag on the merged commit and
   publish the GitHub release with validation evidence, migration notes, image
   names, commit SHA, and non-blocking maintainability follow-ups.

## GitHub Actions Availability

If Actions jobs fail before starting, check repository or account billing and
spending limits before treating the failures as code failures.
