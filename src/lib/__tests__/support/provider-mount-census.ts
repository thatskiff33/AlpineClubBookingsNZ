import fs from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * The machinery behind a PROVIDER MOUNT CENSUS: the shared route walk, the
 * layout-wrapping rule and the import-graph walk that two of them now run.
 *
 * ## Why it is a module rather than a copy
 *
 * `club-time-provider-mount-census.test.tsx` (CT-4, #2870) invented this shape
 * and `club-format-provider-mount-census.test.tsx` (#3564) needs it unchanged:
 * both ask "is every page under one of exactly two chrome components, and is
 * every surface outside them provably free of the hook that throws?". Only the
 * provider's NAME, its hook and the reasons on its reviewed list differ.
 *
 * Copying three hundred lines of walker for that would put two homes under one
 * rule, which is what `INV-SSOT` refuses — and worse, the copies would drift:
 * the club-time census has already been corrected three times (a `.jsx` page it
 * could not see, a conditional mount it passed, a comment that satisfied a
 * positive rule), and a copy would have inherited the bugs and none of the
 * fixes. Each census file keeps the part that is genuinely its own: its mount
 * points, its hook, its reviewed surfaces and the reason written against each.
 *
 * ## Reading the source rather than matching it raw
 *
 * Every presence check here runs over `stripComments(source)`, the one shared
 * implementation, whose first caller had already met and documented the hazard:
 * a POSITIVE rule ("this layout must render `<AppProviders>`") is satisfied by a
 * COMMENT mentioning it, so an un-stripped substring match passes on a layout
 * with no provider anywhere. Measured on that census before the strip existed.
 *
 * These are still substring rules over text rather than an AST. A branch that
 * renders something OTHER than the page
 * (`cond ? <AppProviders>{children}</AppProviders> : <SetupRedirect />`) passes,
 * and correctly — down that branch the page is not rendered at all, so there is
 * nothing to be missing a provider. A layout that passes the page through under
 * another name (`{props.children}`, `{cond ? children : null}`) fails, loudly
 * and wrongly, and the fix is to write `{children}`.
 */

export const ROOT = process.cwd();
export const APP = path.join(ROOT, "src", "app");
const SRC = path.join(ROOT, "src");

/** The Next.js file extensions a route or component may be written in. */
export const CODE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

/** Imported for a side effect or a URL, never for a component. */
const ASSET_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".woff",
  ".woff2",
]);

/**
 * A route file, in every extension Next.js accepts.
 *
 * NOT `name === "page.tsx"`. Next resolves `page.jsx` and `page.js` exactly as
 * it resolves `page.tsx`, and both were invisible to the first census — a page
 * added in either would have had neither a mounting layout nor a row on the
 * reviewed list, and nothing would have said so.
 */
export function isRouteFile(name: string, base: string): boolean {
  return CODE_EXTENSIONS.some((extension) => name === `${base}${extension}`);
}

export function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** A repository-relative posix path, which is what every message here prints. */
export function relative(absolute: string): string {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

export function walk(dir: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...walk(full, match));
    } else if (match(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Every `page.*` inside a bracketed route group, as absolute paths. */
export function pagesInRouteGroups(): string[] {
  return walk(APP, (name) => isRouteFile(name, "page")).filter((file) =>
    path.relative(APP, file).startsWith("("),
  );
}

/**
 * The directories whose layout really WRAPS `{children}` in one of `mountNames`.
 *
 * A layout has to wrap the page, not merely name the component: `{children}`
 * must sit between the mount's opening and closing tags AND appear exactly once
 * in the file. The second half is what catches a CONDITIONAL mount —
 * `cond ? <AppProviders>{children}</AppProviders> : <>{children}</>`, which
 * renders the page with no provider down one branch and satisfies any check
 * that only looks for the wrapped branch. Measured: that shape passes a
 * presence check alone and fails this one.
 */
export function mountingLayoutDirectories(
  mountNames: readonly string[],
): Set<string> {
  return new Set(
    walk(APP, (name) => isRouteFile(name, "layout"))
      .filter((file) => {
        const source = stripComments(fs.readFileSync(file, "utf8"));
        return mountNames.some((name) => {
          const opened = source.indexOf(`<${name}`);
          const closed = source.indexOf(`</${name}>`);
          if (opened === -1 || closed <= opened) return false;
          const wrapped = source.slice(opened, closed);
          return (
            wrapped.includes("{children}") &&
            source.split("{children}").length === 2
          );
        });
      })
      .map((file) => path.dirname(file)),
  );
}

/** The route-group pages with no mounting layout at or above them, relative. */
export function pagesWithoutMountingLayout(
  mountNames: readonly string[],
): string[] {
  const mounting = mountingLayoutDirectories(mountNames);
  return pagesInRouteGroups()
    .filter((page) => {
      let dir = path.dirname(page);
      while (dir.startsWith(APP)) {
        if (mounting.has(dir)) return false;
        dir = path.dirname(dir);
      }
      return true;
    })
    .map(relative);
}

/**
 * Every rendered surface with NO mounting layout above it, relative and sorted.
 *
 * PAGES, plus the three special files Next renders OUTSIDE every route group's
 * layout. `not-found.tsx` and `error.tsx` at the app root, and
 * `global-error.tsx`, are real rendered surfaces with no `page.tsx` of their
 * own, so a walk that collected only pages could not see them — and one of
 * them, `(finance)/not-found.tsx`, is inside a route group that has no
 * group-root layout at all, so being in a group does not make it covered.
 */
export function surfacesOutsideMountingLayouts(
  mountNames: readonly string[],
): string[] {
  const pages = walk(APP, (name) => isRouteFile(name, "page"))
    .map(relative)
    .filter((file) => !path.relative(APP, path.join(ROOT, file)).startsWith("("));

  const specials = walk(
    APP,
    (name) =>
      isRouteFile(name, "not-found") ||
      isRouteFile(name, "error") ||
      isRouteFile(name, "global-error"),
  )
    .map(relative)
    .filter((file) => {
      // A not-found/error file IS covered when a mounting layout sits at or
      // above its own directory, which is why (admin), (authenticated) and
      // (lodge) do not appear on a reviewed list and (finance) does.
      let dir = path.dirname(path.join(ROOT, file));
      while (dir.startsWith(APP)) {
        for (const extension of CODE_EXTENSIONS) {
          const layout = path.join(dir, `layout${extension}`);
          if (fs.existsSync(layout)) {
            const source = stripComments(fs.readFileSync(layout, "utf8"));
            if (mountNames.some((name) => source.includes(`<${name}`))) {
              return false;
            }
          }
        }
        dir = path.dirname(dir);
      }
      return true;
    });

  return [...pages, ...specials].sort();
}

/**
 * Resolve one import specifier to a tracked file under `src/`, or `null`.
 *
 * Only `@/` and relative specifiers are followed: a bare specifier is a
 * package, and no package in this application renders a club component.
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  for (const extension of CODE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const extension of CODE_EXTENSIONS) {
      const candidate = path.join(base, `index${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  return null;
}

/** Every specifier a file imports, static and dynamic. */
function importSpecifiers(strippedSource: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(strippedSource)) !== null) found.push(match[1]);
  return found;
}

export interface WalkResult {
  /** Files reached, as repository-relative posix paths. */
  visited: string[];
  /** Files that CALL the hook and are not below a provider of their own. */
  consumers: string[];
  /** Files that mounted their own provider, so their subtree was not walked. */
  boundaries: string[];
  /**
   * First-party specifiers the resolver could not turn into a file, as
   * `importer -> specifier`.
   *
   * THIS IS THE ANTI-VACUITY, and it is the one that fits. "The walk reached
   * more than one file" would be the obvious check and is wrong: several
   * surfaces import nothing but packages, which is not a broken walk but the
   * strongest possible evidence that nothing below them needs the value. A
   * resolver that quietly failed on `@/...` would instead report an empty
   * consumer list having inspected nothing, and that is what this catches.
   */
  unresolved: string[];
}

export interface ProviderWalkOptions {
  /** The opening tag that ENDS the walk, e.g. `"<ClubTimeProvider"`. */
  mountTag: string;
  /** Matches a call of the hook that throws, e.g. `/\buseClubTime\s*\(/`. */
  hookCall: RegExp;
  /** Where the hook is DEFINED, so its own signature is not read as a call. */
  hookDefinition: string;
  /**
   * Walk THROUGH the entry file even though it mounts the provider itself.
   *
   * The default is wrong for a SELF-MOUNTING surface — one outside every
   * chrome layout that mounts the provider in its own file. Stopping at the
   * entry would report a boundary having inspected nothing, which is a green
   * result that measured no code at all. Walking through it instead turns the
   * question around, from "does anything below reach the hook?" to "does
   * anything below reach the hook, so that the mount is load-bearing rather
   * than decorative?" — and the surface's own test asserts the consumers are
   * NON-empty.
   */
  walkThroughEntry?: boolean;
}

/**
 * Everything an entry file can reach, stopping at any file that mounts its own
 * provider.
 *
 * The stop is the whole reason a plain "nothing in this tree names the hook"
 * scan would be wrong: `src/app/not-found.tsx` really does reach the Whakapapa
 * widget, which really does call `useClubTime()`, and that is correct because
 * `skifield-whakapapa-embed.tsx` wraps it in a provider of its own.
 */
export function walkImports(
  entryRelative: string,
  options: ProviderWalkOptions,
): WalkResult {
  const entry = path.join(ROOT, entryRelative);
  const seen = new Set<string>();
  const consumers: string[] = [];
  const boundaries: string[] = [];
  const unresolved: string[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    const stripped = stripComments(fs.readFileSync(file, "utf8"));
    const asRelative = relative(file);

    const isEntry = file === entry;
    if (
      stripped.includes(options.mountTag) &&
      !(isEntry && options.walkThroughEntry === true)
    ) {
      boundaries.push(asRelative);
      continue;
    }
    if (
      asRelative !== options.hookDefinition &&
      options.hookCall.test(stripped)
    ) {
      consumers.push(asRelative);
    }

    for (const specifier of importSpecifiers(stripped)) {
      // A stylesheet or an image imported for its side effect carries no
      // components, so it is neither walked nor counted as a resolution failure.
      if (ASSET_EXTENSIONS.has(path.extname(specifier))) continue;

      const resolved = resolveImport(file, specifier);
      if (resolved === null) {
        if (specifier.startsWith("@/") || specifier.startsWith(".")) {
          unresolved.push(`${asRelative} -> ${specifier}`);
        }
        continue;
      }
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }

  return {
    visited: [...seen].map(relative).sort(),
    consumers: consumers.sort(),
    boundaries: boundaries.sort(),
    unresolved: unresolved.sort(),
  };
}
