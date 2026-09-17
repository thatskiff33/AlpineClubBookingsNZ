import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

function delegateName(
  node: ts.Expression,
  source?: ts.SourceFile,
  seen = new Set<ts.Node>(),
): keyof typeof TRACKED_FIELDS | null {
  if (seen.has(node)) return null;
  seen.add(node);
  if (ts.isPropertyAccessExpression(node)) {
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
function resolveLocalBinding(
  use: ts.Identifier,
  source: ts.SourceFile,
): ts.Expression | undefined {
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
    if (winner?.initializer) return winner.initializer;
  }
  return undefined;
}

function expressionUsesCanonicalFinalPrice(
  expression: ts.Expression,
  source: ts.SourceFile,
  seen = new Set<ts.Node>(),
): boolean {
  if (seen.has(expression)) return false;
  seen.add(expression);
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === "bookingFinalPriceCents" ||
      // Stage 3's verified build-up projector is the canonical evidence-aware
      // equivalent after it has checked the relation against this helper.
      expression.expression.text === "d3CompatibleBookingMoneyBuildUpCents")
  )
    return true;
  if (ts.isIdentifier(expression)) {
    const binding = resolveLocalBinding(expression, source);
    return (
      binding !== undefined &&
      expressionUsesCanonicalFinalPrice(binding, source, seen)
    );
  }
  // Parked edits deliberately preserve the stored value on one branch; the
  // computed branch must still use the one canonical relation.
  if (ts.isConditionalExpression(expression)) {
    const branches = [expression.whenTrue, expression.whenFalse];
    return (
      branches.some((branch) =>
        expressionUsesCanonicalFinalPrice(branch, source, seen),
      ) &&
      branches.some(
        (branch) =>
          ts.isPropertyAccessExpression(branch) &&
          branch.name.text === "finalPriceCents",
      )
    );
  }
  return false;
}

/**
 * A field inventory cannot distinguish `total + 1` from the canonical final
 * price. For complete headline payloads, require the final field to flow from
 * the one arithmetic home (or the deliberate parked-value branch).
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
      } else {
        opaque = true;
      }
    }
    return { values, opaque };
  };
  const inspectPayload = (payload: ResolvedObject, location: ts.Node) => {
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
      hasCompleteHeadline &&
      !(isZeroPromo && finalEqualsTotal) &&
      !expressionUsesCanonicalFinalPrice(finalPrice, source)
    ) {
      const finalLine =
        source.getLineAndCharacterOfPosition(finalPrice.getStart(source)).line +
        1;
      escapes.push(`${file}:${finalLine}|finalPriceCents`);
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
            inspectPayload(resolveObject(payloadExpression), payloadExpression);
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
          : delegateName(node.initializer));
      if (delegate) {
        const receiver =
          ts.isPropertyAccessExpression(node.initializer) ||
          ts.isElementAccessExpression(node.initializer)
            ? node.initializer.expression.getText(source)
            : "";
        aliases.set(node.name.text, {
          delegate,
          forwardsCapability:
            priorAlias?.forwardsCapability ??
            /(?:^|\.)(?:prisma|tx|store|client|db|database)$/i.test(receiver),
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
            forwardsCapability:
              /(?:^|\.)(?:prisma|tx|store|client|db|database)$/i.test(
                node.initializer.getText(source),
              ),
          });
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

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
      if (
        directWrite ||
        (binding.forwardsCapability && isEscapingUse(node, parent))
      ) {
        escapes.add(`${file}|${binding.delegate}`);
      }
    }
    const candidateIdentifier =
      ts.isIdentifier(node) &&
      (isDirectCall(node, parent, grandparent) || isEscapingUse(node, parent));
    if (
      candidateIdentifier ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const alias = ts.isIdentifier(node) ? aliases.get(node.text) : undefined;
      const delegate = ts.isIdentifier(node)
        ? (alias?.delegate ?? null)
        : delegateName(node);
      const receiverLooksLikeClient =
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
          ? /(?:^|\.)(?:prisma|tx|store|client|db|database)$/i.test(
              node.expression.getText(source),
            )
          : (alias?.forwardsCapability ?? false);
      if (
        delegate &&
        !isDirectCall(node, parent, grandparent) &&
        !isLocalAliasInitializer(node, parent) &&
        isEscapingUse(node, parent) &&
        receiverLooksLikeClient
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
      if (relation && ts.isObjectLiteralExpression(value)) {
        for (const entry of value.properties) {
          const method =
            ts.isPropertyAssignment(entry) && propertyName(entry.name);
          if (!method || !WRITE_METHODS.has(method)) continue;
          const nestedOptions = entry.initializer;
          const nestedObject = ts.isObjectLiteralExpression(nestedOptions)
            ? nestedOptions
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
            { fields: new Set<string>(), opaque: payloads.length === 0 },
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
    const statements = isSqlFile ? splitSqlStatements(code) : [code];
    for (const statement of statements) {
      const executable = isSqlFile ? stripSqlComments(statement) : statement;
      const update = new RegExp(
        String.raw`\bUPDATE\s+${table}[\s\S]*?\bSET\b([\s\S]*?)(?=\b(?:FROM|WHERE|RETURNING)\b|;|$)`,
        "i",
      ).exec(executable);
      const insert = new RegExp(
        String.raw`\bINSERT\s+INTO\s+${table}\s*\(([\s\S]*?)\)\s*(?:VALUES|SELECT)\b`,
        "i",
      ).exec(executable);
      const deleted = new RegExp(
        String.raw`\bDELETE\s+FROM\s+${table}\b`,
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
      if (written.length > 0 || deleted) {
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

    for (const statement of splitSqlStatements(sql)) {
      const updatePattern = new RegExp(
        String.raw`\bUPDATE\s+${table}[\s\S]*?\bSET\b([\s\S]*?)(?=\b(?:FROM|WHERE|RETURNING)\b|;|$)`,
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
        String.raw`\bINSERT\s+INTO\s+${table}\s*\(`,
        "gi",
      );
      for (const insert of statement.matchAll(insertPattern)) {
        const columnsOpen = insert.index + insert[0].lastIndexOf("(");
        const columns = parenthesizedSql(statement, columnsOpen);
        if (!columns) continue;
        const valuesMatch = /\bVALUES\s*\(/gi;
        valuesMatch.lastIndex = columns.end;
        const valuesToken = valuesMatch.exec(statement);
        if (!valuesToken) continue;
        const valuesOpen = valuesToken.index + valuesToken[0].lastIndexOf("(");
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
