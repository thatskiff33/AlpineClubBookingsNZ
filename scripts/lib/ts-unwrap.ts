/**
 * The one "strip wrappers that change no shape" walk for scripts that read
 * TypeScript with the compiler's parser (#4927, `INV-SSOT`).
 *
 * `(x)`, `x as T`, `x satisfies T`, `x!` and `<T>x` all evaluate to `x`, so a
 * scanner asking "what is this expression really?" looks through every one of
 * them. Shared by the audit censuses (through `scripts/audit/ts-call-site-scan.ts`)
 * and the function-length ratchet, so they cannot disagree about which kinds
 * are see-through.
 */
import ts from "typescript";

export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}
