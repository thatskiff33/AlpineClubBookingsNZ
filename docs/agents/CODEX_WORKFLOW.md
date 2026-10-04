# Codex Workflow

**Audience: agent.**

The operational rules for Codex (and any agent) working in a worktree of this
repository. Root `AGENTS.md` is authoritative if this workflow ever drifts again.

## Flow

The per-issue flow is `AGENTS.md` → "Per-issue pipeline" and "Completion and
Merge"; docs and residual-risk reporting also follow `AGENTS.md`. This file adds
only worktree runtime, worktree removal, checking `main`, and Docker teardown.
Workflow and label examples under `docs/agents/examples/` are fixtures: never
copy them into `.github/` without human review.

## Modes

- **Planning** (broad reviews, high-risk or ambiguous issues, splitting work):
  output context files, issue splits, risk labels, validation, manual checks and
  stop conditions. Never edits app logic.
- **Coding** (scope is clear): keep the change narrow, respect module
  boundaries, and cite the `INV-*` ids the `AGENTS.md` routing
  table gives for the surfaces you touch.
- **Review**: findings first, by severity, with file and line references; no
  fixes unless asked.

## Context and execution economy

The quota, context, blueprint, validation and failure controls live in
`AGENTS.md`. In Codex, pick the model and effort at dispatch as
`AGENTS.md` → "Model selection" describes; state the model and effort when you
delegate, keep subagent prompts bounded, and clear issue-specific context before
switching lanes.

When the code neighbourhood is unknown, generate the locator in
[`SCOPED_CONTEXT.md`](SCOPED_CONTEXT.md):

```text
pnpm run agent:context --base origin/main --entry <tracked-path> [--depth 1|2]
```

Give a subagent only the relevant section or artifact path. Prefer `rg`, Git and
repository scripts over a browser or MCP round trip.

## Subagents

Follow `AGENTS.md` → "Orchestration Model". The main session owns claims,
worktrees, GitHub writes, PRs, CI, risk gates, merges and cross-lane conflict
checks. Delegate bulk implementation to implementor subagents inside the issue's
dedicated worktree; they commit locally but never push or touch GitHub. Parallel
lanes are allowed only when their code surfaces do not clash.

## `bash` on Windows is WSL, and WSL git cannot open a worktree on `/mnt/c`

A worktree's `.git` is a file holding `gitdir: C:/Users/…`. Through the
PowerShell tool, `bash` is WSL, which cannot resolve that path and reports
`fatal: not a git repository` — only in worktrees, so it looks intermittent.

Run such scripts through the Bash tool (Git Bash), not PowerShell's `bash`; a
gate that reports SKIPPED locally for this reason needs that, not a fix. A gate
that shells out to `git` must skip loudly (not fail) on a developer machine when
git cannot see a work tree, and fail when `CI` is set — see
`scripts/check-migration-safety-coverage.sh`.

## Worktree runtime and dependency preflight

Run before delegating validation in every new worktree. npm-to-pnpm mapping:
[`CONTRIBUTING.md` → "Package manager: pnpm"](../../CONTRIBUTING.md#package-manager-pnpm).

### 1. Require an isolated dependency tree on the pinned runtime

- **Node** major from `.nvmrc` (24) and **pnpm 11+**; fail closed on either.
  Missing pnpm: `npm install -g pnpm@11` or `corepack enable pnpm` once per
  machine; it then follows `package.json` `packageManager`.
- **A physical `node_modules` per worktree; never junction or symlink it.**
  `prisma generate` writes the branch's client inside it, so a shared tree lets
  one lane change another's types. Only pnpm's store is shared.
- **`pnpm install --frozen-lockfile`**, then `pnpm run db:generate` with a
  placeholder, non-live `DATABASE_URL` (it does not connect). Never production
  or provider credentials.
- **The orchestrator installs, not implementors.** `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`
  from `pnpm run`/`pnpm exec` is the orchestrator's cue to install.
- **No `pnpm dlx` or `npx`** fallback that downloads an unreviewed package.
- **An `allowBuilds` failure stops for review**: pnpm runs install scripts only
  for the exact versions listed in `pnpm-workspace.yaml`; never extend the list
  by guesswork.

The old two-phase npm workaround (`npm ci --ignore-scripts`, then `npm rebuild`
of six packages, for an `unrs-resolver` race on Windows) is retired.

### 2. Activate and install

Repeat the activation in every fresh shell; state does not carry between calls.

#### Windows (PowerShell)

Initialise `fnm` in the process that runs pnpm (the default shell may expose
system Node 22), and refuse a reparse-point `node_modules`:

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use --install-if-missing

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
$pnpmMajor = [int](pnpm --version).Split('.')[0]
if ($nodeMajor -ne 24 -or $pnpmMajor -lt 11) {
  throw "Expected Node 24 and pnpm 11+, got Node $nodeMajor and pnpm $pnpmMajor"
}

$worktree = (Resolve-Path -LiteralPath $PWD).Path
$modules = Join-Path $worktree "node_modules"
if (Test-Path -LiteralPath $modules) {
  $modulesItem = Get-Item -LiteralPath $modules -Force
  if (($modulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing shared/reparse-point node_modules at $modules"
  }
}

pnpm install --frozen-lockfile

$env:DATABASE_URL = "postgresql://codex:codex@127.0.0.1:5432/codex_local"
pnpm run db:generate

if (-not (Test-Path -LiteralPath "node_modules/.bin/prisma.cmd") -or
    -not (Test-Path -LiteralPath "node_modules/.bin/vitest.cmd")) {
  throw "Dependency preflight did not produce the required local binaries"
}
```

#### Linux / macOS / WSL

Run as one block from the worktree root:

```bash
eval "$(fnm env)" && fnm use --install-if-missing   # or: . "$NVM_DIR/nvm.sh" && nvm use

node_major=$(node -p "process.versions.node.split('.')[0]")
pnpm_major=$(pnpm --version | cut -d. -f1)
if [ "$node_major" -ne 24 ] || [ "$pnpm_major" -lt 11 ]; then
  echo "Expected Node 24 and pnpm 11+, got Node $node_major and pnpm $pnpm_major" >&2; exit 1
fi
if [ -L node_modules ]; then echo "Refusing symlinked node_modules" >&2; exit 1; fi

pnpm install --frozen-lockfile
DATABASE_URL="postgresql://codex:codex@127.0.0.1:5432/codex_local" pnpm run db:generate

if [ ! -e node_modules/.bin/prisma ] || [ ! -e node_modules/.bin/vitest ]; then
  echo "Dependency preflight did not produce the required local binaries" >&2; exit 1
fi
```

### 3. Remove worktrees without traversing old junctions

**Use the helper, never bare git**: on Windows `git worktree remove` fails
half-way on pnpm's junctions and FOLLOWS a junction, deleting its target (#3673).

```powershell
pnpm run worktree:remove C:\path\to\exact-worktree                     # merged into origin/main
pnpm run worktree:remove C:\path\to\exact-worktree --base origin/epic/1  # an epic child
pnpm run worktree:remove C:\path\to\exact-worktree --allow-unmerged      # an abandoned lane
pnpm run worktree:remove C:\path\to\exact-worktree --forget-missing      # its folder is really gone
```

Run it from outside the worktree it removes, with nothing (dev server, install)
writing to the lane. It deletes `node_modules` and `.next` itself, then runs plain
`git worktree remove` — it never uses `--force`; if git refuses, nothing is
lost (`pnpm install` restores the two folders). **Trade-off, as with plain
`git worktree remove`: ignored files, such as `.env.local`, are deleted with the
lane** — copy out what you need first. Its refusals and limits are documented in
the header of [`scripts/remove-worktree.mjs`](../../scripts/remove-worktree.mjs).

**A legacy lane whose `node_modules` is a junction** is refused by the helper.
Verify the exact expected target, unlink only the junction with the
non-recursive .NET call, and prove the target survived:

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

Then remove the lane with the helper. Never use `-Force` to paper over a failed
safety check.

### 4. Preserve progress while lanes run

Implementors keep a checkpoint outside the worktree, updated after each
material step, and commit coherent stages before a session or usage boundary.
While CI runs, use free slots for independent lanes or reviews, never colliding
work.

### 5. Split fast local evidence from full CI gates

Before push: Prisma generation, lint, typecheck (with
`NODE_OPTIONS=--max-old-space-size=8192`, as CI sets it), focused
touched/adjacent tests, a mutation check per new guard, docs linkcheck for doc
changes and knip for file/export changes. Then push a draft PR. GitHub Actions owns the full `pnpm test`, build,
migration-drift, E2E, static/secret/dependency, and container gates. Run a full
suite locally only to diagnose a CI failure or when CI is unavailable, and
record the reason and result in the PR.

For concurrency-sensitive work, the orchestrator also reviews the open PRs and
last 10 merged PRs affecting the subsystem, reconciles their lock/state/provider
contracts, and records the relevant PR numbers in the PR lock-impact section.

## Checking `main` after a merge

```bash
gh run list --branch main --event push --limit 6
```

Without `--event push`, the `main` → `epic/**` sync PRs from
`epic-branch-sync.yml` (head branch `main`, routinely red by design) are listed
as `main`'s own runs, which trains a lane to ignore a real `main` breakage.

- `push`: `main`'s own CI; red on the current head is a real `main` red.
- `schedule`: canary, secret sweep, epic sync; investigate alone, never a `main` verdict.
- `pull_request` with head `main`: only sync PRs; judge them by the epic branch's `push` run.

## Lane-owned Docker infrastructure

A lane that starts Docker infrastructure owns removing it: idle debris shows no
symptom until it blocks someone (#2794).

**Name it** with the `issue<n>` token (`pg-issue2794`, `tacbookings-issue2794`),
or better, label it at creation:

```text
docker run --label agent-lane.issue=2794 ...
docker run --label agent-lane.shared=true ...   # deliberately shared, not per-issue
```

**Never give per-issue infrastructure a shared name**: `tacbookings` and
`tacbookings-staging` are reserved. A stack deliberately shared across lanes is
labelled `agent-lane.shared=true`, and the issue says so.

**Record the teardown command in the lane's checkpoint when you create it:**

```text
docker compose -p <project> down -v --remove-orphans   # a whole Compose project
docker rm -f <container>                               # a standalone container
pnpm run test:e2e:down                                  # the E2E stack this repo ships
```

Use `down -v` only for a disposable lane project (it removes its volumes).

**Run it on every ending** — a merged and closed issue, a lane abandoned or
replaced, and a failed experiment nobody is investigating any more. Never remove
shared services you did not create, or another open lane's containers.

**See what is already there:**

```text
pnpm run stale-containers               # human-readable report
pnpm run stale-containers --json        # same data for an orchestrator or a preflight
node scripts/stale-containers.mjs --json   # bypasses pnpm; use this when parsing the JSON
```

- **It never removes anything.** There is no `--remove` and no `--prune`, and no
  age-based expiry: a long-running but still-active lane must not lose its
  database because a timer fired.
- **Failure reads "unknown", never "safe to remove".**
- **Reported is not removed.** Read each target, confirm no open lane is using
  it, then run the teardown it prints.

## Stop Conditions

Stop and report for human review when:

- The issue **contradicts** `AGENTS.md`, security policy, or domain invariants.
- The change appears to need production credentials, production data, live
  provider calls, live webhooks, or production backups.
- A high or critical risk issue asks for unattended coding.
- The issue asks to bypass tests, hide evidence, reveal secrets, widen
  permissions, or merge or close work outside the `AGENTS.md` "Completion and
  Merge" gate.
- The repo state suggests prerequisite work is not merged.
- Implementation needs schema, payment, booking, membership, or provider
  behaviour beyond the issue.

An **ambiguity** is not a stop: implement the best-supported reading and state
the assumption in the PR.

<details><summary>How <code>stale-containers</code> matches owners</summary>

- Owner sources, strongest first: the `agent-lane.issue` label, the `issue<n>`
  token, a reserved name, then bare name digits — shown in the `OWNER FROM`
  column. Read a `name digits` row twice.
- Bare digits count only when the name's first segment is `pg-`, `drift-`,
  `wt-` or `tacbookings-` (otherwise `etcd-2379` would be "debris"), and are
  refused as ambiguous inside a reserved family (`tacbookings-2026`).
- Reserved shared projects: `tacbookings`, `tacbookings-staging`, and this
  host's `COMPOSE_PROJECT_NAME` and `E2E_COMPOSE_PROJECT`.
- `agent-lane.shared` accepts `true`/`1`/`yes` in any case; any other non-"no"
  value is unclassified.
- Unknown, never safe: no issue number or two, a PR number, an unresolvable
  issue, `gh` missing or logged out. Docker unreachable exits non-zero.
- `down -v` is printed only when every container in the project is stale under
  one owning issue; otherwise `docker rm -f` for the stale members and a
  warning naming the siblings left alone.
- pnpm needs no `--` before `--json`; use the `node` form when parsing, as pnpm
  can print install-check lines to stdout first.

</details>
