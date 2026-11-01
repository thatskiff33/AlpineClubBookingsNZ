#!/usr/bin/env node
/**
 * One-way mirror of docs/user-guide/ to the GitHub wiki (issue #2083).
 *
 * `docs/user-guide/` stays the single source of truth (reviewed by PR, link-
 * checked by CI). This script transforms those pages for wiki-land and writes
 * them into a cloned wiki working tree; the `Wiki sync` workflow
 * (.github/workflows/wiki-sync.yml) runs it on every push to `main` that
 * touches the guide and pushes the result. Direct wiki edits are overwritten
 * by design — every mirrored page carries a banner saying so.
 *
 *   node scripts/sync-user-guide-wiki.mjs --out <wiki-clone-dir>
 *   node scripts/sync-user-guide-wiki.mjs --list        # dry run: print the page map
 *
 * Transformations:
 *  - README.md becomes Home; each guide page is named from its H1 title.
 *  - Sibling guide links (with anchors) become wiki page links.
 *  - Repo-relative links (../X) become absolute github.com blob/tree URLs.
 *  - Image embeds (../images/**) become raw.githubusercontent.com URLs, so a
 *    screenshot refresh on `main` updates the wiki with no image duplication.
 *  - _Sidebar.md (reading order parsed from the index) and _Footer.md are
 *    generated; previously mirrored pages whose source is gone are deleted
 *    (only pages carrying this script's marker are ever touched).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/is-main-module.mjs";

const MARKER = "<!-- managed-by:sync-user-guide-wiki";
const SOURCE_DIR = "docs/user-guide";
const BRANCH = "main";

/** Repo slug (owner/name) from package.json's repository URL — no hardcoding. */
export function repoSlugFromPackageJson(pkgJsonText) {
  const url = JSON.parse(pkgJsonText)?.repository?.url ?? "";
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!m) throw new Error(`Cannot derive repo slug from repository.url: ${url}`);
  return m[1];
}

/** Wiki page name from a guide's H1 title, e.g. "The waitlist & offers" -> "The-waitlist-and-offers". */
export function pageNameFromTitle(title) {
  const cleaned = title
    .replace(/&/g, "and")
    .replace(/[^A-Za-z0-9 -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) throw new Error(`Guide H1 produces an empty wiki page name: ${JSON.stringify(title)}`);
  return cleaned.replace(/ /g, "-");
}

/** First `# ` heading of a markdown source. */
export function firstH1(source) {
  const m = source.match(/^# (.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Reading order: the order guide files are first linked from the index page.
 * Parsing the index (rather than hardcoding) means the sidebar can never
 * drift from the source of truth.
 */
export function readingOrderFromIndex(indexSource, guideFiles) {
  const seen = [];
  for (const m of indexSource.matchAll(/\]\(([a-z0-9-]+\.md)(#[^)]*)?\)/g)) {
    const file = m[1];
    if (guideFiles.includes(file) && !seen.includes(file)) seen.push(file);
  }
  for (const file of guideFiles) if (!seen.includes(file)) seen.push(file);
  return seen;
}

/** Resolve a ../-style link from docs/user-guide/ to a repo-rooted posix path. */
function resolveRepoPath(relative) {
  const joined = path.posix.normalize(path.posix.join(SOURCE_DIR, relative));
  if (joined.startsWith("..")) {
    throw new Error(`Link escapes the repository root: ${relative}`);
  }
  return joined;
}

/**
 * Rewrite one link target. `isImage` selects raw vs blob/tree URLs.
 * Returns the target unchanged when it is absolute, an in-page anchor, or not
 * something we recognise (never guess).
 */
export function rewriteTarget(target, { slug, pageMap }) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [pathPart, anchor = ""] = target.split(/(?=#)/);
  // Sibling guide page (or the index itself).
  const sibling = pageMap.get(pathPart);
  if (sibling) return `${sibling}${anchor}`;
  if (!pathPart.startsWith("../")) return target;
  const repoPath = resolveRepoPath(pathPart);
  const isImage = /\.(png|gif|jpe?g|svg|webp)$/i.test(repoPath);
  if (isImage) {
    return `https://raw.githubusercontent.com/${slug}/${BRANCH}/${repoPath}`;
  }
  const kind = pathPart.endsWith("/") ? "tree" : "blob";
  return `https://github.com/${slug}/${kind}/${BRANCH}/${repoPath}${anchor}`;
}

/**
 * Rewrite every markdown link/image target in a page.
 *
 * Deliberately fence-blind: anything link-shaped is rewritten, including
 * inside code fences or backticks. No user-guide page puts link-shaped text
 * in code (a STYLE_GUIDE convention for this folder); a fence-aware parser is
 * not worth the complexity until a page actually needs one.
 */
export function transformContent(source, ctx) {
  return source
    .replace(
      /(!?\[[^\]]*\]\()([^)\s]+)(\))/g,
      (_all, open, target, close) => `${open}${rewriteTarget(target, ctx)}${close}`,
    )
    .replace(
      // Reference-style definitions: `[label]: target` at line start.
      /^(\s*\[[^\]^]+\]:\s*)(\S+)/gm,
      (_all, open, target) => `${open}${rewriteTarget(target, ctx)}`,
    );
}

export function banner(sourceFile, slug) {
  const srcUrl = `https://github.com/${slug}/blob/${BRANCH}/${SOURCE_DIR}/${sourceFile}`;
  return (
    `${MARKER} source:${sourceFile} -->\n\n` +
    `> 📖 This page is auto-mirrored from [\`${SOURCE_DIR}/${sourceFile}\`](${srcUrl}) ` +
    `on \`${BRANCH}\`. Please propose changes by pull request — direct wiki edits ` +
    `are overwritten by the next sync.\n\n`
  );
}

export function buildSidebar(order, pageMap, titles, slug) {
  const lines = [
    `${MARKER} source:_Sidebar -->`,
    "",
    "**[Member & Guest Guide](Home)**",
    "",
    ...order.map((file, i) => `${i + 1}. [${titles.get(file)}](${pageMap.get(file)})`),
    "",
    "---",
    "",
    `[Full documentation hub →](https://github.com/${slug}/blob/${BRANCH}/docs/README.md)`,
    "",
  ];
  return lines.join("\n");
}

export function buildFooter(slug) {
  return (
    `${MARKER} source:_Footer -->\n\n` +
    `Mirrored from [\`${SOURCE_DIR}/\`](https://github.com/${slug}/tree/${BRANCH}/${SOURCE_DIR}) — ` +
    `operator, adopter, and developer docs live in the ` +
    `[documentation hub](https://github.com/${slug}/blob/${BRANCH}/docs/README.md).\n`
  );
}

/** Build every wiki file as {name -> content}. Pure given the sources. */
export function buildWiki(sources, slug) {
  const guideFiles = Object.keys(sources)
    .filter((f) => f !== "README.md")
    .sort();
  const titles = new Map();
  const pageMap = new Map([["README.md", "Home"]]);
  for (const file of guideFiles) {
    const title = firstH1(sources[file]);
    if (!title) throw new Error(`${file} has no H1 title`);
    titles.set(file, title);
    const name = pageNameFromTitle(title);
    if ([...pageMap.values()].includes(name)) {
      throw new Error(`Duplicate wiki page name ${name} (from ${file})`);
    }
    pageMap.set(file, name);
  }
  const ctx = { slug, pageMap };
  const order = readingOrderFromIndex(sources["README.md"], guideFiles);
  const out = new Map();
  for (const [file, pageName] of pageMap) {
    out.set(`${pageName}.md`, banner(file, slug) + transformContent(sources[file], ctx));
  }
  out.set("_Sidebar.md", buildSidebar(order, pageMap, titles, slug));
  out.set("_Footer.md", buildFooter(slug));
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const outFlag = args.indexOf("--out");
  const outDir = outFlag !== -1 ? args[outFlag + 1] : null;
  const list = args.includes("--list");
  if (!outDir && !list) {
    console.error("Usage: sync-user-guide-wiki.mjs --out <wiki-clone-dir> | --list");
    process.exit(2);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const slug = repoSlugFromPackageJson(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const srcDir = path.join(repoRoot, SOURCE_DIR);
  const sources = Object.fromEntries(
    fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => [f, fs.readFileSync(path.join(srcDir, f), "utf8")]),
  );
  const wiki = buildWiki(sources, slug);

  if (list) {
    for (const name of wiki.keys()) console.log(name);
    return;
  }

  if (!fs.existsSync(outDir)) {
    console.error(`--out directory does not exist: ${outDir} (clone the wiki repo first)`);
    process.exit(2);
  }
  let wrote = 0;
  for (const [name, content] of wiki) {
    fs.writeFileSync(path.join(outDir, name), content);
    wrote += 1;
  }
  // Remove ONLY pages this script previously managed whose source is gone.
  let removed = 0;
  for (const existing of fs.readdirSync(outDir).filter((f) => f.endsWith(".md"))) {
    if (wiki.has(existing)) continue;
    const head = fs.readFileSync(path.join(outDir, existing), "utf8").slice(0, 200);
    if (head.startsWith(MARKER)) {
      fs.rmSync(path.join(outDir, existing));
      removed += 1;
      console.log(`removed orphaned mirrored page ${existing}`);
    }
  }
  console.log(`wrote ${wrote} wiki pages to ${outDir}${removed ? `, removed ${removed}` : ""}`);
}

if (isMainModule(import.meta.url)) main();
