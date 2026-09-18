import { describe, expect, it, vi } from "vitest";

import {
  ageInDays,
  buildReport,
  classifyOwnership,
  extractIssueNumber,
  groupEntries,
  parseArguments,
  parseDockerOutput,
  parseDockerTimestamp,
  renderReport,
  reservedProjects,
  RESERVED_PROJECTS,
} from "./stale-containers.mjs";

/**
 * Unit coverage for the stale-container reporter (#2794).
 *
 * Both real boundaries are injected, so nothing here talks to Docker or to
 * GitHub and no test can remove anything: `buildReport` takes `listContainers`
 * and `resolveIssueState` as parameters and the CLI is the only thing that ever
 * supplies the live versions.
 *
 * The fixtures are the containers measured on the development host on
 * 19 Aug 2026, because the failure this tool exists to catch is exactly that
 * shape: a three-container Compose stack plus five standalone Postgres
 * containers, all from issues closed a week or more earlier.
 *
 * `now` is passed explicitly everywhere. The suite runs with the clock frozen at
 * 2026-07-01 (`docs/TESTING.md`), and an age assertion that read the real clock
 * would be a stopwatch — the thing that convention forbids.
 */

const NOW = Date.parse("2026-08-19T00:00:00.000Z");

function container(overrides = {}) {
  return {
    name: "pg-2376",
    state: "exited",
    status: "Exited (255) 6 days ago",
    image: "postgres:16-alpine",
    createdAt: "2026-08-09 08:16:05 +1200 NZST",
    project: "",
    issueLabel: "",
    sharedLabel: "",
    ...overrides,
  };
}

/**
 * Resolver that answers from a table and throws for anything not in it.
 *
 * The `url` is not decoration. `gh issue view <n>` resolves pull-request numbers
 * too, so the reporter requires an `/issues/` URL before it will believe a state
 * — see "refuses a number that resolves to a pull request" below. A fixture that
 * omitted the URL would exercise the refusal branch on every test instead of the
 * behaviour it names.
 */
function resolverFor(states) {
  return vi.fn(async (number) => {
    if (!(number in states)) throw new Error(`could not resolve issue ${number}`);
    return {
      number,
      state: states[number],
      title: `issue ${number}`,
      url: `https://github.com/example/repo/issues/${number}`,
    };
  });
}

describe("extractIssueNumber", () => {
  it("reads the canonical issue<n> token", () => {
    expect(extractIssueNumber("pg-issue2595")).toEqual({
      issue: 2595,
      reason: null,
      source: "issue-token",
    });
    expect(extractIssueNumber("tacbookings-issue2595-app-1")).toEqual({
      issue: 2595,
      reason: null,
      source: "issue-token",
    });
  });

  it("accepts the canonical token in a name from no known family", () => {
    // The token is an explicit declaration, so it needs no prefix anchor — that
    // is exactly why the docs prefer it over a bare number.
    expect(extractIssueNumber("zookeeper-issue2181")).toEqual({
      issue: 2181,
      reason: null,
      source: "issue-token",
    });
  });

  it("lets the canonical token win over an unrelated digit run in the same name", () => {
    // Without this, adopting the convention would make a name LESS resolvable
    // than the legacy shape it replaced.
    expect(extractIssueNumber("pg-issue2595-shard-4096")).toEqual({
      issue: 2595,
      reason: null,
      source: "issue-token",
    });
  });

  it("refuses an issue-shaped digit run in a name from no agent-owned family", () => {
    /*
      Review measured this on the real module: with no anchor, any 3-7 digit
      segment inside the repository's issue range claimed the container.
      `zookeeper-2181` -> #2181 (a CLOSED issue), `etcd-2379` -> #2379 (CLOSED),
      `snapshot-2026`, `pgdata-2026`, `db-2024` — none of them agent lane
      containers, all of them printed with a `docker rm -f` line. #2794's own
      requirement is "do not infer ownership from arbitrary substring matches
      that could target unrelated containers".
    */
    for (const name of ["zookeeper-2181", "etcd-2379", "snapshot-2026", "pgdata-2026", "db-2024"]) {
      expect(extractIssueNumber(name), name).toEqual({
        issue: null,
        reason: "unanchored-digits",
        source: null,
      });
    }
  });

  it("reads the legacy bare-numeric and glued shapes measured on the host", () => {
    // Every one of these carries an agent-owned first segment, which is what the
    // anchor above requires and what the real host debris looked like.
    expect(extractIssueNumber("pg-2376")).toMatchObject({ issue: 2376, source: "bare-digits" });
    expect(extractIssueNumber("drift-2597")).toMatchObject({ issue: 2597, source: "bare-digits" });
    expect(extractIssueNumber("pg-race-2595-resume")).toMatchObject({ issue: 2595 });
    expect(extractIssueNumber("pg-2623-fence")).toMatchObject({ issue: 2623 });
    expect(extractIssueNumber("wt-2794")).toMatchObject({ issue: 2794 });
    expect(extractIssueNumber("tacbookings-e2e2595")).toMatchObject({
      issue: 2595,
      source: "glued-digits",
    });
  });

  it("refuses a name with no issue number in it", () => {
    expect(extractIssueNumber("my-scratch-db")).toEqual({
      issue: null,
      reason: "no-issue-in-name",
      source: null,
    });
    expect(extractIssueNumber("")).toEqual({
      issue: null,
      reason: "no-issue-in-name",
      source: null,
    });
    expect(extractIssueNumber(undefined)).toEqual({
      issue: null,
      reason: "no-issue-in-name",
      source: null,
    });
  });

  it("never reads a Compose container number or a short digit run as an issue", () => {
    // `-1` is the Compose container-number suffix on EVERY Compose container,
    // and `postgres16` is an image-shaped fragment. Either being matched would
    // make this tool claim ownership of most of the host.
    expect(extractIssueNumber("someproject-app-1").issue).toBeNull();
    expect(extractIssueNumber("postgres16").issue).toBeNull();
    expect(extractIssueNumber("db-99").issue).toBeNull();
  });

  it("refuses an ambiguous name rather than guessing an owner", () => {
    expect(extractIssueNumber("pg-2595-2597")).toEqual({
      issue: null,
      reason: "ambiguous",
      source: null,
    });
    expect(extractIssueNumber("pg-issue2595-issue2597")).toEqual({
      issue: null,
      reason: "ambiguous",
      source: null,
    });
  });
});

describe("classifyOwnership", () => {
  it("treats every reserved Compose project as shared, whatever the name suggests", () => {
    for (const project of RESERVED_PROJECTS) {
      const result = classifyOwnership(container({ name: `${project}-postgres-1`, project }));
      expect(result.ownership).toBe("shared");
      expect(result.issue).toBeNull();
    }
  });

  it("reports #2663's former measurement stack as unowned, never as debris", () => {
    // `tacbookings-measure` was a reserved project here until #3382 removed
    // the `measurement/` tree it named and the reservation with it — that
    // Compose project can never exist again. Nothing about removing the
    // reservation may turn this name into removable debris: the container
    // name carries no issue-shaped digits anywhere, so it falls out of
    // `extractIssueNumber` as "no-issue-in-name" and lands on "unowned" the
    // same way any container the naming convention does not cover does.
    const result = classifyOwnership(
      container({ name: "tacbookings-measure-postgres-1", project: "tacbookings-measure" }),
    );
    expect(result.ownership).toBe("unowned");
    expect(result.issue).toBeNull();
  });

  it("honours an explicit shared label on a container whose name carries a number", () => {
    const result = classifyOwnership(
      container({ name: "pg-2595", project: "", sharedLabel: "true" }),
    );
    expect(result.ownership).toBe("shared");
  });

  it("honours the shared label through surrounding whitespace and casing", () => {
    /*
      Measured by review: `sharedLabel: "true "` returned ownership `agent-lane`,
      issue 2595 — one trailing space defeated the opt-out entirely and a stack
      deliberately marked shared was reported as removable debris. A trailing
      space is easy to acquire in a Compose `labels:` block or a shell variable,
      and this is the one label whose whole job is to prevent a removal.
    */
    for (const value of ["true ", " true", "\tTrue\n", "YES", "1"]) {
      const result = classifyOwnership(container({ name: "pg-2595", sharedLabel: value }));
      expect(result.ownership, JSON.stringify(value)).toBe("shared");
      expect(result.issue, JSON.stringify(value)).toBeNull();
    }
  });

  it("reports an unreadable shared label instead of falling through to the name", () => {
    // Symmetric with the malformed issue label below. Something set this
    // deliberately and got it wrong; guessing from the name is how a protected
    // stack becomes a removal candidate.
    const result = classifyOwnership(container({ name: "pg-2595", sharedLabel: "maybe" }));
    expect(result.ownership).toBe("unowned");
    expect(result.issue).toBeNull();
    expect(result.reason).toContain("not a yes/no value");

    // An explicit negative is a real answer, so the name is read as usual.
    expect(classifyOwnership(container({ name: "pg-2595", sharedLabel: "false" }))).toMatchObject({
      ownership: "agent-lane",
      issue: 2595,
    });
  });

  it("prefers an explicit issue label over the name", () => {
    const result = classifyOwnership(container({ name: "scratch-db", issueLabel: "2794" }));
    expect(result).toMatchObject({ ownership: "agent-lane", issue: 2794 });
  });

  it("reports a malformed issue label as unowned instead of falling back to the name", () => {
    const result = classifyOwnership(container({ name: "pg-2376", issueLabel: "not-a-number" }));
    expect(result.ownership).toBe("unowned");
    expect(result.reason).toContain("not an issue number");
  });

  it("protects a Compose project this host has configured through the environment", () => {
    /*
      Both shared project names are environment-configurable — `docker-compose.yml`
      reads `${COMPOSE_PROJECT_NAME:-tacbookings}` and `scripts/e2e-stack.sh` reads
      `${E2E_COMPOSE_PROJECT:-tacbookings-staging}` — so the hard-coded default set
      protects nothing on a host that changed either.
    */
    const reserved = reservedProjects({
      COMPOSE_PROJECT_NAME: "clubstack-prod",
      E2E_COMPOSE_PROJECT: "clubstack-e2e",
    });
    expect(reserved.has("clubstack-prod")).toBe(true);
    expect(reserved.has("tacbookings-staging")).toBe(true);

    const result = classifyOwnership(
      container({ name: "clubstack-prod-postgres-1", project: "clubstack-prod" }),
      { reserved },
    );
    expect(result.ownership).toBe("shared");
  });

  it("refuses a bare number inside a reserved project family, however the host is configured", () => {
    /*
      `scripts/run-production-blue-green-deploy.sh` derives the project name from
      the source-repo directory basename, in a shell this command never sees — so
      reading the environment cannot be the only protection. A deploy or checkout
      root named `tacbookings-2026` produced project `tacbookings-2026`, extracted
      #2026, resolved closed and printed
      `docker compose -p tacbookings-2026 down -v` against a live shared stack.
      A bare number in a reserved family is ambiguous, and ambiguous is unknown.
    */
    const result = classifyOwnership(
      container({ name: "tacbookings-2026-app-1", project: "tacbookings-2026" }),
    );
    expect(result.ownership).toBe("unowned");
    expect(result.issue).toBeNull();
    expect(result.reason).toContain("reserved");
    expect(result.reason).toContain("COMPOSE_PROJECT_NAME");
  });

  it("still resolves a declared lane stack inside a reserved project family", () => {
    // The refusal above must not cost the tool its actual job: a lane stack that
    // declares its owner, or uses the glued form the E2E lanes measured on the
    // host, still resolves.
    expect(
      classifyOwnership(container({ name: "tacbookings-issue2794-app-1", project: "tacbookings-issue2794" })),
    ).toMatchObject({ ownership: "agent-lane", issue: 2794, source: "issue-token" });
    expect(
      classifyOwnership(container({ name: "tacbookings-e2e2595-app-1", project: "tacbookings-e2e2595" })),
    ).toMatchObject({ ownership: "agent-lane", issue: 2595, source: "glued-digits" });
    expect(
      classifyOwnership(container({ name: "tacbookings-2026-app-1", project: "tacbookings-2026", issueLabel: "2794" })),
    ).toMatchObject({ ownership: "agent-lane", issue: 2794 });
  });

  it("reads the Compose project rather than the per-service container name", () => {
    const result = classifyOwnership(
      container({ name: "tacbookings-e2e2595-app-1", project: "tacbookings-e2e2595" }),
    );
    expect(result).toMatchObject({ ownership: "agent-lane", issue: 2595 });
  });
});

describe("buildReport", () => {
  it("classifies a closed-issue container as stale and offers its teardown", async () => {
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2376" })],
      resolveIssueState: resolverFor({ 2376: "CLOSED" }),
      now: NOW,
    });

    expect(report.dockerAvailable).toBe(true);
    expect(report.entries[0]).toMatchObject({
      name: "pg-2376",
      issue: 2376,
      issueState: "CLOSED",
      classification: "stale",
      reviewAsStale: true,
    });
    expect(report.groups).toEqual([
      {
        kind: "container",
        key: "pg-2376",
        issue: 2376,
        members: ["pg-2376"],
        retained: [],
        teardown: "docker rm -f pg-2376",
        warning: null,
      },
    ]);
  });

  it("classifies an open-issue container as active and never offers it", async () => {
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2794" })],
      resolveIssueState: resolverFor({ 2794: "OPEN" }),
      now: NOW,
    });

    expect(report.entries[0]).toMatchObject({ classification: "active", reviewAsStale: false });
    expect(report.groups).toEqual([]);
  });

  it("classifies a malformed / non-issue name as unknown, not removable", async () => {
    const resolveIssueState = vi.fn();
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "my-scratch-db" }),
        container({ name: "pg-2595-2597" }),
      ],
      resolveIssueState,
      now: NOW,
    });

    expect(report.entries.map((entry) => entry.classification)).toEqual(["unknown", "unknown"]);
    expect(report.entries.every((entry) => entry.reviewAsStale === false)).toBe(true);
    expect(report.entries[1].note).toContain("more than one issue number");
    // Ownership failed, so GitHub was never asked — no lookup, no false answer.
    expect(resolveIssueState).not.toHaveBeenCalled();
    expect(report.groups).toEqual([]);
  });

  it("never claims a host container whose name merely contains an issue-shaped number", async () => {
    // The resolver would happily call #2181 closed. It is never asked, because
    // ownership fails first — a digit run in somebody else's container name is
    // not an ownership claim.
    const resolveIssueState = resolverFor({ 2181: "CLOSED", 2026: "CLOSED" });
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "zookeeper-2181" }),
        container({ name: "pgdata-2026" }),
      ],
      resolveIssueState,
      now: NOW,
    });

    expect(report.entries.map((entry) => entry.classification)).toEqual(["unknown", "unknown"]);
    expect(report.entries.every((entry) => entry.reviewAsStale === false)).toBe(true);
    expect(report.entries[0].note).toContain("not an agent-owned name");
    expect(resolveIssueState).not.toHaveBeenCalled();
    expect(report.groups).toEqual([]);
    expect(renderReport(report)).not.toContain("docker rm -f");
  });

  it("shows how each owner was established, so a name-derived guess is visible", async () => {
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "pg-2376" }),
        container({ name: "pg-issue2595" }),
        container({ name: "scratch-db", issueLabel: "2597" }),
      ],
      resolveIssueState: resolverFor({ 2376: "CLOSED", 2595: "CLOSED", 2597: "CLOSED" }),
      now: NOW,
    });

    expect(
      report.entries.map((entry) => [entry.name, entry.ownerSource]),
    ).toEqual([
      ["pg-2376", "bare-digits"],
      ["pg-issue2595", "issue-token"],
      ["scratch-db", "issue-label"],
    ]);

    const rendered = renderReport(report);
    expect(rendered).toContain("OWNER FROM");
    expect(rendered).toMatch(/pg-2376\s+-\s+#2376\s+name digits/);
    expect(rendered).toMatch(/pg-issue2595\s+-\s+#2595\s+issue<n>/);
    expect(rendered).toMatch(/scratch-db\s+-\s+#2597\s+label/);
  });

  it('reports "unknown" — never "safe to remove" — when GitHub status cannot be resolved', async () => {
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2376" })],
      resolveIssueState: vi.fn(async () => {
        throw new Error(
          "GitHub CLI is not authenticated for this repository. Run `gh auth login`",
        );
      }),
      now: NOW,
    });

    expect(report.entries[0]).toMatchObject({
      issue: 2376,
      issueState: "UNKNOWN",
      classification: "unknown",
      reviewAsStale: false,
    });
    expect(report.entries[0].note).toContain("could not resolve #2376");
    expect(report.groups).toEqual([]);
    expect(renderReport(report)).not.toContain("belong to closed issues");
  });

  it("refuses a number that resolves to a pull request rather than an issue", async () => {
    /*
      Measured live against this repository: `gh issue view 2026 --json state,url`
      returns state CLOSED with url `.../pull/2026`, because `gh issue view`
      resolves the pull-request namespace too. #2026 is a closed CI-probe PR, so
      on `state` alone a container named `snapshot-2026` became closed-issue
      debris with a `docker rm -f` line. The URL is the only field that separates
      the namespaces.
    */
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2026" })],
      resolveIssueState: async (number) => ({
        number,
        state: "CLOSED",
        title: "a CI probe",
        url: `https://github.com/example/repo/pull/${number}`,
      }),
      now: NOW,
    });

    expect(report.entries[0]).toMatchObject({
      issue: 2026,
      issueState: "UNKNOWN",
      classification: "unknown",
      reviewAsStale: false,
    });
    expect(report.entries[0].note).toContain("not an issue");
    expect(report.entries[0].note).toContain("/pull/2026");
    expect(report.groups).toEqual([]);
  });

  it("refuses a resolution that carries no issue URL at all", async () => {
    // Fail closed: an answer that cannot be confirmed to be about an issue is
    // not an answer, even when it says CLOSED.
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2376" })],
      resolveIssueState: async (number) => ({ number, state: "CLOSED", title: "" }),
      now: NOW,
    });

    expect(report.entries[0].classification).toBe("unknown");
    expect(report.entries[0].reviewAsStale).toBe(false);
    expect(report.entries[0].note).toContain("without an issue URL");
  });

  it("treats an unrecognised GitHub state as unknown rather than as not-closed", async () => {
    const report = await buildReport({
      listContainers: async () => [container({ name: "pg-2376" })],
      // An `/issues/` URL, so this exercises the unrecognised-STATE branch rather
      // than passing vacuously through the not-an-issue-URL refusal above.
      resolveIssueState: async () => ({
        state: "MERGED",
        url: "https://github.com/example/repo/issues/2376",
      }),
      now: NOW,
    });

    expect(report.entries[0].classification).toBe("unknown");
    expect(report.entries[0].reviewAsStale).toBe(false);
    expect(report.entries[0].note).toContain("unrecognised state");
  });

  it("reports Docker being unavailable as unknown, and says so in the rendered output", async () => {
    const report = await buildReport({
      listContainers: async () => {
        throw new Error("`docker` is not on PATH, so no container could be enumerated.");
      },
      resolveIssueState: vi.fn(),
      now: NOW,
    });

    expect(report.dockerAvailable).toBe(false);
    expect(report.entries).toEqual([]);
    const rendered = renderReport(report);
    expect(rendered).toContain("UNKNOWN");
    expect(rendered).toContain("This is not a clean result");
    // The precise regression to guard: an empty enumeration reading as clean.
    expect(rendered).not.toContain("No closed-issue debris found");
  });

  it("looks each distinct issue up once across a whole Compose stack", async () => {
    const resolveIssueState = resolverFor({ 2595: "CLOSED" });
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "tacbookings-e2e2595-app-1", project: "tacbookings-e2e2595" }),
        container({ name: "tacbookings-e2e2595-postgres-1", project: "tacbookings-e2e2595" }),
        container({ name: "tacbookings-e2e2595-mailpit-1", project: "tacbookings-e2e2595" }),
      ],
      resolveIssueState,
      now: NOW,
    });

    expect(resolveIssueState).toHaveBeenCalledTimes(1);
    expect(report.groups).toEqual([
      {
        kind: "compose-project",
        key: "tacbookings-e2e2595",
        issue: 2595,
        members: [
          "tacbookings-e2e2595-app-1",
          "tacbookings-e2e2595-postgres-1",
          "tacbookings-e2e2595-mailpit-1",
        ],
        retained: [],
        teardown: "docker compose -p tacbookings-e2e2595 down -v --remove-orphans",
        warning: null,
      },
    ]);
  });

  it("never offers a project-wide teardown for a project holding a shared or unknown sibling", async () => {
    /*
      The blocker found by review (#2794): the project-wide command removes every
      container in the project plus its named volumes, so printing it for a
      partly-stale project destroys the very siblings the same report has just
      refused to offer. Measured shape: one lane-labelled member, one unlabelled
      member, one deliberately-shared member, all in project `devstack`.
    */
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "devstack-scratch-1", project: "devstack", issueLabel: "2595" }),
        container({ name: "devstack-redis-1", project: "devstack" }),
        container({ name: "devstack-minio-1", project: "devstack", sharedLabel: "true" }),
      ],
      resolveIssueState: resolverFor({ 2595: "CLOSED" }),
      now: NOW,
    });

    expect(report.groups).toHaveLength(1);
    const [group] = report.groups;
    expect(group.teardown).toBe("docker rm -f devstack-scratch-1");
    expect(group.teardown).not.toContain("docker compose");
    expect(group.retained).toEqual([
      { name: "devstack-redis-1", classification: "unknown" },
      { name: "devstack-minio-1", classification: "shared" },
    ]);
    expect(group.warning).toContain("NOT removal candidates");
    expect(group.warning).toContain("devstack-redis-1 — unknown");
    expect(group.warning).toContain("devstack-minio-1 — shared");

    // The rendered report is what an operator actually copies from, so the
    // destructive form must not appear there either, and the warning must.
    const rendered = renderReport(report);
    expect(rendered).not.toContain("down -v --remove-orphans");
    expect(rendered).toContain("! Compose project \"devstack\" also holds 2 container(s)");
  });

  it("refuses a project-wide teardown when one project names two different owners", async () => {
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "devstack-a-1", project: "devstack", issueLabel: "2595" }),
        container({ name: "devstack-b-1", project: "devstack", issueLabel: "2597" }),
      ],
      resolveIssueState: resolverFor({ 2595: "CLOSED", 2597: "CLOSED" }),
      now: NOW,
    });

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].issue).toBeNull();
    expect(report.groups[0].teardown).toBe("docker rm -f devstack-a-1 devstack-b-1");
    expect(report.groups[0].warning).toContain("different owning issues (#2595, #2597)");
    expect(renderReport(report)).toContain("#? (mixed owners)");
  });

  it("reproduces the 19 Aug 2026 host measurement", async () => {
    const report = await buildReport({
      listContainers: async () => [
        container({ name: "pg-2376", createdAt: "2026-08-09 08:16:05 +1200 NZST" }),
        container({ name: "pg-race-2656" }),
        container({ name: "tacbookings-e2e2595-app-1", project: "tacbookings-e2e2595", state: "running" }),
        container({ name: "pg-2623-fence" }),
        container({ name: "pg-race-2595-resume" }),
        container({ name: "pg-race-2595" }),
        container({ name: "tacbookings-e2e2595-mailpit-1", project: "tacbookings-e2e2595", state: "running" }),
        container({ name: "tacbookings-e2e2595-postgres-1", project: "tacbookings-e2e2595", state: "running" }),
        container({ name: "drift-2597" }),
        // Present as a control: this container must survive the report,
        // whatever its classification. It really was on the host that day —
        // the measurement stack's `tacbookings-measure` Compose project was a
        // reserved name at the time (#2663), so it classified "shared" then.
        // #3382 removed the `measurement/` tree the project belonged to and
        // the reservation with it; the fixture keeps the real container so
        // the regression this guards — reporting it as removable debris —
        // stays covered, and the expected classification below moved to
        // "unknown" to match the reservation's removal.
        container({ name: "tacbookings-measure-postgres-1", project: "tacbookings-measure" }),
      ],
      resolveIssueState: resolverFor({
        2376: "CLOSED",
        2595: "CLOSED",
        2597: "CLOSED",
        2623: "CLOSED",
        2656: "CLOSED",
      }),
      now: NOW,
    });

    expect(report.entries.filter((entry) => entry.classification === "stale")).toHaveLength(9);
    expect(report.entries.filter((entry) => entry.classification === "shared")).toHaveLength(0);
    expect(report.entries.filter((entry) => entry.classification === "unknown")).toHaveLength(1);
    expect(report.groups.map((group) => group.key).sort()).toEqual([
      "drift-2597",
      "pg-2376",
      "pg-2623-fence",
      "pg-race-2595",
      "pg-race-2595-resume",
      "pg-race-2656",
      "tacbookings-e2e2595",
    ]);
  });
});

describe("parseDockerTimestamp", () => {
  it("reads Docker's own CreatedAt format, which Date.parse cannot", () => {
    // The regression this pins: `Date.parse` returns NaN for this exact string,
    // so the first draft of the reporter rendered every age as "-".
    expect(Number.isNaN(Date.parse("2026-08-09 08:16:05 +1200 NZST"))).toBe(true);
    expect(parseDockerTimestamp("2026-08-09 08:16:05 +1200 NZST")).toBe(
      Date.parse("2026-08-08T20:16:05.000Z"),
    );
  });

  it("applies the offset sign and a colon-separated offset", () => {
    expect(parseDockerTimestamp("2026-08-09 08:16:05 -0500 EST")).toBe(
      Date.parse("2026-08-09T13:16:05.000Z"),
    );
    expect(parseDockerTimestamp("2026-08-09T08:16:05+12:00")).toBe(
      Date.parse("2026-08-08T20:16:05.000Z"),
    );
    expect(parseDockerTimestamp("2026-08-09T08:16:05.250Z")).toBe(
      Date.parse("2026-08-09T08:16:05.250Z"),
    );
  });

  it("returns null rather than guessing when the zone is missing or the value is junk", () => {
    expect(parseDockerTimestamp("2026-08-09 08:16:05")).toBeNull();
    expect(parseDockerTimestamp("not a date")).toBeNull();
    expect(parseDockerTimestamp(undefined)).toBeNull();
  });
});

describe("ageInDays", () => {
  it("computes whole days from the supplied instant", () => {
    expect(ageInDays("2026-08-09 08:16:05 +1200 NZST", NOW)).toBe(10);
  });

  it("returns null for an unparseable or future timestamp instead of a wrong number", () => {
    expect(ageInDays("not a date", NOW)).toBeNull();
    expect(ageInDays("2026-09-01T00:00:00.000Z", NOW)).toBeNull();
  });
});

describe("parseDockerOutput", () => {
  it("splits the tab-delimited format, including a container with no labels", () => {
    const rows = parseDockerOutput(
      "pg-2376\texited\tExited (255) 6 days ago\tpostgres:16-alpine\t2026-08-09 08:16:05 +1200 NZST\t\t\t\n" +
        'tacbookings-e2e2595-app-1\trunning\tUp 6 days (healthy)\ttacbookings-e2e2595-app:local\t2026-08-08 13:00:01 +1200 NZST\ttacbookings-e2e2595\t\t\n',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "pg-2376", project: "", state: "exited" });
    expect(rows[1]).toMatchObject({
      name: "tacbookings-e2e2595-app-1",
      project: "tacbookings-e2e2595",
    });
  });

  it("ignores blank lines rather than emitting an empty container", () => {
    expect(parseDockerOutput("\n\n")).toEqual([]);
  });
});

describe("parseArguments", () => {
  it("accepts nothing and --json", () => {
    expect(parseArguments([])).toEqual({ json: false });
    expect(parseArguments(["--json"])).toEqual({ json: true });
  });

  it("skips a literal -- so one documented command works in every shell", () => {
    // PowerShell eats npm's separator; bash does not. Without this, the single
    // documented invocation is wrong in one shell or the other.
    expect(parseArguments(["--", "--json"])).toEqual({ json: true });
    expect(parseArguments(["--", "--"])).toEqual({ json: false });
  });

  it("refuses anything that looks like a removal mode", () => {
    // There is no destructive mode, deliberately. A typo must fail loudly rather
    // than be ignored, so nobody believes they asked for one and got it.
    expect(() => parseArguments(["--remove"])).toThrow(/no removal mode/);
    expect(() => parseArguments(["--prune"])).toThrow(/Unrecognised argument/);
  });
});

describe("groupEntries", () => {
  it("groups only review-as-stale entries", () => {
    expect(
      groupEntries([
        { name: "a", project: null, issue: 1, reviewAsStale: false },
        { name: "b", project: null, issue: 2, reviewAsStale: true },
      ]),
    ).toEqual([
      {
        kind: "container",
        key: "b",
        issue: 2,
        members: ["b"],
        retained: [],
        teardown: "docker rm -f b",
        warning: null,
      },
    ]);
  });

  it("offers the project-wide teardown only when every member of the project is stale", () => {
    const wholeProject = groupEntries([
      { name: "p-a-1", project: "p", issue: 5, classification: "stale", reviewAsStale: true },
      { name: "p-b-1", project: "p", issue: 5, classification: "stale", reviewAsStale: true },
    ]);
    expect(wholeProject[0].teardown).toBe("docker compose -p p down -v --remove-orphans");
    expect(wholeProject[0].warning).toBeNull();

    const partial = groupEntries([
      { name: "p-a-1", project: "p", issue: 5, classification: "stale", reviewAsStale: true },
      { name: "p-b-1", project: "p", issue: 5, classification: "active", reviewAsStale: false },
    ]);
    expect(partial[0].teardown).toBe("docker rm -f p-a-1");
    expect(partial[0].retained).toEqual([{ name: "p-b-1", classification: "active" }]);
    expect(partial[0].warning).toContain("p-b-1 — active");
  });
});
