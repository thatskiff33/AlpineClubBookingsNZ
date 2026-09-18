#!/usr/bin/env node
/**
 * Report agent-owned Docker debris: containers whose owning issue is closed.
 *
 *   npm run stale-containers                  # human-readable report
 *   npm run stale-containers -- -- --json     # portable in PowerShell, bash and CI
 *   node scripts/stale-containers.mjs --json  # bypasses npm entirely; always exact
 *
 * The doubled `--` is the form `npm run agent:context` is documented with, and
 * `parseArguments` skips a literal `--` so one line works in every shell. Do NOT
 * write `npm run stale-containers --json` with no separator: measured, npm
 * consumes `--json` as its own flag, the script receives nothing, and it prints
 * the human table and exits 0 — which a JSON consumer reads as either a parse
 * error or, worse, a padded table it half understands.
 *
 * ## Why this exists (#2794)
 *
 * Agent lanes create disposable Postgres containers and whole local E2E stacks.
 * A healthy idle container produces no symptom at all, so nobody discovers the
 * debris — they discover a host that seems busy. #2663's CPU measurement refuses
 * to run unless the host carries exactly its four approved measurement
 * containers, and it kept failing against containers belonging to work that had
 * been closed for over a week.
 *
 * The owner's decision (11 Aug 2026) was visibility plus lane-owned teardown,
 * explicitly NOT a background garbage collector and explicitly NOT an age-based
 * expiry: a long-running but still-active lane must never lose its database
 * because a timer fired.
 *
 * ## This command never removes anything
 *
 * There is no `--remove`, no `--prune`, no `--force`. It reads `docker ps -a`,
 * reads issue state through the repository's existing `gh` boundary, prints what
 * it found, and exits. The teardown commands it prints are for a human or an
 * orchestrator to run deliberately, against targets they have read.
 *
 * ## The one rule that matters: failure reads "unknown", never "safe to remove"
 *
 * Every path that cannot establish BOTH "this is agent-owned per the naming
 * convention" AND "its owning issue is closed" lands in `unknown`. That covers a
 * name with no issue number in it, a name with two, a digit run in a name that is
 * not agent-owned, a number that turns out to be a pull request rather than an
 * issue, an issue `gh` could not resolve, and `gh` being absent or logged out
 * entirely. If Docker itself cannot
 * be reached the command exits non-zero rather than printing an empty, clean
 * looking table — silence must never be mistaken for a clean host.
 *
 * ## Naming convention
 *
 * Documented in `docs/agents/CODEX_WORKFLOW.md` -> "Lane-owned Docker
 * infrastructure". Summary of what this file implements:
 *
 *   1. RESERVED projects are shared infrastructure and are never debris,
 *      whatever their name looks like. Checked first, before anything else, and
 *      read from this host's environment as well as from the defaults.
 *   2. An explicit `agent-lane.shared=true` label also means shared.
 *   3. An explicit `agent-lane.issue=<n>` label is authoritative when present.
 *   4. Otherwise the issue number is read out of the Compose project name (for a
 *      Compose-managed container) or the container name (for a standalone one),
 *      by the conservative extraction in `extractIssueNumber` below — and only
 *      when that name belongs to an agent-owned family
 *      (`AGENT_OWNED_PREFIXES`). A digit run in somebody else's container name
 *      establishes nothing.
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { fetchIssueState } from "./lib/github-cli.mjs";

/**
 * Compose projects that are shared infrastructure, never per-issue debris.
 *
 * `tacbookings` is the production/local compose project (`docker-compose.yml`)
 * and `tacbookings-staging` is the E2E stack's default project
 * (`E2E_COMPOSE_PROJECT` in `scripts/e2e-stack.sh`). Reporting either as
 * removable debris would be the worst possible failure of this tool, so the
 * check runs before issue extraction and matches the project name exactly
 * rather than by prefix.
 *
 * `tacbookings-measure` — #2663's measurement stack, the very stack this tool
 * was written to stop blocking — was a third reserved name here until the
 * `measurement/` tree was removed whole by #3382. That Compose project's own
 * definition no longer exists anywhere in this repository, so it can never be
 * created again and the reservation protected nothing left to protect.
 *
 * These are the DEFAULTS only. Every one of them is environment-configurable, so
 * see `reservedProjects` below — a hard-coded list on its own left the shared
 * stack unprotected under any non-default name.
 */
export const RESERVED_PROJECTS = new Set(["tacbookings", "tacbookings-staging"]);

/** Environment variables a deployment uses to name its Compose project. */
const RESERVED_PROJECT_ENV_KEYS = ["COMPOSE_PROJECT_NAME", "E2E_COMPOSE_PROJECT"];

/**
 * The reserved set for THIS environment: the defaults plus whatever this host
 * has configured.
 *
 * `docker-compose.yml` uses `${COMPOSE_PROJECT_NAME:-tacbookings}`,
 * `scripts/e2e-stack.sh` uses `${E2E_COMPOSE_PROJECT:-tacbookings-staging}`,
 * `CONFIGURATION.md` documents `COMPOSE_PROJECT_NAME` as configurable with
 * "defaults vary by script", and `scripts/run-production-blue-green-deploy.sh`
 * derives it from the source-repo directory basename. So the exact-match snapshot
 * above is only correct on a host that changed none of that, and review measured
 * the consequence: a deploy root named `tacbookings-2026` produces project
 * `tacbookings-2026`, which is not in the default set, extracts #2026, resolves
 * closed, and gets a `docker compose -p tacbookings-2026 down -v` printed against
 * a live shared stack and its volumes.
 */
export function reservedProjects(env = process.env) {
  const reserved = new Set(RESERVED_PROJECTS);
  for (const key of RESERVED_PROJECT_ENV_KEYS) {
    const value = String(env?.[key] ?? "").trim();
    if (value) reserved.add(value);
  }
  return reserved;
}

/**
 * The first name segment of each reserved project (`tacbookings`).
 *
 * Reading the environment only helps when the reporter runs in the same
 * environment as whatever created the stack, and the blue-green deploy derives
 * its project name from a directory basename in a shell this command never sees.
 * So within a reserved project's own name family, a BARE number is not enough to
 * claim per-issue ownership: `tacbookings-2026` is equally consistent with a
 * configured deployment and with a lane stack, and the honest answer to that is
 * `unknown`.
 *
 * A declared owner still wins — `tacbookings-issue2794`, or an
 * `agent-lane.issue` label — and so does the glued form the E2E lane stacks
 * actually use (`tacbookings-e2e2595`), which names a purpose rather than being a
 * bare number. That keeps the measured true positives working while removing the
 * one shape that collides with a deployment name.
 */
function reservedFamilies(reserved) {
  return new Set([...reserved].map((project) => firstSegment(project)));
}

function firstSegment(name) {
  return String(name ?? "").split(/[-_]/)[0].toLowerCase();
}

/** Opt-out label: a deliberately shared stack that happens to carry a number. */
export const SHARED_LABEL = "agent-lane.shared";

/**
 * Values that make `agent-lane.shared` mean shared, and mean not-shared.
 *
 * Compared after `.trim().toLowerCase()`, and that is not tidiness: review
 * measured that `agent-lane.shared=true ` with one trailing space defeated the
 * opt-out completely, and a stack deliberately marked shared was reported as
 * removable debris. A trailing space is easy to acquire in a Compose `labels:`
 * block or a shell variable, and this is the one label whose entire purpose is to
 * prevent a removal.
 *
 * A value in neither set is treated the way a malformed `agent-lane.issue` value
 * is treated below — reported, not ignored. Something set it deliberately and got
 * it wrong, and quietly falling through to a name-shaped guess is how a protected
 * stack becomes a candidate.
 */
const SHARED_LABEL_TRUE = new Set(["true", "1", "yes"]);
const SHARED_LABEL_FALSE = new Set(["false", "0", "no"]);

/** Opt-in label: the authoritative owning issue, set when the lane creates it. */
export const ISSUE_LABEL = "agent-lane.issue";

/** The Compose label every Compose-managed container carries. */
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/**
 * The canonical going-forward token: `issue<n>` as a whole segment, e.g.
 * `pg-issue2595`, `tacbookings-issue2595-app-1`. Unambiguous by construction —
 * when one of these is present, the legacy heuristics below are not consulted
 * at all.
 */
const CANONICAL_ISSUE_TOKEN = /(?:^|[-_])issue(\d{1,7})(?=$|[-_])/gi;

/**
 * A bare numeric segment: `pg-2376`, `drift-2597`, `pg-race-2595-resume`.
 *
 * The three-digit floor is load-bearing, not tidiness. Compose appends a
 * container number (`-app-1`) and images carry version-shaped fragments; a
 * one-or-two-digit segment read as an issue number would be a false match on
 * essentially every Compose container on the host.
 */
const BARE_NUMERIC_SEGMENT = /^\d{3,7}$/;

/**
 * First-segment names that mark a container or Compose project as agent-owned.
 *
 * This anchor is the difference between "a digit run in a name" and "an agent
 * lane's container", and #2794 requires it in as many words: *do not infer
 * ownership from arbitrary substring matches that could target unrelated
 * containers.* Without it a 3-7 digit segment inside this repository's issue range
 * was enough to claim any container on the host — measured, `zookeeper-2181`,
 * `etcd-2379`, `snapshot-2026` and `pgdata-2026` all resolved to closed
 * references and were printed as debris with a `docker rm -f` line, and the
 * tool's own canonical example `pg-2376` is coincidentally the Docker daemon TLS
 * port.
 *
 * The set is the measured agent-owned naming families (`pg-2376`, `pg-race-2595`,
 * `drift-2597`, `wt-2794`, `tacbookings-e2e2595`) and nothing else. It applies
 * ONLY to the legacy digit-run path: the canonical `issue<n>` token and the
 * `agent-lane.issue` label are explicit declarations and need no anchor, which is
 * the whole reason to prefer them. A lane whose naming family is not listed here
 * declares itself with the token or the label rather than by adding a prefix.
 */
export const AGENT_OWNED_PREFIXES = new Set(["pg", "drift", "wt", "tacbookings"]);

/**
 * A glued suffix on an otherwise alphabetic segment: `e2e2595` in
 * `tacbookings-e2e2595`. The segment must END in the digit run and the part
 * before it must end in a letter, so `postgres16` (two digits) and a pure
 * numeric segment are both handled elsewhere.
 */
const GLUED_NUMERIC_SUFFIX = /^(?:[a-z0-9]*[a-z])(\d{3,7})$/i;

/**
 * Pull the owning issue number out of an agent-owned name.
 *
 * Returns `{ issue, source }` only when exactly one distinct candidate is found
 * in a name that is agent-owned. `source` records HOW the number was read —
 * `issue-token`, `bare-digits` or `glued-digits` — because a declared owner and a
 * digit run are not equally trustworthy and the report says which it had.
 *
 * Anything else returns a reason, and every reason routes to `unknown`:
 *
 *   - `no-issue-in-name` — nothing issue-shaped is present. A container the
 *     convention does not cover is somebody else's, not debris.
 *   - `ambiguous` — two or more different numbers. `pg-2595-2597` could be owned
 *     by either, and guessing is exactly the false-deletion risk this refuses.
 *   - `unanchored-digits` — a single issue-shaped digit run, in a name that does
 *     not belong to an agent-owned family (`zookeeper-2181`, `pgdata-2026`). The
 *     number resolves; the ownership claim does not.
 */
export function extractIssueNumber(name) {
  const text = String(name ?? "");
  if (!text) return { issue: null, reason: "no-issue-in-name", source: null };

  const canonical = new Set();
  for (const match of text.matchAll(CANONICAL_ISSUE_TOKEN)) {
    canonical.add(Number(match[1]));
  }
  // The canonical token wins outright. A name that declares `issue2595` has said
  // what it means, and letting a stray digit run elsewhere in the same name turn
  // that into "ambiguous" would punish the convention we want lanes to adopt.
  if (canonical.size === 1) {
    return { issue: [...canonical][0], reason: null, source: "issue-token" };
  }
  if (canonical.size > 1) return { issue: null, reason: "ambiguous", source: null };

  const segments = text.split(/[-_]/);
  const legacy = new Set();
  let sawBare = false;
  for (const segment of segments) {
    if (BARE_NUMERIC_SEGMENT.test(segment)) {
      legacy.add(Number(segment));
      sawBare = true;
      continue;
    }
    const glued = GLUED_NUMERIC_SUFFIX.exec(segment);
    if (glued) legacy.add(Number(glued[1]));
  }

  if (legacy.size > 1) return { issue: null, reason: "ambiguous", source: null };
  if (legacy.size === 0) return { issue: null, reason: "no-issue-in-name", source: null };
  if (!AGENT_OWNED_PREFIXES.has(String(segments[0]).toLowerCase())) {
    return { issue: null, reason: "unanchored-digits", source: null };
  }
  // When both shapes matched the same number, report the bare one: it is the less
  // trustworthy of the two and the reserved-family refusal in `classifyOwnership`
  // keys off it.
  return {
    issue: [...legacy][0],
    reason: null,
    source: sawBare ? "bare-digits" : "glued-digits",
  };
}

/**
 * Decide what a container IS, before any issue state is known.
 *
 * Split out from state resolution so the ownership question and the open/closed
 * question fail independently: GitHub being unreachable must not turn a shared
 * stack into an unknown one, and it must not turn anything into debris.
 */
export function classifyOwnership(container, { reserved = reservedProjects() } = {}) {
  const project = container.project || null;

  if (project && reserved.has(project)) {
    return {
      ownership: "shared",
      issue: null,
      source: "reserved-project",
      reason: `reserved Compose project ${project}`,
    };
  }
  const sharedRaw = String(container.sharedLabel ?? "").trim();
  const sharedValue = sharedRaw.toLowerCase();
  if (sharedValue) {
    if (SHARED_LABEL_TRUE.has(sharedValue)) {
      return {
        ownership: "shared",
        issue: null,
        source: "shared-label",
        reason: `${SHARED_LABEL}=${sharedRaw}`,
      };
    }
    if (!SHARED_LABEL_FALSE.has(sharedValue)) {
      return {
        ownership: "unowned",
        issue: null,
        source: "shared-label",
        reason: `${SHARED_LABEL} label is not a yes/no value: ${sharedRaw}`,
      };
    }
  }

  const labelled = String(container.issueLabel ?? "").trim();
  if (labelled) {
    if (/^\d{1,7}$/.test(labelled)) {
      return {
        ownership: "agent-lane",
        issue: Number(labelled),
        source: "issue-label",
        reason: `${ISSUE_LABEL} label`,
      };
    }
    // A malformed label is worse than no label: something set it deliberately
    // and got it wrong, so say so instead of quietly falling back to the name.
    return {
      ownership: "unowned",
      issue: null,
      source: "issue-label",
      reason: `${ISSUE_LABEL} label is not an issue number: ${labelled}`,
    };
  }

  // Prefer the Compose project name. Every container in the project shares one
  // owner, so reading the project answers once for the whole stack and cannot
  // be confused by a per-service name.
  const basis = project ?? container.name;
  const { issue, reason, source } = extractIssueNumber(basis);
  if (issue === null) {
    return { ownership: "unowned", issue: null, source: null, reason: describeNoOwner(reason, basis) };
  }
  if (source === "bare-digits" && reservedFamilies(reserved).has(firstSegment(basis))) {
    return {
      ownership: "unowned",
      issue: null,
      source: null,
      reason:
        `"${basis}" is a bare number inside the reserved "${firstSegment(basis)}" ` +
        "Compose-project family, which a deployment can be configured to use " +
        `(${RESERVED_PROJECT_ENV_KEYS.join(" / ")}) — declare a lane stack with an ` +
        `issue<n> token or an ${ISSUE_LABEL} label instead`,
    };
  }
  return { ownership: "agent-lane", issue, source, reason: `issue number read from "${basis}"` };
}

/** Turn an `extractIssueNumber` reason into the sentence the report prints. */
function describeNoOwner(reason, basis) {
  if (reason === "ambiguous") return `more than one issue number in "${basis}"`;
  if (reason === "unanchored-digits") {
    const prefixes = [...AGENT_OWNED_PREFIXES].map((prefix) => `${prefix}-`).join(", ");
    return (
      `"${basis}" carries an issue-shaped digit run but is not an agent-owned name, so its ` +
      `owner is not established — declare one with an issue<n> token, an ${ISSUE_LABEL} label, ` +
      `or one of the ${prefixes} name families`
    );
  }
  return `no issue number in "${basis}"`;
}

/**
 * Docker's `CreatedAt` timestamp, e.g. `2026-08-09 08:16:05 +1200 NZST`.
 *
 * Parsed explicitly rather than handed to `Date.parse`, which returns NaN for
 * exactly this string: the space separator, the colon-less offset and the
 * trailing zone abbreviation are all outside the format the spec requires an
 * engine to accept. The first version of this file used `Date.parse` and its
 * own unit test caught it — every age would have rendered as "-" on a real host.
 *
 * A timestamp with no zone at all returns null. Docker always emits one, and
 * guessing a zone would silently shift the age by up to a day.
 */
const DOCKER_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})/;

export function parseDockerTimestamp(value) {
  const match = DOCKER_TIMESTAMP.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const milliseconds = fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes =
      (zone[0] === "-" ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }

  return (
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds,
    ) -
    offsetMinutes * 60_000
  );
}

/**
 * Container age in whole days, from an explicit `now`.
 *
 * `now` is a parameter rather than a `Date.now()` call inside so the unit suite
 * — which runs with the clock frozen at 2026-07-01 (`docs/TESTING.md`) — can
 * assert real numbers without fighting the freeze or opting out of it.
 *
 * Age is reported, never acted on: the owner ruled out age-based expiry, so a
 * long-lived container belonging to an open issue stays "active" no matter how
 * large this number gets.
 */
export function ageInDays(createdAt, now) {
  const created = parseDockerTimestamp(createdAt);
  if (created === null) return null;
  const elapsed = now - created;
  if (elapsed < 0) return null;
  return Math.floor(elapsed / 86_400_000);
}

/**
 * Build the whole report from two injected boundaries.
 *
 * `listContainers()` returns the parsed `docker ps -a` rows or throws;
 * `resolveIssueState(n)` returns `{ state, url }` or throws; `reserved` is the
 * shared-project set for this environment, defaulting to `reservedProjects()`
 * (the documented defaults plus this host's configured names). All three are
 * injected so the
 * unit suite can exercise every failure branch — Docker down, `gh` logged out, a
 * single issue that 404s — with no live Docker and no destructive operation
 * anywhere near a test run.
 */
export async function buildReport({
  listContainers,
  resolveIssueState,
  now = Date.now(),
  reserved = reservedProjects(),
}) {
  let containers;
  try {
    containers = await listContainers();
  } catch (error) {
    return {
      dockerAvailable: false,
      dockerError: error?.message ?? String(error),
      entries: [],
      groups: [],
    };
  }

  const owned = containers.map((container) => ({
    container,
    ...classifyOwnership(container, { reserved }),
  }));

  // Resolve each distinct issue once. A stack contributes three containers and
  // one lookup, and a `gh` outage produces one recorded reason rather than N.
  const issueStates = new Map();
  for (const { issue } of owned) {
    if (issue === null || issueStates.has(issue)) continue;
    try {
      const resolved = await resolveIssueState(issue);
      const state = String(resolved?.state ?? "").toUpperCase();
      const url = String(resolved?.url ?? "");

      // `gh issue view <n>` resolves PULL REQUEST numbers too, and a
      // closed-unmerged pull request is indistinguishable from a closed issue on
      // `state` alone: measured, #2026 is a closed CI-probe PR that reports
      // CLOSED, so a container named `snapshot-2026` would be printed as
      // closed-issue debris. The URL is the only field that tells the two
      // namespaces apart, so a resolution that is not an issue URL is not an
      // answer to the question this tool asked, and lands in `unknown` like
      // every other unresolvable reference.
      if (!url.includes("/issues/")) {
        issueStates.set(issue, {
          state: "UNKNOWN",
          error: url
            ? `#${issue} resolves to ${url}, which is not an issue — a pull-request number is not an owning issue`
            : `#${issue} resolved without an issue URL, so it could not be confirmed to be an issue at all`,
        });
        continue;
      }

      issueStates.set(
        issue,
        state === "OPEN" || state === "CLOSED"
          ? { state, title: resolved?.title ?? "" }
          : { state: "UNKNOWN", error: `GitHub reported an unrecognised state: ${resolved?.state}` },
      );
    } catch (error) {
      issueStates.set(issue, { state: "UNKNOWN", error: error?.message ?? String(error) });
    }
  }

  const entries = owned.map(({ container, ownership, issue, reason, source }) => {
    const resolved = issue === null ? null : issueStates.get(issue);
    const issueState = resolved?.state ?? null;

    let classification;
    let note;
    if (ownership === "shared") {
      classification = "shared";
      note = reason;
    } else if (ownership === "unowned") {
      classification = "unknown";
      note = reason;
    } else if (issueState === "CLOSED") {
      classification = "stale";
      note = `#${issue} is closed`;
    } else if (issueState === "OPEN") {
      classification = "active";
      note = `#${issue} is open`;
    } else {
      // The honesty branch. `gh` could not answer, so the answer is "I do not
      // know", and an unknown container is never offered for removal.
      classification = "unknown";
      note = `could not resolve #${issue}: ${resolved?.error ?? "no state returned"}`;
    }

    return {
      name: container.name,
      project: container.project || null,
      image: container.image ?? "",
      state: container.state ?? "",
      status: container.status ?? "",
      createdAt: container.createdAt ?? "",
      ageDays: ageInDays(container.createdAt, now),
      issue,
      // How the owner was established, not just what it is. A row whose owner came
      // from a digit run in a name is a weaker claim than one carrying a label or
      // the `issue<n>` token, and an operator deciding whether to run a teardown
      // is entitled to see which they are looking at.
      ownerSource: source ?? null,
      issueState,
      classification,
      note,
      reviewAsStale: classification === "stale",
    };
  });

  return { dockerAvailable: true, dockerError: null, entries, groups: groupEntries(entries) };
}

/**
 * Group the stale entries into the units a human actually tears down: a whole
 * Compose project, or a standalone container. Printing `docker rm -f x` three
 * times for one stack invites someone to remove the containers and leave the
 * project's network and volumes behind, which is most of what was consuming disk.
 *
 * ## Why a project-wide teardown needs the WHOLE project, not just the stale part
 *
 * `docker compose -p X down -v --remove-orphans` removes every container in
 * project X plus its network and named volumes — including containers this same
 * report classified `shared` or `unknown` and explicitly refused to offer. A
 * project with one stale member and two unclassified siblings must therefore not
 * print that command: it would hand the operator a blast radius wider than the
 * rows they just read, which is the false-deletion class review focus #1 exists
 * to prevent.
 *
 * So the project-wide command is emitted only when EVERY container on the host in
 * that project is stale and they all name the same owning issue. Otherwise the
 * stale members are offered individually with `docker rm -f`, and the group
 * carries a `warning` naming the siblings being left alone and saying why the
 * project's network and volumes stay behind.
 *
 * `entries` is the full entry list, not the stale subset: the stale rows alone
 * cannot answer "is anything else in this project", and that question is the
 * whole difference between removing a lane's stack and removing somebody else's.
 */
export function groupEntries(entries) {
  const all = [...entries];

  const projectMembers = new Map();
  for (const entry of all) {
    if (!entry.project) continue;
    const members = projectMembers.get(entry.project);
    if (members) members.push(entry);
    else projectMembers.set(entry.project, [entry]);
  }

  const grouped = new Map();
  for (const entry of all) {
    if (!entry.reviewAsStale) continue;
    const key = entry.project ? `project:${entry.project}` : `container:${entry.name}`;
    let group = grouped.get(key);
    if (!group) {
      group = {
        kind: entry.project ? "compose-project" : "container",
        key: entry.project ?? entry.name,
        issues: new Set(),
        members: [],
      };
      grouped.set(key, group);
    }
    group.issues.add(entry.issue);
    group.members.push(entry.name);
  }

  return [...grouped.values()].map(({ issues, ...group }) => {
    // One owner for the whole group, or none: two different owning issues inside
    // one Compose project means the project's own ownership is not established.
    const issue = issues.size === 1 ? [...issues][0] : null;
    const base = { ...group, issue, retained: [] };

    if (group.kind === "container") {
      return { ...base, teardown: `docker rm -f ${group.key}`, warning: null };
    }

    const retained = (projectMembers.get(group.key) ?? [])
      .filter((entry) => !entry.reviewAsStale)
      .map((entry) => ({ name: entry.name, classification: entry.classification ?? "unknown" }));
    const perContainer = `docker rm -f ${group.members.join(" ")}`;

    if (retained.length > 0) {
      const listed = retained.map((entry) => `${entry.name} — ${entry.classification}`).join(", ");
      return {
        ...base,
        retained,
        teardown: perContainer,
        warning:
          `Compose project "${group.key}" also holds ${retained.length} container(s) that are NOT ` +
          `removal candidates (${listed}), so no project-wide teardown is offered: ` +
          `\`docker compose -p ${group.key} down -v\` would take those with it, along with the ` +
          "project's network and named volumes. Removing only the stale containers deliberately " +
          "leaves those behind.",
      };
    }

    if (issue === null) {
      const owners = [...issues]
        .sort((first, second) => first - second)
        .map((number) => `#${number}`)
        .join(", ");
      return {
        ...base,
        teardown: perContainer,
        warning:
          `Compose project "${group.key}" holds containers naming different owning issues ` +
          `(${owners}), so the project's own ownership is not established and no project-wide ` +
          "teardown is offered.",
      };
    }

    return {
      ...base,
      teardown: `docker compose -p ${group.key} down -v --remove-orphans`,
      warning: null,
    };
  });
}

/**
 * How the owner was established, in the fewest words that still distinguish a
 * declaration from a guess. `name digits` is the row to read twice.
 */
const OWNER_SOURCE_LABELS = {
  "reserved-project": "reserved",
  "shared-label": "label",
  "issue-label": "label",
  "issue-token": "issue<n>",
  "bare-digits": "name digits",
  "glued-digits": "name digits",
};

const COLUMNS = [
  ["CONTAINER", (entry) => entry.name],
  ["PROJECT", (entry) => entry.project ?? "-"],
  ["ISSUE", (entry) => (entry.issue === null ? "-" : `#${entry.issue}`)],
  ["OWNER FROM", (entry) => OWNER_SOURCE_LABELS[entry.ownerSource] ?? "-"],
  // "-" rather than "unknown" when no owner was established: nothing was asked
  // of GitHub for that row, and printing "unknown" invites the reader to think a
  // lookup failed on a container the report is deliberately protecting.
  ["ISSUE STATE", (entry) => entry.issueState ?? (entry.issue === null ? "-" : "unknown")],
  ["CONTAINER STATE", (entry) => entry.state || "-"],
  ["AGE", (entry) => (entry.ageDays === null ? "-" : `${entry.ageDays}d`)],
  ["REVIEW AS STALE", (entry) => (entry.reviewAsStale ? "yes" : "no")],
];

/** Render the human report. Pure, so the suite asserts on the real output. */
export function renderReport(report) {
  if (!report.dockerAvailable) {
    return [
      "Stale-container report: UNKNOWN — Docker could not be queried.",
      `  ${report.dockerError}`,
      "",
      "Nothing is being claimed about this host. This is not a clean result:",
      "no container could be enumerated, so no container could be cleared.",
    ].join("\n");
  }

  const lines = [];
  if (report.entries.length === 0) {
    lines.push("Stale-container report: no containers on this host.");
    return lines.join("\n");
  }

  const rows = [COLUMNS.map(([heading]) => heading)];
  const ordered = [...report.entries].sort((a, b) => {
    const rank = { stale: 0, unknown: 1, active: 2, shared: 3 };
    return rank[a.classification] - rank[b.classification] || a.name.localeCompare(b.name);
  });
  for (const entry of ordered) rows.push(COLUMNS.map(([, read]) => read(entry)));

  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  for (const row of rows) {
    lines.push(row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd());
  }

  const stale = report.entries.filter((entry) => entry.classification === "stale");
  const unknown = report.entries.filter((entry) => entry.classification === "unknown");

  lines.push("");
  if (stale.length === 0) {
    lines.push("No closed-issue debris found.");
  } else {
    lines.push(
      `${stale.length} container(s) belong to closed issues. Nothing has been removed — ` +
        "read each target, confirm no open lane is using it, then run its teardown deliberately:",
    );
    for (const group of report.groups) {
      const owner = group.issue === null ? "#? (mixed owners)" : `#${group.issue}`;
      lines.push(`  ${owner}  ${group.members.join(", ")}`);
      lines.push(`         ${group.teardown}`);
      // The warning is not decoration. It is the only place the report says that
      // the printed command is narrower than the project, and why.
      if (group.warning) lines.push(`         ! ${group.warning}`);
    }
  }

  if (unknown.length > 0) {
    lines.push("");
    lines.push(
      `${unknown.length} container(s) could not be classified. These are NOT removal ` +
        "candidates — an unresolved container is unknown, not stale:",
    );
    for (const entry of unknown) lines.push(`  ${entry.name} — ${entry.note}`);
  }

  return lines.join("\n");
}

/**
 * The Docker boundary.
 *
 * One `docker ps -a` call with per-label template lookups. Deliberately NOT
 * `{{.Labels}}`: that renders every label into one comma-joined string, and
 * `com.docker.compose.depends_on` legitimately contains commas, so splitting it
 * misattributes values. Tabs cannot appear in any of these fields, so a
 * tab-delimited line is unambiguous.
 */
const DOCKER_FORMAT = [
  "{{.Names}}",
  "{{.State}}",
  "{{.Status}}",
  "{{.Image}}",
  "{{.CreatedAt}}",
  `{{.Label "${COMPOSE_PROJECT_LABEL}"}}`,
  `{{.Label "${ISSUE_LABEL}"}}`,
  `{{.Label "${SHARED_LABEL}"}}`,
].join("\t");

export function parseDockerOutput(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [name, state, status, image, createdAt, project, issueLabel, sharedLabel] =
        line.split("\t");
      return { name, state, status, image, createdAt, project, issueLabel, sharedLabel };
    });
}

function listContainersFromDocker() {
  try {
    const stdout = execFileSync("docker", ["ps", "-a", "--no-trunc", "--format", DOCKER_FORMAT], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseDockerOutput(stdout);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("`docker` is not on PATH, so no container could be enumerated.");
    }
    const stderr = String(error?.stderr ?? "").trim();
    throw new Error(
      stderr
        ? `\`docker ps -a\` failed (is the Docker daemon running?):\n${stderr}`
        : `\`docker ps -a\` failed: ${error?.message ?? error}`,
    );
  }
}

export function parseArguments(argv) {
  // A literal `--` is skipped so one documented command works in every shell.
  // PowerShell eats npm's separator, which is why other scripts here are
  // invoked as `npm run x -- -- --flag`; tolerating the token means nobody has
  // to remember which shell needs how many.
  const args = argv.filter((arg) => arg !== "--");
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new Error(
      `Unrecognised argument(s): ${unknown.join(" ")}. This command reports and takes ` +
        "only --json. It has no removal mode, deliberately (#2794).",
    );
  }
  return { json: args.includes("--json") };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { json } = parseArguments(process.argv.slice(2));
    const report = await buildReport({
      listContainers: listContainersFromDocker,
      resolveIssueState: fetchIssueState,
    });
    console.log(json ? JSON.stringify(report, null, 2) : renderReport(report));
    // A report that could not be produced must not exit 0: #2663's preflight and
    // any orchestrator reading this would otherwise read "clean host".
    if (!report.dockerAvailable) process.exitCode = 1;
  } catch (error) {
    console.error(`stale-containers failed: ${error.message}`);
    process.exitCode = 1;
  }
}
