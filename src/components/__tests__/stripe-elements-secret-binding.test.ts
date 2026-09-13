import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #3340 acceptance criterion 4, the other half — THE FORM REBINDS WHEN THE SECRET
  CHANGES.

  Stripe treats `options.clientSecret` as IMMUTABLE after `<Elements>` mounts.
  Handing it a different secret changes nothing: the mounted PaymentElement goes
  on confirming the intent it was born with, which is exactly how a member came
  to be charged $65 against a superseded intent on a page reading $300. The only
  fix available in the library's contract is to remount, and the only way to make
  React remount is a changed `key`.

  Checked over the AST rather than the file text, for the reason
  `additional-payment-card-gate.test.ts` states: the file carries comments
  quoting the very expressions being matched, and raw text cannot tell a call
  site from prose about one.

  MUTATION PROOF: delete the `key` prop, or key it on anything but
  `clientSecret`, and this fails.
*/

const STRIPE_PROVIDER = join(
  process.cwd(),
  "src",
  "components",
  "stripe",
  "StripeProvider.tsx",
);

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

describe("the Stripe Elements binding", () => {
  it("is keyed on the client secret, so a changed secret remounts the form", () => {
    const source = parse(STRIPE_PROVIDER);

    const opening = findFirst(
      source,
      (node) =>
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText() === "Elements",
    ) as ts.JsxOpeningElement | ts.JsxSelfClosingElement | null;
    expect(opening, "<Elements> is no longer rendered by StripeProvider").not.toBeNull();

    const keyProp = opening!.attributes.properties.find(
      (property) =>
        ts.isJsxAttribute(property) && property.name.getText() === "key",
    ) as ts.JsxAttribute | undefined;
    expect(
      keyProp,
      "<Elements> has no `key`, so a changed clientSecret cannot rebind the form (#3340)",
    ).toBeDefined();

    const initializer = keyProp!.initializer;
    expect(initializer && ts.isJsxExpression(initializer)).toBe(true);
    expect((initializer as ts.JsxExpression).expression?.getText()).toBe(
      "clientSecret",
    );
  });

  it("hands the page the intent's OWN amount and id, not a second source for them", () => {
    const source = parse(SECRET_ROUTE);

    // The success response object literal: `NextResponse.json({ clientSecret ...
    const response = findFirst(
      source,
      (node) =>
        ts.isObjectLiteralExpression(node) &&
        node.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText() === "clientSecret",
        ),
    ) as ts.ObjectLiteralExpression | null;
    expect(response, "the secret route no longer returns a clientSecret").not.toBeNull();

    const assignments = new Map<string, string>();
    for (const property of response!.properties) {
      if (ts.isPropertyAssignment(property)) {
        assignments.set(property.name.getText(), property.initializer.getText());
      }
    }

    // All three from the SAME PaymentIntent. Reading the amount off
    // `payment.additionalAmountCents` — the Payment column's mirror — is the
    // second source the #3340 display defect lived in.
    expect(assignments.get("clientSecret")).toBe("pi.client_secret");
    expect(assignments.get("amountCents")).toBe("pi.amount");
    expect(assignments.get("paymentIntentId")).toBe("pi.id");
  });
});
