/**
 * #4628 (Ledger M3c): EVERY WRITER THAT SETS A BOOKING PAID OR CANCELLED IS
 * CLASSIFIED. A PAID is a booking's confirmation and a CANCELLED is its
 * cancellation: each either posts its member-money journal event (R01 or the
 * confirmation bridge, R04) or is not a sale. This census reads every non-test
 * source file under `src/` and `scripts/` and finds each Prisma write to a
 * booking (`<client>.booking.create|createMany|update|updateMany|upsert`) that
 * sets `status` to PAID or CANCELLED, sets it to anything computed, or hands
 * over a payload or spread it cannot read. Each must be listed below, by file,
 * value and count; a new one fails until someone decides which it is. A raw
 * SQL `UPDATE "Booking"` that sets the status is refused outright.
 *
 * `POSTS` names the posting call the file makes, and the census checks the
 * file still makes it. `LEGACY_GAP` is a sale whose writer posts no legacy
 * confirmation line, so no journal event either: the booking-ledger back-post
 * confirms it later and posts its R01 (M3b), and the gap is reported, not
 * fixed here. Seeds under `prisma/` are fixtures, not doors, and are not read.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { RELEASE_ADMIN_CAPACITY_HOLD_UPDATE, RELEASE_WHOLE_LODGE_HOLD_UPDATE } from "@/lib/booking-status";
import { compareOrdinal } from "@/lib/ordinal-order";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const SALE_STATUSES = new Set(["PAID", "CANCELLED"]);

type Classification =
  | { kind: "POSTS"; call: string; why: string }
  | { kind: "NOT_A_SALE"; why: string }
  | { kind: "LEGACY_GAP"; why: string }
  | { kind: "NO_SALE_STATUS"; why: string };

/**
 * A site, as `file|value|count`: value is PAID, CANCELLED, or `computed:<expr>{…}`,
 * `payload:<expr>{…}` or `spread:<expr>{…}` with the status values its content
 * can reach. A non-literal site proven to reach only other statuses is not listed.
 */
const REVIEWED: Record<string, Classification> = {
  // --- PAID: a confirmation ---
  "src/lib/payment-reconciliation.ts|PAID|1": { kind: "POSTS", call: "postBookingConfirmationLedgerLines", why: "the settle: R01, or the bridge to a binding R01" },
  "src/lib/xero-inbound/invoice-paid-effects.ts|PAID|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the Xero receipt confirms the booking and links its binding R01 (#4628)" },
  "src/lib/school-booking-request.ts|PAID|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "a credit-settled request approval" },
  "src/lib/group-settlement.ts|PAID|1": { kind: "POSTS", call: "postGroupSettlementLedgerLines", why: "a group settle confirms each organiser-settled child" },
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts|PAID|1": { kind: "NOT_A_SALE", why: "only a $0 booking (savedCardChargeCents 0): nothing to charge" },
  "src/app/api/bookings/[id]/confirm-draft/route.ts|PAID|1": { kind: "NOT_A_SALE", why: "only a $0 draft (finalPriceCents 0)" },
  "src/app/api/bookings/[id]/waitlist-confirm/route.ts|PAID|1": { kind: "NOT_A_SALE", why: "only a $0 offer (finalPriceCents 0)" },
  "src/lib/cron-confirm-pending.ts|PAID|1": { kind: "NOT_A_SALE", why: "only a $0 provisional booking (savedCardChargeCents 0)" },
  "src/lib/booking-create.ts|PAID|1": { kind: "LEGACY_GAP", why: "a create whose price account credit covers posts no confirmation line (back-post)" },
  "src/lib/booking-credit-election.ts|PAID|1": { kind: "LEGACY_GAP", why: "a fully credit-covered settle posts no confirmation line (back-post)" },
  // --- CANCELLED: a cancellation ---
  "src/lib/booking-cancel.ts|CANCELLED|5": { kind: "POSTS", call: "postCancellationLedgerLines", why: "every cancel path: R04, pending or confirmed" },
  "src/lib/cron-confirm-pending.ts|CANCELLED|3": { kind: "POSTS", call: "postCancellationLedgerLines", why: "capacity bump and hold-ended cancels" },
  "src/lib/internet-banking-payment-cron.ts|CANCELLED|1": { kind: "POSTS", call: "postCancellationLedgerLines", why: "bank-transfer hold expiry: the pending charge's R04" },
  "src/lib/payment-reconciliation.ts|CANCELLED|1": { kind: "POSTS", call: "postCancellationLedgerLines", why: "the settle's capacity void" },
  "src/lib/xero-inbound/invoice-paid-effects.ts|CANCELLED|1": { kind: "POSTS", call: "postCancellationLedgerLines", why: "a late receipt's capacity cancel" },
  "src/lib/group-cancel.ts|CANCELLED|1": { kind: "POSTS", call: "postGroupCancelChildLedgerLines", why: "group cancel, through the cancellation poster per child" },
  "src/lib/booking-request-quotes.ts|CANCELLED|1": { kind: "NOT_A_SALE", why: "a quote, never bound" },
  "src/lib/cron-quote-expiry-reminders.ts|CANCELLED|2": { kind: "NOT_A_SALE", why: "expired quotes, never bound" },
  "src/lib/cron-waitlist.ts|CANCELLED|1": { kind: "NOT_A_SALE", why: "waitlist entries, which hold no charge" },
  "src/lib/cron-group-settlement-reaper.ts|CANCELLED|1": { kind: "NOT_A_SALE", why: "organiser-settled children whose group never settled: none was bound" },
  "src/lib/waitlist-cross-lodge.ts|CANCELLED|2": { kind: "NOT_A_SALE", why: "an expired offer, and the card-priced replacement undone on price drift" },
  "src/app/api/admin/bookings/[id]/review/route.ts|CANCELLED|1": { kind: "NOT_A_SALE", why: "a rejected legacy draft" },
  // --- computed statuses, keyed by every value the census sees each take (`?`: one it cannot read) ---
  "src/lib/booking-date-modification-service.ts|computed:newStatus{?,PAID,PAYMENT_PENDING}|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the zero-dollar auto-pay confirms; otherwise PAYMENT_PENDING or unchanged" },
  "src/lib/booking-date-modification-service.ts|computed:newStatus{?,PAYMENT_PENDING}|1": { kind: "NO_SALE_STATUS", why: "the admin date shift: unchanged, or PAYMENT_PENDING" },
  "src/lib/booking-batch-modification-service.ts|computed:lifecycle.newStatus{?}|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the zero-dollar auto-pay confirms" },
  "src/lib/booking-guest-acceptance-reprice.ts|computed:lifecycle.newStatus{?}|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the zero-dollar auto-pay confirms" },
  "src/lib/booking-guest-removal-service.ts|computed:lifecycle.newStatus{?}|1": { kind: "POSTS", call: "postStoredBookingConfirmationLedgerLines", why: "the zero-dollar auto-pay confirms" },
  "src/app/api/admin/bookings/[id]/force-confirm/route.ts|computed:nextStatus{AWAITING_REVIEW,PAID,PAYMENT_PENDING}|1": { kind: "NOT_A_SALE", why: "PAID only for a $0 booking; otherwise AWAITING_REVIEW or PAYMENT_PENDING" },
  "src/app/api/bookings/[id]/guests/route.ts|computed:holdAdjustedStatus{?,PAYMENT_PENDING}|1": { kind: "NO_SALE_STATUS", why: "unchanged, or PENDING to PAYMENT_PENDING" },
  "src/lib/booking-create.ts|computed:effectiveStatus{?,AWAITING_REVIEW,CONFIRMED,PAYMENT_PENDING,PENDING}|1": { kind: "NO_SALE_STATUS", why: "AWAITING_REVIEW or the requested PENDING, PAYMENT_PENDING or CONFIRMED" },
  "src/lib/payment-reconciliation.ts|computed:restoredStatus{?,PAYMENT_PENDING}|1": { kind: "NO_SALE_STATUS", why: "a mark-paid reversal restores the unpaid status" },
};

/** Spreads of an imported constant, checked here to hold no `status` at all. */
const STATUS_FREE_CONSTANTS: Record<string, object> = {
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
};

const unwrap = (node: ts.Expression): ts.Expression =>
  (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node);

/** The BookingStatus a literal names (`BookingStatus.PAID`, `"PAID"`), or null for anything computed. */
function literalStatus(node: ts.Expression): string | null {
  const value = unwrap(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "BookingStatus") return value.name.text;
  return null;
}

/**
 * WHAT A NON-LITERAL SITE CAN WRITE, BY CONTENT, FAILING CLOSED (#4659 review,
 * concurrency-4 and the delta lens d-1 to d-4). A site whose status is
 * computed, or whose payload, spread or whole write arguments are a name, is
 * keyed by the name AND the set of status values it can take: every value
 * assigned to that one binding (resolved by symbol, so a shadowing or unrelated
 * declaration of the same name supplies nothing), followed through names to a
 * fixed depth. Anything the scanner cannot fully read adds `?`, which keeps the
 * site listed: a binding made by a parameter, a destructuring, an import, a
 * for-of/for-in variable or a catch clause; a value that is not a literal, a
 * name or a conditional of those; and, for an object, the name passed to any
 * call (`Object.assign`, a helper), written through a computed key, or
 * deleted from. `??` and `||` read both operands; only `&&` may drop its left.
 * A site proven to reach only other statuses (or none) is not a PAID/CANCELLED
 * writer and needs no entry; one that can reach a sale status or `?` is listed.
 */
const MAX_DEPTH = 3;

interface Scanned {
  source: ts.SourceFile;
  checker: ts.TypeChecker;
  /** The booking write being judged: its own use of a name is not a mutation of it. */
  site?: ts.Node;
}

/** One file bound on its own (no lib, no imports resolved): enough for local symbols, never for types. */
function bind(text: string, file: string): { source: ts.SourceFile; checker: ts.TypeChecker } {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], allowJs: false, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve };
  const name = file.endsWith(".tsx") ? "/scan.tsx" : "/scan.ts";
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => (fileName === name ? source : undefined),
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => fileName === name,
    readFile: () => undefined,
  };
  const program = ts.createProgram([name], options, host);
  return { source: program.getSourceFile(name)!, checker: program.getTypeChecker() };
}

const UNKNOWN = ["?"];

/** How a binding came to exist: a declaration the scanner can follow, or one whose value it cannot know. */
function bindingIsOpaque(declaration: ts.Declaration): boolean {
  if (ts.isParameter(declaration) || ts.isBindingElement(declaration)) return true;
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration) || ts.isImportEqualsDeclaration(declaration)) return true;
  if (ts.isVariableDeclaration(declaration)) {
    if (!ts.isIdentifier(declaration.name)) return true;
    const list = declaration.parent;
    if (ts.isCatchClause(list)) return true;
    const statement = list?.parent;
    if (statement && (ts.isForOfStatement(statement) || ts.isForInStatement(statement))) return true;
    return false;
  }
  // A function, class or enum declaration is no status value either.
  return true;
}

/** The binding a name refers to; a shorthand `{ data }` names the variable, not the property. */
function symbolOf(identifier: ts.Identifier, scanned: Scanned): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
    ? scanned.checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : scanned.checker.getSymbolAtLocation(identifier);
}

/** Every reference to the symbol in the file, by symbol identity (shorthand uses included). */
function referencesTo(symbol: ts.Symbol, scanned: Scanned): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === symbol.name && symbolOf(node, scanned) === symbol) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scanned.source);
  return found;
}

const within = (node: ts.Node, ancestor: ts.Node | undefined): boolean => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === ancestor) return true;
  return false;
};

const isAssignmentOperator = (kind: ts.SyntaxKind) =>
  kind === ts.SyntaxKind.EqualsToken || kind === ts.SyntaxKind.QuestionQuestionEqualsToken || kind === ts.SyntaxKind.BarBarEqualsToken
  || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken;

/** The values written to a binding and, for an object, what else touches it. */
interface BindingUse {
  assigned: ts.Expression[];
  statusWrites: ts.Expression[];
  opaque: boolean;
  objectOpaque: boolean;
}

function bindingUse(identifier: ts.Identifier, scanned: Scanned): BindingUse | null {
  const symbol = symbolOf(identifier, scanned);
  if (!symbol || !symbol.declarations || symbol.declarations.length === 0) return null;
  const use: BindingUse = { assigned: [], statusWrites: [], opaque: false, objectOpaque: false };
  for (const declaration of symbol.declarations) {
    if (bindingIsOpaque(declaration)) use.opaque = true;
    else if (ts.isVariableDeclaration(declaration) && declaration.initializer) use.assigned.push(declaration.initializer);
  }
  for (const reference of referencesTo(symbol, scanned)) {
    let node: ts.Node = reference;
    while (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isSatisfiesExpression(node.parent) || ts.isNonNullExpression(node.parent)) node = node.parent;
    const parent = node.parent;
    if (ts.isBinaryExpression(parent) && parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) {
      use.assigned.push(parent.right);
      continue;
    }
    // A member write: `name.status = …`, `name["status"] = …`; any computed key is unknown.
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) {
      const outer = parent.parent;
      const written = ts.isBinaryExpression(outer) && outer.left === parent && isAssignmentOperator(outer.operatorToken.kind);
      const deleted = ts.isDeleteExpression(outer);
      if (written || deleted) {
        const key = ts.isPropertyAccessExpression(parent) ? parent.name.text
          : ts.isStringLiteralLike(parent.argumentExpression) ? parent.argumentExpression.text : null;
        if (key === null || deleted) use.objectOpaque = true;
        else if (key === "status") use.statusWrites.push((outer as ts.BinaryExpression).right);
      }
      continue;
    }
    // The declaration's own name, a spread (which copies, never aliases), and the write being judged, are not escapes.
    if (ts.isVariableDeclaration(parent) && parent.name === node) continue;
    if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) continue;
    if (within(node, scanned.site)) continue;
    // Any other use hands the object on: to a call (`Object.assign`, a helper), into
    // another object or array, to another name. It may come back mutated: unknown.
    use.objectOpaque = true;
  }
  return use;
}

/** Each status value an expression can evaluate to. */
function statusValues(node: ts.Expression, scanned: Scanned, depth: number): string[] {
  const value = unwrap(node);
  const literal = literalStatus(value);
  if (literal !== null) return [literal];
  if (ts.isConditionalExpression(value)) return [...statusValues(value.whenTrue, scanned, depth), ...statusValues(value.whenFalse, scanned, depth)];
  if (ts.isBinaryExpression(value) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(value.operatorToken.kind)) {
    return [...statusValues(value.left, scanned, depth), ...statusValues(value.right, scanned, depth)];
  }
  if (ts.isIdentifier(value) && depth < MAX_DEPTH) {
    const use = bindingUse(value, scanned);
    if (!use) return UNKNOWN;
    return [...(use.opaque ? UNKNOWN : []), ...use.assigned.flatMap((expression) => statusValues(expression, scanned, depth + 1))];
  }
  return UNKNOWN;
}

/** Every `status` an object expression (or a name for one) can carry. */
function objectStatusValues(node: ts.Expression, scanned: Scanned, depth: number): string[] {
  const value = unwrap(node);
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.flatMap((property) => {
      if (ts.isPropertyAssignment(property)) {
        if (ts.isComputedPropertyName(property.name)) return UNKNOWN;
        return property.name.getText(scanned.source).replace(/^["']|["']$/g, "") === "status" ? statusValues(property.initializer, scanned, depth) : [];
      }
      if (ts.isShorthandPropertyAssignment(property)) return property.name.text === "status" ? statusValues(property.name, scanned, depth) : [];
      if (ts.isSpreadAssignment(property)) return objectStatusValues(property.expression, scanned, depth);
      return [];
    });
  }
  if (ts.isConditionalExpression(value)) return [...objectStatusValues(value.whenTrue, scanned, depth), ...objectStatusValues(value.whenFalse, scanned, depth)];
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return objectStatusValues(value.right, scanned, depth);
  if (ts.isBinaryExpression(value) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(value.operatorToken.kind)) {
    return [...objectStatusValues(value.left, scanned, depth), ...objectStatusValues(value.right, scanned, depth)];
  }
  if (ts.isIdentifier(value) && value.text in STATUS_FREE_CONSTANTS) return [];
  if (ts.isIdentifier(value) && depth < MAX_DEPTH) {
    const use = bindingUse(value, scanned);
    if (!use) return UNKNOWN;
    return [...(use.opaque || use.objectOpaque ? UNKNOWN : []),
      ...use.assigned.flatMap((expression) => objectStatusValues(expression, scanned, depth + 1)),
      ...use.statusWrites.flatMap((expression) => statusValues(expression, scanned, depth + 1))];
  }
  return UNKNOWN;
}

/** `{A,B,?}`: the distinct values, in plain code-unit order. */
const valueSet = (values: readonly string[]) => `{${[...new Set(values)].sort(compareOrdinal).join(",")}}`;

/** Listed only when its content can reach a sale status or a value the census cannot read. */
const siteOf = (label: string, values: readonly string[]): string[] =>
  values.some((value) => value === "?" || SALE_STATUSES.has(value)) ? [`${label}${valueSet(values)}`] : [];

/** The sites one data object literal yields: its `status`, and those of every object a spread may add. */
function objectSites(object: ts.ObjectLiteralExpression, scanned: Scanned): string[] {
  const sites: string[] = [];
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      if (ts.isComputedPropertyName(property.name)) {
        sites.push(`computed:${property.name.getText(scanned.source)}{?}`);
        continue;
      }
      if (property.name.getText(scanned.source).replace(/^["']|["']$/g, "") !== "status") continue;
      const status = literalStatus(property.initializer);
      if (status === null) sites.push(...siteOf(`computed:${property.initializer.getText(scanned.source)}`, statusValues(property.initializer, scanned, 0)));
      else if (SALE_STATUSES.has(status)) sites.push(status);
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === "status") {
      sites.push(...siteOf("computed:status", statusValues(property.name, scanned, 0)));
    } else if (ts.isSpreadAssignment(property)) {
      sites.push(...spreadSites(property.expression, scanned));
    }
  }
  return sites;
}

function spreadSites(node: ts.Expression, scanned: Scanned): string[] {
  const value = unwrap(node);
  if (ts.isObjectLiteralExpression(value)) return objectSites(value, scanned);
  if (ts.isConditionalExpression(value)) return [...spreadSites(value.whenTrue, scanned), ...spreadSites(value.whenFalse, scanned)];
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return spreadSites(value.right, scanned);
  if (ts.isIdentifier(value) && value.text in STATUS_FREE_CONSTANTS) return [];
  return siteOf(`spread:${value.getText(scanned.source)}`, objectStatusValues(value, scanned, 0));
}

/** A write's data payload: an object literal, or a conditional choosing between payloads, read through; anything else by content. */
function payloadSites(node: ts.Expression, scanned: Scanned): string[] {
  const value = unwrap(node);
  if (ts.isObjectLiteralExpression(value)) return objectSites(value, scanned);
  if (ts.isConditionalExpression(value)) return [...payloadSites(value.whenTrue, scanned), ...payloadSites(value.whenFalse, scanned)];
  return siteOf(`payload:${value.getText(scanned.source)}`, objectStatusValues(value, scanned, 0));
}

const PAYLOAD_KEYS = new Set(["data", "create", "update"]);

/** The sites a write's WHOLE arguments yield: its data/create/update payloads; whatever it cannot read is opaque. */
function argsSites(node: ts.Expression, scanned: Scanned, depth: number): string[] {
  const value = unwrap(node);
  const opaque = [`payload:${value.getText(scanned.source)}{?}`];
  if (ts.isConditionalExpression(value)) return [...argsSites(value.whenTrue, scanned, depth), ...argsSites(value.whenFalse, scanned, depth)];
  if (ts.isObjectLiteralExpression(value)) {
    const sites: string[] = [];
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        sites.push(`payload:...${property.expression.getText(scanned.source)}{?}`);
      } else if (ts.isShorthandPropertyAssignment(property) && PAYLOAD_KEYS.has(property.name.text)) {
        sites.push(...payloadSites(property.name, scanned));
      } else if (ts.isPropertyAssignment(property)) {
        if (ts.isComputedPropertyName(property.name)) {
          sites.push(`payload:${property.name.getText(scanned.source)}{?}`);
          continue;
        }
        if (!PAYLOAD_KEYS.has(property.name.getText(scanned.source).replace(/^["']|["']$/g, ""))) continue;
        const initializer = unwrap(property.initializer);
        const payloads = ts.isArrayLiteralExpression(initializer) ? initializer.elements : [property.initializer];
        for (const payload of payloads) sites.push(...payloadSites(payload, scanned));
      }
    }
    return sites;
  }
  if (ts.isIdentifier(value) && depth < MAX_DEPTH) {
    const use = bindingUse(value, scanned);
    if (!use) return opaque;
    // Its own `data` written through the name (`args.data = …`) is as unreadable as any other member write.
    const unreadable = use.opaque || use.objectOpaque || use.statusWrites.length > 0 || use.assigned.length === 0;
    return [...(unreadable ? opaque : []), ...use.assigned.flatMap((expression) => argsSites(expression, scanned, depth + 1))];
  }
  return opaque;
}

/** Every classified site in one file's source, as `value` strings (one per occurrence). */
function bookingSaleStatusSites(text: string, file: string): string[] {
  const { source, checker } = bind(text, file);
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && WRITE_METHODS.has(node.expression.name.text)) {
      const delegate = unwrap(node.expression.expression);
      const isBooking = (ts.isPropertyAccessExpression(delegate) && delegate.name.text === "booking")
        || (ts.isElementAccessExpression(delegate) && ts.isStringLiteralLike(delegate.argumentExpression) && delegate.argumentExpression.text === "booking");
      if (isBooking) {
        const [argument] = node.arguments;
        sites.push(...(argument ? argsSites(argument, { source, checker, site: node }, 0) : ["payload:none{?}"]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/**
 * A raw `UPDATE "Booking"` that sets the status, which no classification can
 * admit: quoted or bare `status` (the column is lowercase, so both name it),
 * an alias with or without AS, `ONLY` and a `public` schema, and only inside
 * the SET list, so a WHERE that merely reads the status is not a write.
 */
const RAW_STATUS_UPDATE = new RegExp(
  String.raw`\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"Booking"(?:\s+(?:AS\s+)?(?!SET\b)"?\w+"?)?\s+SET\b`
  + String.raw`(?:(?!\bWHERE\b|\bFROM\b|\bRETURNING\b)[^;\x60])*?(?:^|[\s,(])(?:"?\w+"?\.)?(?:"status"|status)\s*=`,
  "i",
);

const scanned = productionSourceFiles(ROOT).filter((file) => !file.startsWith("prisma/"));

function census(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of scanned) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (!/\bbooking\b/.test(text)) continue;
    for (const site of bookingSaleStatusSites(text, file)) found[`${file}|${site}`] = (found[`${file}|${site}`] ?? 0) + 1;
  }
  return found;
}

describe("every booking PAID/CANCELLED writer is classified (#4628)", () => {
  const found = census();

  it("finds exactly the reviewed writers, by file, value and count", () => {
    const actual = Object.entries(found).map(([site, count]) => `${site}|${count}`).sort();
    expect(actual, "a writer that sets a booking PAID or CANCELLED (or a status the scan cannot read) is unclassified").toEqual(Object.keys(REVIEWED).sort());
  });

  it("holds each POSTS writer to the posting call it names", () => {
    for (const [site, classification] of Object.entries(REVIEWED)) {
      if (classification.kind !== "POSTS") continue;
      const file = site.split("|")[0]!;
      expect(stripComments(readFileSync(join(ROOT, file), "utf8")), `${file} no longer calls ${classification.call}`).toMatch(new RegExp(`\\b${classification.call}\\(`));
    }
  });

  it("refuses a raw SQL status write to a booking", () => {
    const offenders = scanned.filter((file) => RAW_STATUS_UPDATE.test(stripComments(readFileSync(join(ROOT, file), "utf8"))));
    expect(offenders).toEqual([]);
    for (const write of [
      'await tx.$executeRaw`UPDATE "Booking" SET "status" = \'CANCELLED\' WHERE id = ${id}`',
      'UPDATE "Booking" SET status = \'PAID\' WHERE id = 1',
      'UPDATE "Booking" b SET "status" = \'CANCELLED\' WHERE b.id = 1',
      'UPDATE "Booking" AS b SET status = \'PAID\'',
      'UPDATE ONLY public."Booking" SET "deletedAt" = now(), status = \'CANCELLED\'',
      'UPDATE "public"."Booking" SET\n  "status" = $1::"BookingStatus" WHERE id = $2',
    ]) {
      expect(write).toMatch(RAW_STATUS_UPDATE);
    }
    for (const other of [
      'await tx.$executeRaw`UPDATE "Booking" SET "deletedAt" = now() WHERE id = ${id}`',
      'UPDATE "Booking" SET "notes" = NULL WHERE "status" = \'PAID\'',
      'UPDATE "Booking" b SET "statusNote" = \'x\' WHERE b.id = 1',
      'UPDATE "Payment" SET status = \'SUCCEEDED\'',
    ]) {
      expect(other).not.toMatch(RAW_STATUS_UPDATE);
    }
  });

  it("checks the status-free constants it lets a spread name", () => {
    for (const [name, value] of Object.entries(STATUS_FREE_CONSTANTS)) expect(Object.keys(value), name).not.toContain("status");
  });

  it("sees every form a status write can take (fixture proof)", () => {
    const sites = (code: string) => bookingSaleStatusSites(code, "fixture.ts");
    expect(sites("await tx.booking.update({ where, data: { status: BookingStatus.PAID } });")).toEqual(["PAID"]);
    expect(sites('await prisma.booking.updateMany({ where, data: { status: "CANCELLED", x: 1 } });')).toEqual(["CANCELLED"]);
    expect(sites("await db.booking.create({ data: { status: BookingStatus.CONFIRMED } });")).toEqual([]);
    expect(sites("await tx.booking.update({ where, data: { status: next } });")).toEqual(["computed:next{?}"]);
    // By content: a name's reachable values are read where it is declared, so a new PAID in one changes the key.
    expect(sites("function f(x) { let next = BookingStatus.PENDING; if (x) next = BookingStatus.PAID; return tx.booking.update({ where, data: { status: next } }); }"))
      .toEqual(["computed:next{PAID,PENDING}"]);
    expect(sites("function f() { const next = x ? BookingStatus.PENDING : BookingStatus.CONFIRMED; return tx.booking.update({ where, data: { status: next } }); }")).toEqual([]);
    expect(sites("function f() { const data = { status: BookingStatus.PENDING }; return tx.booking.update({ where, data: data }); }")).toEqual([]);
    // #4659 delta lens, d-4: shorthand `{ where, data }` is read through, and a top-level spread is opaque.
    expect(sites("function f() { const data = { status: BookingStatus.PENDING }; return tx.booking.update({ where, data }); }")).toEqual([]);
    expect(sites("function f() { const data = { status: BookingStatus.PAID }; return tx.booking.update({ where, data }); }")).toEqual(["payload:data{PAID}"]);
    expect(sites("async function f(base) { await tx.booking.update({ ...base }); }")).toEqual(["payload:...base{?}"]);
    // d-1: whole arguments passed by name are walked for their data, never read as the data.
    expect(sites("async function f(id) { const args = { where: { id }, data: { status: BookingStatus.PAID } }; await tx.booking.update(args); }")).toEqual(["PAID"]);
    expect(sites("async function f(id) { const args = { where: { id }, data: { status: BookingStatus.PAID } }; await tx.booking.updateMany(args); }")).toEqual(["PAID"]);
    expect(sites("async function f(id) { const args = { where: { id }, data: { status: BookingStatus.PAID } } satisfies Prisma.BookingUpdateArgs; await tx.booking.update(args); }")).toEqual(["PAID"]);
    expect(sites("async function f(args) { await tx.booking.update(args); }")).toEqual(["payload:args{?}"]);
    // d-2: a payload name the scanner cannot follow fails closed.
    expect(sites("async function f(cancel) { const data: Prisma.BookingUpdateInput = {}; if (cancel) Object.assign(data, { status: BookingStatus.CANCELLED }); await tx.booking.update({ where, data: data }); }"))
      .toEqual(["payload:data{?}"]);
    expect(sites("async function f() { const updateData = { notes: null }; applyCancellation(updateData); await tx.booking.update({ where, data: updateData }); }"))
      .toEqual(["payload:updateData{?}"]);
    expect(sites("async function f(k, v) { const updateData = { notes: null }; updateData[k] = v; await tx.booking.update({ where, data: updateData }); }"))
      .toEqual(["payload:updateData{?}"]);
    expect(sites("async function f(input) { const data = input.cancelData ?? { notes: null }; await tx.booking.update({ where, data: data }); }"))
      .toEqual(["payload:data{?}"]);
    // d-3: a status bound where the scanner cannot see its value, or shadowed elsewhere, stays unknown.
    expect(sites("async function f(tx, status: BookingStatus) { if (!status) status = BookingStatus.PENDING; await tx.booking.update({ where, data: { status } }); }"))
      .toEqual(["computed:status{?,PENDING}"]);
    expect(sites("async function f(input, x) { let { next } = input; if (x) next = BookingStatus.PENDING; await tx.booking.update({ where, data: { status: next } }); }"))
      .toEqual(["computed:next{?,PENDING}"]);
    expect(sites("function f(tx, next) { const g = () => { const next = BookingStatus.PENDING; return next; }; g(); return tx.booking.update({ where, data: { status: next } }); }"))
      .toEqual(["computed:next{?}"]);
    expect(sites('import { next } from "./x"; function g() { const next = BookingStatus.PENDING; return next; } function f() { return tx.booking.update({ where, data: { status: next } }); }'))
      .toEqual(["computed:next{?}"]);
    expect(sites("async function f(rows) { for (const next of rows) await tx.booking.update({ where, data: { status: next } }); }")).toEqual(["computed:next{?}"]);
    expect(sites("async function f() { try { x(); } catch (next) { await tx.booking.update({ where, data: { status: next } }); } }")).toEqual(["computed:next{?}"]);
    expect(sites("function f() { const data: Record<string, unknown> = { status: BookingStatus.PENDING }; data.status = BookingStatus.PAID; return tx.booking.updateMany({ where, data: data }); }"))
      .toEqual(["payload:data{PAID,PENDING}"]);
    expect(sites('function f() { const extra = { x: 1 }; extra["status"] = "CANCELLED"; return tx.booking.update({ where, data: { ...extra } }); }'))
      .toEqual(["spread:extra{CANCELLED}"]);
    expect(sites("await tx.booking.update({ where, data: { ...(legacy ? { status: BookingStatus.CANCELLED } : {}) } });")).toEqual(["CANCELLED"]);
    expect(sites("await tx.booking.update({ where, data: { ...(ok && { status: BookingStatus.PAID }) } });")).toEqual(["PAID"]);
    expect(sites("await tx.booking.update({ where, data: { ...extra } });")).toEqual(["spread:extra{?}"]);
    expect(sites("await tx.booking.update({ where, data: { ...RELEASE_WHOLE_LODGE_HOLD_UPDATE } });")).toEqual([]);
    expect(sites("await tx.booking.updateMany({ where, data: payload });")).toEqual(["payload:payload{?}"]);
    expect(sites("await tx.booking.update({ where, data: on ? { flag: true } : { status: BookingStatus.CANCELLED } });")).toEqual(["CANCELLED"]);
    expect(sites("await tx.booking.upsert({ where, create: { status: BookingStatus.PAID }, update: { status } });")).toEqual(["PAID", "computed:status{?}"]);
    expect(sites('await tx["booking"].update({ where, data: { status: BookingStatus.PAID } });')).toEqual(["PAID"]);
    expect(sites("await tx.booking.findMany({ where: { status: BookingStatus.PAID } });")).toEqual([]);
    expect(sites("await tx.booking.updateMany({ where: { status: BookingStatus.PAID }, data: { notes: null } });")).toEqual([]);
  });
});
