/**
 * `test-clock/no-date-now-elapsed` (#4462): the frozen test clock's elapsed-time
 * rule, enforced instead of written down.
 *
 * Every Vitest file runs with `Date` frozen at 2026-07-01T00:00:00.000Z
 * (`docs/TESTING.md` -> "The frozen test clock"), so `Date.now()` is a constant
 * there. Two uses of it then stop measuring anything:
 *
 * - a stopwatch, `Date.now() - start` where `start` was itself `Date.now()`,
 *   always reads 0, so "it did not wait" passes vacuously;
 * - a deadline, `Date.now() < deadline` where `deadline` was `Date.now() + n`,
 *   never moves, so a polling loop either never ends or never runs.
 *
 * Both are recognised when the earlier reading is inline or held in a plain
 * variable (`const start = Date.now()`, `let deadline; deadline = Date.now() +
 * n`). A reading kept on an object property is not followed.
 *
 * Use `realElapsedMs(process.hrtime.bigint())` from
 * `src/lib/__tests__/helpers/clock.ts` for either. Reading "now" for a fixture
 * (`new Date(Date.now() - DAY_MS)`) or comparing a fixture instant with it
 * (`lockedUntil.getTime() > Date.now()`) is deterministic under the freeze and
 * is not reported; `docs/TESTING.md` rule 2 covers fixtures as advice.
 */

const MESSAGE =
  "Date.now() is frozen in tests, so {{shape}} never measures real time. " +
  "Use realElapsedMs(process.hrtime.bigint()) from src/lib/__tests__/helpers/clock.ts " +
  '(docs/TESTING.md -> "The frozen test clock", rule 5).';

const COMPARISONS = new Set(["<", "<=", ">", ">="]);

/** `Date.now()`, with an optional `globalThis.` or `window.` prefix ignored. */
function isDateNow(node) {
  if (node?.type !== "CallExpression" || node.arguments.length !== 0) return false;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.name !== "now") return false;
  const object = callee.object;
  if (object.type === "Identifier") return object.name === "Date";
  return (
    object.type === "MemberExpression" &&
    !object.computed &&
    object.property.name === "Date" &&
    object.object.type === "Identifier" &&
    ["globalThis", "window", "global"].includes(object.object.name)
  );
}

/** `Date.now()` itself, or `Date.now() + n` / `Date.now() - n`: a clock reading. */
function isReading(node) {
  if (isDateNow(node)) return true;
  return (
    node?.type === "BinaryExpression" &&
    (node.operator === "+" || node.operator === "-") &&
    (isDateNow(node.left) || isDateNow(node.right))
  );
}

/** Whether `node` is a reading, or a variable that is ever set to one. */
function heldReading(context, node) {
  if (isReading(node)) return true;
  if (node?.type !== "Identifier") return false;
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      if (variable.defs.some((def) => isReading(def.node?.init))) return true;
      return variable.references.some((reference) => isReading(reference.writeExpr));
    }
    scope = scope.upper;
  }
  return false;
}

const noDateNowElapsed = {
  meta: {
    type: "problem",
    schema: [],
    messages: { frozen: MESSAGE },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (COMPARISONS.has(node.operator)) {
          if (isDateNow(node.left) && heldReading(context, node.right)) {
            context.report({ node: node.left, messageId: "frozen", data: { shape: "a deadline" } });
          } else if (isDateNow(node.right) && heldReading(context, node.left)) {
            context.report({ node: node.right, messageId: "frozen", data: { shape: "a deadline" } });
          }
          return;
        }
        if (node.operator === "-" && isDateNow(node.left) && heldReading(context, node.right)) {
          context.report({ node: node.left, messageId: "frozen", data: { shape: "a stopwatch" } });
        }
      },
    };
  },
};

const testClock = { rules: { "no-date-now-elapsed": noDateNowElapsed } };

export default testClock;
