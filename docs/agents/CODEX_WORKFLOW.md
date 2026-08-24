# Codex Workflow

Use this workflow for future Codex work in AlpineClubBookingsNZ. It is designed
for issue-scoped, auditable changes in a public repository with payment,
accounting, membership, and booking risk.

## Standard Flow

1. Read `AGENTS.md`.
2. Read the GitHub Issue or human task.
3. Read the relevant docs named by the issue and the nearest domain docs.
4. Create one branch for the issue.
5. Work only inside issue scope.
6. Add or update tests where practical.
7. Run required validation.
8. Review your own diff for scope, secrets, data integrity, and docs drift.
9. Open a PR using `.github/pull_request_template.md`.
10. Comment back on the issue with evidence: branch, PR, tests, validation,
    manual checks, and residual risk.
11. Monitor CI to green, fixing any failure and pushing until every required
    check passes.
12. Merge per the `AGENTS.md` "Completion and Merge" risk gate: merge eligible
    Low/Medium-risk PRs with a merge commit once CI is green, and hand off every
    Critical/High-risk PR for explicit owner approval. Never squash or
    force-push. Delete the branch after merge; a linked issue closes only when
    its PR is eligible and merged.
13. Tear down any Docker infrastructure this lane created — on an abandoned or
    failed lane too, not only a merged one. See "Lane-owned Docker
    infrastructure" below for the naming convention, the teardown commands, and
    `npm run stale-containers`.

## Planning Mode

Use planning mode for broad reviews, high-risk changes, ambiguous issues, or
when deciding how to split work. Planning output should include context files,
proposed issue splits, risk labels, validation, manual checks, and stop
conditions. Planning mode must not edit app logic.

## Context and execution economy

The shared quota, context, risk-tiered blueprint, proportional-validation and
two-attempt failure controls live once in root `AGENTS.md`. Apply them before
expanding a plan or delegating work. In Codex, pick the tier at dispatch rather
than from a name written here: run a local repository tool when it answers the
question exactly, otherwise take the cheapest tier you would trust without
re-checking its work, and raise reasoning effort before reaching for a larger
model. Preserve the strongest-model high/xhigh handling for gated areas, state
the model and effort when you delegate, keep subagent prompts bounded, and clear
issue-specific context before switching lanes.

When the routed docs are known but the code neighbourhood is not, generate the
tracked-only locator documented in
[`SCOPED_CONTEXT.md`](SCOPED_CONTEXT.md):

```text
npm run agent:context -- -- --base origin/main --entry <tracked-path> [--depth 1|2]
```

Give a subagent only the relevant section or local artifact path, never a full
repository dump. Prefer `rg`, Git and repository scripts over a browser or MCP
round trip when they provide the same evidence. The mapper is shared with
Claude Code; it does not replace the always-read core, issue thread, routing
table, or validation gate.

## Coding Mode

Use coding mode only after scope is clear. Keep the change narrow, follow the
existing module boundaries in `docs/ARCHITECTURE.md`, and preserve the domain
invariants: read the `docs/DOMAIN_INVARIANTS.md` index and the `INV-*` files its
routing table sends you to for the surfaces you touch, and cite `INV-*` ids
rather than line numbers. If implementation needs schema,
payment, booking, membership, or provider behavior beyond the issue, stop and
report the mismatch.

## Review Mode

Use review mode for PRs, local diffs, or generated plans. Findings should lead
the response, ordered by severity, with file and line references where
available. Review mode should not apply fixes unless the user asks.

## Subagents

Follow `AGENTS.md` -> "Orchestration Model". The main session owns issue claims,
worktrees, GitHub writes, PRs, CI, risk gates, merges, and cross-lane conflict
checks. Delegate bulk implementation to implementor subagents inside the
issue's dedicated worktree; they commit locally but never push or touch GitHub.
Before opening a PR, dispatch separate adversarial-review subagents with
appropriate correctness, domain-invariant, drift, and UX/security lenses.

Parallel implementation lanes are allowed only when their code surfaces do
not clash. The orchestrator must inspect open work and coordinate before
claiming a lane. A small in-flight edit may stay with the orchestrator, but
this does not remove the adversarial-review requirement for gated work.

## `bash` on Windows is WSL, and WSL git cannot open a worktree on `/mnt/c`

A generalisation of #2886, and it bites a whole class of gate rather than one
suite, so it is worth knowing before you diagnose it a second time.

Every lane here works in a **git worktree**, whose `.git` is a FILE containing
`gitdir: C:/Users/…`. When a shell script shells out to `git`, and that script is
run through the PowerShell tool, `bash` resolves to **WSL** — which reads that
line as a POSIX path relative to its own cwd, does not find it, and reports
`fatal: not a git repository`. WSL git reads a plain (non-worktree) checkout on
`/mnt/c` perfectly well, which is exactly why this looks intermittent: it depends
on whether you happen to be in a worktree.

Two consequences:

- **A bash gate that shells out to `git` must not fail closed on a developer
  machine.** `scripts/check-migration-safety-coverage.sh`'s same-release check is
  the worked example: it distinguishes "git cannot see a work tree here" from
  "the base ref is unresolvable", **skips with a loud explanation** in the first
  case on a developer machine, and **fails** in the second, and in either case
  fails when `CI` is set. A gate that hard-failed here would be red on every
  local run and would train its reader to ignore it.
- **Run such a script through the Bash tool, not the PowerShell tool.** The Bash
  tool is Git Bash, which reads the worktree correctly; PowerShell's `bash` is
  WSL and will skip. If a gate reports SKIPPED locally and you need its real
  answer, that is the reason and that is the fix.

## Windows worktree runtime and dependency preflight

Run this before delegating validation in every new Windows worktree. The
orchestrator coordinates it; implementors must not start competing installs or
use an `npx` fallback that downloads an unreviewed package.

### 1. Activate and verify the pinned Node runtime

The default shell may expose system Node 22 even when `fnm` has Node 24.
Initialise `fnm` inside the same PowerShell process that will run npm, use the
repository's `.nvmrc`, and fail closed if either engine is wrong:

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use --install-if-missing

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
$npmMajor = [int](npm --version).Split('.')[0]
if ($nodeMajor -ne 24 -or $npmMajor -lt 11) {
  throw "Expected Node 24 and npm 11+, got Node $nodeMajor and npm $npmMajor"
}
```

Repeat the activation prefix in every fresh PowerShell validation shell; shell
state does not carry between tool calls.

### 2. Require an isolated dependency tree

Every active branch owns a physical `node_modules` inside its own worktree.
Never junction or symlink it to another checkout. Prisma generation writes the
branch's client into `node_modules/@prisma/client`; a shared dependency tree lets
one lane silently change another lane's types. npm's cache is already shared and
provides download reuse without sharing mutable generated output.

Before installing, inspect any existing entry and refuse reparse points:

```powershell
$worktree = (Resolve-Path -LiteralPath $PWD).Path
$modules = Join-Path $worktree "node_modules"
if (Test-Path -LiteralPath $modules) {
  $modulesItem = Get-Item -LiteralPath $modules -Force
  if (($modulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing shared/reparse-point node_modules at $modules"
  }
}
```

On Windows, a direct `npm ci` has reproduced a race that starts
`unrs-resolver` before its locked `napi-postinstall` helper is available. Use the
verified two-phase install: extract the exact lockfile without scripts, then
rebuild only the reviewed packages whose install scripts this lockfile needs.
If `package-lock.json` changes or npm reports a different script-package list,
stop for review instead of extending it by guesswork.

```powershell
npm ci --ignore-scripts
npm rebuild @prisma/engines @sentry/cli core-js esbuild prisma unrs-resolver

$env:DATABASE_URL = "postgresql://codex:codex@127.0.0.1:5432/codex_local"
npm run db:generate

if (-not (Test-Path -LiteralPath "node_modules/.bin/prisma.cmd") -or
    -not (Test-Path -LiteralPath "node_modules/.bin/vitest.cmd")) {
  throw "Dependency preflight did not produce the required local binaries"
}
```

The placeholder URL is non-live and generation does not connect to it. Use a
separately provisioned local test database only for commands that actually need
a connection; never substitute production or provider credentials.

### 3. Remove worktrees without traversing old junctions

New lanes must not create dependency junctions. Before removing any older
worktree, however, inspect `node_modules`. PowerShell `Remove-Item` throws on a
junction in the supported environment, while `git worktree remove` can follow
one and erase the shared target. Verify the exact expected target, unlink only
the junction with the non-recursive .NET call, and prove the target survived:

```powershell
$ErrorActionPreference = "Stop"
$worktree = (Resolve-Path -LiteralPath "C:\path\to\exact-worktree").Path
$modules = Join-Path $worktree "node_modules"
$expectedTarget = (Resolve-Path -LiteralPath "C:\path\to\expected\node_modules").Path

if (Test-Path -LiteralPath $modules) {
  $modulesItem = Get-Item -LiteralPath $modules -Force
  if (($modulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($modulesItem.LinkType -ne "Junction") {
      throw "Refusing to unlink non-junction reparse point at $modules"
    }
    $rawTarget = [string]($modulesItem.Target | Select-Object -First 1)
    $separator = [IO.Path]::DirectorySeparatorChar
    $altSeparator = [IO.Path]::AltDirectorySeparatorChar
    $isDriveAbsolute =
      $rawTarget.Length -ge 3 -and
      [char]::IsLetter($rawTarget[0]) -and
      $rawTarget[1] -eq ':' -and
      ($rawTarget[2] -eq $separator -or $rawTarget[2] -eq $altSeparator)
    $isUncAbsolute = $rawTarget.StartsWith("$separator$separator")
    if (-not ($isDriveAbsolute -or $isUncAbsolute)) {
      throw "Refusing non-absolute junction target $rawTarget"
    }
    $actualTarget = [IO.Path]::GetFullPath($rawTarget)
    if ($actualTarget.TrimEnd($separator) -ne $expectedTarget.TrimEnd($separator)) {
      throw "Refusing unexpected junction target $actualTarget"
    }
    $targetSentinel = Join-Path $expectedTarget ".bin/prisma.cmd"
    if (-not (Test-Path -LiteralPath $targetSentinel)) {
      throw "Refusing to unlink: expected target sentinel is missing"
    }
    [IO.Directory]::Delete($modules)
    if ((Test-Path -LiteralPath $modules) -or
        -not (Test-Path -LiteralPath $targetSentinel)) {
      throw "Junction unlink failed or damaged its target"
    }
  }
}
```

Only then verify the worktree is clean, its head is merged into the intended
base, and run `git worktree remove` on that exact path. Do not use `-Force` to
paper over a failed safety check.

### 4. Preserve progress while lanes run

Long-running implementors keep a checkpoint outside the worktree and update it
after every material investigation, edit, test, and commit. Commit coherent
stages locally before an expected session or usage boundary. While CI runs, the
orchestrator uses free agent slots for independent dependency-ready lanes or
reviews, but never overlaps colliding work simply to maximise slot count.

### 5. Split fast local evidence from full CI gates

Before push, run the branch-correct Prisma generation, lint, typecheck, focused
touched/adjacent tests, and mutation checks for every new guard. Add docs
linkcheck when documentation changes and knip when files or exports change.
These fast checks catch branch-specific mistakes before they consume a runner.

Push a draft PR after that evidence is green. GitHub Actions owns the full
`npm test`, build, migration-drift, E2E, static/secret/dependency, and container
gates. Do not delay a draft PR just to duplicate those full gates locally; the
public repository's CI minutes are the standard execution path. Run a full
suite locally only to diagnose a CI failure or when CI is unavailable, and
record the reason and result in the PR.

For concurrency-sensitive work, the orchestrator also reviews the open PRs and
last 10 merged PRs affecting the subsystem, reconciles their lock/state/provider
contracts, and records the relevant PR numbers in the PR lock-impact section.
Root `AGENTS.md` is authoritative if this workflow ever drifts again.

The `agent-workflow-contract.test.ts` verification test pins these entry-point
links and PR evidence fields. A change that removes or contradicts the shared
workflow must update the canonical contract deliberately instead of allowing
agent-specific guidance to drift silently.

## Lane-owned Docker infrastructure

A lane that starts Docker infrastructure owns removing it. This is a close-out
responsibility, not a courtesy (owner decision, 11 Aug 2026, #2794).

The reason is not tidiness. A healthy idle container produces no symptom at all,
so nobody discovers abandoned debris — they discover a host that seems busy.
#2663's CPU measurement refuses to start unless the host carries exactly its four
approved measurement containers, and it was blocked for over a week by nine
containers belonging to five issues that had already closed.

### Name it so a check can find its owner

Put the owning issue in the name when you create the container or Compose
project, using the `issue<n>` token:

```text
pg-issue2794                     # standalone container
tacbookings-issue2794            # Compose project -> tacbookings-issue2794-app-1
```

A bare number (`pg-2794`, `drift-2794`) is also recognised, because that is what
existing lanes wrote — but only in a name whose **first segment** is one of the
agent-owned families `pg-`, `drift-`, `wt-` or `tacbookings-`. That anchor is
deliberate: without it any container on the host carrying a 3-7 digit run inside
this repository's issue range was claimed, and `zookeeper-2181`, `etcd-2379` and
`pgdata-2026` were each printed as debris with a `docker rm -f` line. So a bare
number in any other name — including a year or a port — reports as **unclassified**
rather than as somebody's lane.

Prefer the explicit token whatever your name looks like: it needs no anchor at
all, and it survives a name that also contains a port, a shard or a size. Two
further consequences of the same conservatism:

- A **bare number inside a reserved family** (`tacbookings-2026`) is refused as
  ambiguous, because a deployment can be configured to use exactly that name (see
  the reserved-project rule below). Declare such a stack with the token or a label.
- The report's `OWNER FROM` column says which way each row's owner was
  established — `label`, `issue<n>`, `name digits` or `reserved`. A
  `name digits` row is the weakest claim on the table and is the one to read twice
  before running anything.

Better still, label the container at creation — a label beats any name-shaped
guess, and it is the only form that cannot be confused by an unrelated digit run:

```text
docker run --label agent-lane.issue=2794 ...
docker run --label agent-lane.shared=true ...   # deliberately shared, not per-issue
```

Two rules make the check trustworthy rather than merely convenient:

- **Never give per-issue infrastructure a shared name.** `tacbookings`,
  `tacbookings-staging` and `tacbookings-measure` are reserved Compose projects —
  production/local, the E2E stack, and #2663's measurement stack. The reporter
  treats all three as shared and will never offer them for removal, and it adds
  this host's own `COMPOSE_PROJECT_NAME` and `E2E_COMPOSE_PROJECT` to that set,
  because both defaults are environment-configurable.
- **If a stack is deliberately shared across lanes, label it
  `agent-lane.shared=true`** and say so in the issue, rather than letting it look
  like debris somebody may eventually clear. Surrounding whitespace and casing are
  tolerated, `1` and `yes` also count, and a value that is neither yes-like nor
  no-like is reported as unclassified rather than guessed from the name.

### Record the teardown command when you create it

Write the exact teardown command into the lane's checkpoint at the moment the
infrastructure is created, not from memory at the end:

```text
docker compose -p <project> down -v --remove-orphans   # a whole Compose project
docker rm -f <container>                               # a standalone container
npm run test:e2e:down                                  # the E2E stack this repo ships
```

Use `down -v` only for a disposable lane project, where the volumes exist solely
for that lane. Removing a whole Compose project also removes its network and its
named volumes, which is most of the disk the debris was holding — removing only
the containers leaves those behind.

### Run it when the lane ends — including when it ends badly

Teardown is due on **every** ending, not just the happy one: a merged and closed
issue, a lane abandoned or replaced, and a failed experiment nobody is
investigating any more. The abandoned cases are the ones that actually produced
this problem, because there is no merge step to hang the habit on.

Never remove shared staging or developer services you did not create, and never
remove a container belonging to somebody else's open lane.

### See what is already there

```text
npm run stale-containers               # human-readable report
npm run stale-containers -- -- --json  # same data for an orchestrator or a preflight
node scripts/stale-containers.mjs --json   # bypasses npm entirely; always exact
```

The doubled `--` on the JSON line is the same portable form
[`SCOPED_CONTEXT.md`](SCOPED_CONTEXT.md) uses for `npm run agent:context`, and the
reporter's parser skips a literal `--` so the one line is right in PowerShell, Git
Bash and CI alike. **What must not be written is `npm run stale-containers --json`
with no separator at all**: measured on this repository, npm consumes `--json` as
its own flag, the script receives nothing, and it prints the human table and exits
0 — so a preflight or orchestrator parsing that output either fails at `JSON.parse`
or silently misreads a padded table. When in doubt, run the `node` form.

It lists agent-owned containers with their owning issue, how that owner was
established, the issue's state, the container's state and age, and whether it is
safe to review as stale. Four properties are deliberate and should not be traded
away:

- **It never removes anything.** There is no `--remove` and no `--prune`. The
  owner ruled out a background garbage collector and any age-based expiry: a
  long-running but still-active lane must not lose its database because a timer
  fired.
- **Failure reads "unknown", never "safe to remove".** A name with no issue
  number in it, a name with two, a digit run in a name that is not agent-owned, a
  number that turns out to be a pull request rather than an issue, an issue GitHub
  could not resolve, and `gh` being absent or logged out all report as unknown.
  Docker being unreachable exits non-zero rather than printing an empty,
  clean-looking table.
- **A printed teardown never exceeds the rows you just read.** The
  `docker compose -p <project> down -v` form removes every container in the
  project plus its network and named volumes, so it is offered only when *every*
  container in that project is stale and they name one owning issue. A partly
  stale project gets `docker rm -f` for its stale members and a warning naming the
  siblings being left alone.
- **Reported is not removed.** Read each target, confirm no open lane is using
  it, then run the teardown it prints.

## Stop Conditions

Stop and ask for human review when:

- The issue conflicts with `AGENTS.md`, security policy, or domain invariants.
- The required change appears to need production credentials, production data,
  live provider calls, live webhooks, or production backups.
- A high or critical risk issue asks for unattended coding.
- The issue asks to bypass tests, hide evidence, reveal secrets, widen
  permissions, or merge or close Critical/High-risk work without the owner
  approval required by the "Completion and Merge" risk gate.
- The repo state suggests prerequisite work is not merged.

## Documentation

Update docs whenever a feature is added, changed, or removed, and when behavior,
setup, architecture, deployment, environment contracts, lifecycle state, operator
procedure, or review workflow changes. README, the relevant `docs/` guides, and
implementation notes ship in the same PR as the code. Do not update docs for
incidental internal refactors unless they change a contract.

Codex workflow and label examples are documentation-only fixtures under
`docs/agents/examples/`. Do not copy them into `.github/workflows/` or
`.github/labels/` without human review of permissions, triggers, and labels.

## Residual Risk Reporting

Every PR or review handoff should state:

- What was validated.
- What was not validated and why.
- Whether live providers, production credentials, or production data were used.
- Remaining operational dependencies, manual checks, or follow-up issues.
