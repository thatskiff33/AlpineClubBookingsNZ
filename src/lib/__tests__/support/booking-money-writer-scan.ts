import { readFileSync } from "node:fs";
import ts from "typescript";

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
};

function delegateName(node: ts.Expression): keyof typeof TRACKED_FIELDS | null {
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
  return null;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function looksLikePrismaClientReceiver(
  node: ts.Expression,
  source: ts.SourceFile,
): boolean {
  const receiver = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
    ? node.expression
    : node;
  return /(?:^|\.)(?:prisma|tx|store|client|db)$/i.test(receiver.getText(source));
}

function enclosingScope(node: ts.Node): ts.Node | undefined {
  for (let cursor: ts.Node | undefined = node.parent; cursor; cursor = cursor.parent) {
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
  for (
    let scope = enclosingScope(use);
    scope;
    scope = enclosingScope(scope)
  ) {
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
      (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isSourceFile(node) ||
        (ts.isBlock(node) && declaresName(node)))
    ) return;
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
export function scanBookingMoneyWriterEscapes(file: string, code: string): string[] {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const escapes = new Set<string>();
  const visit = (node: ts.Node, parent?: ts.Node, grandparent?: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const delegate = delegateName(node);
      if (delegate && looksLikePrismaClientReceiver(node, source)) {
        const method = parent;
        const call = grandparent;
        const isDirectCall =
          method !== undefined &&
          call !== undefined &&
          ts.isPropertyAccessExpression(method) &&
          method.expression === node &&
          ts.isCallExpression(call) &&
          call.expression === method;
        if (!isDirectCall) escapes.add(`${file}|${delegate}`);
      }
    }
    if (ts.isBindingElement(node)) {
      const name = node.propertyName
        ? propertyName(node.propertyName)
        : ts.isIdentifier(node.name)
          ? node.name.text
          : undefined;
      const binding = parent;
      const declaration = grandparent;
      if (
        name &&
        Object.prototype.hasOwnProperty.call(TRACKED_FIELDS, name) &&
        binding !== undefined &&
        declaration !== undefined &&
        ts.isObjectBindingPattern(binding) &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        /(?:^|\.)(?:prisma|tx|store|client|db)$/i.test(
          declaration.initializer.getText(source),
        )
      ) {
        escapes.add(`${file}|${name}`);
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
  const uncommented = stripComments(code);
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Map<
    keyof typeof TRACKED_FIELDS,
    { methods: Set<string>; fields: Set<string> }
  >();
  const record = (
    delegate: keyof typeof TRACKED_FIELDS,
    method: string,
    fields: readonly string[],
  ) => {
    const site = found.get(delegate) ?? { methods: new Set<string>(), fields: new Set<string>() };
    site.methods.add(method);
    fields.forEach((field) => site.fields.add(field));
    found.set(delegate, site);
  };
  const mutationPayloads = (call: ts.CallExpression): {
    payloads: ts.Expression[];
    opaqueOptions: boolean;
  } => {
    let options = call.arguments[0];
    if (options && ts.isIdentifier(options)) {
      options = resolveLocalBinding(options, source);
    }
    if (!options || !ts.isObjectLiteralExpression(options)) {
      return { payloads: [], opaqueOptions: true };
    }
    const names =
      ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "upsert"
        ? ["create", "update"]
        : ["data"];
    const data = options.properties.filter((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return names.includes(property.name.text);
      }
      if (!ts.isPropertyAssignment(property)) return false;
      return (
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        names.includes(property.name.text)
      );
    });
    return {
      payloads: data.map((property) =>
        ts.isShorthandPropertyAssignment(property)
          ? property.name
          : property.initializer,
      ),
      opaqueOptions: data.length === 0,
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
      return expression.elements.reduce(
        (result, element) => {
          if (!ts.isExpression(element)) return { fields: result.fields, opaque: true };
          const next = inspectPayload(element, delegate, nested, seen);
          next.fields.forEach((field) => result.fields.add(field));
          return { fields: result.fields, opaque: result.opaque || next.opaque };
        },
        { fields: new Set<string>(), opaque: false },
      );
    }
    if (!ts.isObjectLiteralExpression(expression)) return { fields: new Set(), opaque: true };
    const fields = new Set<string>();
    let opaque = false;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = inspectPayload(property.expression, delegate, nested, seen);
        spread.fields.forEach((field) => fields.add(field));
        opaque ||= spread.opaque;
        continue;
      }
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        opaque = true;
        continue;
      }
      const name = propertyName(property.name);
      if (!name) {
        opaque = true;
        continue;
      }
      if (TRACKED_FIELDS[delegate].includes(name)) fields.add(name);
      const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
      const relation =
        delegate === "booking" && name === "guests" ? "bookingGuest" :
        delegate === "bookingGuest" && name === "nights" ? "bookingGuestNight" : undefined;
          if (relation && ts.isObjectLiteralExpression(value)) {
        for (const entry of value.properties) {
          if (ts.isPropertyAssignment(entry) && propertyName(entry.name) === "create") {
            const child = inspectPayload(entry.initializer, relation, relation, seen);
            record(relation, "create", [...child.fields]);
            // A guest builder can conceal its nested night payload.  Keep the
            // descendant visible too: otherwise a booking.create({ guests:
            // { create: buildGuests() } }) would enumerate guests but silently
            // lose the price-bearing nights the builder may create.
            if (child.opaque && relation === "bookingGuest") {
              record("bookingGuestNight", "opaquePayload", []);
            }
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
      const delegate = delegateName(receiver);
      if (delegate) {
        const tracked = TRACKED_FIELDS[delegate];
        if (tracked) {
          const payload = mutationPayloads(node);
          const inspected = payload.payloads.map((entry) => inspectPayload(entry, delegate));
          const written = [...new Set(inspected.flatMap((entry) => [...entry.fields]))];
          if (written.length > 0 || node.expression.name.text.startsWith("delete")) {
            record(delegate, node.expression.name.text, written);
          }
          // A builder passed as the whole payload cannot be classified from
          // this source file, so keep it visible to the reviewed manifest. An
          // object payload is still useful evidence even if one of its ordinary
          // (non-money) values is computed.
          if (
            (payload.opaqueOptions || inspected.some((entry) => entry.opaque)) &&
            written.length === 0 &&
            !node.expression.name.text.startsWith("delete")
          ) record(delegate, "opaquePayload", []);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  for (const [delegate, fields] of Object.entries(TRACKED_FIELDS) as Array<
    [keyof typeof TRACKED_FIELDS, readonly string[]]
  >) {
    const model = delegate[0]!.toUpperCase() + delegate.slice(1);
    if (
      new RegExp(
        String.raw`\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO|DELETE\s+FROM)\s+(?:(?:[A-Za-z_$][\w$]*|["'\x60][A-Za-z_$][\w$]*["'\x60])\s*\.\s*)?["'\x60]${model}["'\x60]`,
        "i",
      ).test(uncommented)
    ) {
      record(
        delegate,
        "rawSql",
        fields.filter((field) => new RegExp(String.raw`\b${field}\b`).test(uncommented)),
      );
    }
  }

  return [...found.entries()]
    .map(([delegate, site]) => ({
      file,
      delegate,
      methods: [...site.methods].sort(),
      fields: [...site.fields].sort(),
    }))
    .sort((left, right) => left.delegate.localeCompare(right.delegate));
}

export function discoveredBookingMoneyWriterSites(): BookingMoneyWriterSite[] {
  return sourceFiles()
    .flatMap((file) =>
      scanBookingMoneyWriterSites(relativeSource(file), readFileSync(file, "utf8")),
    )
    .sort((left, right) =>
      `${left.file}|${left.delegate}`.localeCompare(`${right.file}|${right.delegate}`),
    );
}

export function discoveredBookingMoneyWriterEscapes(): string[] {
  return sourceFiles()
    .flatMap((file) =>
      scanBookingMoneyWriterEscapes(relativeSource(file), readFileSync(file, "utf8")),
    )
    .sort();
}
