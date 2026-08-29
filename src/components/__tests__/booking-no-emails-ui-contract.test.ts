import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The closed-world scan below asks "does this file touch `notifyMember`", and
// raw text cannot tell a call site from prose about one. Several of these files
// discuss the flag at length, and `booking-no-emails-notice.tsx` — which does not
// touch it at all — explains the whole honesty rule in its module comment.
// Matching raw text enrolled it as a notify-prompt surface.
import { stripComments } from "@/lib/__tests__/support/strip-comments";

/*
  #2259 (owner decision D10) — the two invariants the "No emails" UI must never
  break, checked structurally rather than by review.

  1. A MEMBER MUST NEVER LEARN THE SWITCH EXISTS. The booking detail page serves
     members and admins from one file, so the control, the banner, and every
     `noEmails` value it produces have to sit behind an admin predicate. Not
     only the render: props are serialised into client-component RSC payloads,
     so a prop threaded unconditionally leaks the switch on the wire even when
     nothing draws it.

  2. THE HONESTY RULE. While the switch is on, no per-action prompt may offer to
     email the member. The mailer withholds the message either way, so offering
     the choice invites the admin to pick "…and email member" and walk away
     believing the member was told — the exact false belief D10's acknowledgement
     exists as the compensating control for.

  Both run over the TypeScript AST rather than over file text, for the reason
  `view-only-banner-contract.test.ts` had to learn twice: raw text cannot tell a
  call site from prose about a call site, and every file here carries comments
  quoting the very expressions being matched.
*/

const SRC = join(process.cwd(), "src");

const BOOKING_PAGE = join(
  SRC,
  "app",
  "(authenticated)",
  "bookings",
  "[id]",
  "page.tsx",
);

/**
 * Admin predicates the booking page may gate on. `canSeeAdminTools` is the
 * page's own "Full Admin or Booking Officer" gate; the role comparison is what
 * the cancel and modify routes themselves resolve before honouring
 * `notifyMember`, so a value gated on it can only reach a viewer the server
 * already treats as an admin.
 */
const ADMIN_GATES = [
  /\bcanSeeAdminTools\b/,
  /viewerAuthorizationRole\s*===/,
  /\bnoEmailsState\b/,
];

/**
 * Every surface that offers a per-action "email the member?" choice about a
 * BOOKING, and therefore has to drop that choice while the switch is on.
 *
 * The closed-world assertion below is what keeps this list honest: the set of
 * files mentioning `notifyMember` must be exactly this list plus the
 * deliberately-excluded one, so a NEW notify prompt anywhere forces a decision
 * about the switch instead of silently escaping the rule.
 */
const BOOKING_NOTIFY_PROMPTS = [
  // #2262: recording a booking's cash / off-Xero payment offers the club's
  // standard "email the member?" choice, and the confirmation it would send is
  // booking-scoped, so the switch must take the choice away.
  "components/admin/booking-manual-payment-controls.tsx",
  "components/admin/confirm-pending-guests-button.tsx",
  "components/cancel-booking-button.tsx",
  "components/edit-booking-panel.tsx",
  "components/admin/booking-requests/booking-approvals-panel.tsx",
  "app/(admin)/admin/waitlist/page.tsx",
  "app/(admin)/admin/refund-requests/page.tsx",
];

/**
 * Surveyed and deliberately NOT changed, each with the reason it is out of
 * scope. Written down here rather than in a commit message, because the next
 * person's question is "was this one missed?" and the answer has to be
 * checkable.
 */
const NOT_BOOKING_BOUND: Record<string, string> = {
  // A booking that does not exist yet cannot carry the switch.
  "app/(admin)/admin/book/page.tsx":
    "creates a NEW booking; there is nothing silenced yet",
  // BookingRequest, not Booking. Its templates are explicitly excluded from
  // ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES for the same reason.
  "components/admin/booking-requests/public-booking-requests-panel.tsx":
    "declines a public BookingRequest before any Booking row exists",
  // Membership / account / family lifecycle: keyed on a member, not a booking.
  // The switch is deliberately booking-keyed and never address-keyed, so it
  // does not and must not reach these.
  "app/(admin)/admin/membership-cancellations/page.tsx":
    "membership-scoped: reviews cancellation participants, not a booking",
  "app/(admin)/admin/member-applications/page.tsx":
    "membership application review, not a booking",
  "app/(admin)/admin/deletion-requests/deletion-requests-client.tsx":
    "account deletion (privacy) request, not a booking",
  "app/(admin)/admin/members/[id]/_components/member-lifecycle-card.tsx":
    "member archive/delete lifecycle, not a booking",
  "app/(admin)/admin/members/[id]/_components/member-partner-link-card.tsx":
    "member partner link, not a booking",
  "components/admin/family-groups/request-review-section.tsx":
    "family group request review, not a booking",
  // #2260: manual mark-paid for a membership SUBSCRIPTION. Keyed on a member's
  // season row, never on a Booking, so no booking's switch can reach it — the
  // sender passes bookingContext "none" for exactly that reason.
  "app/(admin)/admin/subscriptions/_components/manual-payment-dialog.tsx":
    "membership subscription mark-paid, not a booking",
  "app/(admin)/admin/subscriptions/page.tsx":
    "membership subscription mark-paid, not a booking",
  // The one genuinely awkward case. The roster send is per DATE and fans out
  // across every booking staying that night, so it is not one booking's choice
  // to suppress: silencing the prompt would misdescribe what happens to the
  // OTHER bookings' guests, who are still emailed. A silenced booking's own
  // `chore-roster` mail is already withheld by the mailer's gate, which is
  // where a multi-booking send has to be handled.
  "app/(admin)/admin/roster/page.tsx":
    "per-date roster send fanning out across many bookings; the mailer's gate silences each one individually",
};

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

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function isJsxTag(node: ts.Node): node is JsxTag {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
}

function lineOf(ast: ts.SourceFile, node: ts.Node): number {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}

/**
 * The text of every condition `node` is rendered under: the test of each
 * enclosing `? :`, the left operand of each enclosing `&&`, and the condition
 * of each enclosing `if`. This is what "is it gated" means for a render site —
 * it is only reached when all of them hold, so matching ANY of them is the
 * correct (and conservative) reading of "gated on".
 */
function guardTexts(ast: ts.SourceFile, node: ts.Node): string[] {
  const out: string[] = [];
  let cur: ts.Node = node;
  while (cur.parent) {
    const parent = cur.parent;
    if (ts.isConditionalExpression(parent) && parent.condition !== cur) {
      out.push(parent.condition.getText(ast));
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === cur
    ) {
      out.push(parent.left.getText(ast));
    }
    if (ts.isIfStatement(parent) && parent.thenStatement === cur) {
      out.push(parent.expression.getText(ast));
    }
    cur = parent;
  }
  return out;
}

function jsxTagsNamed(ast: ts.SourceFile, name: string): JsxTag[] {
  const out: JsxTag[] = [];
  eachNode(ast, (node) => {
    if (isJsxTag(node) && node.tagName.getText(ast) === name) out.push(node);
  });
  return out;
}

/** Every `.tsx` source file under `src`, excluding tests. */
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (
      entry.name.endsWith(".tsx") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("No emails UI is admin-only (#2259)", () => {
  const ast = parse(BOOKING_PAGE);

  it("finds the surface it is meant to police", () => {
    // Guards against a tree move making every assertion below vacuous.
    expect(
      ast.getFullText().length,
      "booking detail page not found or empty",
    ).toBeGreaterThan(1000);
    expect(ast.getFullText()).toContain("BookingWithheldEmailsBanner");
  });

  it("proves the indirection it accepts as a gate", () => {
    /*
      `noEmailsState` counts as an admin gate below because it is null for
      anyone who is not an admin. That is only true while its DECLARATION says
      so, and nothing else in this suite would notice if it stopped — every
      render site would keep passing while quietly gating on nothing. So the
      declaration is checked here, once, and the indirection is earned rather
      than assumed.
    */
    const declarations: ts.VariableDeclaration[] = [];
    eachNode(ast, (node) => {
      if (!ts.isVariableDeclaration(node)) return;
      if (node.name.getText(ast) !== "noEmailsState") return;
      declarations.push(node);
    });
    expect(declarations, "noEmailsState is not declared here").toHaveLength(1);

    const initializer = declarations[0].initializer?.getText(ast) ?? "";
    expect(
      /\bcanSeeAdminTools\b/.test(initializer),
      `noEmailsState is treated as an admin gate throughout this suite. Its ` +
        `declaration must derive from canSeeAdminTools, or every render site ` +
        `gated on it is gated on nothing.`,
    ).toBe(true);
    // …and it must actually be ABSENT for a non-admin, not merely different.
    expect(initializer).toMatch(/:\s*null/);
  });

  it("renders the withheld-emails banner only behind the admin gate", () => {
    const sites = jsxTagsNamed(ast, "BookingWithheldEmailsBanner");
    expect(sites.length, "the banner is never rendered").toBeGreaterThan(0);

    const offenders = sites
      .filter(
        (site) =>
          !guardTexts(ast, site).some((guard) =>
            ADMIN_GATES.some((gate) => gate.test(guard)),
          ),
      )
      .map((site) => `page.tsx:${lineOf(ast, site)}`);

    expect(
      offenders,
      `The booking detail page serves MEMBERS as well as admins. A ` +
        `withheld-emails banner rendered outside the admin gate tells a ` +
        `member the "No emails" switch exists — the one thing #2258/#2259 ` +
        `must never do.`,
    ).toEqual([]);
  });

  it("renders the switch itself only behind the admin gate", () => {
    // The control lives inside AdminBookingToolsCard, which is itself gated;
    // the state it needs is produced here, so the production is what is checked.
    const sites = jsxTagsNamed(ast, "AdminBookingToolsCard");
    expect(sites.length).toBeGreaterThan(0);
    const offenders = sites
      .filter(
        (site) =>
          !guardTexts(ast, site).some((guard) =>
            ADMIN_GATES.some((gate) => gate.test(guard)),
          ),
      )
      .map((site) => `page.tsx:${lineOf(ast, site)}`);
    expect(offenders).toEqual([]);
  });

  it("never hands a member the switch KEY, let alone its value, on the wire", () => {
    /*
      Stronger than "gate the value", and the difference is the whole point.

      React Flight serialises the property NAME as well as the value. A
      conditional VALUE still ships the key: `noEmails={admin ? x : false}`
      lands as `"noEmails":false` in a member's payload and
      `noEmails: admin ? x : undefined` lands as `"noEmails":"$undefined"`.
      Either way a member who reads the wire learns the switch exists — they
      merely do not learn its state, which is not the guarantee #2258/#2259
      makes.

      So the only accepted shape is a conditional SPREAD, which omits the key
      entirely. Every `noEmails` produced on this page must either be inside an
      admin-gated spread or inside an object that is itself only built for an
      admin (`noEmailsState`, whose own declaration is proved above).
    */
    const offenders: string[] = [];

    /*
      A JSX attribute literally named `noEmails` ships its key — UNLESS the
      element carrying it is itself only rendered for an admin, in which case
      the element (and every key on it) is absent from a member's payload
      entirely. The admin-tools card and the withheld-emails banner are in that
      position, and demanding a spread there would be cargo cult.

      The two the review caught were the opposite case: `CancelBookingButton`
      and the booking-editor data are rendered for EVERY viewer, so their keys
      shipped to members. Those must use the conditional spread.
    */
    eachNode(ast, (node) => {
      if (!isJsxTag(node)) return;
      const renderGated = guardTexts(ast, node).some((guard) =>
        ADMIN_GATES.some((gate) => gate.test(guard)),
      );
      if (renderGated) return;
      for (const prop of node.attributes.properties) {
        if (!ts.isJsxAttribute(prop)) continue;
        if (prop.name.getText(ast) !== "noEmails") continue;
        offenders.push(
          `page.tsx:${lineOf(ast, prop)} <${node.tagName.getText(ast)} noEmails=…> ` +
            `is rendered for members too — use a conditional spread so their ` +
            `payload has no such key`,
        );
      }
    });

    // The same rule for object literals: a bare `noEmails:` property is only
    // safe inside an object that does not exist for a member at all.
    let propertiesSeen = 0;
    eachNode(ast, (node) => {
      if (!ts.isPropertyAssignment(node)) return;
      if (node.name.getText(ast) !== "noEmails") return;
      propertiesSeen += 1;
      // Inside an admin-gated conditional (e.g. the `noEmailsState` literal),
      // the whole object is absent for a member, so the key cannot leak.
      const inGatedObject = guardTexts(ast, node).some((guard) =>
        ADMIN_GATES.some((gate) => gate.test(guard)),
      );
      // …or inside a conditional spread, whose parent is the `? :` that
      // chooses between `{ noEmails: … }` and `{}`.
      const inConditionalSpread = (() => {
        let cur: ts.Node = node;
        while (cur.parent) {
          if (ts.isSpreadAssignment(cur.parent)) return true;
          if (
            ts.isConditionalExpression(cur.parent) &&
            ts.isSpreadAssignment(cur.parent.parent ?? cur.parent)
          ) {
            return true;
          }
          cur = cur.parent;
        }
        return false;
      })();
      if (!inGatedObject && !inConditionalSpread) {
        offenders.push(
          `page.tsx:${lineOf(ast, node)} noEmails: ${node.initializer.getText(ast)} ` +
            `— ships the key to a member; use a conditional spread`,
        );
      }
    });

    expect(
      propertiesSeen,
      "no `noEmails` value is produced here at all; the check has gone blind",
    ).toBeGreaterThan(0);
    expect(
      offenders,
      `React Flight serialises the KEY as well as the value, so a gated value ` +
        `is not enough: "noEmails":false in a member's payload still tells ` +
        `them the switch exists. Use {...(admin ? { noEmails } : {})}.`,
    ).toEqual([]);
  });

  it("proves the sanctioned spread form is actually in use", () => {
    // Guards the rule above against becoming vacuous by deletion: if the
    // spreads disappeared, the "no bare key" checks would pass trivially.
    const spreads: ts.Node[] = [];
    eachNode(ast, (node) => {
      if (!ts.isSpreadAssignment(node) && !ts.isJsxSpreadAttribute(node)) return;
      if (!/noEmails/.test(node.getText(ast))) return;
      spreads.push(node);
    });
    expect(
      spreads.length,
      "the member-safe conditional-spread form is no longer used anywhere",
    ).toBeGreaterThanOrEqual(2);
    for (const spread of spreads) {
      expect(
        ADMIN_GATES.some((gate) => gate.test(spread.getText(ast))),
        `page.tsx:${lineOf(ast, spread)} spreads noEmails without an admin gate`,
      ).toBe(true);
    }
  });

  it("does not even query the withheld list for a member", () => {
    const calls: ts.CallExpression[] = [];
    eachNode(ast, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === "getWithheldBookingEmailSummary"
      ) {
        calls.push(node);
      }
    });
    expect(calls.length, "the withheld list is never read").toBeGreaterThan(0);

    const offenders = calls
      .filter(
        (call) =>
          !guardTexts(ast, call).some((guard) =>
            ADMIN_GATES.some((gate) => gate.test(guard)),
          ),
      )
      .map((call) => `page.tsx:${lineOf(ast, call)}`);

    expect(
      offenders,
      `Reading the withheld list for a member puts withheld subjects one ` +
        `careless prop away from their screen. Query it only behind the gate.`,
    ).toEqual([]);
  });
});

describe("No emails honesty rule (#2259)", () => {
  it("accounts for every notify-member prompt in the repo", () => {
    /*
      The closed world. A new "email the member?" prompt must be classified —
      booking-bound (and therefore subject to the rule) or not — rather than
      quietly joining neither list.
    */
    const found = sourceFiles()
      .filter((file) =>
        // Comments stripped first: raw text cannot tell a call site from prose
        // about one, and `booking-no-emails-notice.tsx` — which never touches
        // the flag — explains this very rule in its module comment. Matching
        // raw text enrolled it as a notify-prompt surface.
        /\bnotifyMember\b|\bnotifyRequester\b/.test(
          stripComments(readFileSync(file, "utf8")),
        ),
      )
      .map((file) => relative(SRC, file).split(sep).join("/"));

    expect(found.length).toBeGreaterThan(10);
    expect(
      found.sort(),
      `A surface that asks "email the member?" is either about a BOOKING — ` +
        `and must drop the choice while the switch is on — or it is not. Add ` +
        `it to BOOKING_NOTIFY_PROMPTS or to NOT_BOOKING_BOUND with the reason.`,
    ).toEqual(
      [...BOOKING_NOTIFY_PROMPTS, ...Object.keys(NOT_BOOKING_BOUND)].sort(),
    );
  });

  it("offers no email choice on a silenced booking", () => {
    /*
      For each booking-bound prompt: every affirmative "…and email member"
      action must render under a negated `noEmails` guard. Re-offer the choice
      with the switch on — delete the guard — and this fails, which is the point.

      Both spellings of a button label are collected: JSX text
      (`>Save and email member<`) and a string literal inside a JSX expression
      (the `decision === "REJECTED" ? … : …` labels the review queues use). A
      check that saw only the first would be silently vacuous on two of the six.
    */
    const offenders: string[] = [];

    for (const rel of BOOKING_NOTIFY_PROMPTS) {
      const file = join(SRC, ...rel.split("/"));
      const ast = parse(file);

      // The shared note has to be reachable at all.
      if (!ast.getFullText().includes("BookingNoEmailsNotice")) {
        offenders.push(`${rel} never renders <BookingNoEmailsNotice>`);
      }

      const affirmatives: ts.Node[] = [];
      eachNode(ast, (node) => {
        if (ts.isJsxText(node)) {
          if (/and email member/i.test(node.getText(ast))) affirmatives.push(node);
          return;
        }
        // A string literal only counts inside JSX — a toast or an audit string
        // is not an offered choice.
        if (!ts.isStringLiteral(node)) return;
        if (!/and email member/i.test(node.text)) return;
        let cur: ts.Node | undefined = node.parent;
        while (cur) {
          if (ts.isJsxExpression(cur)) {
            affirmatives.push(node);
            return;
          }
          cur = cur.parent;
        }
      });

      if (affirmatives.length === 0) {
        offenders.push(`${rel} has no "…and email member" action to police`);
        continue;
      }

      for (const node of affirmatives) {
        const guarded = guardTexts(ast, node).some(
          (guard) => guard.trimStart().startsWith("!") && /noEmails/i.test(guard),
        );
        if (!guarded) {
          offenders.push(
            `${rel}:${lineOf(ast, node)} offers "…and email member" with no negated noEmails guard`,
          );
        }
      }
    }

    expect(
      offenders,
      `While the "No emails" switch is on, the mailer withholds the message ` +
        `whichever button the admin presses. Offering the choice therefore ` +
        `invites a false belief that the member was told — the exact harm ` +
        `D10's acknowledgement is the compensating control for.`,
    ).toEqual([]);
  });

  it("never promises a choice or an audit entry on the silenced path", () => {
    /*
      The rule above polices BUTTON LABELS. That is not enough, and two rounds
      of review proved it: the labels were correct while the surrounding copy
      still said "your choice is recorded in the audit log" on the silenced
      branch of five dialogs, the cancel success panel, and the cancel preview.

      Since H1 the silenced path sends no `notifyMember` at all, so there IS no
      choice and no recorded choice — pointing an officer at an audit entry
      that does not exist is worse than saying nothing, because the message
      they are hunting for is the cancellation the member never received.
      "Either way" is banned on the same branch for the same reason: it asserts
      a fork that no longer exists.

      Mechanically: collect every subtree that only renders when the booking IS
      silenced, and forbid this vocabulary inside it.
    */
    const BANNED =
      /recorded in the audit log|choose whether|will choose|your choice|either way/i;

    const offenders: string[] = [];

    for (const rel of BOOKING_NOTIFY_PROMPTS) {
      const file = join(SRC, ...rel.split("/"));
      const ast = parse(file);
      const silencedSubtrees: ts.Node[] = [];

      eachNode(ast, (node) => {
        // `noEmails ? <silenced> : <normal>` / `!noEmails ? <normal> : <silenced>`
        if (ts.isConditionalExpression(node)) {
          const condition = node.condition.getText(ast);
          if (!/noEmails/i.test(condition)) return;
          const negated = condition.trimStart().startsWith("!");
          silencedSubtrees.push(negated ? node.whenFalse : node.whenTrue);
          return;
        }
        // `noEmails && <silenced>` — but NOT `!noEmails && <normal>`.
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          const left = node.left.getText(ast);
          if (!/noEmails/i.test(left)) return;
          if (left.trimStart().startsWith("!")) return;
          /*
            A DISJUNCTION only means "maybe silenced", so its body is not a
            silenced-path subtree. The waitlist force-confirm report is guarded
            by `notifiedMember === false || noEmails` precisely because it
            serves both cases, and its audit-log sentence is correct for the
            ordinary one — the inner `noEmails ? … : …` is what separates them,
            and that ternary IS policed above.

            The narrow cost: banned copy written unconditionally inside such a
            card is not caught here. That is the honest reading of the guard
            rather than a hole to paper over, and the ternary rule covers the
            shape this family actually uses.
          */
          if (/\|\|/.test(left)) return;
          silencedSubtrees.push(node.right);
        }
      });

      if (silencedSubtrees.length === 0) {
        offenders.push(`${rel} has no silenced-path branch to police`);
        continue;
      }

      for (const subtree of silencedSubtrees) {
        eachNode(subtree, (node) => {
          const text = ts.isJsxText(node)
            ? node.getText(ast)
            : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
              ? node.text
              : null;
          if (text === null) return;
          const match = text.match(BANNED);
          if (!match) return;
          offenders.push(
            `${rel}:${lineOf(ast, node)} silenced-path copy says "${match[0]}"`,
          );
        });
      }
    }

    expect(
      offenders,
      `With the switch on there is no email choice and no recorded choice — ` +
        `the silenced path sends no notifyMember at all. Copy promising ` +
        `either sends the officer hunting for an audit entry that does not ` +
        `exist, instead of at the withheld list that names what the member ` +
        `never received. Say what happened and point at the banner.`,
    ).toEqual([]);
  });

  it("never lets the suppressed path skip the send that records the withhold", () => {
    /*
      H1 — the compensating control must not blind itself.

      `notifyMember: false` tells the ROUTE not to send at all. The mailer's
      gate therefore never runs, no `SKIPPED_NO_EMAILS` row is written, and the
      booking's withheld-list banner cannot name the cancellation (or
      confirmation, or modification) the officer just performed silently. On an
      otherwise quiet booking the banner would say "Nothing has been withheld
      yet" immediately after a silent cancellation — while the operator guide
      tells the officer to work down that list.

      So the silenced path must send NO flag: the send is attempted, the gate
      withholds it, and the row is recorded. Member outcome is identical either
      way; only the audit trail differs, and only in the direction that makes
      the banner true.

      Mechanically: every `noEmails`-conditional expression in these files that
      chooses a `notifyMember` value must select `undefined` on the silenced
      side, never `false`.
    */
    const offenders: string[] = [];

    for (const rel of BOOKING_NOTIFY_PROMPTS) {
      const file = join(SRC, ...rel.split("/"));
      const ast = parse(file);
      let conditionals = 0;

      eachNode(ast, (node) => {
        if (!ts.isConditionalExpression(node)) return;
        const condition = node.condition.getText(ast);
        if (!/noEmails/i.test(condition)) return;
        // Which branch runs when the booking IS silenced.
        const negated = condition.trimStart().startsWith("!");
        const silencedBranch = negated ? node.whenFalse : node.whenTrue;
        const text = silencedBranch.getText(ast).trim();
        // Only conditionals that pick a notify value are in scope; the copy
        // ternaries (labels, titles) are strings and are ignored.
        if (!/^(true|false|undefined)$/.test(text)) return;
        conditionals += 1;
        if (text !== "undefined") {
          offenders.push(
            `${rel}:${lineOf(ast, node)} sends notifyMember=${text} on the ` +
              `silenced path — the route then skips the send and nothing is recorded`,
          );
        }
      });

      // Two of the six dispatch through a named `confirmSilenced()` helper
      // instead of an inline ternary, so a zero count is only a defect when
      // neither shape is present.
      if (conditionals === 0 && !ast.getFullText().includes("confirmSilenced")) {
        offenders.push(
          `${rel} has neither a silenced-path ternary nor a confirmSilenced() ` +
            `dispatch — nothing proves it stops sending notifyMember:false`,
        );
      }
    }

    expect(
      offenders,
      `The silenced path must let the send be ATTEMPTED so the mailer's gate ` +
        `withholds AND RECORDS it. notifyMember:false makes the route skip the ` +
        `send outright, which leaves the withheld-list banner blind to the ` +
        `action the officer just performed — the banner the operator guide ` +
        `tells them to rely on.`,
    ).toEqual([]);
  });
});
