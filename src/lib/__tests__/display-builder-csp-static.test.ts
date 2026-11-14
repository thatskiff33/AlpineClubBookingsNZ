import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_PAGES, getAdminPage } from "@/lib/admin-hubs";
import { FRAME_SRC_SELF_PATHS, TIGHT_IMG_SRC_PATHS } from "@/lib/csp";

/**
 * Static guards for the invariants that make this app's route-scoped CSP
 * relaxations (`src/lib/csp.ts`, issues #2246 / #2279) actually work and
 * actually stay safe. They are source assertions in the house static-test style
 * (see `email-settings-panel-static.test.ts`) because none can be observed from
 * a rendered unit test: they are about how a document is ENTERED, and about what
 * a future edit might add.
 *
 * The guards are driven from the allowlists themselves, not from a hardcoded
 * route, so ADDING a path to a relaxation automatically requires that path's
 * entry points to be hard navigations — which is the general failure this
 * protects against, not just the one instance of it that was found.
 */

/**
 * Every path that carries a route-scoped CSP relaxation today. Deduped because
 * a path may legitimately appear on both lists.
 */
const RELAXED_PATHS = [
  ...new Set([...FRAME_SRC_SELF_PATHS, ...TIGHT_IMG_SRC_PATHS]),
].sort();

/**
 * The registered admin pages served at a relaxed path. A link reaches them
 * through `adminHref(id)`, which is no literal of either path (C11 part 1
 * #4808), so the scans below treat that call as targeting both of the page's
 * addresses. Each page must therefore be relaxed at its old path AND its hub
 * path, or the hub URL would open without the relaxation once the switch is on.
 */
const RELAXED_PAGE_IDS = ADMIN_PAGES.filter(
  (page) => RELAXED_PATHS.includes(page.oldPath) || RELAXED_PATHS.includes(page.hubPath),
).map((page) => page.id);

const REPO_ROOT = process.cwd();
const BUILDER_SOURCE = "src/app/(admin)/admin/lodge-ops/display/builder/display-builder.tsx";
const HUB_RENDERER = "src/components/admin-hub-page.tsx";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "dist",
  "build",
]);

function collectSourceFiles(directory: string, found: string[] = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectSourceFiles(absolute, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    // Tests legitimately mention a relaxed route as a string (asserting a
    // `window.open(..., "_self")` target, a CSP pathname, …); they render no
    // navigation of their own.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (absolute.split(path.sep).includes("__tests__")) continue;
    found.push(absolute);
  }
  return found;
}

/**
 * Does a link target resolve to one of the relaxed routes?
 *
 * `raw` is the literal text of a URL as written in the source, so it may carry a
 * query string, a fragment, or a `${…}` interpolation. Only the leading path
 * segment counts, and it must match a relaxed path in FULL — `/display` must not
 * be read out of `/admin/display/layouts` or ``/admin/lodges/${id}/display``.
 * A trailing slash is folded exactly as `src/lib/csp.ts` folds it.
 */
function targetsRelaxedPath(raw: string) {
  const [pathPart = ""] = raw.split(/[?#]|\$\{|["'`]/, 1);
  const normalised =
    pathPart.length > 1 && pathPart.endsWith("/")
      ? pathPart.slice(0, -1)
      : pathPart;
  return RELAXED_PATHS.includes(normalised);
}

/** An `adminHref("id")` call, bare or opening a template literal. */
const ADMIN_HREF_CALL = /^(?:`\$\{\s*)?adminHref\(\s*["']([^"']+)["']/;

/**
 * Does a link EXPRESSION, as written from its first character, target a relaxed
 * route? Either a string literal whose path is relaxed, or `adminHref` of a
 * page served at a relaxed path (on its own or leading a template literal).
 */
function targetsRelaxedTarget(expression: string) {
  const call = ADMIN_HREF_CALL.exec(expression);
  if (call) return RELAXED_PAGE_IDS.includes(call[1]);
  const literal = /^[`"']([^`"']*)/.exec(expression);
  return literal !== null && targetsRelaxedPath(literal[1]);
}

/**
 * Every `href=` / `href:` in a source file, with its offset. `value` is the
 * rest of the line from the expression's first character; `text` stops before
 * it, so a caller reading on from `index + text.length` still sees the rest of
 * the object the href sits in.
 */
function hrefLiterals(source: string, form: "jsx" | "descriptor") {
  const pattern = form === "jsx" ? /href=\{?\s*(?=([^\n]*))/g : /href:\s*(?=([^\n]*))/g;
  return [...source.matchAll(pattern)].map((match) => ({
    value: match[1],
    index: match.index,
    text: match[0],
  }));
}

/**
 * The JSX opening tag a given source offset sits inside — found by walking back
 * to the nearest `<Tag`. Scanning backwards from the `href` rather than forwards
 * from the tag is deliberate: a forward `<Tag[^>]*>` scan is truncated by the
 * `>` in any arrow function among the attributes, which would silently turn this
 * guard into a no-op on exactly the kind of component most likely to hide one.
 */
function enclosingJsxTag(source: string, index: number) {
  const before = source.slice(0, index);
  const opener = before.lastIndexOf("<");
  if (opener === -1) return null;
  return /^<([A-Za-z][A-Za-z0-9.]*)/.exec(before.slice(opener))?.[1] ?? null;
}

const sourceFiles = collectSourceFiles(path.join(REPO_ROOT, "src"));

describe("routes with a scoped CSP relaxation are entered by a HARD navigation (#2246, #2279)", () => {
  /*
   * WHY THESE TESTS EXIST — do not "simplify" the guarded links back to <Link>.
   *
   * A Content-Security-Policy is a property of the DOCUMENT. The browser takes
   * it from the response headers when the document is parsed and it never
   * changes for the life of that document. A Next.js App Router <Link> performs
   * a SOFT navigation: it swaps React trees inside the SAME document, so the
   * CSP stays whatever the ENTRY document was served with. There is a single
   * root layout here, so every /admin/* -> /admin/* <Link> is soft.
   *
   * So EVERY relaxation in `src/lib/csp.ts` is inert unless its route is entered
   * by a hard document load: a plain `<a href>` (still a real link — same role,
   * keyboard activation and ctrl/middle-click behaviour as <Link>), a
   * `window.open(url, …)`, or a real frame/tab navigation. `frame-src 'self'`
   * for the Visual builder was exactly this bug: the grant was correct and the
   * Live preview still showed "Content blocked", because both in-app links to
   * the builder were <Link>s.
   */

  it("has allowlisted paths to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(RELAXED_PATHS.length).toBeGreaterThan(0);
  });

  it("relaxes each admin page it relaxes at both of its addresses (C11 part 1 #4808)", () => {
    expect([...RELAXED_PAGE_IDS].sort()).toEqual(["display-builder", "display-preview"]);
    for (const id of RELAXED_PAGE_IDS) {
      const page = ADMIN_PAGES.find((candidate) => candidate.id === id)!;
      expect(RELAXED_PATHS).toContain(page.oldPath);
      expect(RELAXED_PATHS).toContain(page.hubPath);
    }
  });

  it("reads adminHref of a relaxed page as a relaxed target, and nothing else", () => {
    expect(targetsRelaxedTarget(`adminHref("display-builder")`)).toBe(true);
    expect(targetsRelaxedTarget("`${adminHref(\"display-preview\")}?templateId=${id}`")).toBe(true);
    expect(targetsRelaxedTarget(`"/admin/lodge-ops/display/preview?x=1"`)).toBe(true);
    expect(targetsRelaxedTarget(`adminHref("display-templates")`)).toBe(false);
    expect(targetsRelaxedTarget(`adminHref("display-builder-x")`)).toBe(false);
    expect(targetsRelaxedTarget(`"/admin/lodge-ops/display/builder/extra"`)).toBe(false);
    expect(targetsRelaxedTarget(`"/admin/lodge-ops/display/templates"`)).toBe(false);
  });

  it("routes no client-side router push/replace at a relaxed path", () => {
    // `router.push`/`router.replace` are soft for the same reason a <Link> is.
    const routerNavigation = /\.(?:push|replace)\(\s*(?=([^\n]*))/g;
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(routerNavigation)) {
        if (targetsRelaxedTarget(match[1])) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[0]}${match[1]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("puts every JSX href at a relaxed path on a plain <a>, never a component", () => {
    /*
     * This is the generalisation of "no <Link> at the builder": a plain <a> is
     * the ONLY tag that guarantees a document load. `<Link>`, `<BackLink>` and
     * any other component wrapper may route however they like, so all of them
     * fail here — no allowlist of soft-navigating component names to maintain.
     *
     * Known limit: an href passed through a variable (`const to = "/display";
     * <Link href={to}>`) is invisible to any literal scan. The descriptor test
     * below covers the one such indirection that exists in this codebase.
     */
    const offenders: string[] = [];
    let sites = 0;
    let adminHrefSites = 0;

    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, "utf8");
      for (const { value, index, text } of hrefLiterals(source, "jsx")) {
        if (!targetsRelaxedTarget(value)) continue;
        sites += 1;
        if (ADMIN_HREF_CALL.test(value)) adminHrefSites += 1;
        const tag = enclosingJsxTag(source, index);
        if (tag !== "a") {
          offenders.push(`${path.relative(REPO_ROOT, file)}: <${tag ?? "?"} ${text}${value}…`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // Positive control: a scan that matched nothing would pass silently. Five
    // sites exist today — the Layouts page's builder link, the Devices page's
    // per-device /display preview, and the setup wizard's two builder links and
    // its preview link. All but the /display one are adminHref calls.
    expect(sites).toBeGreaterThanOrEqual(5);
    expect(adminHrefSites).toBeGreaterThanOrEqual(4);
  });

  it("never spreads adminLink of a relaxed page into a component", () => {
    // `adminLink` feeds back links and menu items, which are soft. The relaxed
    // pages are linked with `adminHref` on a plain <a> or a hardNavigate card.
    const relaxedLink = new RegExp(
      `adminLink\\(\\s*["'](?:${RELAXED_PAGE_IDS.join("|")})["']`,
    );
    const offenders = sourceFiles
      .filter((file) => relaxedLink.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("marks every hub/nav descriptor pointing at a relaxed path hardNavigate", () => {
    /*
     * The variable-href case a literal scan cannot see: `admin-hub-page.tsx`
     * renders `<Link href={href}>` from a descriptor object, so the relaxed
     * path never appears next to a `<Link>` in the source at all. The descriptor
     * must opt in instead, and the test below pins that the opt-in still emits
     * a plain <a>.
     */
    const offenders: string[] = [];
    let descriptors = 0;

    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, "utf8");
      for (const { value, index, text } of hrefLiterals(source, "descriptor")) {
        if (!targetsRelaxedTarget(value)) continue;
        descriptors += 1;
        // The rest of the object literal this href belongs to: up to its closing
        // `},` — or the next descriptor's `href:`, whichever comes first. Both
        // bounds matter: without the first, a missing `},` would let the search
        // run to end-of-file; without the second, a LATER sibling's
        // `hardNavigate: true` could satisfy this one.
        const rest = source.slice(index + text.length);
        const end = Math.min(
          ...[rest.indexOf("},"), rest.search(/\bhref:/)]
            .filter((at) => at !== -1)
            .concat(rest.length),
        );
        if (!/hardNavigate:\s*true/.test(rest.slice(0, end))) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${text}${value}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // Positive control, as above: the Lobby Display hub's Visual builder card,
    // an adminHref call since C11 part 1 (#4808).
    expect(descriptors).toBeGreaterThanOrEqual(1);
  });

  it("still renders a plain anchor when a descriptor opts in", () => {
    const hubRenderer = fs.readFileSync(path.join(REPO_ROOT, HUB_RENDERER), "utf8");
    // Losing this would make the `hardNavigate` opt-in above a no-op, and the
    // relaxation silently inert again.
    expect(hubRenderer).toMatch(/hardNavigate\s*\?\s*\(\s*<a\b/);
  });
});

describe("Visual builder renders no authored markup itself (#161, #2246)", () => {
  /*
   * WHY THIS TEST EXISTS.
   *
   * `src/lib/csp.ts` keeps two SEPARATE exact-match allowlists. The builder is
   * in `FRAME_SRC_SELF_PATHS` (it embeds the /display iframe) but deliberately
   * NOT in `TIGHT_IMG_SRC_PATHS`, so it keeps the normal admin `img-src ... https:`
   * for avatars and uploaded imagery. That exclusion is only safe because the
   * builder never renders admin-authored display HTML/CSS in its OWN document —
   * the draft is rendered exclusively inside the opaque-origin /display frame,
   * which carries the tightened `img-src 'self' data:` itself.
   *
   * The moment the builder gains an in-canvas WYSIWYG preview (dangerouslySet-
   * InnerHTML, an iframe `srcDoc`, an `innerHTML` assignment, or an injected
   * <style> block of authored CSS), authored markup runs in an admin document
   * with `img-src https:` — reinstating the issue #161 image-beacon
   * exfiltration channel with no other test failing. If this assertion starts
   * failing, the fix is not to delete it: either keep the preview inside the
   * sandboxed frame, or add the builder to TIGHT_IMG_SRC_PATHS and re-review.
   */
  it("keeps the builder out of the tightened img-src allowlist, at both of its addresses", () => {
    // The premise of the assertion below. If the builder is ever added to
    // TIGHT_IMG_SRC_PATHS this test should be re-reviewed, not silently kept.
    const builder = getAdminPage("display-builder");
    for (const address of [builder.oldPath, builder.hubPath]) {
      expect(TIGHT_IMG_SRC_PATHS).not.toContain(address);
      expect(FRAME_SRC_SELF_PATHS).toContain(address);
    }
    expect(builder.hubPath).toBe("/admin/lodge-ops/display/builder");
  });

  it("uses no HTML-injection sink in the builder component", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, BUILDER_SOURCE), "utf8");

    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/\bsrcDoc\b/);
    expect(source).not.toMatch(/\binnerHTML\b/);
    expect(source).not.toMatch(/<style\b/);
  });
});
