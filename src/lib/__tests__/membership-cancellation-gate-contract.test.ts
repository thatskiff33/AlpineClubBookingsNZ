import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #2354, extended by #2383 — the admin member page must decide "may this
  membership be cancelled?" with the same question the server asks, never with
  a permissions question.

  The original bug this pins (#2354): the page gated the action on
  `hasAccessRole(member, "USER")`. Access roles are deliberately cleared for
  anyone who cannot log in (`normalizeAssignableAccessRoles`), so every family
  dependant and every non-login adult resolved to zero roles and the cancel
  action vanished — while `createAdminMembershipCancellationRequest` accepted
  exactly those members.

  #2383 widened the shared helper: eligibility is now an account-holder
  question (`isMembershipHolderRecord`) rather than legacy `role === "USER"`,
  so admins of every class and organisation accounts are cancellable and only
  the lodge kiosk device login and the booking-request contact records are
  refused. That gave the helper more inputs — `canLogin`, `accessRoles` and
  `financeAccessLevel`, the last two only to tell a device from a person. The
  assertions below are unchanged in force and deliberately kept: the page must
  still hand the whole member to the helper and decide nothing itself. A bare
  `canLogin` or `accessRoles` conjunct ON THE PAGE is exactly the #2354
  regression; the helper consulting those fields internally, with the reasoning
  written beside it, is not. Whichever way the shared rule moves next, page and
  server move together — which is the property this file exists to hold.

  Unit tests over the helper cannot catch a regression here: restoring the old
  expression on the page leaves the helper, and its tests, untouched and green.
  So the call site itself is the thing asserted, structurally over the AST
  rather than over file text, because this file quotes the very identifiers
  being matched.
*/

const PAGE = join(
  process.cwd(),
  "src",
  "app",
  "(admin)",
  "admin",
  "membership",
  "members",
  "[id]",
  "page.tsx",
);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
}

function eachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  visit(root);
  root.forEachChild((child) => eachNode(child, visit));
}

/** The initialiser of `const <name> = …`, as source text. */
function declarationInitialiser(
  sourceFile: ts.SourceFile,
  name: string,
): string | null {
  let found: string | null = null;
  eachNode(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer.getText(sourceFile);
    }
  });
  return found;
}

describe("admin membership-cancellation gate (#2354, #2383)", () => {
  const sourceFile = parse(PAGE);
  const gate = declarationInitialiser(sourceFile, "canRequestCancellation");

  it("derives the gate from the shared eligibility helper", () => {
    expect(gate).not.toBeNull();
    expect(gate).toContain("canAdminRequestMembershipCancellation");
  });

  it("hands the whole member to the helper", () => {
    // #2383: the helper reads `role`, `canLogin`, `accessRoles`,
    // `financeAccessLevel`, `active`, `cancelledAt` and `archivedAt`, and will
    // read whatever the rule needs next. Passing the member wholesale is what
    // lets the shared rule change without the page having to be found and
    // changed too — and it is why adding `financeAccessLevel` to the rule
    // needed no change here at all.
    expect(gate).toContain("canAdminRequestMembershipCancellation(member)");
  });

  it("never gates cancellation on access roles or login state", () => {
    // The #2354 regression itself: any access-role or login predicate HERE
    // re-hides the action for dependants and non-login adults, whom the API
    // accepts. The helper's own narrow use of those fields — refusing the
    // lodge kiosk and the non-login booking-request contact records — is
    // documented at its definition and covered by member-roles.test.ts.
    expect(gate).not.toContain("hasAccessRole");
    expect(gate).not.toContain("accessRoles");
    expect(gate).not.toContain("canLogin");
  });

  it("never re-implements the rule with a role comparison", () => {
    // #2383: the rule it replaced was a bare legacy-role equality test whose
    // name and behaviour disagreed. The page must not grow its own copy.
    expect(gate).not.toContain("role");
    expect(gate).not.toContain("ADMIN");
    expect(gate).not.toContain("SCHOOL");
  });

  it("still requires no open request before offering the action", () => {
    // Not part of the API's own validation — the API answers an existing
    // open request with a 409, so the page must not offer a doomed action.
    expect(gate).toContain("openCancellationRequest");
  });
});
