import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #2350 round 2 — the member's "pay this extra" card must not appear on a
  booking whose lifecycle can no longer collect money.

  Cancelling a booking marks the additional intent FAILED and leaves
  `additionalAmountCents` exactly as it was, and the cancel path asks Stripe to
  cancel only an intent that was still OUTSTANDING — one that had already failed
  (a declined card) stays confirmable at Stripe. So while the card's condition
  was amount-and-status only, the owner of a cancelled booking was shown a
  payment form, the secret route behind it handed out a live client secret, and
  a retry with a good card went through. The late-capture backstop (#1350)
  auto-refunds and alerts, but the member had still been charged for a booking
  that no longer existed.

  Checked over the TypeScript AST rather than the file text, for the reason
  `booking-no-emails-ui-contract.test.ts` had to learn twice: the page carries
  comments quoting the very expressions being matched, and raw text cannot tell
  a call site from prose about one.
*/

/*
  #2958 SPLIT THE BOOKING PAGE, and this census did not notice until CI did.

  It used to name one file: `bookings/[id]/page.tsx`. The card moved into
  `_components/booking-payment-cards.tsx` with the rest of the pay doors, so the
  census went looking for it where it no longer lives and failed with "no longer
  on the booking page" — which was true of the FILE and false of the SURFACE.

  Two changes, and the second is the point. It now reads the whole booking-detail
  ROUTE DIRECTORY rather than one file inside it, so a later move between
  modules cannot disarm it again. And it asserts the guard on EVERY render site
  it finds rather than on the first one: while the page was a single file "the
  first site" and "the only site" were the same sentence, and after a split they
  are not — a second, ungated copy in a sibling module is exactly the shape this
  rule has to keep out.

  Worth writing down for the next lane, because the SELECTION missed this too:
  the path below used to be composed segment by segment across seven lines, so
  grepping the test tree for the literal `(authenticated)/bookings/[id]` — the
  usual way to find the suites a route change affects — did not match this file.
  A census can name its target without any line of it containing the target's
  path.
*/
const ROUTE_DIR = join(
  process.cwd(),
  "src",
  "app",
  "(authenticated)",
  "bookings",
  "[id]",
);

/** Every production `.ts`/`.tsx` in the booking-detail route directory. */
function routeSourceFiles(dir: string = ROUTE_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") routeSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

const SECRET_ROUTE = join(
  process.cwd(),
  "src",
  "app",
  "api",
  "bookings",
  "[id]",
  "additional-payment-secret",
  "route.ts",
);

function parse(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function findFirst(
  node: ts.Node,
  predicate: (candidate: ts.Node) => boolean,
): ts.Node | null {
  if (predicate(node)) return node;
  for (const child of node.getChildren()) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function eachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  visit(root);
  root.forEachChild((child) => eachNode(child, visit));
}

function callsFunction(node: ts.Node, name: string): boolean {
  return (
    findFirst(
      node,
      (candidate) =>
        ts.isCallExpression(candidate) &&
        ts.isIdentifier(candidate.expression) &&
        candidate.expression.text === name,
    ) !== null
  );
}

describe("the member's additional-payment card", () => {
  it("renders only for a lifecycle that can still collect the money", () => {
    const files = routeSourceFiles();
    // Guards against a directory move making this assertion vacuous: an empty
    // scan would otherwise report "no ungated site" and pass.
    expect(files.length, "booking-detail route directory not found").toBeGreaterThan(10);

    const sites: Array<{ file: string; card: ts.Node }> = [];
    for (const file of files) {
      const source = parse(file);
      eachNode(source, (node) => {
        const tag = ts.isJsxSelfClosingElement(node)
          ? node.tagName
          : ts.isJsxOpeningElement(node)
            ? node.tagName
            : null;
        if (tag != null && tag.getText(source) === "AdditionalPaymentCard") {
          sites.push({ file: relative(ROUTE_DIR, file), card: node });
        }
      });
    }
    expect(
      sites.map((site) => site.file),
      "AdditionalPaymentCard is no longer anywhere on the booking-detail surface",
    ).not.toEqual([]);

    // EVERY site, not the first: after #2958 a second copy would land in a
    // sibling module rather than below the first one in the same file.
    const ungated = sites.filter(({ card }) => {
      // The `{...}` container the card is rendered from: its expression is the
      // whole guard, and it holds no comment trivia, so this is code only.
      let container: ts.Node | undefined = card;
      while (container && !ts.isJsxExpression(container)) {
        container = container.parent;
      }
      if (!container) return true;
      const guard = (container as ts.JsxExpression).expression;
      if (!guard) return true;
      return !callsFunction(guard, "isAdditionalPayableBookingStatus");
    });
    expect(
      ungated.map((site) => site.file),
      "every AdditionalPaymentCard render site must sit inside a JSX expression " +
        "guard that calls isAdditionalPayableBookingStatus",
    ).toEqual([]);
  });

  it("is gated by the same predicate as the route that hands out the secret", () => {
    const route = parse(SECRET_ROUTE);
    expect(callsFunction(route, "isAdditionalPayableBookingStatus")).toBe(true);
  });
});
