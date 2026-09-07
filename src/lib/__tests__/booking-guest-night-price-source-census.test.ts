import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const REPO = process.cwd();
const SKIPPED_DIRECTORIES = new Set([
  ".artifacts",
  ".git",
  ".next",
  "__tests__",
  "coverage",
  "migration-verification",
  "migrations",
  "node_modules",
]);
const EXECUTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/;
const DIRECT_WRITER_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
]);
const RAW_SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO)\b[\s\S]{0,500}["'`]BookingGuestNight["'`]/i;

type SourceScan = {
  direct: number;
  nested: number;
  aliasedDelegates: number;
  rawSqlWrites: number;
};

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (
        EXECUTABLE_EXTENSION.test(entry.name) &&
        !TEST_FILE.test(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  walk(REPO);
  return files;
}

function relativeSource(file: string): string {
  return relative(REPO, file).split("\\").join("/");
}

const REQUIRED_WRITER_SHAPES = new Map<string, RegExp[]>([
  [
    "e2e/setup/seed-second-lodge.ts",
    [/bookingGuestNight\.create\([\s\S]*?data:\s*\{[\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "prisma/demo-seed.ts",
    [/bookingGuestNight\.create\([\s\S]*?data:\s*\{[\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "src/app/api/bookings/[id]/guests/route.ts",
    [/nights:\s*\{\s*create:\s*\(priced\.nightDates[\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "src/lib/booking-create-guests.ts",
    [/nights:\s*\{\s*create:\s*nightDates\.map[\s\S]*?priceSource:\s*"SOLD"/],
  ],
  [
    "src/lib/booking-date-modification-service.ts",
    [
      /bookingGuestNight\.createMany\([\s\S]*?priceSource:\s*requiredNightPriceSourceToWrite\(/,
      /bookingGuestNight\.createMany\([\s\S]*?priceSource:\s*night\.priceSource/,
    ],
  ],
  [
    "src/lib/booking-modify-plan.ts",
    [
      /bookingGuestNight\.createMany\([\s\S]*?priceSource:\s*nightPriceSourceToWrite\(bg,\s*k,\s*stayDate\)/,
    ],
  ],
  [
    "src/lib/booking-request.ts",
    [
      /nightRows\.push\([\s\S]*?priceSource:\s*night\.priceSource[\s\S]*?bookingGuestNight\.createMany\(\{\s*data:\s*nightRows\s*\}\)/,
      /const replacementNights[\s\S]*?priceSource:\s*night\.priceSource[\s\S]*?bookingGuestNight\.createMany\(\{\s*data:\s*replacementNights\s*\}\)/,
    ],
  ],
  [
    "src/lib/booking-request-shared.ts",
    [
      /buildApprovalGuestNights[\s\S]*?priceSource:\s*"SOLD"[\s\S]*?priceSource:\s*"EVEN_SPLIT"/,
      /toPipelineGuestCreateData[\s\S]*?nights:\s*\{\s*create:\s*\[\.\.\.nights\]\s*\}/,
    ],
  ],
  [
    "src/lib/stored-night-price-repair-store.ts",
    [
      /bookingGuestNight\.updateMany\([\s\S]*?priceSource:\s*"OFFICER_PRICED"/,
      /bookingGuestNight\.create\([\s\S]*?priceSource:\s*"OFFICER_PRICED"/,
    ],
  ],
  [
    "src/lib/waitlist.ts",
    [
      /repricedNightRows[\s\S]*?priceSource:\s*"SOLD"[\s\S]*?bookingGuestNight\.createMany\(\{\s*data:\s*repricedNightRows\[index\]/,
    ],
  ],
]);

const REQUIRED_WRITER_SITE_COUNTS = new Map<
  string,
  { direct: number; nested: number }
>([
  ["e2e/setup/seed-second-lodge.ts", { direct: 1, nested: 0 }],
  ["prisma/demo-seed.ts", { direct: 1, nested: 0 }],
  ["src/app/api/bookings/[id]/guests/route.ts", { direct: 0, nested: 1 }],
  ["src/lib/booking-create-guests.ts", { direct: 0, nested: 1 }],
  ["src/lib/booking-date-modification-service.ts", { direct: 2, nested: 0 }],
  ["src/lib/booking-modify-plan.ts", { direct: 1, nested: 0 }],
  ["src/lib/booking-request.ts", { direct: 2, nested: 0 }],
  ["src/lib/booking-request-shared.ts", { direct: 0, nested: 1 }],
  ["src/lib/stored-night-price-repair-store.ts", { direct: 2, nested: 0 }],
  ["src/lib/waitlist.ts", { direct: 1, nested: 0 }],
]);

function scanSource(file: string, code: string): SourceScan {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    false,
    /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let direct = 0;
  let nested = 0;
  let aliasedDelegates = 0;
  const propertyName = (name: ts.PropertyName): string | undefined =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
  const isNightDelegate = (node: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "bookingGuestNight") ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "bookingGuestNight");
  const visit = (
    node: ts.Node,
    parent?: ts.Node,
    grandparent?: ts.Node,
  ) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      DIRECT_WRITER_METHODS.has(node.expression.name.text) &&
      isNightDelegate(node.expression.expression)
    ) {
      direct += 1;
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "nights" &&
      ts.isObjectLiteralExpression(node.initializer) &&
      node.initializer.properties.some(
        (entry) =>
          ts.isPropertyAssignment(entry) && propertyName(entry.name) === "create",
      )
    ) {
      nested += 1;
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      isNightDelegate(node)
    ) {
      const method = parent;
      const call = grandparent;
      const isDirectCalledMethod =
        method !== undefined &&
        call !== undefined &&
        ts.isPropertyAccessExpression(method) &&
        method.expression === node &&
        ts.isCallExpression(call) &&
        call.expression === method;
      if (!isDirectCalledMethod) aliasedDelegates += 1;
    }
    if (
      ts.isBindingElement(node) &&
      ((node.propertyName !== undefined &&
        propertyName(node.propertyName) === "bookingGuestNight") ||
        (ts.isIdentifier(node.name) && node.name.text === "bookingGuestNight"))
    ) {
      aliasedDelegates += 1;
    }
    ts.forEachChild(node, (child) => visit(child, node, parent));
  };
  visit(source);
  return {
    direct,
    nested,
    aliasedDelegates,
    rawSqlWrites: RAW_SQL_WRITE.test(stripComments(code)) ? 1 : 0,
  };
}

function discoveredWriterSiteCounts(): Map<string, SourceScan> {
  const sites = new Map<string, SourceScan>();
  for (const file of sourceFiles()) {
    const scan = scanSource(file, readFileSync(file, "utf8"));
    if (
      scan.direct > 0 ||
      scan.nested > 0 ||
      scan.aliasedDelegates > 0 ||
      scan.rawSqlWrites > 0
    ) {
      sites.set(relativeSource(file), scan);
    }
  }
  return sites;
}

const DISCOVERED_WRITER_SITE_COUNTS = discoveredWriterSiteCounts();

describe("INV-MONEY-028 BookingGuestNight writer census", () => {
  it("knows every direct and nested writer site, including repeats in one file", () => {
    expect(
      [...DISCOVERED_WRITER_SITE_COUNTS]
        .map(([file, { direct, nested }]) => [file, { direct, nested }] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ).toEqual(
      [...REQUIRED_WRITER_SITE_COUNTS].sort(([a], [b]) => a.localeCompare(b)),
    );
  });

  it("rejects aliased delegates and runtime raw-SQL writes that evade the direct census", () => {
    const unsupported = [...DISCOVERED_WRITER_SITE_COUNTS]
      .filter(([, scan]) => scan.aliasedDelegates > 0 || scan.rawSqlWrites > 0)
      .map(([file, { aliasedDelegates, rawSqlWrites }]) => ({
        file,
        aliasedDelegates,
        rawSqlWrites,
      }));
    expect(
      unsupported,
      "INV-MONEY-028: BookingGuestNight writers must remain directly discoverable Prisma calls with reviewed provenance payloads.",
    ).toEqual([]);
  });

  it("mutation-proves the alias and raw-SQL escape routes are rejected", () => {
    expect(
      scanSource(
        "aliased-mutant.ts",
        "const nights = tx.bookingGuestNight; await nights.create({ data: { priceCents: 1 } });",
      ).aliasedDelegates,
    ).toBe(1);
    expect(
      scanSource(
        "forwarded-mutant.ts",
        'await writeNights(tx["bookingGuestNight"]);',
      ).aliasedDelegates,
    ).toBe(1);
    expect(
      scanSource(
        "destructured-mutant.ts",
        "const { bookingGuestNight: nights } = tx; await nights.create({ data: { priceCents: 1 } });",
      ).aliasedDelegates,
    ).toBe(1);
    expect(
      scanSource(
        "raw-sql-mutant.ts",
        'await tx.$executeRawUnsafe(`INSERT INTO "BookingGuestNight" ("priceCents") VALUES (1)`);',
      ).rawSqlWrites,
    ).toBe(1);
  });

  it("binds every discovered writer to its reviewed provenance payload", () => {
    const discoveredWriters = new Set(DISCOVERED_WRITER_SITE_COUNTS.keys());
    expect([...REQUIRED_WRITER_SHAPES.keys()].sort()).toEqual(
      [...discoveredWriters].sort(),
    );

    for (const [file, shapes] of REQUIRED_WRITER_SHAPES) {
      const code = stripComments(readFileSync(join(REPO, file), "utf8"));
      for (const shape of shapes) {
        expect(
          code,
          `INV-MONEY-028: ${file} no longer carries provenance through its reviewed write shape (${shape}).`,
        ).toMatch(shape);
      }
    }
  });
});
