import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ADMIN_PAGES, adminHref, getAdminPage, type AdminPageId } from "@/lib/admin-hubs";
import { DISPLAY_GLOSSARY_LEAD } from "@/lib/lodge-display/display-terminology";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * A hub card that opens a whole admin page is titled with that page's registry
 * label (follow-up to #4968): the name the command palette shows for that page,
 * so a card and the registry never disagree about what a page is called.
 *
 * A hub card is an object literal with `href`, `title`, `description` and
 * `icon` (the `AdminHubSection` shape), in any production file under `src/`,
 * read as TSX so a comment cannot count. A setup-readiness step has no icon and
 * is named for the check, not the page it links to. A card's
 * `href` opens a whole page when it is `adminHref("<id>")` or
 * `adminLink("<id>").href` with no parameters, or a string literal equal to a
 * static page's old path or live href. A tab, an anchor, a query string or a
 * computed href opens a slice of a page, and its card may name that slice;
 * those are not checked. The title must be `getAdminPage("<same id>").label`
 * or `adminLink("<same id>").label`, or a string literal equal to the label.
 *
 * Why a census and not a helper that builds the whole card from one id: a card
 * may name a slice of a page, so a helper that forced the label would be wrong
 * for those; and the Display hub's cards are `adminHref` calls that the
 * builder's `hardNavigate` guard reads from source (C11 part 1, #4808), so it
 * needs a census whatever the other hubs do. The census reads every form, so
 * the older `adminLink` cards are held to the same rule as the new ones.
 */

const ROOT = process.cwd();

/**
 * Cards allowed another title: `file` to `href` to why. Each must still be
 * found, so a stale entry fails as surely as a new mismatch.
 */
const EXEMPT: Record<string, Record<string, string>> = {};

/** Every production `.ts`/`.tsx` file under `dir`, tests and the registry left out. */
function productionFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") return [];
      if (rel === "src/lib/admin-hubs") return [];
      return productionFiles(rel);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [rel];
  });
}

/** A static page by either path a literal href may spell: its old path or its live `adminHref`. */
const STATIC_PAGE_BY_PATH = new Map<string, string>(
  ADMIN_PAGES.filter((page) => !page.oldPath.includes("[")).flatMap((page): [string, string][] => [
    [page.oldPath, page.id],
    [adminHref(page.id as never), page.id],
  ]),
);

interface HubCard {
  line: number;
  /** The href as written: a string literal's text, or the `adminHref(…)` call. */
  href: string;
  /** The registry page the card opens whole, if it does. */
  pageId?: AdminPageId;
  title: ts.Expression;
}

/** A property's name whether it is written bare, quoted or as a plain template. */
function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && propertyName(prop.name) === name) return prop.initializer;
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) return prop.name;
  }
  return undefined;
}

/** `fn("<id>", …)`, the call itself, when `node` is one to the registry helper `fn`. */
function registryCall(node: ts.Expression, fn: string): ts.CallExpression | undefined {
  return ts.isCallExpression(node) && node.expression.getText() === fn ? node : undefined;
}

/** The call inside `adminLink("<id>").<member>`, when `node` is that. */
function adminLinkMember(node: ts.Expression, member: "href" | "label"): ts.CallExpression | undefined {
  return ts.isPropertyAccessExpression(node) && node.name.text === member
    ? registryCall(node.expression, "adminLink")
    : undefined;
}

/** Every hub card in `source`, and the page each opens whole. */
function hubCards(file: string, source: string): HubCard[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const cards: HubCard[] = [];
  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      const href = property(node, "href");
      const title = property(node, "title");
      if (href && title && property(node, "description") && property(node, "icon")) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        const call = registryCall(href, "adminHref") ?? adminLinkMember(href, "href");
        if (ts.isStringLiteralLike(href)) {
          cards.push({ line, href: href.text, pageId: STATIC_PAGE_BY_PATH.get(href.text) as AdminPageId, title });
        } else if (call) {
          const [id, ...params] = call.arguments;
          const whole = id && ts.isStringLiteral(id) && params.length === 0;
          cards.push({ line, href: href.getText(tree), pageId: whole ? (id.text as AdminPageId) : undefined, title });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return cards;
}

/** The title a card shows, or why it cannot be read. */
function titleValue(card: HubCard): string {
  const { title } = card;
  if (ts.isStringLiteralLike(title)) return title.text;
  // A page's label does not depend on the parameters its link takes.
  const labelOf =
    ts.isPropertyAccessExpression(title) && title.name.text === "label"
      ? registryCall(title.expression, "getAdminPage") ?? adminLinkMember(title, "label")
      : undefined;
  if (labelOf) {
    const [id] = labelOf.arguments;
    if (id && ts.isStringLiteral(id)) {
      if (id.text !== card.pageId) return `the label of ${id.text}, not of ${card.pageId}`;
      return getAdminPage(id.text as AdminPageId).label;
    }
  }
  return `an unreadable title ${title.getText()}`;
}

function scan() {
  const files = ["src/app", "src/components", "src/lib"].flatMap(productionFiles);
  const checked: string[] = [];
  const mismatches: string[] = [];
  const exempted: string[] = [];
  for (const file of files) {
    for (const card of hubCards(file, fs.readFileSync(path.join(ROOT, file), "utf8"))) {
      if (!card.pageId) continue;
      checked.push(`${file}: ${card.href}`);
      const label = getAdminPage(card.pageId).label;
      const shown = titleValue(card);
      if (shown === label) continue;
      if (EXEMPT[file]?.[card.href]) {
        exempted.push(`${file}: ${card.href}`);
        continue;
      }
      mismatches.push(`${file}:${card.line}: ${card.href} is titled "${shown}", its page is "${label}"`);
    }
  }
  return { files, checked, mismatches, exempted };
}

describe("admin hub cards are titled with their page's registry label", { timeout: CENSUS_TIMEOUT_MS }, () => {
  const { files, checked, mismatches, exempted } = scan();

  it("PREMISE: the scan reads the production tree and finds the hubs' cards", () => {
    expect(files).toContain("src/app/(admin)/admin/lodge-ops/display/page.tsx");
    expect(files.some((file) => file.includes("__tests__"))).toBe(false);
    // An `adminHref` card and an `adminLink` one are seen. The Display hub's
    // cards stopped being literal hrefs when it moved under lodge-ops (C11 part
    // 1, #4808); the literal form is read by the fixture test below.
    expect(checked).toContain(
      'src/app/(admin)/admin/lodge-ops/display/page.tsx: adminHref("display-builder")',
    );
    expect(checked).toContain('src/app/(admin)/admin/integrations/page.tsx: adminHref("stripe-setup")');
    expect(checked).toContain(
      'src/app/(admin)/admin/membership/membership-setup/page.tsx: adminLink("membership-types").href',
    );
    expect(checked.length).toBeGreaterThan(20);
  });

  it("finds no card titled other than its page, outside the reviewed list", () => {
    expect(
      mismatches,
      'Title the card getAdminPage("<id>").label. A card that must keep another name goes in EXEMPT with its reason.',
    ).toEqual([]);
  });

  it("still finds every reviewed exemption", () => {
    const stale = Object.entries(EXEMPT).flatMap(([file, hrefs]) =>
      Object.keys(hrefs)
        .map((href) => `${file}: ${href}`)
        .filter((entry) => !exempted.includes(entry)),
    );
    expect(
      stale,
      "a reviewed card is gone or now matches: drop it from EXEMPT.",
    ).toEqual([]);
  });

  // The Display hub's lead is typed text, so it is pinned to the labels its
  // cards now take from the registry: rename a page and this fails.
  it("the Display hub's lead names its cards by their registry labels", () => {
    for (const id of ["display-builder", "display-layouts", "display-templates", "display-reference"] as const) {
      expect(DISPLAY_GLOSSARY_LEAD).toContain(getAdminPage(id).label);
    }
  });

  it("reads each href and title form, and leaves slices of a page alone", () => {
    const source = [
      "const cards = [",
      '  { href: "/admin/display/builder", title: "Visual builder", description: "", icon },',
      '  { href: adminHref("seasons"), title: getAdminPage("seasons").label, description: "", icon },',
      '  { href: adminHref("seasons"), title: getAdminPage("fees").label, description: "", icon },',
      '  { href: adminHref("fees"), title: label, description: "", icon },',
      '  { href: adminTabHref("membership-cancellations", "settings"), title: "x", description: "", icon },',
      '  { href: `${adminHref("fees")}?lodgeId=1`, title: "x", description: "", icon },',
      '  { href: "/finance", title: "Finance Dashboard", description: "", icon },',
      '  { href: "/admin/display/builder", label: "not a card" },',
      '  { href: adminLink("seasons").href, title: adminLink("seasons").label, description: "", icon },',
      '  { href: adminLink("seasons").href, title: adminLink("fees").label, description: "", icon },',
      '  { href: adminLink("seasons", { lodgeId: 1 }).href, title: "x", description: "", icon },',
      '  { "href": adminHref("seasons"), "title": "Hut Fees", "description": "", "icon": icon },',
      "];",
    ].join("\n");
    const cards = hubCards("x.tsx", source);
    expect(cards.map((card) => [card.line, card.href, card.pageId])).toEqual([
      [2, "/admin/display/builder", "display-builder"],
      [3, 'adminHref("seasons")', "seasons"],
      [4, 'adminHref("seasons")', "seasons"],
      [5, 'adminHref("fees")', "fees"],
      [8, "/finance", undefined],
      [10, 'adminLink("seasons").href', "seasons"],
      [11, 'adminLink("seasons").href', "seasons"],
      [12, 'adminLink("seasons", { lodgeId: 1 }).href', undefined],
      [13, 'adminHref("seasons")', "seasons"],
    ]);
    const titles = cards.map(titleValue);
    expect(titles.slice(0, 4)).toEqual([
      "Visual builder",
      getAdminPage("seasons").label,
      "the label of fees, not of seasons",
      "an unreadable title label",
    ]);
    expect(titles.slice(5)).toEqual([
      getAdminPage("seasons").label,
      "the label of fees, not of seasons",
      "x",
      "Hut Fees",
    ]);
  });
});
