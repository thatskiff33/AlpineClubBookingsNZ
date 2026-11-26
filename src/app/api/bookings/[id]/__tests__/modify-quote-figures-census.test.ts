import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #5238 (`INV-MOD-062`): every successful preview carries `quotedFigures`.

  Both edit doors refuse a save without figures (409 `EDIT_FIGURES_REQUIRED`),
  and the panel's Save stays disabled until a preview has answered, sending
  that preview's `quotedFigures` back. So a preview that answered 200 without
  them would let the member press Save on a page that can only be refused. The
  panel's half, that every kind of save sends them, is
  `edit-booking-panel-save-figures.test.tsx`.

  Counted over the TypeScript AST, so a comment is never a hit: each call to
  `NextResponse.json(body, init?)` or `connectionJson(request, body, shape,
  init?)` whose `init` sets no status, or a 2xx one, must hand an object
  literal with a `quotedFigures` property. A body built elsewhere and passed by
  name is reported too, since this census cannot see inside it.

  This test reads the source tree from disk, so `pnpm run test:related` cannot
  reach it. Run it by name.
*/

const PREVIEW_FILES = [
  "src/app/api/bookings/[id]/modify-quote/route.ts",
  // The admin date shift's preview, returned by the route above.
  "src/lib/booking-shift-preview.ts",
];

/** Where the body and the init sit in each JSON-answering call. */
const ANSWERS: Record<string, { body: number; init: number }> = {
  "NextResponse.json": { body: 0, init: 1 },
  connectionJson: { body: 1, init: 3 },
};

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return `${callee.expression.text}.${callee.name.text}`;
  }
  return "";
}

function propertyNamed(literal: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return literal.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
}

/** True when the response this init builds is a 2xx: no init, no status, or a 2xx literal. */
function answersSuccess(init: ts.Expression | undefined): boolean {
  if (!init) return true;
  if (!ts.isObjectLiteralExpression(init)) return false;
  const status = propertyNamed(init, "status");
  if (!status) return true;
  if (!ts.isPropertyAssignment(status)) return false;
  const value = status.initializer;
  return ts.isNumericLiteral(value) && Number(value.text) >= 200 && Number(value.text) < 300;
}

function successAnswers(file: string): Array<{ line: number; carriesFigures: boolean }> {
  const text = readFileSync(join(process.cwd(), file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const answers: Array<{ line: number; carriesFigures: boolean }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const position = ANSWERS[calleeName(node)];
      if (position && answersSuccess(node.arguments[position.init])) {
        const body = node.arguments[position.body];
        answers.push({
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          carriesFigures:
            body !== undefined && ts.isObjectLiteralExpression(body) && propertyNamed(body, "quotedFigures") !== undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return answers;
}

describe("every successful edit preview carries quotedFigures (#5238)", () => {
  it.each(PREVIEW_FILES)("%s", (file) => {
    const answers = successAnswers(file);

    // Not vacuous: each file really answers a preview.
    expect(answers.length, `${file} has no successful answer to check`).toBeGreaterThan(0);
    expect(
      answers.filter((answer) => !answer.carriesFigures).map((answer) => `${file}:${answer.line}`),
      "a successful preview without quotedFigures leaves Save refused 409 EDIT_FIGURES_REQUIRED",
    ).toEqual([]);
  });
});
