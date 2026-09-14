/**
 * The credential-actor census CONTRACT (#2723).
 *
 * WHAT THIS GATE IS FOR. Every mutation of the encrypted `IntegrationCredential`
 * store must carry explicit actor context — a Full Admin, or a NAMED background
 * writer. Before #2723 the store took `updatedByUserId?: string | null`, so a
 * write with no attribution compiled, ran, and stored exactly the `null` a
 * deliberate background write stores. Ten of its eighteen production call sites
 * were in that state, and nothing in the repository could say so.
 *
 * THREE LINES, IN ORDER OF STRENGTH, and this file is the third:
 *
 *  1. the TYPE — `actor` is a required argument, so omission does not compile;
 *  2. the RUNTIME assertion — `assertCredentialActor`, for the holes a type
 *     always has: an `as never` cast, untyped JavaScript, a forwarded value;
 *  3. this CENSUS — for the writer that skips the store altogether.
 *
 * IT COUNTS FROM THE TREE. Every number below is measured by walking `src/`,
 * `scripts/`, `e2e/` and `prisma/` on the run, never read off a list of paths
 * somebody maintains. A population measured by name is not the population.
 *
 * WHY IT PINS EXACT SETS RATHER THAN CEILINGS. "No more than fourteen forwarded
 * actors" passes when one is made explicit and another appears. The sets are
 * pinned by stable symbol id, so changing one means editing this file in the
 * same diff and a reviewer sees it.
 *
 * Scanned from disk, so `vitest related` cannot reach it from a route change:
 * this is a CI-caught contract by design, like the other census tests here. Run
 * it by name — `npm run test:named -- credential-actor-census` — or print the
 * measurement with `npm run credential:census`.
 */
import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_SYSTEM_ACTORS,
  type CredentialSystemActor,
} from "@/lib/integration-credential-actor";

import {
  CREDENTIAL_BOUNDARY_MODULES,
  CREDENTIAL_MUTATORS,
  describeCredentialActor,
  describeCredentialExpectation,
  scanCredentialActorCensus,
  type CredentialWriteSite,
} from "../../../scripts/audit/credential-actor-census";

/** One scan for the whole file; parsing the tree costs a couple of seconds. */
let cached: ReturnType<typeof scanCredentialActorCensus> | null = null;
function census() {
  cached ??= scanCredentialActorCensus();
  return cached;
}

function ids(sites: readonly { id: string }[]): string[] {
  return sites.map((site) => site.id).sort();
}

/**
 * EVERY PLACE THE CURRENT POPULATION IS PUBLISHED.
 *
 * A census whose failure says only "expected 21, got 22" sends its reader
 * hunting for the other copies of the number, and the copy that gets missed is
 * the one that then reads as authoritative. So the message names them all, and
 * this constant is the single list the message is built from — which means
 * publishing the figure somewhere new is an edit here, in the same diff.
 */
const FIGURE_PUBLISHERS = [
  "src/lib/__tests__/credential-actor-census.test.ts (this file: CREDENTIAL_WRITE_SITES, ACTOR_FORWARDED_SITES, APPROVED_STORE_BYPASSES)",
  "scripts/audit/credential-actor-census.ts (the module header's description of what counts as a site)",
] as const;

/**
 * THE OTHER FIGURE, AND WHY IT IS NOT IN THAT LIST.
 *
 * Four documents state how bad things were BEFORE #2723 — ten of eighteen
 * production call sites storing no attribution. The first draft of this file
 * listed them as publishers of "the figure" and told a future editor to
 * re-measure by running the census. That instruction cannot work, and following
 * it would replace a historical measurement with a present-day one: the census
 * walks TODAY'S tree, where the answer is zero by construction, because that is
 * the whole point of the gate.
 *
 * A pre-change figure is re-measured against the pre-change tree. This is the
 * command, and it is the one the figure came from:
 *
 *     git grep -nE '\b(setIntegrationCredential|ensureGeneratedCredential|deleteIntegrationCredential)\(' \
 *       origin/epic/2725-mad -- src ':!src/**\/__tests__/**' | grep -v 'export async function'
 *
 * 18 lines — the production call sites. Eight of them pass `updatedByUserId`
 * (six in the backups route, one in the credentials route, one forwarded
 * through `setServerNzApiKey`); the other ten pass nothing, seven of those
 * because `deleteIntegrationCredential` and `ensureGeneratedCredential` took no
 * attribution argument at all. Three more sites live under `e2e/`.
 *
 * If the figure ever has to change, re-run that against the same base ref and
 * update: `src/lib/integration-credential-actor.ts` (module header),
 * `docs/SECURITY-ATTACK-SURFACE.md`, `docs/invariants/analytics-and-privacy.md`
 * (INV-PRIV-019), and `changelog.d/2723-credential-actor-context.md`.
 */
const HISTORICAL_FIGURE_IS_NOT_RE_MEASURABLE_HERE = true;

function publishersNote(what: string): string {
  return (
    `${what}\n\nRe-MEASURE rather than increment — run \`npm run credential:census\`. ` +
    "Then update EVERY place the current population is published:\n" +
    FIGURE_PUBLISHERS.map((where) => `  - ${where}`).join("\n")
  );
}

/**
 * Every call of a store mutator in the tree, by stable id, with the actor and
 * expectation each declares. Adding a credential writer means adding a row
 * here, which is the point: a reviewer sees the new writer and what it claims.
 */
const CREDENTIAL_WRITE_SITES: Record<string, string> = {
  "e2e/setup/seed-stripe-credentials.ts::main#0":
    "setIntegrationCredential (forwarded) actor / any",
  "e2e/setup/seed-stripe-credentials.ts::main#1":
    "setIntegrationCredential (forwarded) actor / any",
  "e2e/setup/seed-stripe-credentials.ts::main#2":
    "setIntegrationCredential (forwarded) actor / any",
  "src/app/api/admin/backups/config/route.ts::POST#0":
    "setIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/backups/config/route.ts::POST#1":
    "setIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/backups/config/route.ts::POST#2":
    "deleteIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/backups/config/route.ts::POST#3":
    "setIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/backups/config/route.ts::POST#4":
    "deleteIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/backups/config/route.ts::POST#5":
    "setIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/backups/config/route.ts::POST#6":
    "deleteIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/backups/config/route.ts::POST#7":
    "setIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/backups/config/route.ts::POST#8":
    "setIntegrationCredential (forwarded) actor / (forwarded) writeExpectation",
  "src/app/api/admin/integrations/credentials/route.ts::POST#0":
    "setIntegrationCredential admin / any",
  "src/lib/club-post-mirror.ts::ensurePushRegistration#0":
    "setIntegrationCredential system / any",
  "src/lib/google-config.ts::clearGoogleVerified#0":
    "deleteIntegrationCredential (forwarded) actor / any",
  "src/lib/google-config.ts::recordGoogleVerified#0":
    "setIntegrationCredential system / any",
  // #2940 — the first CLUB-EDITABLE consumer of the store, and the first pair
  // of sites that declare a real expectation rather than `any`. The screen read
  // the status and says what it was shown; a second administrator who saved in
  // between makes the write lose. The clear is the one that needs it most: it
  // is a genuine read-modify-write, and an unconditional delete would remove
  // whatever replaced the secret and report success.
  "src/lib/mirotalk-config.ts::clearMirotalkSecret#0":
    "deleteIntegrationCredential (forwarded) params.actor / (forwarded) params.expect",
  "src/lib/mirotalk-config.ts::setMirotalkSecret#0":
    "setIntegrationCredential (forwarded) params.actor / (forwarded) params.expect",
  "src/lib/servernz-config.ts::clearServerNzApiKey#0":
    "deleteIntegrationCredential (forwarded) actor / any",
  "src/lib/servernz-config.ts::setServerNzApiKey#0":
    "setIntegrationCredential (forwarded) actor / any",
  "src/lib/stripe-config.ts::clearStripeWebhookVerified#0":
    "deleteIntegrationCredential (forwarded) actor / any",
  "src/lib/stripe-config.ts::recordStripeWebhookVerified#0":
    "setIntegrationCredential system / any",
  "src/lib/xero-config.ts::getOperationalXeroEncryptionKey.value#0":
    "ensureGeneratedCredential system / (not-applicable)",
};

/**
 * Sites whose actor is decided somewhere this walk cannot read it. A LEGITIMATE
 * shape, pinned rather than forbidden — but each has to earn its entry, because
 * "decided elsewhere" is also what an actorless writer would look like if the
 * walk were wrong about it.
 */
const ACTOR_FORWARDED_SITES: Record<string, string> = {
  "e2e/setup/seed-stripe-credentials.ts::main#0":
    "one `e2e-stripe-seed` system actor hoisted for the three keys the stack seeds",
  "e2e/setup/seed-stripe-credentials.ts::main#1": "same hoisted seed actor",
  "e2e/setup/seed-stripe-credentials.ts::main#2": "same hoisted seed actor",
  "src/app/api/admin/backups/config/route.ts::POST#0":
    "one admin actor hoisted from the request guard for the handler's nine writes",
  "src/app/api/admin/backups/config/route.ts::POST#1": "same hoisted admin actor",
  "src/app/api/admin/backups/config/route.ts::POST#2": "same hoisted admin actor",
  "src/app/api/admin/backups/config/route.ts::POST#3": "same hoisted admin actor",
  "src/app/api/admin/backups/config/route.ts::POST#4": "same hoisted admin actor",
  "src/app/api/admin/backups/config/route.ts::POST#5": "same hoisted admin actor",
  "src/app/api/admin/backups/config/route.ts::POST#6": "same hoisted admin actor",
  "src/app/api/admin/backups/config/route.ts::POST#7": "same hoisted admin actor",
  "src/app/api/admin/backups/config/route.ts::POST#8": "same hoisted admin actor",
  "src/lib/google-config.ts::clearGoogleVerified#0":
    "the actor is this helper's own required parameter: a verify-reset belongs to the administrator whose credential write caused it, not to a background job",
  "src/lib/mirotalk-config.ts::clearMirotalkSecret#0":
    "the actor and the expectation are both this helper's own required parameters, supplied by the admin route that holds the acting member and the version the screen was shown",
  "src/lib/mirotalk-config.ts::setMirotalkSecret#0":
    "the actor and the expectation are both this helper's own required parameters, supplied by the admin route that holds the acting member and the version the screen was shown",
  "src/lib/servernz-config.ts::clearServerNzApiKey#0":
    "the actor is this helper's own required parameter, supplied by its caller",
  "src/lib/servernz-config.ts::setServerNzApiKey#0":
    "the actor is this helper's own required parameter, supplied by its caller",
  "src/lib/stripe-config.ts::clearStripeWebhookVerified#0":
    "the actor is this helper's own required parameter, for the same reason as the Google verify-reset above",
};

/**
 * Direct writes to the credential table that are allowed to exist.
 *
 * EMPTY, and it should stay that way. The store's two boundary modules are
 * excluded by the scanner (they ARE the implementation); everything else that
 * reaches the table without going through them escapes the required argument
 * entirely, which is the one hole a type cannot close.
 */
const APPROVED_STORE_BYPASSES: Record<string, string> = {};

/**
 * A guard against this whole file going vacuous. If the walk ever resolves
 * nothing — a rename of the mutators, a move of the store, a broken import —
 * every assertion below would pass over an empty set and report a clean bill of
 * health for a population nobody had checked. These floors are deliberately far
 * below the measurement so ordinary movement never trips them.
 */
const MINIMUM_FILES_SCANNED = 1500;
const MINIMUM_WRITE_SITES = 15;

describe("credential-actor census: the tree names an actor everywhere (#2723)", { timeout: 180_000 }, () => {
  it("measures the present tree, which is why the BEFORE figure lives elsewhere", () => {
    // The census answers "how many writers omit an actor TODAY", and the answer
    // is zero by construction once the gate holds. The pre-#2723 figure the
    // documents publish is a measurement of a different tree and is re-measured
    // against that ref — see the comment above this constant for the command.
    expect(HISTORICAL_FIGURE_IS_NOT_RE_MEASURABLE_HERE).toBe(true);
    expect(census().actorless).toEqual([]);
  });

  it("resolved a real population, so a clean report means something", () => {
    expect(census().filesScanned).toBeGreaterThan(MINIMUM_FILES_SCANNED);
    expect(census().sites.length).toBeGreaterThanOrEqual(MINIMUM_WRITE_SITES);
    expect(CREDENTIAL_MUTATORS.length).toBe(3);
    // Three modules are exempt from the bypass check because they ARE the
    // implementation: the store, the compare-and-set claim, and the create-only
    // generator. Pinned, because every addition widens the one check that can
    // see a writer which skips the store.
    expect(CREDENTIAL_BOUNDARY_MODULES.length).toBe(3);
  });

  it("has NO writer that omits actor context", () => {
    // THE ACCEPTANCE CRITERION. The scanner self-test proves this assertion
    // discriminates, by seeding a writer that lands here.
    const offenders = census().actorless.map(
      (site) => `${site.id} (${site.mutator}, line ${site.line})`,
    );
    expect(
      offenders,
      publishersNote(
        "A credential writer reached the store without naming an actor. Every " +
          "mutation of the encrypted store must pass `actor: { kind: \"admin\", " +
          "memberId }` or `{ kind: \"system\", actor }` from " +
          "@/lib/integration-credential-actor — an omission stores the same NULL " +
          "a deliberate background write stores, so no reader can tell them apart.",
      ),
    ).toEqual([]);
  });

  it("has NO set or delete that omits its write expectation", () => {
    const offenders = census().expectationless.map(
      (site) => `${site.id} (${site.mutator}, line ${site.line})`,
    );
    expect(
      offenders,
      publishersNote(
        "A credential set or delete declared no write expectation. Pass " +
          "`{ expect: \"absent\" }`, `{ expect: \"version\", version }` or " +
          "`{ expect: \"any\" }` — an undeclared write cannot be told apart from " +
          "one that never considered a concurrent writer.",
      ),
    ).toEqual([]);
  });

  it("has NO writer that reaches the credential table directly", () => {
    const offenders = census().bypasses.map(
      (bypass) => `${bypass.id} (${bypass.statement}, line ${bypass.line})`,
    );
    expect(
      offenders,
      publishersNote(
        "Something writes `IntegrationCredential` without going through the " +
          "store, so no required argument can make it name an actor. Route it " +
          "through `setIntegrationCredential` / `ensureGeneratedCredential` / " +
          "`deleteIntegrationCredential`, or — if it genuinely cannot be — " +
          "record it in APPROVED_STORE_BYPASSES with the reason.",
      ),
    ).toEqual(Object.keys(APPROVED_STORE_BYPASSES).sort());
  });
});

describe("credential-actor census: the pinned populations (#2723)", { timeout: 180_000 }, () => {
  it("pins every mutator call site, with what it declares", () => {
    const measured: Record<string, string> = {};
    for (const site of census().sites) {
      measured[site.id] =
        `${site.mutator} ${describeCredentialActor(site.actor)} / ` +
        `${describeCredentialExpectation(site.expectation)}`;
    }
    expect(
      measured,
      publishersNote(
        "The set of credential writers moved. Adding one is fine and is meant " +
          "to be visible: add its row here so a reviewer reads what it claims.",
      ),
    ).toEqual(CREDENTIAL_WRITE_SITES);
  });

  it("pins the sites whose actor is decided elsewhere", () => {
    expect(
      ids(census().actorForwarded),
      publishersNote(
        "A site's actor stopped being readable at the call, or a new one " +
          "forwards. Forwarding is legitimate — a route hoists one actor for " +
          "nine writes — but it is also what an actorless writer would look " +
          "like if this walk were wrong, so each entry states its reason.",
      ),
    ).toEqual(Object.keys(ACTOR_FORWARDED_SITES).sort());
  });

  it("writes as either a person or a named background actor, never a third thing", () => {
    const kinds = new Set(
      census()
        .sites.filter((site) => site.actor.kind === "literal")
        .map((site) => (site.actor as { value: string }).value),
    );
    expect([...kinds].sort()).toEqual(["admin", "system"]);
  });

  it("keeps the system-actor vocabulary closed and free of duplicates", () => {
    const unique = new Set<CredentialSystemActor>(CREDENTIAL_SYSTEM_ACTORS);
    expect(unique.size).toBe(CREDENTIAL_SYSTEM_ACTORS.length);
    for (const actor of CREDENTIAL_SYSTEM_ACTORS) {
      // A name says WHICH writer. A generic one ("system", "cron", "backend")
      // is exactly the ambiguity the closed list exists to abolish.
      expect(["system", "cron", "backend", "app", "server"]).not.toContain(actor);
    }
  });
});

describe("credential-actor census: reads stay out of it (#2723)", { timeout: 180_000 }, () => {
  it("counts no read as a mutation, so a status check makes no audit noise", () => {
    // Half a dozen config modules read the table directly on purpose, and the
    // Xero token path calls `ensureGeneratedCredential` on every decrypt. If a
    // read counted here, the population would be dominated by traffic nobody
    // needs to attribute — and the census would be ignored.
    const readers: CredentialWriteSite[] = census().sites.filter((site) =>
      site.mutator.startsWith("get") || site.mutator.startsWith("resolve"),
    );
    expect(readers).toEqual([]);
  });
});
