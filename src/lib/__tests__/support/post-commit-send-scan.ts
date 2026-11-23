import ts from "typescript";

import { TRANSACTION_OPENERS } from "@/lib/__tests__/support/lock1-transaction-scan";

/**
 * The reader behind `post-commit-send-census.test.ts` (#5433, `INV-INT-004`):
 * every place, in the scoped files, where a function sends a notice after it
 * has run a transaction. Each one is a notice a committed change may owe, and
 * the census asks whether it goes through the owed-notice mechanism or has a
 * recorded reason.
 *
 * Per module, by syntax tree:
 *
 * - a UNIT is a top-level named function: a function declaration, a `const`
 *   holding a function, or a class method. Everything nested inside a unit
 *   (closures, callbacks) is read as part of it, in source order;
 * - a TRANSACTION POINT is the end of a call to a transaction opener (the
 *   `TRANSACTION_OPENERS` the lock(1) census reads, plus
 *   `runSavedCardClaimRelease`, which commits a release of its own), or to
 *   another unit of the same module that contains one. A send INSIDE the
 *   transaction's callback ends before the point and is not counted;
 * - a SEND is a call whose name is `send`, `alert` or `notify` followed by a
 *   capital letter (which covers `sendEmail`, `sendToAdmins` and
 *   `sendUnmuteableAdminAlert`), or a call to another unit of the same module
 *   that contains a send (how it finds a reaper's `finishReap`);
 * - a SITE is a send that starts after the unit's first transaction point.
 *   Sites are keyed `file#unit#callee`, with the number of calls.
 *
 * It reads the syntax tree, so a comment naming a sender or an opener is never
 * a site; the census's cheap first pass over the tree strips comments first
 * (`stripComments`) for the same reason (`INV-SSOT-004`).
 */

/** The files the census reads (the paths #5433's plan traced). */
export const POST_COMMIT_SEND_SCOPE: readonly RegExp[] = [
  /^src\/lib\/cron-[^/]+\.ts$/,
  /^src\/lib\/[^/]+-payment-cron\.ts$/,
  /^src\/lib\/xero-inbound\/.+\.ts$/,
  /^src\/lib\/stripe-webhook-service\.ts$/,
  /^src\/lib\/group-settlement\.ts$/,
  /^src\/lib\/group-late-joiner\.ts$/,
  /^src\/lib\/waitlist\.ts$/,
  /^src\/app\/api\/webhooks\/.+\.ts$/,
];

/** Calls that commit a transaction of their own. */
export const COMMITTING_CALLS: ReadonlySet<string> = new Set([...Object.keys(TRANSACTION_OPENERS), "runSavedCardClaimRelease"]);

const SENDER = /^(?:send|alert|notify)[A-Z]/;

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** The module's top-level named functions, each with every call inside it. */
function units(source: ts.SourceFile): Map<string, ts.CallExpression[]> {
  const found = new Map<string, ts.CallExpression[]>();
  const collect = (name: string, body: ts.Node) => {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(body);
    found.set(name, calls);
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      collect(statement.name?.text ?? "default", statement.body);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (ts.isIdentifier(declaration.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          collect(declaration.name.text, init.body);
        }
      }
    } else if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
          collect(`${statement.name?.text ?? "default"}.${member.name.text}`, member.body);
        }
      }
    }
  }
  return found;
}

/** The units whose calls reach `direct` names, directly or through other units (a fixpoint). */
function reaching(all: Map<string, ts.CallExpression[]>, direct: (name: string) => boolean): Set<string> {
  const reached = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [unit, calls] of all) {
      if (reached.has(unit)) continue;
      if (calls.some((call) => {
        const name = calleeName(call);
        return name !== null && name !== unit && (direct(name) || reached.has(name));
      })) {
        reached.add(unit);
        grew = true;
      }
    }
  }
  return reached;
}

/** One module's sites: `file#unit#callee` to the number of calls. */
export function scanPostCommitSends(rel: string, code: string): Map<string, number> {
  const source = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const all = units(source);
  const committing = reaching(all, (name) => COMMITTING_CALLS.has(name));
  const sending = reaching(all, (name) => SENDER.test(name));
  const sites = new Map<string, number>();
  for (const [unit, calls] of all) {
    const named = calls.map((call) => ({ call, name: calleeName(call) }));
    const points = named
      .filter(({ name }) => name !== null && name !== unit && (COMMITTING_CALLS.has(name) || committing.has(name)))
      .map(({ call }) => call.getEnd());
    if (points.length === 0) continue;
    const firstPoint = Math.min(...points);
    for (const { call, name } of named) {
      if (name === null || name === unit || call.getStart() < firstPoint) continue;
      if (!SENDER.test(name) && !sending.has(name)) continue;
      const key = `${rel}#${unit}#${name}`;
      sites.set(key, (sites.get(key) ?? 0) + 1);
    }
  }
  return sites;
}
