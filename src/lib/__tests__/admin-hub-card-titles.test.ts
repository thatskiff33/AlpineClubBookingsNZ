import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ADMIN_PAGES, getAdminPage, type AdminPageId } from "@/lib/admin-hubs";

/**
 * A hub card that opens a whole admin page is titled with that page's registry
 * label (follow-up to #4968): the name the sidebar, the palette and the page's
 * own heading show, so the card and the page it opens never disagree.
 *
 * A hub card is an object literal with `href`, `title`, `description` and
 * `icon` (the `AdminHubSection` shape), in any production file under `src/`,
 * read as TSX so a comment cannot count. A setup-readiness step has no icon and
 * is named for the check, not the page it links to. A card's
 * `href` opens a whole page when it is `adminHref("<id>")` with no parameters,
 * or a string literal equal to a static page's old path. A tab, an anchor, a
 * query string or a computed href opens a slice of a page, and its card may
 * name that slice; those are not checked. The title must be
 * `getAdminPage("<same id>").label`, or a string literal equal to the label.
 */

const ROOT = process.cwd();

/**
 * Cards allowed another title: `file` to `href` to why. Each must still be
 * found, so a stale entry fails as surely as a new mismatch.
 */
const EXEMPT: Record<string, Record<string, string>> = {
  // #4968 (PR #5107) moves the Setup cards into `setup/hub-cards.ts`, titled
  // from the registry, drops Foundations' card back to Setup, and retitles the
  // Booking Policies cards. Until it lands, the old titles stay here so the two
  // changes do not conflict; whichever merges second drops these entries.
  "src/app/(admin)/admin/setup/setup-page-client.tsx": {
    "/admin/setup/foundations": "#4968 renames Initial Setup to Foundations Setup",
    "/admin/setup/finance": "#4968 renames Finance to Finance Setup",
    'adminHref("notifications")': "#4968 renames Email Messages / Notifications to Notifications & Email",
  },
  "src/app/(admin)/admin/setup/foundations/page.tsx": {
    "/admin/setup": "#4968 removes Foundations' Setup Checklist card",
  },
  "src/app/(admin)/admin/rules/booking-policies/page.tsx": {
    'adminHref("booking-policies-cancellation")': "#4968 renames Default Cancellation Policy to Cancellation Policy",
    'adminHref("booking-policies-periods")': "#4968 renames Date-Specific Periods to Booking Periods",
    'adminHref("booking-policies-minimum-stay")': "#4968 renames Minimum Night Stay to Minimum Stay",
  },
};

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

const STATIC_PAGE_BY_PATH = new Map(
  ADMIN_PAGES.filter((page) => !page.oldPath.includes("[")).map((page) => [page.oldPath, page.id]),
);

interface HubCard {
  line: number;
  /** The href as written: a string literal's text, or the `adminHref(…)` call. */
  href: string;
  /** The registry page the card opens whole, if it does. */
  pageId?: AdminPageId;
  title: ts.Expression;
}

function property(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText() === name) return prop.initializer;
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) return prop.name;
  }
  return undefined;
}

function isAdminHrefCall(node: ts.Expression): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.getText() === "adminHref";
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
        if (ts.isStringLiteralLike(href)) {
          cards.push({ line, href: href.text, pageId: STATIC_PAGE_BY_PATH.get(href.text) as AdminPageId, title });
        } else if (isAdminHrefCall(href)) {
          const [id, ...params] = href.arguments;
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
  if (
    ts.isPropertyAccessExpression(title) && title.name.text === "label" &&
    ts.isCallExpression(title.expression) && title.expression.expression.getText() === "getAdminPage"
  ) {
    const [id] = title.expression.arguments;
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

describe("admin hub cards are titled with their page's registry label", () => {
  const { files, checked, mismatches, exempted } = scan();

  it("PREMISE: the scan reads the production tree and finds the hubs' cards", () => {
    expect(files).toContain("src/app/(admin)/admin/display/page.tsx");
    expect(files.some((file) => file.includes("__tests__"))).toBe(false);
    // A literal href and an adminHref one, so both forms are seen.
    expect(checked).toContain("src/app/(admin)/admin/display/page.tsx: /admin/display/builder");
    expect(checked).toContain('src/app/(admin)/admin/integrations/page.tsx: adminHref("stripe-setup")');
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
    expect(stale, "a reviewed card is gone or now matches: drop it from EXEMPT").toEqual([]);
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
      "];",
    ].join("\n");
    const cards = hubCards("x.tsx", source);
    expect(cards.map((card) => [card.line, card.href, card.pageId])).toEqual([
      [2, "/admin/display/builder", "display-builder"],
      [3, 'adminHref("seasons")', "seasons"],
      [4, 'adminHref("seasons")', "seasons"],
      [5, 'adminHref("fees")', "fees"],
      [8, "/finance", undefined],
    ]);
    expect(cards.slice(0, 4).map(titleValue)).toEqual([
      "Visual builder",
      getAdminPage("seasons").label,
      "the label of fees, not of seasons",
      "an unreadable title label",
    ]);
  });
});
