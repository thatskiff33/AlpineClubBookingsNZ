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

function looksLikePrismaClientReceiver(
  node: ts.Expression,
  source: ts.SourceFile,
): boolean {
  const receiver = ts.isPropertyAccessExpression(node)
    ? node.expression
    : ts.isElementAccessExpression(node)
      ? node.expression
      : node;
  const text = receiver.getText(source);
  return /(?:^|\.)(?:prisma|tx|store|client|db)$/i.test(text);
}

/** Delegate forwarding can hide a write from the direct call-site census. */
export function scanBookingMoneyWriterEscapes(file: string, code: string): string[] {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    false,
    /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const escapes = new Set<string>();
  const propertyName = (name: ts.PropertyName): string | undefined =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
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
    false,
    /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Map<
    keyof typeof TRACKED_FIELDS,
    { methods: Set<string>; fields: Set<string> }
  >();
  const mutationDataExpressions = (call: ts.CallExpression): ts.Expression[] => {
    const options = call.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) return [];
    const data = options.properties.find((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return property.name.text === "data";
      }
      if (!ts.isPropertyAssignment(property)) return false;
      return (
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "data"
      );
    });
    if (!data) return [];
    if (ts.isShorthandPropertyAssignment(data)) return [data.name];
    if (!ts.isPropertyAssignment(data)) return [];
    if (!ts.isObjectLiteralExpression(data.initializer)) return [data.initializer];
    return data.initializer.properties
      .filter(ts.isSpreadAssignment)
      .map((property) => property.expression);
  };
  const indirectMutationEvidence = (call: ts.CallExpression): string => {
    const evidence: string[] = [];
    const seen = new Set<string>();
    const collectSpreads = (node: ts.Node) => {
      const visitSpread = (child: ts.Node) => {
        if (
          (ts.isSpreadAssignment(child) || ts.isSpreadElement(child)) &&
          ts.isIdentifier(child.expression)
        ) {
          collectIdentifier(child.expression.text);
        }
        ts.forEachChild(child, visitSpread);
      };
      visitSpread(node);
    };
    const collectIdentifier = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const visitBinding = (node: ts.Node) => {
        let value: ts.Node | undefined;
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === name
        ) {
          value = node.initializer;
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          node.left.text === name
        ) {
          value = node.right;
        } else if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === name &&
          ["push", "unshift", "splice"].includes(node.expression.name.text)
        ) {
          value = node;
        }
        if (value) {
          evidence.push(value.getText(source));
          collectSpreads(value);
        }
        ts.forEachChild(node, visitBinding);
      };
      visitBinding(source);
    };
    for (const expression of mutationDataExpressions(call)) {
      evidence.push(expression.getText(source));
      if (ts.isIdentifier(expression)) collectIdentifier(expression.text);
      collectSpreads(expression);
    }
    return stripComments(evidence.join("\n"));
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      if (ts.isPropertyAccessExpression(receiver)) {
        const delegate = receiver.name.text as keyof typeof TRACKED_FIELDS;
        const tracked = TRACKED_FIELDS[delegate];
        if (tracked) {
          const text = node.getText(source);
          // Prisma permits the mutation payload to be supplied by identifier
          // (`update({ data })`, `createMany({ data: rows })`) or spread. In
          // those shapes the field names are outside the call expression, so
          // follow the local binding's initializer, assignments, and array
          // construction. Spread bindings are followed recursively (the
          // adjustment writer builds `rows` from a local `base` object).
          const fieldEvidence = `${text}\n${indirectMutationEvidence(node)}`;
          const written = tracked.filter((field) =>
            new RegExp(String.raw`\b${field}\b`).test(fieldEvidence),
          );
          if (written.length > 0 || node.expression.name.text.startsWith("delete")) {
            const site = found.get(delegate) ?? {
              methods: new Set<string>(),
              fields: new Set<string>(),
            };
            site.methods.add(node.expression.name.text);
            written.forEach((field) => site.fields.add(field));
            found.set(delegate, site);
          }
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
        String.raw`\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO|DELETE\s+FROM)\s+["'\x60]${model}["'\x60]`,
        "i",
      ).test(uncommented)
    ) {
      const site = found.get(delegate) ?? {
        methods: new Set<string>(),
        fields: new Set<string>(),
      };
      site.methods.add("rawSql");
      fields
        .filter((field) => new RegExp(String.raw`\b${field}\b`).test(uncommented))
        .forEach((field) => site.fields.add(field));
      found.set(delegate, site);
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
