/**
 * The sync workflow's pull-request description must satisfy the same gates
 * every other pull request does (#3142).
 *
 * WHAT THIS TEST IS FOR. The description is written by a scheduled job that
 * runs at 06:20 UTC and opens a pull request per live `epic/**` branch. Nobody
 * watches it. When the description was a heredoc inside the workflow, a typo in
 * one of the five concurrency-declaration field labels — which the gate matches
 * EXACTLY — could only be discovered as a red pull request the next morning,
 * and it was: the description carried no declaration at all, and every sync
 * pull request had been failing `verify` at nineteen seconds before lint,
 * typecheck, knip, the suite or the build ran.
 *
 * So this file feeds the REAL rendered description to the REAL gate functions,
 * over a file list that is deliberately more hostile than any real sync diff.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateChangelogFragment } from "./check-pr-changelog-fragment.mjs";
import {
  REQUIRED_FIELDS,
  validateConcurrencyDeclaration,
} from "./check-pr-concurrency-declaration.mjs";
import { readTemplate, renderEpicSyncPrBody, TEMPLATE_PATH } from "./render-epic-sync-pr-body.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PR_TEMPLATE_PATH = path.join(HERE, "..", "..", ".github", "pull_request_template.md");

const BRANCH = "epic/2943-group-trip-hosting";
const RUN_URL = "https://github.com/thatskiff33/AlpineClubBookingsNZ/actions/runs/33058571420";

const render = () => renderEpicSyncPrBody({ branch: BRANCH, runUrl: RUN_URL });

/**
 * A sync diff carries whatever `main` gained. This list is every shape the two
 * gates classify — sensitive source, the schema, a migration, an ordinary
 * source file, a test — so the gates are exercised on their strictest branch
 * rather than on a diff that happens to waive them.
 */
const HOSTILE_CHANGES = [
  { status: "M", path: "prisma/schema.prisma" },
  { status: "A", path: "prisma/migrations/20260825010000_narrow_calendar_date_columns/migration.sql" },
  { status: "M", path: "src/lib/booking-create.ts" },
  { status: "M", path: "src/lib/xero-operation-outbox.ts" },
  { status: "M", path: "src/app/api/webhooks/stripe/route.ts" },
  { status: "M", path: "src/components/SomethingOrdinary.tsx" },
  { status: "M", path: "src/lib/__tests__/booking-create.test.ts" },
];

describe("the epic-sync pull request description", () => {
  it("passes the concurrency-declaration gate against a diff full of sensitive paths", () => {
    const files = HOSTILE_CHANGES.map((change) => change.path);
    expect(validateConcurrencyDeclaration(render(), files)).toEqual({ outcome: "complete" });
  });

  it("completes the declaration rather than waiving it, so the gate is really exercised", () => {
    // A body that ticked N/A, or one measured against an empty diff, would also
    // "pass" — and would prove nothing about the field labels, which is the
    // thing that actually breaks. Assert the outcome is the strict one.
    expect(validateConcurrencyDeclaration(render(), ["prisma/schema.prisma"])).toEqual({
      outcome: "complete",
    });
    expect(render()).not.toMatch(/^\s*-\s*\[[xX]\]\s*N\/A\b/m);
  });

  it("passes the changelog gate on a code-bearing diff with no fragment of its own", () => {
    // A sync introduces no source change of its own, and every entry for the
    // commits in its range is already a fragment on `main`. The range usually
    // contains those fragment ADDITIONS, which would satisfy the gate by
    // accident — so this asserts the harder case, where it does not.
    expect(validateChangelogFragment(render(), HOSTILE_CHANGES)).toEqual({
      outcome: "none-marker",
    });
  });

  it("uses the field labels verbatim from .github/pull_request_template.md", () => {
    // The gate matches labels exactly, and the template and the pull request
    // template are edited by different people at different times. This is what
    // stops them drifting apart silently.
    const prTemplate = readFileSync(PR_TEMPLATE_PATH, "utf8");
    for (const field of REQUIRED_FIELDS) {
      expect(prTemplate, `pull_request_template.md is missing "${field}:"`).toContain(`- ${field}:`);
      expect(render(), `the sync description is missing "${field}:"`).toContain(`- ${field}:`);
    }
  });

  it("substitutes the branch everywhere and leaves no placeholder behind", () => {
    const body = render();
    expect(body).toContain(BRANCH);
    expect(body).toContain(RUN_URL);
    expect(body).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    // The template's own placeholders, so a rename there fails here rather than
    // shipping a literal `__BRANCH__` into a pull request description.
    expect(readTemplate()).toContain("__BRANCH__");
    expect(readTemplate()).toContain("__RUN_URL__");
  });

  it("strips the template's maintainer comment instead of shipping it", () => {
    expect(readTemplate().trimStart().startsWith("<!--")).toBe(true);
    expect(render().trimStart().startsWith("<!--")).toBe(false);
    expect(render()).not.toContain("Substituted by the workflow");
  });

  it("says plainly that the workflow wrote the declaration", () => {
    // The one real cost of a generated declaration is that it can read as
    // though a person examined the diff. If that disclaimer is ever edited
    // away, this fails.
    expect(render()).toContain("The sync workflow wrote this section");
  });

  it("refuses to render a body it cannot finish", () => {
    // Silent half-substitution would still pass both gates and would be wrong
    // on the one artifact a human reads when a sync conflicts.
    expect(() => renderEpicSyncPrBody({ branch: "", runUrl: RUN_URL })).toThrow(/branch/);
    expect(() => renderEpicSyncPrBody({ branch: BRANCH, runUrl: "" })).toThrow(/runUrl/);
    expect(() =>
      renderEpicSyncPrBody({
        branch: BRANCH,
        runUrl: RUN_URL,
        template: "body with an __UNKNOWN_PLACEHOLDER__ in it",
      }),
    ).toThrow(/__UNKNOWN_PLACEHOLDER__/);
  });

  it("does not mistake a branch name's own underscores for a placeholder", () => {
    // The placeholder check reads the TEMPLATE, not the rendered body. Checking
    // the body afterwards looks stricter and is wrong: git allows `__` in a
    // branch name, so this epic would render cleanly and then be rejected as
    // holding an unsubstituted placeholder — aborting its sync over the
    // renderer's own output.
    const branch = "epic/3021__LODGE__info";
    const body = renderEpicSyncPrBody({ branch, runUrl: RUN_URL });
    expect(body).toContain(branch);
    expect(validateConcurrencyDeclaration(body, ["prisma/schema.prisma"])).toEqual({
      outcome: "complete",
    });
  });

  it("reads the template the workflow actually runs", () => {
    expect(TEMPLATE_PATH.replaceAll("\\", "/")).toMatch(
      /\.github\/epic-branch-sync-pr-body\.md$/,
    );
  });
});
