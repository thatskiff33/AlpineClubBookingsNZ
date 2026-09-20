import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

import {
  splitSqlStatements,
  stripSqlComments,
} from "../../../../prisma/migration-verification/split-statements";
import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

const TRACKED_FIELDS: Record<string, readonly string[]> = {
  booking: [
    "totalPriceCents",
    "discountCents",
    "promoAdjustmentCents",
    "finalPriceCents",
  ],
  bookingGuest: ["priceCents"],
  bookingGuestNight: ["priceCents", "priceSource"],
  bookingGuestNightAdjustment: ["amountCents"],
  promoRedemption: ["discountCents", "priceAdjustmentCents"],
  promoRedemptionAllocation: ["discountCents", "priceAdjustmentCents"],
} as const;

export type BookingMoneyWriterSite = {
  file: string;
  delegate: keyof typeof TRACKED_FIELDS;
  methods: readonly string[];
  fields: readonly string[];
  siteCount: number;
};

// Migrations before this Stage 4 boundary are immutable historical evidence,
// not new writers for this census to reject. Every later migration is scanned:
// a component-money data migration must be classified in the reviewed manifest.
const MONEY_MIGRATION_CENSUS_START = "20260914000000";

let capabilityProgram: ts.Program | undefined;

/** Contextual callback parameters need their real type, not a name heuristic. */
function typedDelegateCapability(
  node: ts.Expression,
  source: ts.SourceFile,
): boolean | undefined {
  const file = resolve(source.fileName);
  if (!ts.sys.fileExists(file)) return undefined;
  if (!capabilityProgram) {
    const config = ts.readConfigFile(resolve("tsconfig.json"), ts.sys.readFile);
    if (config.error) {
      throw new Error("Cannot read money census TypeScript config");
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      process.cwd(),
    );
    capabilityProgram = ts.createProgram(parsed.fileNames, parsed.options);
  }
  const typedSource = capabilityProgram.getSourceFile(file);
  // Synthetic mutations must never borrow evidence from the unmutated file.
  if (!typedSource || typedSource.text !== source.text) return undefined;
  let equivalent: ts.Node | undefined;
  const start = node.getStart(source);
  const find = (candidate: ts.Node) => {
    if (candidate.pos > start || candidate.end < node.end) return;
    if (
      candidate.kind === node.kind &&
      candidate.getStart(typedSource) === start &&
      candidate.end === node.end
    ) {
      equivalent = candidate;
      return;
    }
    ts.forEachChild(candidate, find);
  };
  find(typedSource);
  if (!equivalent) return undefined;
  const checker = capabilityProgram.getTypeChecker();
  const inspect = (type: ts.Type): boolean | undefined => {
    if (
      type.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)
    ) {
      return undefined;
    }
    if (type.isUnion()) {
      const parts = type.types.map(inspect);
      return parts.includes(true) ? true : parts.includes(undefined) ? undefined : false;
    }
    return [...WRITE_METHODS].some((method) => {
      const property = checker.getPropertyOfType(type, method);
      return (
        property !== undefined &&
        checker.getSignaturesOfType(
          checker.getTypeOfSymbolAtLocation(property, equivalent!),
          ts.SignatureKind.Call,
        ).length > 0
      );
    });
  };
  return inspect(checker.getTypeAtLocation(equivalent));
}

function delegateName(
  node: ts.Expression,
  source?: ts.SourceFile,
  seen = new Set<ts.Node>(),
): keyof typeof TRACKED_FIELDS | null {
  if (seen.has(node)) return null;
  seen.add(node);
  if (ts.isPropertyAccessExpression(node)) {
    if (source && isProvenOrdinaryLocalObject(node.expression, source)) {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(TRACKED_FIELDS, node.name.text)
      ? (node.name.text as keyof typeof TRACKED_FIELDS)
      : null;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression) &&
    Object.prototype.hasOwnProperty.call(
      TRACKED_FIELDS,
      node.argumentExpression.text,
    )
  ) {
    if (source && isProvenOrdinaryLocalObject(node.expression, source)) return null;
    return node.argumentExpression.text as keyof typeof TRACKED_FIELDS;
  }
  // A delegate is a capability, not a spelling convention.  In particular,
  // `const ledger = database.booking; ledger.update(...)` must remain visible.
  if (source && ts.isIdentifier(node)) {
    const binding = resolveLocalBinding(node, source);
    return binding ? delegateName(binding, source, seen) : null;
  }
  return null;
}

/** A local object literal is data, not an untyped database capability. */
function isProvenOrdinaryLocalObject(
  expression: ts.Expression,
  source: ts.SourceFile,
  seen = new Set<ts.Node>(),
): boolean {
  if (seen.has(expression)) return false;
  seen.add(expression);
  if (ts.isObjectLiteralExpression(expression)) return true;
  if (ts.isIdentifier(expression)) {
    const binding = resolveLocalBinding(expression, source);
    return (
      binding !== undefined &&
      isProvenOrdinaryLocalObject(binding, source, seen)
    );
  }
  return false;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined;
}

function enclosingScope(node: ts.Node): ts.Node | undefined {
  for (
    let cursor: ts.Node | undefined = node.parent;
    cursor;
    cursor = cursor.parent
  ) {
    if (
      ts.isSourceFile(cursor) ||
      ts.isBlock(cursor) ||
      ts.isModuleBlock(cursor) ||
      ts.isCaseBlock(cursor) ||
      ts.isForStatement(cursor) ||
      ts.isForInStatement(cursor) ||
      ts.isForOfStatement(cursor)
    ) {
      return cursor;
    }
  }
  return undefined;
}

/**
 * Does a declaration's name bind `text`?
 *
 * A declaration name is an identifier OR a destructuring pattern, and a pattern
 * nests, so the answer is recursive. This is the one home for it: the shadow
 * walk in `importedCanonicalBinding` and the local-declaration walk in the
 * delegate scan both read it. They each used to decide it themselves, and the
 * money-side spelling was the weaker of the two — it tested only
 * `ts.isIdentifier`, so `function run({ bookingFinalPriceCents }) {}` shadowed
 * the canonical import invisibly and any call at all certified the write
 * (`INV-SSOT`).
 */
function bindingDeclaresName(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some(
    (element) =>
      ts.isBindingElement(element) && bindingDeclaresName(element.name, text),
  );
}

function isNestedScope(node: ts.Node): boolean {
  return (
    ts.isFunctionLike(node) ||
    ts.isClassLike(node) ||
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node)
  );
}

/**
 * Resolve only a binding that is visible at `use`.  A whole-source same-name
 * search makes an unrelated inner `data` object evidence for a writer, which
 * is a census bypass rather than a conservative result.
 */
function resolveLocalVariableDeclaration(
  use: ts.Identifier,
  source: ts.SourceFile,
): ts.VariableDeclaration | undefined {
  const name = use.text;
  for (let scope = enclosingScope(use); scope; scope = enclosingScope(scope)) {
    let winner: ts.VariableDeclaration | undefined;
    const visit = (node: ts.Node) => {
      if (node !== scope && isNestedScope(node)) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer !== undefined &&
        node.getStart(source) < use.getStart(source) &&
        (!winner || winner.getStart(source) < node.getStart(source))
      ) {
        winner = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    if (winner) return winner;
  }
  return undefined;
}

/**
 * Whether a local binding is ever assigned to after it is declared.
 *
 * Deliberately crude, and deliberately crude in the SAFE direction: any
 * assignment or increment anywhere in the declaring scope counts, whether or
 * not it can reach the use being certified. A census that has to decide
 * "does this name still hold that value" cannot answer yes for a name that
 * anything reassigns, because the thing it is certifying is a value.
 */
function reassignmentsAfterDeclaration(
  declaration: ts.VariableDeclaration,
  source: ts.SourceFile,
): readonly ts.Node[] | undefined {
  // `undefined` means "cannot tell", which callers treat exactly as they treat
  // a reassignment. An empty array means "looked, and there are none".
  if (!ts.isIdentifier(declaration.name)) return undefined;
  const name = declaration.name.text;
  const scope = enclosingScope(declaration);
  if (!scope) return undefined;
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      node.getStart(source) > declaration.getStart(source)
    ) {
      found.push(node);
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) ||
        ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name &&
      node.getStart(source) > declaration.getStart(source)
    ) {
      found.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

function isReassignedAfterDeclaration(
  declaration: ts.VariableDeclaration,
  source: ts.SourceFile,
): boolean {
  const reassignments = reassignmentsAfterDeclaration(declaration, source);
  return reassignments === undefined || reassignments.length > 0;
}

/**
 * What a local name binds to, or NOTHING if the name can change under us.
 *
 * Returning the declaration's initializer and stopping was how every
 * certificate resolved through this function stayed claimable by writing
 * `let` instead of `const`:
 *
 *     let newTotalPriceCents = booking.totalPriceCents;
 *     newTotalPriceCents = legacyQuote.totalPriceCents;   // certified
 *
 * The `const` spelling of that same write was correctly refused, which is the
 * tell: the guard was reading the declaration and not the variable. A name
 * anything reassigns resolves to `undefined` now, so the certificate is not
 * granted and the writer is refused — the fail-closed direction, and the same
 * rule `sameParkedCondition` was already applying ten lines below.
 */
function resolveLocalBinding(
  use: ts.Identifier,
  source: ts.SourceFile,
): ts.Expression | undefined {
  const declaration = resolveLocalVariableDeclaration(use, source);
  if (!declaration) return undefined;
  if (isReassignedAfterDeclaration(declaration, source)) return undefined;
  return declaration.initializer;
}

/**
 * The census reads files the `@/` alias cannot reach. `prisma/demo-seed.ts`
 * imports the one canonical relation as `../src/lib/booking-final-price`,
 * because a seed script outside `src/` has no alias to spell. Matching the
 * specifier as text therefore reported a correct caller of the one home as an
 * escape. Resolve both spellings to the repository path they name instead.
 */
function importsCanonicalModule(
  specifier: string,
  importingFile: string,
  canonicalPath: string,
): boolean {
  const normalise = (path: string): string | undefined => {
    const segments: string[] = [];
    for (const segment of path.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        // `pop()` on an empty array is a no-op, so a specifier that climbs
        // above the repository root wrapped back onto the canonical path and
        // certified a writer that imports nothing this repository can spell.
        if (segments.length === 0) return undefined;
        segments.pop();
        continue;
      }
      segments.push(segment);
    }
    return segments.join("/");
  };
  if (specifier.startsWith("@/")) {
    return normalise(`src/${specifier.slice(2)}`) === canonicalPath;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const directory = importingFile.replaceAll("\\", "/").split("/");
    directory.pop();
    return normalise(`${directory.join("/")}/${specifier}`) === canonicalPath;
  }
  return false;
}

/**
 * A same-named local function is not the money helper.  The census proves the
 * binding at the call site is the canonical import, rather than trusting its
 * spelling, so a shadowed helper cannot certify a writer.
 */
function importedCanonicalBinding(
  use: ts.Identifier,
  source: ts.SourceFile,
  canonicalPath: string,
): boolean {
  let imported = false;
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !importsCanonicalModule(
        statement.moduleSpecifier.text,
        source.fileName,
        canonicalPath,
      ) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    imported ||= statement.importClause.namedBindings.elements.some(
      (specifier) =>
        specifier.name.text === use.text &&
        (specifier.propertyName?.text ?? specifier.name.text) === use.text,
    );
  }
  if (!imported) return false;
  // Parameters live on the function node rather than its body block.  Check
  // the lexical ancestors directly so a parameter that shadows an otherwise
  // valid top-level import cannot be mistaken for that import.
  for (let cursor: ts.Node | undefined = use.parent; cursor; cursor = cursor.parent) {
    if (
      ts.isFunctionLike(cursor) &&
      cursor.parameters.some((parameter) =>
        bindingDeclaresName(parameter.name, use.text),
      )
    ) {
      return false;
    }
  }
  for (let scope = enclosingScope(use); scope; scope = enclosingScope(scope)) {
    if (ts.isSourceFile(scope)) break;
    // A catch clause binds its variable ON THE CLAUSE, not inside the block it
    // guards, so walking the block's children never reaches it and the scope
    // walk then climbs straight to the source file and stops.
    if (
      ts.isCatchClause(scope.parent) &&
      scope.parent.block === scope &&
      scope.parent.variableDeclaration &&
      bindingDeclaresName(scope.parent.variableDeclaration.name, use.text)
    ) {
      return false;
    }
    let shadowed = false;
    const visit = (node: ts.Node) => {
      if (shadowed || (node !== scope && isNestedScope(node))) return;
      if (
        ((ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
          bindingDeclaresName(node.name, use.text)) ||
        (ts.isFunctionDeclaration(node) && node.name?.text === use.text)
      ) {
        shadowed = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);
    if (shadowed) return false;
  }
  return true;
}

/**
 * The payload expressions a relation operand may legitimately be spelled as.
 * More than one is possible on a parked edit; see `withBranchOperands`.
 */
type ExpectedOperands = {
  totalPriceCents?: readonly ts.Expression[];
  promoAdjustmentCents?: readonly ts.Expression[];
};

/** A payload that writes the column contributes exactly one spelling to start. */
function acceptedOperand(
  value: ts.Expression | undefined,
): readonly ts.Expression[] | undefined {
  return value ? [value] : undefined;
}

/**
 * Compare one operand of the canonical relation against the payload value for
 * the same column.
 *
 * Every operand must be the payload's own spelling of the column it names. A
 * relation fed a total this write is not storing computes a headline for some
 * other row: the stored pair then fails the relation, and the difference is
 * what every settlement decision and Xero line reads. Reconciliation notices
 * the mismatch when someone next renders the booking, which is after the write,
 * the settlement and the invoice; preventing the write is this census's job.
 *
 * Accepting an unwritten operand "as long as it is not a hard-coded number" was
 * tried (`ec3c1fb86`) and reverted: it admitted
 * `bookingFinalPriceCents({ totalPriceCents: someOtherBooking.totalPriceCents,
 * ... })` and every variant of it, on `update`, `updateMany` and both branches
 * of an `upsert`, and no writer in this tree needed it — all thirteen booking
 * writers that store `finalPriceCents` store `totalPriceCents` with it, and a
 * `create` takes the new-booking exemption before reaching here.
 */
function canonicalOperandMatches(
  operand: ts.Expression | undefined,
  accepted: readonly ts.Expression[] | undefined,
  source: ts.SourceFile,
): boolean {
  // The relation takes both operands; a call missing one is not that relation.
  if (!operand) return false;
  if (!accepted || accepted.length === 0) return false;
  return accepted.some(
    (candidate) => candidate.getText(source) === operand.getText(source),
  );
}

/**
 * Can this expression be read a second time and answer the same both times?
 *
 * Only a read of state something else already computed qualifies. A call, a
 * `new`, an `await`, a tagged template, an assignment or an increment may
 * answer differently on the second reading, so two identically-spelled copies
 * of one of those are two conditions rather than one.
 */
function isReReadableExpression(expression: ts.Node): boolean {
  let stable = true;
  const visit = (node: ts.Node) => {
    if (!stable) return;
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    ) {
      stable = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return stable;
}

/**
 * Are two parked ternaries turning on ONE value?
 *
 * They have to be, because the write stores one branch's total beside the same
 * branch's final price: if the two ternaries can disagree, the stored pair is
 * a total from one world and a headline from the other, which is exactly the
 * pair this census exists to refuse. Comparing the two conditions as SOURCE
 * TEXT asserted that without being able to see it — `isParked()` here and
 * `isParked()` there are the same eleven characters and two evaluations of a
 * call, which may answer differently.
 *
 * So resolve the condition rather than reading it. A name that binds a local
 * `const` is identified by the declaration it resolves to: the same value
 * however it is spelled, and a different value however alike it is spelled.
 * Only when neither side names a binding the census can resolve does the text
 * carry any weight at all, and then only for an expression that cannot answer
 * differently the second time it is read — which is what the one real site
 * needing that fallback (`pricingResult.kind === "priced"`) is.
 */
function sameParkedCondition(
  left: ts.Expression,
  right: ts.Expression,
  source: ts.SourceFile,
): boolean {
  const constantBinding = (
    expression: ts.Expression,
    depth = 0,
  ): ts.VariableDeclaration | undefined => {
    if (depth > 4 || !ts.isIdentifier(expression)) return undefined;
    const declaration = resolveLocalVariableDeclaration(expression, source);
    if (!declaration || !ts.isVariableDeclarationList(declaration.parent)) {
      return undefined;
    }
    // A `let` can be reassigned between the two ternaries, so only a `const`
    // is demonstrably the same value at both of them.
    if (!(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
    // `const alsoParked = parked` is a second SPELLING of one value, not a
    // second value, so follow the alias to the declaration both names reach.
    return declaration.initializer && ts.isIdentifier(declaration.initializer)
      ? (constantBinding(declaration.initializer, depth + 1) ?? declaration)
      : declaration;
  };
  const leftBinding = constantBinding(left);
  const rightBinding = constantBinding(right);
  if (leftBinding || rightBinding) {
    return leftBinding !== undefined && leftBinding === rightBinding;
  }
  // The comment above says only a `const` is demonstrably the same value at
  // both ternaries — but the rule was enforced only when at least one side
  // WAS one. With two `let` identifiers neither side produced a binding, and
  // the text compare below then accepted them as one parked edit although the
  // name was reassigned in between. An identifier that names a local this
  // census can see, and did not qualify as a const above, therefore resolves
  // to nothing rather than falling through to its own spelling.
  for (const side of [left, right]) {
    if (
      ts.isIdentifier(side) &&
      resolveLocalVariableDeclaration(side, source) !== undefined
    ) {
      return false;
    }
  }
  return (
    left.getText(source) === right.getText(source) &&
    isReReadableExpression(left) &&
    isReReadableExpression(right)
  );
}

/**
 * Whether an assignment provably cannot have run on the branch being certified.
 *
 * This is what lets the census stay sound AND keep a correct writer. The real
 * shape in the tree is:
 *
 *     let newTotalPriceCents = booking.totalPriceCents;
 *     if (!parkedFinancialReview) { newTotalPriceCents = repriced.totalPriceCents; }
 *     const newFinalPriceCents = parkedFinancialReview ? booking.finalPriceCents : ...;
 *
 * On the parked branch the guard is false, so the reassignment cannot have
 * happened and the name still holds `booking.totalPriceCents` — which is what
 * makes the parked receiver check pass. Refusing every reassigned name
 * outright would report that writer, and the issue is explicit that a repair
 * which starts reporting correct callers is a false positive needing a
 * different answer. This is that answer.
 *
 * It only ever DISCOUNTS an assignment, and only when the guard is the parked
 * condition itself (resolved, not spelled) with a polarity the branch
 * excludes. Anything it cannot read that way still counts, so the unreadable
 * case stays refused.
 */
function assignmentReachabilityOnBranch(
  assignment: ts.Node,
  conditional: ts.ConditionalExpression,
  branchIndex: number,
  source: ts.SourceFile,
): "excluded" | "certain" | "unknown" {
  // "excluded": the guards say this assignment cannot have run on this branch.
  // "certain": they say it definitely did, and nothing else guards it.
  // "unknown": anything this cannot read that way, which callers refuse.
  let sawMatchingGuard = false;
  for (
    let cursor: ts.Node | undefined = assignment;
    cursor;
    cursor = cursor.parent
  ) {
    const parent = cursor.parent;
    if (!parent || !ts.isIfStatement(parent)) continue;
    const inThen = parent.thenStatement === cursor;
    const inElse = parent.elseStatement === cursor;
    if (!inThen && !inElse) continue;
    let guard: ts.Expression = parent.expression;
    let guardRequiresTrue = inThen;
    while (
      ts.isPrefixUnaryExpression(guard) &&
      guard.operator === ts.SyntaxKind.ExclamationToken
    ) {
      guard = guard.operand;
      guardRequiresTrue = !guardRequiresTrue;
    }
    // An enclosing `if` on something OTHER than the parked condition makes the
    // assignment conditional on a question this census cannot answer, so the
    // whole thing is unknown however the parked guards read.
    if (!sameParkedCondition(guard, conditional.condition, source)) {
      return "unknown";
    }
    // Branch 0 is `whenTrue`, where the condition holds.
    if (guardRequiresTrue !== (branchIndex === 0)) return "excluded";
    sawMatchingGuard = true;
  }
  return sawMatchingGuard ? "certain" : "unknown";
}

/**
 * What a local name binds to on one branch of a parked ternary.
 *
 * Same fail-closed rule as `resolveLocalBinding`, minus the assignments this
 * branch provably excludes.
 */
function branchAwareBinding(
  use: ts.Identifier,
  conditional: ts.ConditionalExpression,
  branchIndex: number,
  source: ts.SourceFile,
): ts.Expression | undefined {
  const declaration = resolveLocalVariableDeclaration(use, source);
  if (!declaration) return undefined;
  const reassignments = reassignmentsAfterDeclaration(declaration, source);
  if (reassignments === undefined) return undefined;
  const live = reassignments.filter(
    (assignment) =>
      assignmentReachabilityOnBranch(
        assignment,
        conditional,
        branchIndex,
        source,
      ) !== "excluded",
  );
  // Nothing this branch does not exclude: the declaration still stands.
  if (live.length === 0) return declaration.initializer;
  // Exactly one, and this branch is the one that runs it: the name holds what
  // that assignment put there. Any other shape — two live assignments, or one
  // whose reachability cannot be read — is refused, because a census that
  // guesses between two values is not certifying anything.
  if (
    live.length === 1 &&
    ts.isBinaryExpression(live[0]) &&
    assignmentReachabilityOnBranch(
      live[0],
      conditional,
      branchIndex,
      source,
    ) === "certain"
  ) {
    return live[0].right;
  }
  return undefined;
}

/**
 * The expression a parked payload value takes ON the branch being certified.
 *
 * Resolves a name to what it binds and a ternary on the same parked condition
 * to that condition's matching branch, so the caller compares values rather
 * than spellings. A ternary on a DIFFERENT condition yields nothing: the value
 * on this branch is then unknown, and an unknown is not evidence.
 */
function parkedBranchValue(
  expression: ts.Expression,
  conditional: ts.ConditionalExpression,
  branchIndex: number,
  source: ts.SourceFile,
  depth = 0,
): ts.Expression | undefined {
  if (depth > 4) return undefined;
  if (ts.isIdentifier(expression)) {
    const binding = branchAwareBinding(
      expression,
      conditional,
      branchIndex,
      source,
    );
    return binding
      ? parkedBranchValue(binding, conditional, branchIndex, source, depth + 1)
      : undefined;
  }
  if (ts.isConditionalExpression(expression)) {
    if (
      !sameParkedCondition(expression.condition, conditional.condition, source)
    ) {
      return undefined;
    }
    const branch =
      branchIndex === 0 ? expression.whenTrue : expression.whenFalse;
    return ts.isIdentifier(branch)
      ? (parkedBranchValue(
          branch,
          conditional,
          branchIndex,
          source,
          depth + 1,
        ) ?? branch)
      : branch;
  }
  return expression;
}

/**
 * Is this branch of the ternary the row's OWN stored headline?
 *
 * Certify it by the receiver it reads, not by the column name it spells.
 * `? legacyQuote.finalPriceCents :` is a property access named
 * `finalPriceCents` and is some other row's money; stored beside this row's
 * total it writes a pair that satisfies the relation for neither row, and the
 * difference is what every settlement decision then reads.
 *
 * The write supplies the proof. On the same branch the payload's own total must
 * be read off the same object, so what gets stored is one row's already-agreed
 * pair and the relation it satisfied before the write survives it. All four
 * parked writers in this tree store `booking.totalPriceCents` beside
 * `booking.finalPriceCents`, which is what that rule says out loud.
 */
function isStoredHeadlineBranch(
  branch: ts.Expression,
  conditional: ts.ConditionalExpression,
  branchIndex: number,
  expectedTotals: readonly ts.Expression[] | undefined,
  source: ts.SourceFile,
): boolean {
  if (
    !ts.isPropertyAccessExpression(branch) ||
    branch.name.text !== "finalPriceCents"
  ) {
    return false;
  }
  const receiver = branch.expression.getText(source);
  return (expectedTotals ?? []).some((candidate) => {
    const total = parkedBranchValue(
      candidate,
      conditional,
      branchIndex,
      source,
    );
    return (
      total !== undefined &&
      ts.isPropertyAccessExpression(total) &&
      total.name.text === "totalPriceCents" &&
      total.expression.getText(source) === receiver
    );
  });
}

/**
 * The D3 build-up helper is not the certificate; the selection handed to it is.
 *
 * `d3CompatibleBookingMoneyBuildUpCents` yields the recorded build-up amount,
 * or the derived one when the stored base is unknown, so the money it returns
 * is THIS write's money only when the derived figure the selection was made
 * against is the canonical relation over the very operands this payload stores.
 * Certifying the call by its NAME made the exemption something a writer grants
 * itself: any later function taking that name left the census altogether, next
 * to a hard-coded total. Resolve the selection's `derivedCents` instead and put
 * it through the same relation check every other headline goes through, so the
 * exemption is earned by the argument rather than claimed by the name.
 *
 * What this does NOT prove: that the recorded build-up the selection prefers
 * equals that derived figure. Nothing visible in the syntax could — it is a
 * database read — and reconciling the two is what the build-up programme's own
 * reader census and D3 decision cover.
 */
/**
 * The one selector whose result the D3 exemption is granted to, and the module
 * it must be imported from. Named here rather than inline so the D3 check and
 * the helper dispatch below cannot drift to different spellings of the same
 * module path.
 */
const CANONICAL_BUILD_UP_MODULE = "src/lib/booking-money-build-up";
const CANONICAL_BUILD_UP_SELECTOR = "selectLoadedBookingMoneyBuildUp";

function d3SelectionProvesCanonicalFinalPrice(
  selection: ts.Expression | undefined,
  source: ts.SourceFile,
  expectedOperands: ExpectedOperands | undefined,
  seen: Set<ts.Node>,
  depth = 0,
): boolean {
  if (!selection || depth > 4) return false;
  if (ts.isIdentifier(selection)) {
    const binding = resolveLocalBinding(selection, source);
    return (
      binding !== undefined &&
      d3SelectionProvesCanonicalFinalPrice(
        binding,
        source,
        expectedOperands,
        seen,
        depth + 1,
      )
    );
  }
  if (!ts.isCallExpression(selection)) return false;
  // WHO produced the selection, not just what it was handed. This accepted any
  // call at all whose arguments contained an object literal with a canonical
  // `derivedCents`, so the exemption was claimable by argument shape:
  //
  //     const selection = whateverIWant(loaded, { derivedCents: derived });
  //     const verified = d3CompatibleBookingMoneyBuildUpCents(selection);
  //
  // and that is exploitable rather than merely untidy, because
  // `BookingMoneyBuildUpSelection` is a plain structural union — a helper
  // returning an arbitrary `selectedCents` type-checks, and the canonical
  // `derived` exists only to satisfy this scanner. The selection must come
  // from the one canonical selector, resolved as an import of the build-up
  // module rather than matched by name.
  if (
    !ts.isIdentifier(selection.expression) ||
    selection.expression.text !== CANONICAL_BUILD_UP_SELECTOR ||
    !importedCanonicalBinding(
      selection.expression,
      source,
      CANONICAL_BUILD_UP_MODULE,
    )
  ) {
    return false;
  }
  for (const argument of selection.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      let derived: ts.Expression | undefined;
      if (
        ts.isPropertyAssignment(property) &&
        propertyName(property.name) === "derivedCents"
      ) {
        derived = property.initializer;
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === "derivedCents"
      ) {
        derived = property.name;
      }
      if (
        derived &&
        expressionUsesCanonicalFinalPrice(
          derived,
          source,
          expectedOperands,
          seen,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Follow a parked edit into the branch being checked.
 *
 * A parked writer stores its four columns from parallel ternaries on the one
 * condition: the total is `parked ? stored : computed`, and the final price is
 * `parked ? stored : relation(...)`. Inside the computed branch the relation may
 * legitimately be fed either spelling — the ternary variable itself, which
 * evaluates to the computed total on that branch, or the computed expression
 * the ternary chooses — and the tree contains both. Comparing only the whole
 * ternary reported `booking-batch-modification-service.ts` as an escape, and
 * comparing only the branch reported `api/bookings/[id]/guests/route.ts`; each
 * is a correct caller. Accept the branch AS WELL, and only when the payload
 * value is parked on the same condition, so a writer that feeds the relation
 * the stored figure, or mixes two conditions, is still refused.
 */
function withBranchOperands(
  expectedOperands: ExpectedOperands | undefined,
  conditional: ts.ConditionalExpression,
  branchIndex: number,
  source: ts.SourceFile,
): ExpectedOperands | undefined {
  if (!expectedOperands) return expectedOperands;
  const widen = (
    accepted: readonly ts.Expression[] | undefined,
  ): readonly ts.Expression[] | undefined => {
    if (!accepted || accepted.length === 0) return accepted;
    const widened = [...accepted];
    for (const candidate of accepted) {
      // Route through the ONE resolver for "what is this expression on the
      // parked branch". This used to do its own single hop while
      // `parkedBranchValue` — called from the other half of the very same
      // conjunction — recursed and resolved the branch it picked. Two answers
      // to one question, and the disagreement was reachable: one extra local
      // between the declaration and the ternary flipped a CORRECT writer to
      // refused.
      const onBranch = parkedBranchValue(
        candidate,
        conditional,
        branchIndex,
        source,
      );
      if (onBranch && onBranch !== candidate) widened.push(onBranch);
    }
    return widened;
  };
  return {
    totalPriceCents: widen(expectedOperands.totalPriceCents),
    promoAdjustmentCents: widen(expectedOperands.promoAdjustmentCents),
  };
}

function expressionUsesCanonicalFinalPrice(
  expression: ts.Expression,
  source: ts.SourceFile,
  expectedOperands?: ExpectedOperands,
  seen = new Set<ts.Node>(),
): boolean {
  if (seen.has(expression)) return false;
  seen.add(expression);
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const helper = expression.expression;
    const imported = importedCanonicalBinding(
      helper,
      source,
      helper.text === "bookingFinalPriceCents"
        ? "src/lib/booking-final-price"
        : CANONICAL_BUILD_UP_MODULE,
    );
    if (!imported) return false;
    if (helper.text === "d3CompatibleBookingMoneyBuildUpCents") {
      return d3SelectionProvesCanonicalFinalPrice(
        expression.arguments[0],
        source,
        expectedOperands,
        seen,
      );
    }
    const argument = expression.arguments[0];
    if (!argument || !ts.isObjectLiteralExpression(argument)) return false;
    const operands = new Map<string, ts.Expression>();
    for (const property of argument.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name);
        if (name) operands.set(name, property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        operands.set(property.name.text, property.name);
      }
    }
    return (
      canonicalOperandMatches(
        operands.get("totalPriceCents"),
        expectedOperands?.totalPriceCents,
        source,
      ) &&
      canonicalOperandMatches(
        operands.get("promoAdjustmentCents"),
        expectedOperands?.promoAdjustmentCents,
        source,
      )
    );
  }
  if (ts.isIdentifier(expression)) {
    const binding = resolveLocalBinding(expression, source);
    return (
      binding !== undefined &&
      expressionUsesCanonicalFinalPrice(binding, source, expectedOperands, seen)
    );
  }
  // Parked edits deliberately preserve the stored value on one branch; the
  // computed branch must still use the one canonical relation.
  if (ts.isConditionalExpression(expression)) {
    const branches = [expression.whenTrue, expression.whenFalse];
    return (
      branches.some((branch, index) =>
        expressionUsesCanonicalFinalPrice(
          branch,
          source,
          withBranchOperands(expectedOperands, expression, index, source),
          seen,
        ),
      ) &&
      branches.some((branch, index) =>
        isStoredHeadlineBranch(
          branch,
          expression,
          index,
          expectedOperands?.totalPriceCents,
          source,
        ),
      )
    );
  }
  return false;
}

function expressionUsesCanonicalDiscount(
  expression: ts.Expression,
  promo: ts.Expression | undefined,
  source: ts.SourceFile,
  seen = new Set<ts.Node>(),
): boolean {
  if (seen.has(expression)) return false;
  seen.add(expression);
  if (ts.isIdentifier(expression)) {
    const binding = resolveLocalBinding(expression, source);
    return (
      binding !== undefined &&
      expressionUsesCanonicalDiscount(binding, promo, source, seen)
    );
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Math" &&
    expression.expression.name.text === "max" &&
    expression.arguments.length === 2 &&
    expression.arguments[0]!.getText(source) === "0"
  ) {
    const negated = expression.arguments[1]!;
    return (
      ts.isPrefixUnaryExpression(negated) &&
      negated.operator === ts.SyntaxKind.MinusToken &&
      promo !== undefined &&
      negated.operand.getText(source) === promo.getText(source)
    );
  }
  return false;
}

function isPairedPromoResult(
  discount: ts.Expression,
  promo: ts.Expression | undefined,
): boolean {
  return (
    promo !== undefined &&
    ts.isPropertyAccessExpression(discount) &&
    ts.isPropertyAccessExpression(promo) &&
    discount.name.text === "newDiscountCents" &&
    promo.name.text === "newPromoAdjustmentCents" &&
    discount.expression.getText() === promo.expression.getText()
  );
}

function isPairedPromoVariables(
  discount: ts.Expression,
  promo: ts.Expression | undefined,
  source: ts.SourceFile,
): boolean {
  if (!ts.isIdentifier(discount) || !promo || !ts.isIdentifier(promo)) {
    return false;
  }

  const discountDeclaration = resolveLocalVariableDeclaration(discount, source);
  const promoDeclaration = resolveLocalVariableDeclaration(promo, source);
  if (!discountDeclaration || !promoDeclaration) return false;
  if (
    discountDeclaration.initializer?.getText(source) !== "0" ||
    promoDeclaration.initializer?.getText(source) !== "0"
  ) {
    return false;
  }

  type Assignment = {
    value: ts.Expression;
    path: string;
    position: number;
  };
  const containsIdentifier = (node: ts.Node, name: string): boolean => {
    let found = false;
    const visit = (child: ts.Node) => {
      if (ts.isIdentifier(child) && child.text === name) found = true;
      if (!found) ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const controlFlowPath = (node: ts.Node): string => {
    const path: string[] = [];
    for (
      let cursor: ts.Node | undefined = node.parent;
      cursor;
      cursor = cursor.parent
    ) {
      if (ts.isIfStatement(cursor)) {
        const branch =
          cursor.thenStatement.pos <= node.pos &&
          node.end <= cursor.thenStatement.end
            ? "then"
            : cursor.elseStatement &&
                cursor.elseStatement.pos <= node.pos &&
                node.end <= cursor.elseStatement.end
              ? "else"
              : "condition";
        path.push(`${cursor.expression.getStart(source)}:${branch}`);
      } else if (
        ts.isCaseClause(cursor) ||
        ts.isDefaultClause(cursor) ||
        ts.isForStatement(cursor) ||
        ts.isForOfStatement(cursor) ||
        ts.isForInStatement(cursor) ||
        ts.isWhileStatement(cursor) ||
        ts.isDoStatement(cursor) ||
        ts.isCatchClause(cursor) ||
        ts.isConditionalExpression(cursor) ||
        (ts.isBinaryExpression(cursor) &&
          (cursor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            cursor.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            cursor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
      ) {
        // Distinct guarded expressions/loop bodies are not paired writes.
        path.push(`${cursor.kind}:${cursor.getStart(source)}`);
      }
    }
    return path.reverse().join("/");
  };
  const assignmentsBefore = (
    use: ts.Identifier,
    declaration: ts.VariableDeclaration,
  ): { assignments: Assignment[]; unsupportedMutation: boolean } => {
    const scope = enclosingScope(declaration);
    if (!scope) return { assignments: [], unsupportedMutation: true };
    const assignments: Assignment[] = [];
    let unsupportedMutation = false;
    const declaresShadow = (block: ts.Block): boolean => {
      let shadow = false;
      const inspect = (node: ts.Node) => {
        if (shadow || (node !== block && isNestedScope(node))) return;
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === use.text &&
          node !== declaration
        ) {
          shadow = true;
          return;
        }
        ts.forEachChild(node, inspect);
      };
      ts.forEachChild(block, inspect);
      return shadow;
    };
    const visit = (node: ts.Node) => {
      if (node.getStart(source) >= use.getStart(source)) return;
      if (
        node !== scope &&
        (ts.isFunctionLike(node) ||
          ts.isClassLike(node) ||
          ts.isSourceFile(node) ||
          (ts.isBlock(node) && declaresShadow(node)))
      ) {
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        containsIdentifier(node.left, use.text) &&
        node.getStart(source) > declaration.getStart(source)
      ) {
        if (
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          node.left.text === use.text
        ) {
          assignments.push({
            value: node.right,
            path: controlFlowPath(node),
            position: node.getStart(source),
          });
        } else {
          unsupportedMutation = true;
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        containsIdentifier(node.operand, use.text) &&
        node.getStart(source) > declaration.getStart(source)
      ) {
        unsupportedMutation = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return {
      assignments: assignments.sort(
        (left, right) => left.position - right.position,
      ),
      unsupportedMutation,
    };
  };

  const discountHistory = assignmentsBefore(discount, discountDeclaration);
  const promoHistory = assignmentsBefore(promo, promoDeclaration);
  if (discountHistory.unsupportedMutation || promoHistory.unsupportedMutation)
    return false;
  const discountAssignments = discountHistory.assignments;
  const promoAssignments = promoHistory.assignments;
  if (discountAssignments.length !== promoAssignments.length) return false;

  const propertyPair = (
    discountValue: ts.Expression,
    promoValue: ts.Expression,
  ): boolean => {
    if (
      !ts.isPropertyAccessExpression(discountValue) ||
      !ts.isPropertyAccessExpression(promoValue) ||
      discountValue.expression.getText(source) !==
        promoValue.expression.getText(source)
    ) {
      return false;
    }
    return (
      ["discountCents", "newDiscountCents"].includes(discountValue.name.text) &&
      [
        "promoAdjustmentCents",
        "newPromoAdjustmentCents",
        "priceAdjustmentCents",
      ].includes(promoValue.name.text)
    );
  };

  return discountAssignments.every((assignment, index) => {
    const promoAssignment = promoAssignments[index];
    return (
      promoAssignment !== undefined &&
      assignment.path === promoAssignment.path &&
      (propertyPair(assignment.value, promoAssignment.value) ||
        expressionUsesCanonicalDiscount(
          assignment.value,
          promoAssignment.value,
          source,
        ))
    );
  });
}

/**
 * A field inventory cannot distinguish a canonical relation from a nearby
 * arithmetic expression. Every written derived headline field is therefore
 * checked at its concrete payload, including partial writes.
 */
export function scanBookingMoneyWriterEqualityEscapes(
  file: string,
  code: string,
): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const escapes: string[] = [];
  type ResolvedObject = { values: Map<string, ts.Expression>; opaque: boolean };
  const resolveObject = (
    expression: ts.Expression | undefined,
    seen = new Set<ts.Node>(),
  ): ResolvedObject => {
    if (!expression || seen.has(expression))
      return { values: new Map(), opaque: true };
    seen.add(expression);
    if (ts.isIdentifier(expression)) {
      return resolveObject(resolveLocalBinding(expression, source), seen);
    }
    if (!ts.isObjectLiteralExpression(expression))
      return { values: new Map(), opaque: true };
    const values = new Map<string, ts.Expression>();
    let opaque = false;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = resolveObject(property.expression, seen);
        spread.values.forEach((value, name) => values.set(name, value));
        opaque ||= spread.opaque;
      } else if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name);
        if (name) values.set(name, property.initializer);
        else opaque = true;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        values.set(property.name.text, property.name);
      } else {
        opaque = true;
      }
    }
    return { values, opaque };
  };
  const inspectPayload = (
    payload: ResolvedObject,
    location: ts.Node,
    createsNewBooking: boolean,
  ) => {
    const { values } = payload;
    const finalPrice = values.get("finalPriceCents");
    const isZeroPromo =
      values.get("promoAdjustmentCents")?.getText(source) === "0";
    const finalEqualsTotal =
      finalPrice?.getText(source) ===
      values.get("totalPriceCents")?.getText(source);
    const hasCompleteHeadline = TRACKED_FIELDS.booking.every((field) =>
      values.has(field),
    );
    const hasPotentiallyCompleteHeadline =
      payload.opaque &&
      ["totalPriceCents", "discountCents", "promoAdjustmentCents"].every(
        (field) => values.has(field),
      );
    const line =
      source.getLineAndCharacterOfPosition(location.getStart(source)).line + 1;
    if (hasPotentiallyCompleteHeadline && !hasCompleteHeadline) {
      escapes.push(`${file}:${line}|opaqueCompleteHeadlinePayload`);
    }
    if (
      finalPrice &&
      !(isZeroPromo && finalEqualsTotal) &&
      !(
        createsNewBooking &&
        finalEqualsTotal &&
        !values.has("promoAdjustmentCents")
      ) &&
      !expressionUsesCanonicalFinalPrice(finalPrice, source, {
        totalPriceCents: acceptedOperand(values.get("totalPriceCents")),
        promoAdjustmentCents: acceptedOperand(
          values.get("promoAdjustmentCents"),
        ),
      })
    ) {
      const finalLine =
        source.getLineAndCharacterOfPosition(finalPrice.getStart(source)).line +
        1;
      escapes.push(`${file}:${finalLine}|finalPriceCents`);
    }
    const discount = values.get("discountCents");
    // Creation keeps the schema's zero default for a no-promo headline. An
    // update has an existing component and must prove it was cleared too.
    if (
      !createsNewBooking &&
      isZeroPromo &&
      !discount
    ) {
      escapes.push(`${file}:${line}|discountCents`);
    }
    if (
      discount &&
      !expressionUsesCanonicalDiscount(
        discount,
        values.get("promoAdjustmentCents"),
        source,
      ) &&
      !isPairedPromoResult(discount, values.get("promoAdjustmentCents")) &&
      !isPairedPromoVariables(
        discount,
        values.get("promoAdjustmentCents"),
        source,
      ) &&
      !(
        discount.getText(source) === "0" &&
        values.get("promoAdjustmentCents")?.getText(source) === "0"
      )
    ) {
      const discountLine =
        source.getLineAndCharacterOfPosition(discount.getStart(source)).line +
        1;
      escapes.push(`${file}:${discountLine}|discountCents`);
    }
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text) &&
      delegateName(node.expression.expression, source) === "booking"
    ) {
      const options = resolveObject(node.arguments[0]);
      if (!options.opaque || options.values.size > 0) {
        const payloadNames =
          node.expression.name.text === "upsert"
            ? new Set(["create", "update"])
            : new Set(["data"]);
        for (const [name, payloadExpression] of options.values) {
          if (payloadNames.has(name)) {
            inspectPayload(
              resolveObject(payloadExpression),
              payloadExpression,
              node.expression.name.text === "create" || name === "create",
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(escapes)].sort();
}

/** The mutating array methods are evidence only before the payload use. */
function localArrayMutations(
  use: ts.Identifier,
  source: ts.SourceFile,
): ts.Expression[] {
  const name = use.text;
  const expressions: ts.Expression[] = [];
  const scope = enclosingScope(use);
  if (!scope) return expressions;
  const declaresName = (block: ts.Block): boolean => {
    let declared = false;
    const find = (node: ts.Node) => {
      if (node !== block && isNestedScope(node)) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name
      ) {
        declared = true;
      }
      ts.forEachChild(node, find);
    };
    ts.forEachChild(block, find);
    return declared;
  };
  const visit = (node: ts.Node) => {
    if (
      node !== scope &&
      (ts.isFunctionLike(node) ||
        ts.isClassLike(node) ||
        ts.isSourceFile(node) ||
        (ts.isBlock(node) && declaresName(node)))
    )
      return;
    if (node.getStart(source) >= use.getStart(source)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      expressions.push(node.right);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === name
    ) {
      const method = node.expression.name.text;
      if (method === "push" || method === "unshift") {
        expressions.push(...node.arguments);
      } else if (method === "splice") {
        expressions.push(...node.arguments.slice(2));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return expressions;
}

/** Delegate forwarding can hide a write from the direct call-site census. */
export function scanBookingMoneyWriterEscapes(
  file: string,
  code: string,
): string[] {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const escapes = new Set<string>();
  const destructured = new Map<
    string,
    { delegate: keyof typeof TRACKED_FIELDS; forwardsCapability: boolean }
  >();
  const aliases = new Map<
    string,
    { delegate: keyof typeof TRACKED_FIELDS; forwardsCapability: boolean }
  >();
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const priorAlias = ts.isIdentifier(node.initializer)
        ? aliases.get(node.initializer.text)
        : undefined;
      const delegate =
        priorAlias?.delegate ??
        (ts.isIdentifier(node.initializer)
          ? null
          : delegateName(node.initializer, source));
      if (delegate) {
        aliases.set(node.name.text, {
          delegate,
          // Once a local is assigned a tracked delegate, its spelling carries
          // no authority.  The capability itself is what may escape.
          forwardsCapability:
            priorAlias?.forwardsCapability ??
            receiverCouldHoldDelegate(node.initializer),
        });
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      for (const element of node.name.elements) {
        const key = element.propertyName
          ? propertyName(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (
          key &&
          ts.isIdentifier(element.name) &&
          Object.prototype.hasOwnProperty.call(TRACKED_FIELDS, key)
        ) {
          destructured.set(element.name.text, {
            delegate: key as keyof typeof TRACKED_FIELDS,
            forwardsCapability: clientCouldHoldDelegate(node.initializer),
          });
        }
      }
    }
    ts.forEachChild(node, collect);
  };

  const isDirectCall = (
    node: ts.Expression,
    parent: ts.Node | undefined,
    grandparent: ts.Node | undefined,
  ) =>
    parent !== undefined &&
    grandparent !== undefined &&
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node &&
    ts.isCallExpression(grandparent) &&
    grandparent.expression === parent;

  const isLocalAliasInitializer = (
    node: ts.Expression,
    parent: ts.Node | undefined,
  ) =>
    parent !== undefined &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.initializer === node;

  const isEscapingUse = (node: ts.Expression, parent: ts.Node | undefined) =>
    parent !== undefined &&
    ((ts.isCallExpression(parent) && parent.arguments.includes(node)) ||
      (ts.isReturnStatement(parent) && parent.expression === node) ||
      (ts.isBinaryExpression(parent) && parent.right === node) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
      ts.isArrayLiteralExpression(parent));

  // An inline/local object literal is ordinary data, not a Prisma capability.
  // Unknown receivers fail closed; the census must not let a renamed client
  // evade it merely because it is not called `db` or `tx`.
  const isOrdinaryObjectProperty = (node: ts.Expression): boolean => {
    if (
      !ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)
    )
      return false;
    const receiver = node.expression;
    return isProvenOrdinaryLocalObject(receiver, source);
  };

  const parameterFor = (
    identifier: ts.Identifier,
  ): ts.ParameterDeclaration | undefined => {
    for (
      let cursor: ts.Node | undefined = identifier.parent;
      cursor;
      cursor = cursor.parent
    ) {
      if (!ts.isFunctionLike(cursor)) continue;
      const parameter = cursor.parameters.find(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === identifier.text,
      );
      if (parameter) return parameter;
    }
    return undefined;
  };

  const hasLocalDeclaration = (identifier: ts.Identifier): boolean => {
    let declared = false;
    const visitDeclaration = (node: ts.Node) => {
      if (declared) return;
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        bindingDeclaresName(node.name, identifier.text)
      ) {
        declared = true;
        return;
      }
      if (ts.isImportSpecifier(node) && node.name.text === identifier.text) {
        declared = true;
        return;
      }
      ts.forEachChild(node, visitDeclaration);
    };
    visitDeclaration(source);
    return declared;
  };

  const clientCouldHoldDelegate = (receiver: ts.Expression): boolean => {
    if (isProvenOrdinaryLocalObject(receiver, source)) return false;
    if (!ts.isIdentifier(receiver)) return false;
    const binding = resolveLocalBinding(receiver, source);
    if (binding !== undefined) return false;

    const parameter = parameterFor(receiver);
    if (parameter) {
      // Parameters are caller-provided capabilities unless their declaration
      // proves otherwise. An untyped Prisma client must not bypass the census.
      if (!parameter.type) return true;
      const type = parameter.type.getText(source);
      return /(?:^|\W)(?:any|PrismaClient|TransactionClient)(?:\W|$)/.test(
        type,
      );
    }
    return !hasLocalDeclaration(receiver);
  };

  const receiverCouldHoldDelegate = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    clientCouldHoldDelegate(node.expression);

  collect(source);

  const visit = (node: ts.Node, parent?: ts.Node, grandparent?: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      destructured.has(node.text) &&
      !(parent && ts.isBindingElement(parent))
    ) {
      const binding = destructured.get(node.text)!;
      const directWrite =
        isDirectCall(node, parent, grandparent) &&
        parent !== undefined &&
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        ((ts.isPropertyAccessExpression(parent) &&
          WRITE_METHODS.has(parent.name.text)) ||
          (ts.isElementAccessExpression(parent) &&
            ts.isStringLiteral(parent.argumentExpression) &&
            WRITE_METHODS.has(parent.argumentExpression.text)));
      // A destructured property becomes proven delegate capability only when
      // it is invoked as one. Bare `const { booking } = pageData` is an
      // ordinary domain projection and must not become a false escape.
      if (
        directWrite ||
        ((typedDelegateCapability(node, source) ??
          binding.forwardsCapability) &&
          isEscapingUse(node, parent))
      ) {
        escapes.add(`${file}|${binding.delegate}`);
      }
    }
    const candidateIdentifier = ts.isIdentifier(node) && aliases.has(node.text);
    if (
      candidateIdentifier ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const alias = ts.isIdentifier(node) ? aliases.get(node.text) : undefined;
      const delegate = ts.isIdentifier(node)
        ? (alias?.delegate ?? null)
        : delegateName(node);
      if (
        delegate &&
        !isDirectCall(node, parent, grandparent) &&
        !isLocalAliasInitializer(node, parent) &&
        isEscapingUse(node, parent) &&
        !isOrdinaryObjectProperty(node) &&
        (typedDelegateCapability(node, source) ??
          (ts.isIdentifier(node)
            ? (alias?.forwardsCapability ?? false)
            : receiverCouldHoldDelegate(node)))
      ) {
        escapes.add(`${file}|${delegate}`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, node, parent));
  };
  visit(source);
  return [...escapes].sort();
}

export function scanBookingMoneyWriterSites(
  file: string,
  code: string,
): BookingMoneyWriterSite[] {
  const uncommented = file.endsWith(".sql")
    ? stripSqlComments(code)
    : stripComments(code);
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Map<
    keyof typeof TRACKED_FIELDS,
    { methods: Set<string>; fields: Set<string>; siteCount: number }
  >();
  const record = (
    delegate: keyof typeof TRACKED_FIELDS,
    method: string,
    fields: readonly string[],
  ) => {
    const site = found.get(delegate) ?? {
      methods: new Set<string>(),
      fields: new Set<string>(),
      siteCount: 0,
    };
    site.siteCount += 1;
    site.methods.add(method);
    fields.forEach((field) => site.fields.add(field));
    found.set(delegate, site);
  };
  const resolveObjectProperties = (
    expression: ts.Expression | undefined,
    seen = new Set<ts.Node>(),
  ): { properties: ts.ObjectLiteralElementLike[]; opaque: boolean } => {
    if (!expression || seen.has(expression)) {
      return { properties: [], opaque: true };
    }
    seen.add(expression);
    if (ts.isIdentifier(expression)) {
      return resolveObjectProperties(resolveLocalBinding(expression, source), seen);
    }
    if (!ts.isObjectLiteralExpression(expression)) {
      return { properties: [], opaque: true };
    }
    const properties: ts.ObjectLiteralElementLike[] = [];
    let opaque = false;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = resolveObjectProperties(property.expression, seen);
        properties.push(...spread.properties);
        opaque ||= spread.opaque;
      } else {
        properties.push(property);
      }
    }
    return { properties, opaque };
  };
  const mutationPayloads = (
    call: ts.CallExpression,
  ): {
    payloads: ts.Expression[];
    opaqueOptions: boolean;
  } => {
    let options: ts.Expression | undefined = call.arguments[0];
    if (options && ts.isIdentifier(options)) {
      options = resolveLocalBinding(options, source);
    }
    if (!options || !ts.isObjectLiteralExpression(options)) {
      return { payloads: [], opaqueOptions: true };
    }
    const names =
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "upsert"
        ? ["create", "update"]
        : ["data"];
    const payloads: ts.Expression[] = [];
    for (const property of options.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (names.includes(property.name.text)) payloads.push(property.name);
        continue;
      }
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        names.includes(property.name.text)
      ) {
        payloads.push(property.initializer);
      }
    }
    return {
      payloads,
      opaqueOptions: payloads.length === 0,
    };
  };
  const inspectPayload = (
    expression: ts.Expression,
    delegate: keyof typeof TRACKED_FIELDS,
    nested?: keyof typeof TRACKED_FIELDS,
    seen = new Set<ts.Node>(),
  ): { fields: Set<string>; opaque: boolean } => {
    if (seen.has(expression)) return { fields: new Set(), opaque: true };
    seen.add(expression);
    if (ts.isIdentifier(expression)) {
      const binding = resolveLocalBinding(expression, source);
      if (!binding) return { fields: new Set(), opaque: true };
      const result = inspectPayload(binding, delegate, nested, seen);
      if (ts.isArrayLiteralExpression(binding)) {
        const mutations = localArrayMutations(expression, source);
        for (const mutation of mutations) {
          const next = inspectPayload(mutation, delegate, nested, seen);
          next.fields.forEach((field) => result.fields.add(field));
          result.opaque ||= next.opaque;
        }
        if (binding.elements.length === 0 && mutations.length === 0) {
          result.opaque = true;
        }
      }
      return result;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.reduce<{
        fields: Set<string>;
        opaque: boolean;
      }>(
        (result, element) => {
          if (!ts.isExpression(element))
            return { fields: result.fields, opaque: true };
          const next = inspectPayload(element, delegate, nested, seen);
          next.fields.forEach((field) => result.fields.add(field));
          return {
            fields: result.fields,
            opaque: result.opaque || next.opaque,
          };
        },
        { fields: new Set<string>(), opaque: false },
      );
    }
    if (!ts.isObjectLiteralExpression(expression))
      return { fields: new Set(), opaque: true };
    const fields = new Set<string>();
    let opaque = false;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = inspectPayload(
          property.expression,
          delegate,
          nested,
          seen,
        );
        spread.fields.forEach((field) => fields.add(field));
        opaque ||= spread.opaque;
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      ) {
        opaque = true;
        continue;
      }
      const name = propertyName(property.name);
      if (!name) {
        opaque = true;
        continue;
      }
      if (TRACKED_FIELDS[delegate].includes(name)) fields.add(name);
      const value = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : property.initializer;
      const relation =
        delegate === "booking" && name === "guests"
          ? "bookingGuest"
          : delegate === "bookingGuest" && name === "nights"
            ? "bookingGuestNight"
            : undefined;
      if (relation) {
        const relationPayload = inspectPayload(
          value,
          relation,
          undefined,
          new Set(),
        );
        const relationObject = resolveObjectProperties(value);
        if (relationObject.opaque && relationObject.properties.length > 0) {
          record(relation, "opaquePayload", []);
        }
        if (relationObject.properties.length === 0) {
          record(relation, "opaquePayload", []);
          continue;
        }
        for (const entry of relationObject.properties) {
          const method =
            ts.isPropertyAssignment(entry) && propertyName(entry.name);
          if (!method || !WRITE_METHODS.has(method)) continue;
          const nestedOptions = entry.initializer;
          const resolvedNestedOptions = ts.isIdentifier(nestedOptions)
            ? resolveLocalBinding(nestedOptions, source)
            : nestedOptions;
          const nestedObject =
            resolvedNestedOptions &&
            ts.isObjectLiteralExpression(resolvedNestedOptions)
              ? resolvedNestedOptions
              : undefined;
          const payloadNames =
            method === "upsert"
              ? ["create", "update"]
              : method === "create"
                ? []
                : ["data"];
          const payloads =
            payloadNames.length === 0
              ? [nestedOptions]
              : nestedObject
                ? nestedObject.properties.flatMap((property) =>
                    ts.isPropertyAssignment(property) &&
                    propertyName(property.name) &&
                    payloadNames.includes(propertyName(property.name)!)
                      ? [property.initializer]
                      : [],
                  )
                : [];
          const child = payloads.reduce<{
            fields: Set<string>;
            opaque: boolean;
          }>(
            (result, payload) => {
              const next = inspectPayload(payload, relation, undefined, seen);
              next.fields.forEach((field) => result.fields.add(field));
              return {
                fields: result.fields,
                opaque: result.opaque || next.opaque,
              };
            },
            {
              fields: new Set<string>(relationPayload.fields),
              opaque:
                relationPayload.opaque ||
                relationObject.opaque ||
                payloads.length === 0,
            },
          );
          record(relation, method, [...child.fields]);
          // Recurse through every relation operation, not only `create`.
          // `upsert` carries both branches, which inspectPayload sees as an
          // object containing nested relations.
          if (
            child.opaque &&
            relation === "bookingGuest" &&
            method !== "delete" &&
            method !== "deleteMany"
          ) {
            record("bookingGuestNight", "opaquePayload", []);
          }
        }
      }
    }
    return { fields, opaque };
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      const delegate = delegateName(receiver, source);
      if (delegate) {
        const tracked = TRACKED_FIELDS[delegate];
        if (tracked) {
          const payload = mutationPayloads(node);
          const inspected = payload.payloads.map((entry) =>
            inspectPayload(entry, delegate),
          );
          const written = [
            ...new Set(inspected.flatMap((entry) => [...entry.fields])),
          ];
          if (
            written.length > 0 ||
            node.expression.name.text.startsWith("delete")
          ) {
            record(delegate, node.expression.name.text, written);
          }
          // A builder passed as the whole payload cannot be classified from
          // this source file, so keep it visible to the reviewed manifest. An
          // object payload is still useful evidence even if one of its ordinary
          // (non-money) values is computed.
          if (
            (payload.opaqueOptions ||
              inspected.some((entry) => entry.opaque)) &&
            written.length === 0 &&
            !node.expression.name.text.startsWith("delete")
          )
            record(delegate, "opaquePayload", []);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  for (const rawSite of rawSqlWriterSites(uncommented, file.endsWith(".sql"))) {
    record(rawSite.delegate, "rawSql", rawSite.fields);
  }

  return [...found.entries()]
    .map(([delegate, site]) => ({
      file,
      delegate,
      methods: [...site.methods].sort(),
      fields: [...site.fields].sort(),
      siteCount: site.siteCount,
    }))
    .sort((left, right) => left.delegate.localeCompare(right.delegate));
}

function rawSqlWriterSites(
  code: string,
  isSqlFile: boolean,
): Array<{
  delegate: keyof typeof TRACKED_FIELDS;
  fields: string[];
}> {
  const sites: Array<{
    delegate: keyof typeof TRACKED_FIELDS;
    fields: string[];
  }> = [];
  for (const [delegate, tracked] of Object.entries(TRACKED_FIELDS) as Array<
    [keyof typeof TRACKED_FIELDS, readonly string[]]
  >) {
    const model = delegate[0]!.toUpperCase() + delegate.slice(1);
    const table = String.raw`(?:(?:[A-Za-z_$][\w$]*|["\x60][A-Za-z_$][\w$]*["\x60])\s*\.\s*)?["\x60]${model}["\x60]`;
    const splitStatements = isSqlFile ? splitSqlStatements(code) : [];
    const statements = splitStatements.length > 0 ? splitStatements : [code];
    for (const statement of statements) {
      const executable = isSqlFile ? stripSqlComments(statement) : statement;
      const update = new RegExp(
        String.raw`\bUPDATE\s+(?:ONLY\s+)?${table}[\s\S]*?\bSET\b([\s\S]*?)(?=\b(?:FROM|WHERE|RETURNING)\b|;|$)`,
        "i",
      ).exec(executable);
      const insert = new RegExp(
        String.raw`\bINSERT\s+INTO\s+(?:ONLY\s+)?${table}\s*\(([\s\S]*?)\)`,
        "i",
      ).exec(executable);
      const deleted = new RegExp(
        String.raw`\bDELETE\s+FROM\s+${table}\b`,
        "i",
      ).test(executable);
      const merged = new RegExp(
        String.raw`\bMERGE\s+INTO\s+(?:ONLY\s+)?${table}(?=\s|$)`,
        "i",
      ).test(executable);
      const written = tracked.filter((field) => {
        const name = new RegExp(String.raw`["\x60]?${field}["\x60]?`, "i");
        return (
          (update &&
            new RegExp(String.raw`${name.source}\s*=`, "i").test(update[1]!)) ||
          (insert &&
            new RegExp(
              String.raw`(?:^|,)\s*${name.source}\s*(?:,|$)`,
              "i",
            ).test(insert[1]!))
        );
      });
      if (written.length > 0 || deleted || merged) {
        sites.push({ delegate, fields: [...written] });
      }
    }
  }
  return sites;
}

function splitTopLevelSqlList(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      entries.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  entries.push(value.slice(start).trim());
  return entries.filter(Boolean);
}

function parenthesizedSql(
  value: string,
  openIndex: number,
): { body: string; end: number } | null {
  if (value[openIndex] !== "(") return null;
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = openIndex + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return { body: value.slice(openIndex + 1, index), end: index + 1 };
      }
    }
  }
  return null;
}

function normalizeSqlExpression(expression: string): string {
  return expression
    .replace(/::[A-Za-z_][\w.]*/g, "")
    .replace(/["`\s]/g, "")
    .toLowerCase();
}

function isSameColumnCopy(expression: string, field: string): boolean {
  const normalized = normalizeSqlExpression(expression);
  const lowerField = field.toLowerCase();
  return (
    normalized === lowerField ||
    normalized === `new.${lowerField}` ||
    normalized === `excluded.${lowerField}`
  );
}

function isCanonicalRawSqlMoneyExpression(
  delegate: keyof typeof TRACKED_FIELDS,
  field: string,
  expression: string,
): boolean {
  if (isSameColumnCopy(expression, field)) return true;
  if (delegate !== "booking") return false;
  const normalized = normalizeSqlExpression(expression).replace(
    /\b[A-Za-z_][\w$]*\./g,
    "",
  );
  if (field === "finalPriceCents") {
    return normalized === "totalpricecents+promoadjustmentcents";
  }
  if (field === "discountCents") {
    return normalized === "greatest(0,-promoadjustmentcents)";
  }
  return false;
}

/**
 * SQL writes do not have TypeScript's object shape.  Read their real SET
 * assignments after removing source and SQL comments; a field merely named in
 * prose, a WHERE clause, or a copied old value is not reconciliation evidence.
 */
export function scanBookingMoneyRawSqlEscapes(
  file: string,
  code: string,
): string[] {
  const sql = stripSqlComments(code);
  const escapes: string[] = [];
  const recordExpression = (
    delegate: keyof typeof TRACKED_FIELDS,
    field: string,
    expression: string,
  ) => {
    if (!isCanonicalRawSqlMoneyExpression(delegate, field, expression)) {
      escapes.push(`${file}|rawSql:${delegate}.${field}`);
    }
  };

  for (const [delegate, fields] of Object.entries(TRACKED_FIELDS) as Array<
    [keyof typeof TRACKED_FIELDS, readonly string[]]
  >) {
    const model = delegate[0]!.toUpperCase() + delegate.slice(1);
    const table = String.raw`(?:(?:[A-Za-z_$][\w$]*|["\x60][A-Za-z_$][\w$]*["\x60])\s*\.\s*)?["\x60]${model}["\x60]`;

    const splitStatements = splitSqlStatements(sql);
    const statements = splitStatements.length > 0 ? splitStatements : [sql];
    const mergePattern = new RegExp(
      String.raw`\bMERGE\s+INTO\s+(?:ONLY\s+)?${table}(?=\s|$)`,
      "i",
    );
    if (mergePattern.test(sql)) {
      escapes.push(`${file}|rawSql:${delegate}.unsupportedMutation`);
    }
    for (const statement of statements) {
      const updatePattern = new RegExp(
        String.raw`\bUPDATE\s+(?:ONLY\s+)?${table}[\s\S]*?\bSET\b([\s\S]*?)(?=\b(?:FROM|WHERE|RETURNING)\b|;|$)`,
        "gi",
      );
      for (const update of statement.matchAll(updatePattern)) {
        for (const assignment of splitTopLevelSqlList(update[1]!)) {
          const match = /^["`]?(\w+)["`]?\s*=\s*([\s\S]+)$/.exec(assignment);
          if (match && fields.includes(match[1]!)) {
            recordExpression(delegate, match[1]!, match[2]!);
          }
        }
      }

      const insertPattern = new RegExp(
        String.raw`\bINSERT\s+INTO\s+(?:ONLY\s+)?${table}\s*\(`,
        "gi",
      );
      for (const insert of statement.matchAll(insertPattern)) {
        const columnsOpen = insert.index + insert[0].lastIndexOf("(");
        const columns = parenthesizedSql(statement, columnsOpen);
        if (!columns) continue;
        const valuesToken = /^\s*VALUES\s*\(/i.exec(statement.slice(columns.end));
        if (!valuesToken) {
          // An INSERT ... SELECT has no positional VALUES tuple we can prove
          // against. A tracked column is a post-boundary mutation and must be
          // reviewed rather than silently treated as reconciled.
          const names = splitTopLevelSqlList(columns.body).map((name) =>
            name.replace(/["`\s]/g, ""),
          );
          // SELECT/WITH forms and any unsupported INSERT modifier (including
          // OVERRIDING SYSTEM VALUE) have no VALUES tuple to validate.
          for (const name of names) {
            if (fields.includes(name)) {
              escapes.push(`${file}|rawSql:${delegate}.${name}`);
            }
          }
          continue;
        }
        const valuesOpen = columns.end + valuesToken[0].lastIndexOf("(");
        const values = parenthesizedSql(statement, valuesOpen);
        if (!values) continue;
        const names = splitTopLevelSqlList(columns.body).map((name) =>
          name.replace(/["`\s]/g, ""),
        );
        const expressions = splitTopLevelSqlList(values.body);
        names.forEach((name, index) => {
          if (fields.includes(name) && expressions[index]) {
            recordExpression(delegate, name, expressions[index]!);
          }
        });
      }

      const conflictPattern =
        /\bON\s+CONFLICT[\s\S]*?\bDO\s+UPDATE\s+SET\b([\s\S]*?)(?=\bRETURN(?:ING)?\b|;|$)/gi;
      for (const conflict of statement.matchAll(conflictPattern)) {
        for (const assignment of splitTopLevelSqlList(conflict[1]!)) {
          const match = /^["`]?(\w+)["`]?\s*=\s*([\s\S]+)$/.exec(assignment);
          if (match && fields.includes(match[1]!)) {
            recordExpression(delegate, match[1]!, match[2]!);
          }
        }
      }

      // MERGE can contain both INSERT and UPDATE branches; this lightweight
      // census deliberately has no SQL evaluator, so reject every tracked
      // target until a reviewed shape is added here.
      if (mergePattern.test(statement)) {
        escapes.push(`${file}|rawSql:${delegate}.unsupportedMutation`);
      }
    }
  }
  return [...new Set(escapes)].sort();
}

export function discoveredBookingMoneyWriterSites(): BookingMoneyWriterSite[] {
  const migrationFiles = readdirSync(
    join(process.cwd(), "prisma", "migrations"),
    {
      withFileTypes: true,
    },
  )
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name >= MONEY_MIGRATION_CENSUS_START,
    )
    .map((entry) =>
      join(process.cwd(), "prisma", "migrations", entry.name, "migration.sql"),
    )
    .filter((file) => {
      try {
        readFileSync(file, "utf8");
        return true;
      } catch {
        return false;
      }
    });
  return [...sourceFiles(), ...migrationFiles]
    .flatMap((file) =>
      scanBookingMoneyWriterSites(
        relativeSource(file),
        readFileSync(file, "utf8"),
      ),
    )
    .sort((left, right) =>
      `${left.file}|${left.delegate}`.localeCompare(
        `${right.file}|${right.delegate}`,
      ),
    );
}

export function discoveredBookingMoneyWriterEscapes(): string[] {
  return sourceFiles()
    .flatMap((file) =>
      scanBookingMoneyWriterEscapes(
        relativeSource(file),
        readFileSync(file, "utf8"),
      ),
    )
    .sort();
}

export function discoveredBookingMoneyWriterEqualityEscapes(): string[] {
  return sourceFiles()
    .flatMap((file) =>
      scanBookingMoneyWriterEqualityEscapes(
        relativeSource(file),
        readFileSync(file, "utf8"),
      ),
    )
    .sort();
}

export function discoveredBookingMoneyRawSqlEscapes(): string[] {
  const migrationRoot = join(process.cwd(), "prisma", "migrations");
  return readdirSync(migrationRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name >= MONEY_MIGRATION_CENSUS_START,
    )
    .map((entry) => join(migrationRoot, entry.name, "migration.sql"))
    .filter((file) => {
      try {
        readFileSync(file, "utf8");
        return true;
      } catch {
        return false;
      }
    })
    .flatMap((file) =>
      scanBookingMoneyRawSqlEscapes(
        relativeSource(file),
        readFileSync(file, "utf8"),
      ),
    )
    .sort();
}
