import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";

/**
 * INV-CONFIG-003: nothing decides "is this production?" except the canonical
 * resolver (ENV-SAFETY 1, #3034; epic #2986).
 *
 * The rule this census exists for is one line of the issue's acceptance
 * criteria — "No production caller independently infers role" — and it cannot be
 * enforced by types, because the thing being forbidden is reading two perfectly
 * ordinary environment variables. `NODE_ENV` is a BUILD mode: the staging stack
 * runs `next start` on a production build, so `NODE_ENV === "production"` is TRUE
 * there. `APP_RUNTIME_ROLE` names which container SLOT this is — `web-blue`,
 * `web-green`, `cron-leader`, `staging` — which is a deployment naming
 * convention, and a convention holds right up until somebody stands up a copy
 * that breaks it. Either one used as "am I production?" is the guess epic #2986
 * exists to remove.
 *
 * SO THIS IS A CENSUS, NOT A BAN. Thirty files read one of these today and most
 * of them are entirely legitimate — a `Secure` cookie attribute, a dev-only
 * `console.warn`, a CSP relaxation for the dev server. Each is listed below with
 * a one-line reason, and the list is keyed by file AND by how many reads that
 * file has, so a NEW read inside an already-listed file fails too. That count is
 * the half that does the work: a ban would have to grandfather thirty files and
 * would then be silent about the thirty-first read landing in one of them.
 *
 * WHAT IT CANNOT SEE, said plainly rather than left to be discovered. It matches
 * `process.env.X` / `env.X` and the quoted key `"X"`, so a read laundered through
 * a helper that takes the name apart (`process.env["NODE" + "_ENV"]`, or a
 * generic `readEnv(env, someVariable)` whose argument is computed) is invisible
 * to it. That is inherent to a text census; the guarantee here is the narrower
 * and still useful one — "no new PLAIN read appears unnoticed".
 *
 * `test:related` cannot select this file. It reads `src/` from disk with `fs`, so
 * it has no import edge to the files it scans and the module graph cannot reach
 * it. It is CI-caught by design (`docs/TESTING.md`), which is also why the
 * failure message below has to say what to do rather than merely what is wrong.
 */

const SRC = path.resolve(process.cwd(), "src");
const EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * The variables this census tracks.
 *
 * `VERCEL_ENV` is read nowhere in this repository today and is listed anyway:
 * it is the single most likely name for the next inference to arrive under, and
 * a census that only knows the mistakes already made teaches nothing about the
 * next one.
 */
const TRACKED_VARIABLES = ["NODE_ENV", "APP_RUNTIME_ROLE", "VERCEL_ENV"] as const;

/**
 * `process.env.X`, the injected-env `env.X` shape (`demo-seed-guard.ts` takes its
 * environment as a parameter), and the quoted key a string-indexed read would
 * use. The optional `process.` prefix means one occurrence is counted once, not
 * twice.
 */
const TRACKED_READ = new RegExp(
  `(?:process\\.)?env\\.(?:${TRACKED_VARIABLES.join("|")})\\b` +
    `|["'](?:${TRACKED_VARIABLES.join("|")})["']`,
  "g",
);

type Allowance = { file: string; reads: number; reason: string };

/**
 * READS THIS EPIC IS ABOUT. Each is a real environment-safety decision taken
 * from a build mode or a slot name, each is owned by a named child issue, and
 * none is changed here: rewriting #3035's and #3036's surfaces from inside
 * #3034 would put three lanes' diffs in one pull request. What #3034 owes them
 * is the canonical resolver to move onto, and this list, so that the debt is
 * counted rather than remembered.
 */
const ENVIRONMENT_SAFETY_READS: Allowance[] = [
  {
    file: "src/lib/email/core.ts",
    reads: 1,
    reason:
      "The dev-mode send short-circuit, and it is NO LONGER THE SAFETY AUTHORITY: #3035 put the canonical resolver ABOVE it, so a message reaching this line has already been cleared by resolveEnvironmentRole(). It is KEPT deliberately as a local-development convenience and as a backstop for a developer's laptop that has been wrongly declared production; deleting it would remove today's protection for that case. It cannot decide safety on its own — a staging container runs a production build, so this never fires there — which is exactly why the boundary sits above it.",
  },
  {
    file: "src/lib/cron-email-retry.ts",
    reads: 1,
    reason:
      "The same dev-mode short-circuit on the email RETRY path, kept for the same reason and now underneath the same boundary. It used to be a SECOND copy of the safety decision, because this job built its own transport and never passed through sendEmail; since #3035 it asks the same policy and obtains its transport through the same clearance-gated accessor, so what is left here is a convenience rather than a duplicate authority.",
  },
  {
    file: "src/lib/xero-mock-endpoint.ts",
    reads: 2,
    reason:
      "isRealProductionRuntime() NO LONGER DECIDES ALONE (#3036): it asks readEnvironmentRoleDeclaration() FIRST, so a deployment that declares production is real production by the canonical answer, and these two reads are only the backstop underneath it. They are KEPT rather than collapsed, deliberately. They only ever DISABLE a harness that already requires an explicit XERO_MOCK_API_ORIGIN opt-in, so deleting them would let an UNDECLARED installation — the live club that upgraded without the line, this epic's headline case — past a gate the build-mode check catches today. Same shape as the email/core.ts entry above: not the authority, still the backstop.",
  },
  {
    file: "src/lib/xero-config.ts",
    reads: 2,
    reason:
      "xeroMockHarnessActive() duplicates only the BACKSTOP half of isRealProductionRuntime(), still to avoid the cycle xero-config -> xero-mock-endpoint -> xero-token-store -> xero-config (see the comment there). The DECLARATION half is not duplicated: both copies call the one canonical parser, which is a leaf and forms no cycle (#3036). What is left here is the same kept backstop, for the same reason as the entry above.",
  },
  {
    file: "src/lib/ses-sns.ts",
    reads: 1,
    reason:
      "allowsUnsafeMissingTopicArn() relaxes SNS topic-ARN verification when NODE_ENV !== 'production' AND an explicit opt-in variable is set. A SECURITY relaxation keyed on a build mode — noted here so it is visible; the explicit second variable is what keeps it from being reachable by accident, and moving it is not this issue's change.",
  },
];

/**
 * READS THAT ARE NOT ABOUT ENVIRONMENT SAFETY, listed so that nobody "fixes"
 * them into the resolver. Every one of these genuinely wants the build mode: a
 * `Secure` cookie cannot be set on the plain-HTTP dev server, a dev-only
 * `console.warn` must not ship, and the CSP has to admit the dev server's
 * `eval`. Routing any of them through the role resolver would make a local
 * checkout behave like production in a way that breaks development, and would
 * add a DATABASE READ to a cookie flag.
 */
const NOT_ENVIRONMENT_SAFETY_READS: Allowance[] = [
  {
    file: "src/app/api/display/pair/route.ts",
    reads: 1,
    reason: "Secure cookie attribute — plain HTTP in local development.",
  },
  {
    file: "src/app/api/lodge/pin-login/route.ts",
    reads: 1,
    reason:
      "Secure cookie attribute on the lodge kiosk PIN session cookie.",
  },
  {
    file: "src/app/api/profile/google/link/start/route.ts",
    reads: 1,
    reason: "Secure cookie attribute on the OAuth link-start state cookie.",
  },
  {
    file: "src/app/api/admin/integrations/google/verify/start/route.ts",
    reads: 1,
    reason: "Secure cookie attribute on the Google verify-start state cookie.",
  },
  {
    file: "src/lib/family-invite-return-address.ts",
    reads: 1,
    reason:
      "Secure cookie attribute on the family-invite return-address cookie.",
  },
  {
    file: "src/lib/xero-oauth-state.ts",
    reads: 1,
    reason: "Secure cookie attribute on the Xero OAuth state cookie.",
  },
  {
    file: "src/lib/signed-in-hint.ts",
    reads: 1,
    reason: "Secure cookie attribute on the signed-in hint cookie.",
  },
  {
    file: "src/lib/logger.ts",
    reads: 1,
    reason:
      "Pretty-printed logs in development, structured JSON otherwise. A log format.",
  },
  {
    file: "src/lib/csp.ts",
    reads: 1,
    reason:
      "The dev server needs 'unsafe-eval' for React Refresh; production must not have it.",
  },
  {
    file: "src/lib/prisma.ts",
    reads: 2,
    reason:
      "Query logging in development, and the global client cached across hot reloads.",
  },
  {
    file: "src/instrumentation-client.ts",
    reads: 3,
    reason:
      "Sentry's own `environment` tag and its sample rates. Sentry wants the build mode; it is a reporting label, not a safety decision.",
  },
  {
    file: "src/app/api/admin/health/route.ts",
    reads: 1,
    reason:
      "APP_RUNTIME_ROLE as WHAT IT IS — which container slot answered — reported on the health page. The correct use of that variable.",
  },
  {
    file: "src/lib/health-check.ts",
    reads: 1,
    reason:
      "The same again: the slot name, reported as the slot name and nothing else.",
  },
  {
    file: "src/lib/diagnostics/tools/packs/support-evidence.ts",
    reads: 1,
    reason:
      "The slot name in a support-evidence bundle, so an operator reading a diagnostics pack can tell which container produced it.",
  },
  {
    file: "src/lib/bed-allocation.ts",
    reads: 2,
    reason:
      "NODE_ENV === 'test': an invariant divergence throws in the test suite and is reported rather than thrown in a real runtime.",
  },
  {
    file: "src/lib/demo-seed-guard.ts",
    reads: 1,
    reason:
      "Refuses the demo seed when NODE_ENV=production. A refusal in the SAFE direction, and it takes its environment as a parameter rather than reading the process.",
  },
  {
    file: "src/lib/calendar-events.ts",
    reads: 1,
    reason:
      "Warn-only: logs once when the loopback MiroTalk fallback is used in production.",
  },
  {
    file: "src/lib/member-application-mapping.ts",
    reads: 1,
    reason:
      "Warn-only diagnostic: logs an unmapped application field in production.",
  },
  {
    file: "src/lib/member-merge.ts",
    reads: 1,
    reason:
      "Warn-only diagnostic on the merge path; changes no merge decision.",
  },
  {
    file: "src/lib/seasonal-membership-assignments.ts",
    reads: 1,
    reason:
      "Warn-only diagnostic on the seasonal-assignment path; changes no outcome.",
  },
  {
    file: "src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx",
    reads: 1,
    reason:
      "Dev-only console guard in a client component; ships nothing to production.",
  },
  {
    file: "src/components/admin/finance-report-mappings-panel.tsx",
    reads: 2,
    reason:
      "Two dev-only console guards in a client component; nothing ships.",
  },
  {
    file: "src/components/admin/lodge-capacity-card.tsx",
    reads: 1,
    reason:
      "Dev-only console guard in a client component; nothing ships.",
  },
  {
    file: "src/components/admin/rooms-beds-manager.tsx",
    reads: 1,
    reason:
      "Dev-only console guard in a client component; nothing ships.",
  },
  {
    file: "src/components/admin/subscription-lockout-settings-panel.tsx",
    reads: 1,
    reason:
      "Dev-only console guard in a client component; nothing ships.",
  },
];

const ALLOWLIST: Allowance[] = [
  ...ENVIRONMENT_SAFETY_READS,
  ...NOT_ENVIRONMENT_SAFETY_READS,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      walk(full, out);
    } else if (
      EXTENSIONS.has(path.extname(name)) &&
      !/\.test\.tsx?$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function repoRelative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/** Every production file under `src/` that reads a tracked variable, and how often. */
function censusReads(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of walk(SRC)) {
    const matches = readFileSync(file, "utf8").match(TRACKED_READ);
    if (matches) found.set(repoRelative(file), matches.length);
  }
  return found;
}

const REMEDY =
  `Deciding whether this installation is production is ` +
  `resolveEnvironmentRole() / getEnvironmentRole() in src/lib/environment-role.ts, ` +
  `which reads the ${ENVIRONMENT_ROLE_ENV_VAR} declaration and the database ` +
  `safer override and answers PRODUCTION / NON_PRODUCTION / UNKNOWN ` +
  `(INV-CONFIG-003). NODE_ENV is a build mode and APP_RUNTIME_ROLE is a ` +
  `container-slot name; neither can answer it. If this read is NOT an ` +
  `environment-safety decision — a Secure cookie flag, a dev-only console ` +
  `guard, a CSP relaxation — add it to NOT_ENVIRONMENT_SAFETY_READS in ` +
  `src/lib/__tests__/environment-role-inference-census.test.ts with a one-line ` +
  `reason saying which.`;

describe("environment-role inference census (INV-CONFIG-003)", () => {
  it("lists every file at most once", () => {
    const files = ALLOWLIST.map((entry) => entry.file);
    expect(files).toEqual([...new Set(files)]);
  });

  it("gives every allowance a real reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, `${entry.file} needs a reason`).toBeGreaterThan(
        30,
      );
      expect(entry.reads).toBeGreaterThan(0);
    }
  });

  it("finds no NODE_ENV / APP_RUNTIME_ROLE / VERCEL_ENV read that is not allowlisted", () => {
    const found = censusReads();
    const allowed = new Set(ALLOWLIST.map((entry) => entry.file));
    const unlisted = [...found.keys()].filter((file) => !allowed.has(file));

    expect(
      unlisted,
      `Unlisted read of a build-mode / slot-name variable. ${REMEDY}`,
    ).toEqual([]);
  });

  it("matches the published read count for every listed file", () => {
    const found = censusReads();
    const drifted = ALLOWLIST.filter(
      (entry) => found.get(entry.file) !== entry.reads,
    ).map((entry) => `${entry.file}: listed ${entry.reads}, found ${found.get(entry.file) ?? 0}`);

    expect(
      drifted,
      `A listed file gained or lost a read of NODE_ENV / APP_RUNTIME_ROLE / ` +
        `VERCEL_ENV. If a read was ADDED: ${REMEDY} If a read was REMOVED — ` +
        `which is what #3035 and #3036 are for — update the count, or delete ` +
        `the entry when it reaches zero.`,
    ).toEqual([]);
  });

  /*
    THE DECLARATION VARIABLE ITSELF HAS EXACTLY ONE READER (#3034 review).

    `APP_ENVIRONMENT_ROLE` is deliberately NOT in TRACKED_VARIABLES: that array's
    own case below asserts the tracked variables are never read in the declaration
    module, which is the one place this one MUST be read. So it gets its own,
    opposite-shaped assertion — not "nowhere reads it" but "exactly one module
    does".

    WHY IT MATTERS FOR #3035 AND #3036. Both are about to branch on the role, and
    the cheap way to do that is to read this variable directly and skip the
    database round trip. That would be a SECOND authority which ignores the safer
    override — so a copy whose administrator had switched the override on would
    still be treated as production by that caller. Split-brain is exactly what
    INV-CONFIG-003 exists to prevent, and nothing else in this file would notice.

    SAME BLIND SPOT AS THE REST OF THIS CENSUS, said plainly: it matches the
    literal read shapes, so a name taken apart at runtime is invisible to it.
  */
  it("is read by exactly one module, the canonical declaration parser", () => {
    const DECLARATION_MODULE = "src/lib/environment-role-declaration.ts";
    /*
      Read SHAPES, never the mere appearance of the name — which would be useless
      here, because the operator-facing copy in the resolver, the readiness step
      and the admin panel all quote `APP_ENVIRONMENT_ROLE` to tell somebody which
      setting to fix. `ENVIRONMENT_ROLE_ENV_VAR` is included as an index because
      that is how the one legitimate read is actually spelled.
    */
    const READ = new RegExp(
      `(?:process\\.)?env(?:\\.${ENVIRONMENT_ROLE_ENV_VAR}\\b` +
        `|\\[\\s*(?:"${ENVIRONMENT_ROLE_ENV_VAR}"|'${ENVIRONMENT_ROLE_ENV_VAR}'` +
        `|ENVIRONMENT_ROLE_ENV_VAR)\\s*\\])`,
    );

    const readers = walk(SRC)
      .filter((file) => READ.test(readFileSync(file, "utf8")))
      .map(repoRelative)
      .sort();

    expect(
      readers,
      `${ENVIRONMENT_ROLE_ENV_VAR} must be read in ${DECLARATION_MODULE} and ` +
        `nowhere else. A second reader is a second authority on "is this ` +
        `production?" that does not consult the database safer override, so a ` +
        `copy an administrator has deliberately forced safer would still be ` +
        `treated as the live site by that caller (INV-CONFIG-003). Call ` +
        `resolveEnvironmentRole() / getEnvironmentRole() from ` +
        `src/lib/environment-role.ts instead, or readEnvironmentRoleDeclaration() ` +
        `if you genuinely want the deployment's declaration alone and not the ` +
        `effective role — which is what src/lib/health-check.ts does, and why it ` +
        `is not in this list.`,
    ).toEqual([DECLARATION_MODULE]);
  });

  it("keeps the canonical resolver itself free of every one of them", () => {
    for (const file of [
      "src/lib/environment-role.ts",
      "src/lib/environment-role-declaration.ts",
    ]) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      for (const variable of TRACKED_VARIABLES) {
        // The word may APPEAR — both modules explain at length why these
        // variables cannot answer the question. What must not appear is a read.
        expect(
          source.match(
            new RegExp(`(?:process\\.)?env\\.${variable}\\b|\\[["']${variable}["']\\]`),
          ),
          `${file} must not read ${variable}`,
        ).toBeNull();
      }
    }
  });
});
