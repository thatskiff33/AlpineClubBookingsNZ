#!/usr/bin/env node
/**
 * Documentation index integrity: every doc is reachable, every cited invariant
 * id exists (issue #2691).
 *
 * ## Why this exists
 *
 * #2691 split a 7,135-line `docs/DOMAIN_INVARIANTS.md` into per-domain files
 * under `docs/invariants/`, each rule carrying a permanent `INV-<PREFIX>-<NNN>`
 * id, and replaced the nine-document "Read First" list in `AGENTS.md` with a
 * small always-read core plus a routing table. Both halves of that only work
 * while these properties hold, and none of them is self-maintaining:
 *
 *  - **A prefix's numbers are dense.** They run from `001` to that prefix's
 *    highest with no holes, which is the whole reason "take the next number" is
 *    mechanical rather than a matter of looking carefully. See
 *    {@link auditNumberSequences}.
 *  - **Merged ids are append-only.** Density alone cannot see the highest id
 *    being deleted, or a whole prefix disappearing. The current definitions are
 *    therefore also compared with the base revision. See
 *    {@link auditPermanentInvariantIds}.
 *  - **Every cited id resolves.** An id is cited from places this repository
 *    cannot rewrite — merged commits, closed issues, lint strings shipped in a
 *    release, test names in a fork. A citation that resolves to nothing is the
 *    exact failure #2691 exists to prevent: a rule written down correctly that
 *    still does not hold, because the pointer to it went stale.
 *  - **Every doc is reachable from an index.** The issue's own watchpoint names
 *    the routing table as the part most likely to rot. A doc nothing links to is
 *    a doc nobody finds, which is how `docs/DOMAIN_INVARIANTS.md` became
 *    unreachable-at-the-moment-of-need in the first place.
 *  - **The routing table points at things that exist.** Every prefix it names is
 *    a declared prefix, every declared prefix has a row, and every document it
 *    links to is a real file.
 *  - **Nobody cites a line number into the invariants.** A `:NN` suffix is stale
 *    the next time somebody edits above it; the whole point of the id scheme is
 *    that it is not.
 *  - **No tracked text file is mojibake or carries a byte-order mark.** One
 *    invariant file was committed double-encoded and every other gate stayed
 *    green. See {@link auditEncoding}.
 *
 *   npm run docs:indexcheck                       # check, non-zero on any problem
 *   node scripts/ci/check-doc-index-integrity.mjs  # same
 *
 * ## The `INV-` namespace was already occupied
 *
 * This repository writes `INV-…` strings in quantity as **Xero invoice numbers**
 * in test fixtures, and four of them match the invariant citation shape exactly
 * (`INV-IB-001`, `INV-SETTLE-001`, `INV-SETTLE-002`, `INV-SUP-001`). They are
 * carried in {@link RESERVED_INVOICE_PREFIXES} below.
 *
 * An **unrecognised** prefix is a hard failure rather than something the
 * reserved list waves through. That is deliberate and it is the whole reason the
 * `INV-` namespace was safe to adopt: the likelier mistake is a typo'd prefix —
 * `INV-CPA-…` written for `INV-CAP-021` — and a blanket whitelist would make
 * exactly that mistake invisible. Every failure mode here is a noisy error; none
 * of them is a silent mis-resolution.
 *
 * ## Scanning rules
 *
 * Definitions, ordinary citations and malformed shapes skip Markdown literal
 * regions, so a document may show placeholders and fixture ids without treating
 * them as definitions. One bounded CommonMark block pass classifies fenced and
 * indented code, raw HTML, paragraphs, and ATX/Setext headings while retaining
 * blockquote/list containers. A second, narrower pass does inspect the literal
 * view: a
 * well-formed id under a prefix the repository really declares must resolve
 * there too. That catches an invented live-prefix example while leaving
 * `INV-<PREFIX>-<NNN>` placeholders, reserved invoice numbers and custom fixture
 * prefixes alone.
 * Inline backticks are **not** skipped — most real citations in prose are
 * written `` `INV-CAP-021` `` and skipping them would make the check blind to
 * the common case.
 *
 * Anchor-style citations (`…#inv-cap-021`) are deliberately not handled here.
 * `npm run docs:linkcheck` already validates fragments against real headings, and
 * duplicating it would give two places to disagree.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The index every invariant file and every id must be reachable from. */
export const INVARIANT_INDEX = "docs/DOMAIN_INVARIANTS.md";

/** Where invariant definitions live. Nothing outside it may define an id. */
export const INVARIANT_DIR = "docs/invariants/";

/** The scheme's illustrative fences must never look like live invariant ids. */
export const INVARIANT_SCHEME = "docs/invariants/SCHEME.md";

/**
 * A DEFINITION is a heading whose entire text is the id. A citation is never a
 * whole heading line, so the two patterns cannot be confused in either
 * direction. Levels 2–4 because an id heading sits exactly one level below its
 * nearest structural heading, and a file with no subsections has one level less.
 */
export const DEFINITION_PATTERN = /^#{2,4} (INV-[A-Z][A-Z0-9]*-\d{3})\s*$/;

/** A numeric invariant-shaped token, used to recognise Setext headings too. */
export const INVARIANT_SHAPED_TOKEN_PATTERN =
  /\bINV-[A-Z][A-Z0-9]*-\d+/i;

/** The underline that turns the active paragraph into a Setext heading. */
export const SETEXT_HEADING_UNDERLINE_PATTERN = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK_PATTERN =
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/** A CITATION is the id anywhere in a line of any tracked text file. */
export const CITATION_PATTERN = /\bINV-[A-Z][A-Z0-9]*-\d{3}\b/g;

/**
 * An index ROW is the id alone in the first cell of a table row. Matching the
 * row rather than any mention is what lets the index's own prose use a real id
 * as an illustration without counting as a second catalogue entry.
 */
export const INDEX_ROW_PATTERN = /^ {0,3}\|\s*`(INV-[A-Z][A-Z0-9]*-\d{3})`\s*\|/;

/**
 * Prefixes that belong to Xero invoice-number fixtures, not to invariants, and
 * are therefore permanently unavailable as invariant prefixes.
 *
 * The first three collide with the citation shape today. The rest are near
 * misses in the same fixture family (`INV-SUB-2026-001`, `INV-XERO-9`, …) that
 * would collide the day someone wrote one with three trailing digits; reserving
 * them now costs nothing and stops a future invariant prefix from being chosen
 * where a fixture could plausibly land on it.
 */
export const RESERVED_INVOICE_PREFIXES = new Set([
  "IB",
  "SETTLE",
  "SUP",
  "SUB",
  "XERO",
  "FAM",
  "LEGACY",
  "PM",
  "JOR",
  "REB",
]);

/**
 * Files that quote MALFORMED ids on purpose, in prose rather than in a fence,
 * and are therefore exempt from the shape guard only — never from citation
 * resolution.
 *
 * Exactly one: `SCHEME.md` is the id scheme itself. It argues for three digits
 * by showing the two-digit form the issue body illustrated, and justifies the
 * shape guard by showing the two near-misses it catches. Those sentences are
 * about the malformed forms, so fencing them would be a worse document.
 *
 * If the file is ever renamed, this entry has to be renamed with it or the
 * exemption silently stops applying and `SCHEME.md` starts failing. Nothing
 * enforces that; the failure is at least loud and names the file.
 */
export const SHAPE_GUARD_EXEMPT_FILES = new Set(["docs/invariants/SCHEME.md"]);

/**
 * Files exempt from the CITATION scan and from the line-number citation scan.
 *
 * Exactly one, and it is this check's own test: its fixtures have to contain
 * unresolvable ids, unrecognised prefixes and line-number citations, because
 * that is what they assert the checker rejects. Nothing else may be added here —
 * an exemption is the one way to make a citation invisible, which is the failure
 * this file exists to prevent.
 *
 * This file itself is deliberately NOT exempt. Its prose describes the forbidden
 * forms without writing them, which is the same discipline it asks of everybody
 * else.
 */
export const CITATION_EXEMPT_FILES = new Set([
  "scripts/ci/check-doc-index-integrity.test.mjs",
]);

/**
 * The repository's front doors, for the reachability walk.
 *
 * `docs/README.md` is the documentation hub named by the house rule ("every doc
 * must be reachable from a hub"); the other four are the entry points a reader
 * or an agent actually starts from, and each links into `docs/` directly.
 */
export const REACHABILITY_ROOTS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "docs/README.md",
];

/**
 * Markdown under `docs/` that is deliberately not linked from anywhere.
 *
 * Empty, and it should stay that way: an unreachable doc is the problem, not a
 * category of doc. Link the file from its nearest hub instead of listing it
 * here.
 */
export const UNREACHABLE_ALLOWLIST = new Set([]);

/**
 * The domain `##` headings `docs/DOMAIN_INVARIANTS.md` keeps VERBATIM.
 *
 * `SCHEME.md` §4.1 and §6.1 promise that the index retains the ten domain
 * headings of the pre-split document byte-identical, so an anchor written
 * before the split still resolves. Until #2720 nothing checked that, and the
 * prose beside it also claimed "many inbound anchors" target them — a number
 * this repository cannot support. Measured on 17 Aug 2026: **zero** tracked
 * files link to an anchor inside the index; every reference is to the bare
 * path. So every anchor the promise is about lives outside this repository —
 * in a fork, a merged commit, a closed issue, a shipped release — and is
 * therefore unmeasurable here and permanently unfixable once it breaks.
 *
 * That is the argument for pinning the property instead of editing the number:
 * an anchor nobody can enumerate is exactly the anchor that must never move.
 * A heading renamed here fails loudly, at the moment of the edit, in the one
 * place that can still do something about it.
 *
 * This is an ALLOWLIST OF SURVIVORS, not a census. The index may grow new
 * sections freely — `Product Configuration` is one, added by #2720 — and a new
 * section carries no pre-split anchors, so nothing about it is promised. What is
 * forbidden is renaming, re-casing or removing one of the ten.
 */
export const STABLE_INDEX_HEADINGS = [
  "Public authoritative content",
  "Money",
  "Booking Dates And Capacity",
  "Payment And Settlement",
  "Member-Guest Consent",
  "Booking Modifications",
  "Analytics And Privacy",
  "Membership Lifecycle",
  "Integrations",
  "Operations",
];

/** A top-level section heading in the index, with its exact text. */
const INDEX_SECTION_HEADING_PATTERN = /^ {0,3}##\s+(.+?)\s*#*\s*$/;

/**
 * Where the routing table lives, and how its section is found.
 *
 * Anchored on the heading rather than on a line range so the audit survives
 * every edit above it. If the heading is renamed the audit fails loudly rather
 * than quietly checking nothing, which is the failure mode that matters: a
 * routing audit that silently stops running is worse than none, for the same
 * reason the table itself says a stale table is worse than no table.
 */
export const ROUTING_TABLE_FILE = "AGENTS.md";
export const ROUTING_TABLE_HEADING = /^###\s+Routing table\s*$/;

/**
 * A routed PREFIX is a bare family name in backticks: `` `INV-CAP` ``.
 *
 * Deliberately does not match a full id (`` `INV-CAP-021` ``): the table routes
 * families, and a row that named a single rule would be a row that goes stale
 * the moment a second rule joins the family.
 */
export const ROUTING_PREFIX_PATTERN = /`INV-([A-Z][A-Z0-9]*)`/g;

/**
 * A line-number citation INTO the invariants: the index or any domain file,
 * with or without a leading path, followed by a `:120` or `:35-40` suffix.
 *
 * Scoped to the invariants because that is the habit the id scheme replaced.
 * Line references into other documents are not great either, but they were not
 * what #2691 was about and a repository-wide ban would be a much larger change
 * than this check should make on its own.
 *
 * There is no allowlist and no grandfather register. Both were considered and
 * both were rejected: this repository resolves residuals inside the PR rather
 * than deferring them, and a per-file register has the specific vice that a file
 * somebody has since CLEANED stays on the list, silently unprotected. The five
 * pre-existing citations under `src/lib/` were fixed instead — they now cite
 * INV-CAP-017 (the admin-mediated double-book guard) and INV-PAY-017 (a booking
 * invoice is raised at the full price and locally-applied credit is never
 * allocated against it).
 */
export const INVARIANT_LINE_CITATION_PATTERN =
  /\b((?:[A-Za-z0-9_.-]+\/)*(?:DOMAIN_INVARIANTS\.md|invariants\/[A-Za-z0-9_-]+\.md)):(\d+(?:-\d+)?)/g;

/**
 * The leading character of a cp1252-through-UTF-8 mojibake pair.
 *
 * These are what cp1252 renders for the UTF-8 lead bytes C2-C6, CE-D1 and
 * E1-E7 — the ranges that carry Latin-1 accents, the General Punctuation block
 * (em dash, curly quotes, ellipsis) and Greek/Cyrillic.
 *
 * Built from code points rather than written out, so that this file stays pure
 * ASCII and cannot trip its own check.
 */
const MOJIBAKE_LEAD = String.fromCharCode(
  0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xce, 0xcf, 0xd0, 0xd1,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
);

/**
 * The trailing character of a mojibake pair: what cp1252 renders for a UTF-8
 * CONTINUATION byte (0x80-0xBF). Bytes 0xA0-0xBF map to themselves; the rest map
 * into the punctuation cp1252 defines in that range.
 *
 * Requiring a lead AND a trail is what keeps this quiet on real text: te reo
 * macrons, a French name or a stray accented letter are single characters and
 * never form one of these pairs.
 */
const MOJIBAKE_TRAIL =
  // 0x80-0xBF as a character-class range, then the cp1252 punctuation those
  // bytes render as when the byte itself is not a printable Latin-1 letter.
  `${String.fromCharCode(0x80)}-${String.fromCharCode(0xbf)}` +
  String.fromCharCode(
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
    0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
    0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
  );

/** A cp1252-through-UTF-8 mojibake pair, anywhere in a line. */
export const MOJIBAKE_PATTERN = new RegExp(
  `[${MOJIBAKE_LEAD}][${MOJIBAKE_TRAIL}]`,
  "g",
);

/** What an em dash looks like after one bad round-trip, for the message. */
const MOJIBAKE_EXAMPLE = String.fromCharCode(0xe2, 0x20ac, 0x201d);

/** The Unicode byte-order mark, as `fs.readFileSync(path, "utf8")` leaves it. */
export const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

// Inline links/images: ![alt](target) and [text](target).
const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;
// Reference definitions at line start: [label]: target
const REF_DEF = /^\s*\[[^\]]+\]:\s*(\S+)/;

const FENCE_OPENER_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSER_PATTERN = /^ {0,3}(`+|~+)[ \t]*$/;
const BLOCKQUOTE_PREFIX_PATTERN = /^ {0,3}> ?/;
const LIST_MARKER_PATTERN =
  /^( {0,3})([*+-]|([0-9]{1,9})[.)])(?:( +)(?=\S|$)|$)/;
const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|" +
  "colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|" +
  "footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|" +
  "li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|" +
  "search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCK_TAG_PATTERN = new RegExp(
  `^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[ \\t]|/?>|$)`,
  "i",
);
// Upper bound on the inline-tag stripping loop in stripInlineHtmlTags. Each pass
// must strip at least one `<...>` to continue, so a heading cannot need more
// passes than it has characters; this only caps pathological input.
const MAX_INLINE_HTML_STRIP_PASSES = 100;

// The unquoted attribute value excludes TAB as well as space. CommonMark defines
// it as "a nonempty string of characters not including whitespace, ", ', =, <, >,
// or `" — and whitespace is both. Letting it swallow tabs was not only wrong, it
// made the value overlap the `[ \t]+` that separates the next attribute, so the
// outer `(...)*` could re-split the same tabs an exponential number of ways.
// Measured before the fix: a line of `<a` followed by 22 repetitions of "\t\t:=!"
// took 337ms, and each further repetition doubled it — a ~200-character line in
// any tracked Markdown file would have hung this gate forever. Now linear.
const COMPLETE_HTML_TAG_PATTERN =
  /^ {0,3}(?:<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>|<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>)[ \t]*$/;

function indentationColumns(text, initialColumn = 0) {
  let column = initialColumn;
  for (const character of text) {
    column = character === "\t" ? column + (4 - (column % 4)) : column + 1;
  }
  return column;
}

/** Expand tabs into the virtual columns CommonMark slices for block structure. */
function expandMarkdownTabs(text) {
  let column = 0;
  let expanded = "";
  for (const character of text) {
    if (character === "\t") {
      const width = 4 - (column % 4);
      expanded += " ".repeat(width);
      column += width;
    } else {
      expanded += character;
      column += 1;
    }
  }
  return expanded;
}

/** Resolve CommonMark list padding while retaining any four-column code indent. */
function listPrefix(line) {
  const match = line.match(LIST_MARKER_PATTERN);
  if (!match) return null;

  const marker = `${match[1]}${match[2]}`;
  const markerColumn = indentationColumns(marker);
  const whitespace = match[4] ?? "";
  const hasContent = marker.length + whitespace.length < line.length;
  if (!hasContent) {
    return {
      consumedLength: marker.length + whitespace.length,
      delimiter: match[3] === undefined ? match[2] : match[2].at(-1),
      orderedDigits: match[3],
      width: markerColumn + 1,
    };
  }

  const paddingColumns =
    indentationColumns(whitespace, markerColumn) - markerColumn;
  const consumedWhitespace =
    paddingColumns <= 4 ? whitespace : whitespace.slice(0, 1);

  return {
    consumedLength: marker.length + consumedWhitespace.length,
    delimiter: match[3] === undefined ? match[2] : match[2].at(-1),
    orderedDigits: match[3],
    width: markerColumn + consumedWhitespace.length,
  };
}

/** Strip quote/list markers from a possible container-block opener. */
function stripOpeningContainers(line, { interruptingParagraph = false } = {}) {
  const containers = [];
  let text = line;
  while (true) {
    const blockquote = text.match(BLOCKQUOTE_PREFIX_PATTERN);
    if (blockquote) {
      containers.push({ type: "blockquote" });
      text = text.slice(blockquote[0].length);
      interruptingParagraph = false;
      continue;
    }

    // CommonMark gives a thematic break precedence over the list marker that
    // its first `-` or `*` could otherwise resemble.  Do this after stripping
    // any blockquote prefix, but before consuming a list marker, so spaced
    // forms such as `- - -` retain the same precedence inside a quote too.
    if (THEMATIC_BREAK_PATTERN.test(text)) {
      return { containers, text };
    }

    const list = listPrefix(text);
    if (list) {
      const itemText = text.slice(list.consumedLength);
      const orderedStart =
        list.orderedDigits === undefined ? null : Number(list.orderedDigits);
      if (
        interruptingParagraph &&
        (itemText.trim() === "" || (orderedStart !== null && orderedStart !== 1))
      ) {
        return { containers, text };
      }
      containers.push({
        delimiter: list.delimiter,
        ordered: list.orderedDigits !== undefined,
        type: "list",
        width: list.width,
      });
      text = itemText;
      interruptingParagraph = false;
      continue;
    }
    return { containers, text };
  }
}

/** Consume at least the indentation columns that keep a line in one list item. */
function stripIndentation(text, requiredColumns) {
  let column = 0;
  let index = 0;
  while (index < text.length && column < requiredColumns) {
    if (text[index] === " ") column += 1;
    else if (text[index] === "\t") column += 4 - (column % 4);
    else return null;
    index += 1;
  }
  return column >= requiredColumns ? text.slice(index) : null;
}

/** Strip the exact container stack that owned an open literal block. */
function stripExpectedContainers(line, containers) {
  if (line.trim() === "") return "";
  let text = line;
  for (const container of containers) {
    if (container.type === "blockquote") {
      const blockquote = text.match(BLOCKQUOTE_PREFIX_PATTERN);
      if (!blockquote) return null;
      text = text.slice(blockquote[0].length);
      continue;
    }

    text = stripIndentation(text, container.width);
    if (text === null) return null;
  }
  return text;
}

/**
 * Return the terminator for a CommonMark raw HTML block whose contents may
 * legally contain fence markers. `null` means ordinary Markdown.
 *
 * Types 1-5 have explicit terminators. Types 6-7 (the standard block-tag list
 * and a complete open/close tag) end at the next blank line. The latter is
 * deliberately recognised only as a complete tag, so ordinary prose beginning
 * with an angle bracket cannot hide the rest of a document from the audit.
 */
/**
 * A terminator that ends on a literal string, which is what CommonMark actually
 * specifies for HTML block types 2 to 5: the block ends on the line *containing*
 * `-->`, `?>`, `]]>` or `>`. Four of the five end conditions are substring
 * searches, not patterns, and saying so in the code is both clearer and more
 * accurate than four regexes that only look like matchers.
 *
 * It also removes a standing false positive. Written as `/-->/`, the comment
 * terminator tripped CodeQL's js/bad-tag-filter, which wants `--!>` accepted
 * too. That is right for an HTML *sanitizer* and wrong here: browsers accept
 * `--!>`, CommonMark does not, and widening it would make this scanner disagree
 * with the renderer GitHub actually uses — text GitHub keeps inside a comment
 * would start counting as live document. The behaviour below is unchanged from
 * the regexes it replaces; only the alert, which was never about this code, goes
 * away. Same interface (`.test`) so callers do not care which they hold.
 */
function endsOn(marker) {
  return { test: (text) => text.includes(marker) };
}

function rawHtmlBlockTerminator(line) {
  const rawTag = line.match(
    /^ {0,3}<(pre|script|style|textarea)(?:[ \t]|>|$)/i,
  );
  if (rawTag) {
    return {
      canInterruptParagraph: true,
      end: new RegExp(`</${rawTag[1]}\\s*>`, "i"),
      type: "explicit",
    };
  }
  if (/^ {0,3}<!--/.test(line)) {
    return { canInterruptParagraph: true, end: endsOn("-->"), type: "explicit" };
  }
  if (/^ {0,3}<\?/.test(line)) {
    return { canInterruptParagraph: true, end: endsOn("?>"), type: "explicit" };
  }
  if (/^ {0,3}<!\[CDATA\[/.test(line)) {
    return { canInterruptParagraph: true, end: endsOn("]]>"), type: "explicit" };
  }
  if (/^ {0,3}<![A-Z]/.test(line)) {
    return { canInterruptParagraph: true, end: endsOn(">"), type: "explicit" };
  }
  if (HTML_BLOCK_TAG_PATTERN.test(line)) {
    return { canInterruptParagraph: true, type: "blank" };
  }
  if (COMPLETE_HTML_TAG_PATTERN.test(line)) {
    return { canInterruptParagraph: false, type: "blank" };
  }
  return null;
}

function sameContainers(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (container, index) =>
        container.type === right[index].type &&
        (container.type !== "list" ||
          (container.delimiter === right[index].delimiter &&
            container.width === right[index].width &&
            container.ordered === right[index].ordered)),
    )
  );
}

/**
 * List membership is marker-shaped, not padding-shaped. Marker digit count and
 * item padding change the continuation width of one item, but not whether the
 * next marker is its sibling. Delimiter identity remains structural: `.` and
 * `)` ordered lists (and the three bullet marker characters) are distinct.
 */
function sameContainerIdentity(left, right) {
  return (
    left.type === right.type &&
    (left.type !== "list" ||
      (left.delimiter === right.delimiter && left.ordered === right.ordered))
  );
}

/**
 * Retry a marker as a sibling of any active list depth.
 *
 * A fresh `10.` cannot interrupt a paragraph, so the ordinary CommonMark pass
 * initially leaves it as text. If that paragraph belongs to `9.`, however,
 * `10.` is a sibling even though its continuation width grew by one column.
 * Strip each possible ancestor stack exactly, then compare the fresh marker's
 * structural identity with the active list at that depth. This both preserves
 * nesting and lets an outer sibling close an inner list.
 */
function listSiblingLine(line, activeContainers) {
  for (let index = activeContainers.length - 1; index >= 0; index -= 1) {
    const active = activeContainers[index];
    if (active.type !== "list") continue;

    const ancestors = activeContainers.slice(0, index);
    const remainder = stripExpectedContainers(line, ancestors);
    if (remainder === null) continue;

    const sibling = stripOpeningContainers(remainder);
    if (
      sibling.containers.length > 0 &&
      sameContainerIdentity(sibling.containers[0], active)
    ) {
      return {
        containers: [...ancestors, ...sibling.containers],
        text: sibling.text,
      };
    }
  }
  return null;
}

/** Resolve a line against active or blank-retained containers, or fresh openers. */
function structuralLine(line, paragraph, retainedContainers = null) {
  const expectedContainers = paragraph?.containers ?? retainedContainers;
  if (expectedContainers?.length > 0) {
    const continuation = stripExpectedContainers(line, expectedContainers);
    if (continuation !== null) {
      const nested = stripOpeningContainers(continuation, {
        interruptingParagraph: paragraph !== null,
      });
      return {
        containers: [...expectedContainers, ...nested.containers],
        opensContainer: nested.containers.length > 0,
        text: nested.text,
      };
    }
  }
  let fresh = stripOpeningContainers(line, {
    interruptingParagraph: paragraph !== null,
  });

  // A top-level ordered marker greater than one cannot interrupt an unrelated
  // paragraph, but it can be the next sibling of an already-open ordered list.
  // The same retry admits an empty sibling marker in either list kind. Compare
  // marker identity at an active list depth rather than continuation width, so
  // `9.` -> `10.` and padding changes remain siblings without turning `2.` into
  // an interrupting nested or unrelated list.
  if (paragraph?.containers.length > 0 && fresh.containers.length === 0) {
    fresh = listSiblingLine(line, paragraph.containers) ?? fresh;
  }
  return {
    ...fresh,
    lazyContinuation:
      paragraph?.containers.length > 0 &&
      fresh.containers.length === 0 &&
      !THEMATIC_BREAK_PATTERN.test(fresh.text),
    opensContainer: fresh.containers.length > 0,
  };
}

function leadingIndentColumns(text) {
  return indentationColumns(text.match(/^[ \t]*/)?.[0] ?? "");
}

const ATX_HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]+|$)/;

/**
 * One bounded CommonMark block pass for every invariant audit.
 *
 * It retains the paragraph/container state that makes type-7 HTML, indented
 * code, multiline Setext headings and container-owned ATX headings meaningful.
 */
function scanMarkdownBlocks(text) {
  const scannable = [];
  const fenced = [];
  const fenceOpeners = [];
  const headings = [];
  let literal = null;
  let paragraph = null;
  let retainedListContainers = null;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const numberedLine = { number: index + 1, text: line };
    const structuralText = expandMarkdownTabs(line);
    let reprocess = true;
    while (reprocess) {
      reprocess = false;

      if (literal) {
        const content = stripExpectedContainers(structuralText, literal.containers);
        if (content === null) {
          literal = null;
          reprocess = true;
          continue;
        }

        if (literal.type === "indented") {
          if (content.trim() === "" || leadingIndentColumns(content) >= 4) {
            fenced.push(numberedLine);
            continue;
          }
          literal = null;
          reprocess = true;
          continue;
        }

        if (literal.type === "html") {
          if (literal.terminator.type === "blank" && content.trim() === "") {
            literal = null;
            scannable.push(numberedLine);
            paragraph = null;
            continue;
          }
          fenced.push(numberedLine);
          if (
            literal.terminator.type === "explicit" &&
            literal.terminator.end.test(content)
          ) {
            literal = null;
          }
          continue;
        }

        const closer = content.match(FENCE_CLOSER_PATTERN);
        if (
          closer &&
          closer[1][0] === literal.marker &&
          closer[1].length >= literal.length
        ) {
          literal = null;
        } else {
          fenced.push(numberedLine);
        }
        continue;
      }

      const outside = structuralLine(
        structuralText,
        paragraph,
        retainedListContainers,
      );
      const continuesParagraph =
        paragraph !== null &&
        !outside.opensContainer &&
        (sameContainers(outside.containers, paragraph.containers) ||
          outside.lazyContinuation);

      if (outside.text.trim() === "") {
        scannable.push(numberedLine);
        const blankContainers = outside.opensContainer
          ? outside.containers
          : paragraph?.containers;
        if (blankContainers?.some((container) => container.type === "list")) {
          retainedListContainers = blankContainers;
        }
        paragraph = null;
        continue;
      }
      retainedListContainers = null;

      if (
        continuesParagraph &&
        !outside.lazyContinuation &&
        SETEXT_HEADING_UNDERLINE_PATTERN.test(outside.text)
      ) {
        headings.push({
          containerDepth: paragraph.containers.length,
          kind: "setext",
          lineNumbers: [
            ...paragraph.lines.map((entry) => entry.number),
            numberedLine.number,
          ],
          number: paragraph.lines[0].number,
          text: paragraph.lines.map((entry) => entry.text).join(" "),
        });
        scannable.push(numberedLine);
        paragraph = null;
        continue;
      }

      if (THEMATIC_BREAK_PATTERN.test(outside.text)) {
        scannable.push(numberedLine);
        paragraph = null;
        continue;
      }

      const htmlTerminator = rawHtmlBlockTerminator(outside.text);
      if (
        htmlTerminator &&
        (htmlTerminator.canInterruptParagraph ||
          paragraph === null ||
          outside.opensContainer)
      ) {
        fenced.push(numberedLine);
        paragraph = null;
        if (
          htmlTerminator.type === "blank" ||
          !htmlTerminator.end.test(outside.text)
        ) {
          literal = {
            containers: outside.containers,
            terminator: htmlTerminator,
            type: "html",
          };
        }
        continue;
      }

      const candidate = outside.text.match(FENCE_OPENER_PATTERN);
      const markerRun = candidate?.[1];
      const info = candidate?.[2] ?? "";
      const isValidOpener =
        markerRun && (markerRun[0] === "~" || !info.includes("`"));
      if (isValidOpener) {
        paragraph = null;
        fenceOpeners.push(numberedLine);
        literal = {
          containers: outside.containers,
          length: markerRun.length,
          marker: markerRun[0],
          type: "fence",
        };
        continue;
      }

      if (
        (paragraph === null || outside.opensContainer) &&
        leadingIndentColumns(outside.text) >= 4
      ) {
        paragraph = null;
        fenced.push(numberedLine);
        literal = { containers: outside.containers, type: "indented" };
        continue;
      }

      if (ATX_HEADING_PATTERN.test(outside.text)) {
        headings.push({
          containerDepth: outside.containers.length,
          kind: "atx",
          lineNumbers: [numberedLine.number],
          number: numberedLine.number,
          text: outside.text,
        });
        scannable.push(numberedLine);
        paragraph = null;
        continue;
      }

      scannable.push(numberedLine);
      if (continuesParagraph) {
        paragraph.lines.push({ number: numberedLine.number, text: outside.text });
      } else {
        paragraph = {
          containers: outside.containers,
          lines: [{ number: numberedLine.number, text: outside.text }],
        };
      }
    }
  }

  return {
    fenced,
    headings,
    literalAudit: [...fenced, ...fenceOpeners].sort((left, right) => left.number - right.number),
    scannable,
  };
}

/**
 * Classify Markdown lines with one bounded CommonMark literal-block state.
 *
 * A closer uses the opener's marker and at least its length. A shorter run, the
 * other marker, or a candidate closer carrying non-whitespace is literal
 * content. Blockquote/list containers are retained until they end; the first
 * non-container line is reprocessed outside the block. Explicitly terminated
 * raw HTML blocks ignore fence markers until their terminator. Backtick info
 * strings may not themselves contain a backtick. Fence opener/closer lines
 * belong to neither output; raw HTML and indented-code boundary lines belong
 * to the literal view.
 */
export function scanMarkdownFenceLines(text) {
  const { fenced, scannable } = scanMarkdownBlocks(text);
  return { fenced, scannable };
}

/** Lines outside Markdown literal blocks, with their original line numbers. */
export function scannableLines(text) {
  return scanMarkdownFenceLines(text).scannable;
}

/**
 * Lines inside fenced code, indented code or raw HTML literal blocks, with their
 * original line numbers.
 *
 * This is deliberately separate from {@link scannableLines}: most audits must
 * ignore examples, while the narrow live-prefix citation audit below must see
 * enough of them to reject an invented id under a real prefix.
 */
export function fencedLines(text) {
  return scanMarkdownFenceLines(text).fenced;
}

/** Literal lines inspected by the narrow live-prefix audit, including fence openers. */
export function literalAuditLines(text) {
  return scanMarkdownBlocks(text).literalAudit;
}

/** Every physical line in a non-Markdown source file, with its original number. */
function sourceLines(text) {
  return text.split(/\r?\n/).map((line, index) => ({ number: index + 1, text: line }));
}

/** Markdown hides examples structurally; every other scanned format is linewise source. */
function ordinaryAuditLines(rel, text) {
  return rel.endsWith(".md") ? scannableLines(text) : sourceLines(text);
}

/** The prefix half of an id: `INV-CAP-021` -> `CAP`. */
export function prefixOf(id) {
  return id.split("-")[1];
}

/** The number half of an id, as a number: `INV-CAP-021` -> `21`. */
export function numberOf(id) {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

/**
 * A sorted ascending list of numbers as zero-padded runs: `033-041, 050`.
 *
 * Runs rather than a bare list because a mis-numbered id usually skips a block
 * of numbers at once, and "missing 033-041" is a sentence a reader acts on where
 * nine comma-separated numbers is a wall.
 */
function formatNumberRuns(numbers) {
  const pad = (n) => String(n).padStart(3, "0");
  const runs = [];
  for (const n of numbers) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([from, to]) => (from === to ? pad(from) : `${pad(from)}-${pad(to)}`)).join(", ");
}

/** Relative Markdown links a file makes, resolved to repo-relative paths. */
export function markdownLinkTargets(fromPath, text) {
  const dir = path.posix.dirname(fromPath);
  const targets = [];
  for (const { text: line } of scannableLines(text)) {
    // Inline-code spans are stripped here (a link shown as code is not a link),
    // which is the opposite of the citation scan and deliberately so.
    const scannable = line.replace(/`[^`]*`/g, " ");
    const raw = [];
    for (const match of scannable.matchAll(INLINE_LINK)) raw.push(match[1]);
    const refMatch = scannable.match(REF_DEF);
    if (refMatch) raw.push(refMatch[1]);

    for (let target of raw) {
      if (target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.replace(/^</, "").replace(/>$/, "").split("#")[0].split("?")[0];
      if (!target) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        /* malformed encoding: leave as written, it simply will not resolve */
      }
      if (!target.toLowerCase().endsWith(".md")) continue;
      targets.push(path.posix.normalize(path.posix.join(dir, target)));
    }
  }
  return targets;
}

/**
 * Definitions, keyed by id, each with every place it was defined.
 *
 * Only files under {@link INVARIANT_DIR} may define an id.
 */
export function collectDefinitions(files) {
  const definitions = new Map();
  for (const [rel, text] of files) {
    if (!rel.startsWith(INVARIANT_DIR) || !rel.endsWith(".md")) continue;
    for (const { number, text: line } of scannableLines(text)) {
      const match = line.match(DEFINITION_PATTERN);
      if (match) {
        if (!definitions.has(match[1])) definitions.set(match[1], []);
        definitions.get(match[1]).push(`${rel}:${number}`);
      }
    }
  }
  return definitions;
}

/**
 * A conservative GFM inline-link shape used only by the invariant-heading
 * sentinel. It retains the rendered label and removes a destination that is
 * syntactically bounded on this line. The destination accepts an angle form or
 * a whitespace-free form with one balanced-parentheses level, plus an optional
 * quoted/parenthesised title. Images are deliberately excluded: alt text is not
 * a visibly contiguous heading token.
 */
const HEADING_INLINE_LINK_PATTERN =
  /(?<!!)\[([^\]\r\n]+)\]\(\s*(?:<[^<>\r\n]*>|(?:\\[^\r\n]|[^\\()\s\r\n]|\([^()\r\n]*\))+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?[ \t]*\)/g;

/**
 * Full/collapsed reference-link labels, followed by shortcut-link labels.
 * Resolving a shortcut requires definitions elsewhere in the document, so the
 * sentinel conservatively unwraps bracketed labels whenever doing so reveals
 * an invariant-shaped heading. Literal brackets around a would-be invariant ID
 * are decoration too and cannot be a canonical definition.
 */
const HEADING_REFERENCE_LINK_PATTERN = /(?<!!)\[([^\]\r\n]+)\][ \t]*\[[^\]\r\n]*\]/g;
const HEADING_SHORTCUT_LINK_PATTERN = /(?<!!)\[([^\]\r\n]+)\]/g;

/** Decode bounded numeric character references without importing an HTML parser. */
function decodeNumericCharacterReferences(text) {
  return text.replace(
    /&#(?:([0-9]{1,7})|[xX]([0-9A-Fa-f]{1,6}));/g,
    (reference, decimal, hexadecimal) => {
      const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16);
      if (
        !Number.isInteger(codePoint) ||
        codePoint === 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return reference;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

/**
 * Approximate the visible heading text only as far as the invariant sentinel
 * needs. This is intentionally not a Markdown renderer: it unwraps bounded
 * inline links, decodes numeric references, and removes inline decoration
 * delimiters/tags that can split an otherwise canonical-looking token.
 */
function headingInvariantShapeText(line) {
  return foldInvariantLookalikes(
    stripInlineHtmlTags(
      decodeNumericCharacterReferences(
        line
          .replace(HEADING_INLINE_LINK_PATTERN, "$1")
          .replace(HEADING_REFERENCE_LINK_PATTERN, "$1")
          .replace(HEADING_SHORTCUT_LINK_PATTERN, "$1"),
      ).replace(/[*_~`]/g, ""),
    ),
  );
}

/**
 * Fold the characters that *look* like an invariant id but are not one.
 *
 * Every other defence in this function works on ASCII `INV-[A-Z]-\d`, so a
 * single lookalike codepoint used to walk through all of them at once: the
 * heading, `collectDefinitions`, `CITATION_PATTERN` and `INDEX_ROW_PATTERN`
 * would all miss a heading whose hyphen is U+2011 rather than hyphen-minus,
 * while GitHub rendered it as an ordinary, correct-looking id. A reviewer saw a
 * normal new invariant that had skipped nine numbers, and CI was green — the
 * exact outcome this check exists to make impossible.
 *
 * No literal id is written in this comment on purpose. This file is scanned for
 * citations like any other, so an illustrative id here would either have to
 * resolve or be excused — and an invented one under a live prefix is precisely
 * the grep bait #2889 exists to remove. Describe the shape; do not spell it.
 *
 * Two steps, because they catch different things. NFKC settles the
 * compatibility forms (full-width letters and digits). The dash class then
 * folds the hyphen lookalikes NFKC deliberately leaves alone, since U+2011 and
 * U+2013 are distinct characters rather than compatibility variants of `-`.
 *
 * Letter homoglyphs from other scripts — Cyrillic `А` for `A` — are not
 * foldable this way and are handled instead by the ASCII-only rule in
 * `auditDefinitionHeadingShapes`: an invariant heading is pure ASCII by
 * construction, so anything else in it is worth failing on.
 */
function foldInvariantLookalikes(text) {
  return text
    .normalize("NFKC")
    .replace(/[­‐-―−﹘﹣－]/g, "-");
}

/**
 * Remove inline HTML tags, repeatedly, until the text stops changing.
 *
 * A single pass is not enough: removing the inner tag from `<scr<span>ipt>`
 * splices its neighbours into a *new* tag, so one pass leaves behind markup a
 * reader never sees. That matters here because this text is what decides
 * whether a heading carries an invariant token — residue can split an
 * otherwise canonical id and make a real definition invisible to the
 * catalogue, which is the failure this whole check exists to prevent.
 * (CodeQL js/incomplete-multi-character-sanitization flagged the single pass.)
 *
 * The loop is bounded: each pass must shorten the string to continue, so it
 * terminates in at most one iteration per character even on adversarial input.
 */
function stripInlineHtmlTags(text) {
  let current = text;
  for (let pass = 0; pass < MAX_INLINE_HTML_STRIP_PASSES; pass += 1) {
    const next = current.replace(/<\/?[A-Za-z][^>]*>/g, "");
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Fail headings under the invariant directory that contain a numeric invariant
 * token but are not canonical definitions. Without this, a lower-cased,
 * backticked or decorated heading can be mistaken for a citation (or ignored
 * entirely) while the rule it appears to define stays invisible to catalogue
 * and sequence checks.
 */
/**
 * Report a non-ASCII character sitting inside something that reads as an
 * invariant id, or `null` when the heading is clean.
 *
 * `foldInvariantLookalikes` handles the dash and compatibility families, but it
 * cannot help with letter homoglyphs: Cyrillic `А` (U+0410) is a different
 * letter from `A` and folding it would be wrong everywhere else. The workable
 * rule is the structural one. An invariant id is ASCII by construction, so a
 * word-run that contains `INV` and also contains a non-ASCII character is
 * either a lookalike or a typo, and both deserve to fail rather than to be
 * silently skipped by every scan in this file.
 *
 * Scoped to word-runs containing `INV` so ordinary prose in a heading — an em
 * dash, a macron, a te reo Māori word — is untouched.
 */
function nonAsciiInsideInvariantWord(line) {
  for (const run of line.split(/[^\p{L}\p{N}\p{Pd}_&#;]+/u)) {
    if (!/INV/i.test(run.normalize("NFKC")) || !/[^\x20-\x7e]/.test(run)) {
      continue;
    }
    const offender = [...run].find((ch) => !/[\x20-\x7e]/.test(ch));
    const codePoint = offender.codePointAt(0).toString(16).toUpperCase();
    return {
      description: `U+${codePoint.padStart(4, "0")} (${JSON.stringify(offender)})`,
    };
  }
  return null;
}

export function auditDefinitionHeadingShapes(files) {
  const problems = [];
  for (const [rel, text] of files) {
    if (!rel.startsWith(INVARIANT_DIR) || !rel.endsWith(".md")) continue;
    for (const heading of scanMarkdownBlocks(text).headings) {
      const { number, text: line } = heading;
      const lookalike = nonAsciiInsideInvariantWord(line);
      if (lookalike) {
        problems.push(
          `${rel}:${number} writes ${lookalike.description} inside what reads as an ` +
            "invariant id. An invariant id is pure ASCII, so this heading is invisible to " +
            "every audit here — the definition scan, the citation scan and the index-row " +
            "scan all miss it — while GitHub renders it as an ordinary id. That is how a " +
            "wrong number reaches a reviewer looking correct and merges permanently. " +
            "Retype the id with ASCII letters, digits and hyphen-minus. A smart-punctuation " +
            "editor, or a paste from a document or chat transcript, is the usual cause.",
        );
        continue;
      }
      if (
        INVARIANT_SHAPED_TOKEN_PATTERN.test(headingInvariantShapeText(line)) &&
        (heading.kind !== "atx" ||
          heading.containerDepth > 0 ||
          !DEFINITION_PATTERN.test(line))
      ) {
        problems.push(
          `${rel}:${number} looks like an invariant definition heading but is not in ` +
            "the canonical top-level `##`-to-`#### INV-<PREFIX>-<NNN>` shape with an uppercase " +
            "prefix, exactly three digits, no identifier suffix and no decoration. Only " +
            "that canonical heading defines a rule, even when an embedded existing ID " +
            "resolves as a citation. Make this heading canonical, or give a narrative " +
            "heading ordinary topic text and put the invariant citation in its body.",
        );
      }
    }
  }
  return problems;
}

/** Every citation in every scanned file, with where it was written. */
export function collectCitations(files) {
  const citations = [];
  for (const [rel, text] of files) {
    if (CITATION_EXEMPT_FILES.has(rel)) continue;
    for (const { number, text: line } of ordinaryAuditLines(rel, text)) {
      for (const match of line.matchAll(CITATION_PATTERN)) {
        citations.push({ id: match[0], at: `${rel}:${number}` });
      }
    }
  }
  return citations;
}

/**
 * Invariant citation assertions: no duplicate definition, every citation under
 * a declared prefix resolves (including the narrow fenced pass), every
 * unrecognised ordinary prefix is either reserved or a failure, and every
 * near-miss under a declared prefix has exactly three digits.
 */
export function auditInvariantIds(files) {
  const problems = [];
  const definitions = collectDefinitions(files);

  for (const [id, places] of definitions) {
    if (places.length > 1) {
      problems.push(
        `${id} is defined ${places.length} times (${places.join(", ")}). An id names ` +
          "exactly one rule and is never reused. Two lanes that independently took " +
          "the next free number is the usual cause: whichever lands second renumbers " +
          "its own definition — free, because nothing has cited it yet — and updates " +
          `its row in ${INVARIANT_INDEX}.`,
      );
    }
  }

  const declaredPrefixes = new Set([...definitions.keys()].map(prefixOf));
  const unresolved = new Map();
  const unrecognised = new Map();

  for (const { id, at } of collectCitations(files)) {
    const prefix = prefixOf(id);
    if (declaredPrefixes.has(prefix)) {
      if (!definitions.has(id)) {
        if (!unresolved.has(id)) unresolved.set(id, []);
        unresolved.get(id).push(at);
      }
    } else if (!RESERVED_INVOICE_PREFIXES.has(prefix)) {
      if (!unrecognised.has(prefix)) unrecognised.set(prefix, []);
      unrecognised.get(prefix).push(`${id} at ${at}`);
    }
  }

  for (const [id, places] of unresolved) {
    problems.push(
      `${id} is cited at ${places.join(", ")} but no file under ${INVARIANT_DIR} ` +
        "defines it. Either the id is mistyped, or the rule it named was deleted — " +
        "which the scheme forbids: a superseded rule keeps its heading and gains a " +
        "`Superseded by` line, a retired one keeps its heading and gains a reason, so " +
        "an old citation always lands on an explanation rather than on nothing.",
    );
  }

  // Literal source may carry placeholders, invoice-number fixtures, custom
  // prefixes and real citations. A numeric token under a declared prefix must
  // resolve and use the canonical width. SCHEME's illustrative literal blocks
  // are stricter: they use placeholders/custom prefixes exclusively, because a
  // live-looking example is the grep trap this issue exists to remove.
  const unresolvedFenced = new Map();
  const malformedFenced = [];
  const schemeLiteralLiveIds = [];

  // Built only from declared prefixes, so placeholders, reserved invoice
  // numbers and custom fixture prefixes never enter this audit.
  const livePrefixNumericPattern =
    declaredPrefixes.size > 0
      ? new RegExp(
          `\\bINV-(?:${[...declaredPrefixes].sort().join("|")})-[0-9]+\\b(?!\\.[0-9]|-[A-Za-z0-9_])`,
          // A dotted numeric continuation is owned by the identifier audit
          // below; do not also truncate it to a plausible unresolved ID.
          "g",
        )
      : null;

  if (livePrefixNumericPattern) {
    for (const [rel, text] of files) {
      if (CITATION_EXEMPT_FILES.has(rel) || !rel.endsWith(".md")) continue;
      for (const { number, text: line } of literalAuditLines(text)) {
        for (const match of line.matchAll(livePrefixNumericPattern)) {
          const id = match[0];
          const digits = id.slice(id.lastIndexOf("-") + 1);
          if (digits.length !== 3) {
            malformedFenced.push({
              id,
              digits: digits.length,
              at: `${rel}:${number}`,
            });
          } else if (!definitions.has(id)) {
            if (!unresolvedFenced.has(id)) unresolvedFenced.set(id, []);
            unresolvedFenced.get(id).push(`${rel}:${number}`);
          } else if (rel === INVARIANT_SCHEME) {
            schemeLiteralLiveIds.push({ at: `${rel}:${number}`, id });
          }
        }
      }
    }
  }

  for (const { id, digits, at } of malformedFenced) {
    problems.push(
      `${id} at ${at} uses ${digits} digit(s) inside a Markdown literal block or fence opener. Invariant ` +
        "numbers under a live prefix are exactly three, zero-padded, even in examples. " +
        "Use a placeholder such as `INV-<PREFIX>-<NNN>` when the example must not " +
        "claim a real invariant id.",
    );
  }

  for (const [id, places] of unresolvedFenced) {
    problems.push(
      `${id} appears inside a Markdown literal block or fence opener at ${places.join(", ")} but no ` +
        `file under ${INVARIANT_DIR} defines it. A fence may use ` +
        "`INV-<PREFIX>-<NNN>`, a reserved invoice number, a custom fixture prefix, " +
        "or a real citation that resolves; it may not invent a number under a live " +
        "invariant prefix, because that reads as a real maximum to repository searches.",
    );
  }

  for (const { at, id } of schemeLiteralLiveIds) {
    problems.push(
      `${id} at ${at} is a live invariant id inside an illustrative literal block in ` +
        `${INVARIANT_SCHEME}. That file teaches allocation and is the source of the ` +
        "#2889 grep trap, so its examples use `INV-<PREFIX>-<NNN>` placeholders or a " +
        "custom non-live prefix instead of anything a live-id grep can mistake for " +
        "the current maximum.",
    );
  }

  for (const [prefix, places] of unrecognised) {
    problems.push(
      `INV-${prefix}-… is not a declared invariant prefix and is not on the reserved ` +
        `Xero invoice-number list (${places.join(", ")}). If it is a typo for a real ` +
        `prefix, fix it. If it is a new invariant area, define its ids under ` +
        `${INVARIANT_DIR} and list them in ${INVARIANT_INDEX}. If it is genuinely an ` +
        "invoice number, add its prefix to RESERVED_INVOICE_PREFIXES in this script " +
        "with a note saying so.",
    );
  }

  // Shape guard, built from the prefixes the definitions actually declared: a
  // near-miss under a REAL prefix slips past the strict citation pattern and
  // resolves to nothing while being reported as nothing. Scoped to declared
  // prefixes rather than to `INV-` generally, because a generic shape guard
  // flags every Xero invoice fixture in the test suite.
  if (livePrefixNumericPattern) {
    for (const [rel, text] of files) {
      if (SHAPE_GUARD_EXEMPT_FILES.has(rel) || CITATION_EXEMPT_FILES.has(rel)) continue;
      for (const { number, text: line } of ordinaryAuditLines(rel, text)) {
        for (const match of line.matchAll(livePrefixNumericPattern)) {
          const digits = match[0].slice(match[0].lastIndexOf("-") + 1);
          if (digits.length !== 3) {
            problems.push(
              `${match[0]} at ${rel}:${number} uses ${digits.length} digit(s). Invariant ` +
                "numbers are exactly three, zero-padded, so a citation cannot be " +
                "ambiguous between `-21` and `-021`. Write it the way the definition " +
                "heading does.",
            );
          }
        }
      }
    }
  }

  const prefixAlternation = [...declaredPrefixes].sort().join("|");
  const livePrefixIdentifierContinuationPattern =
    prefixAlternation.length > 0
      ? new RegExp(
          `\\bINV-(?:${prefixAlternation})-([0-9]+)((?:[A-Za-z_]|-[A-Za-z0-9_]|\\.(?=[0-9]))[A-Za-z0-9_.-]*)(?=$|[^A-Za-z0-9_.-])`,
          "g",
        )
      : null;

  if (livePrefixIdentifierContinuationPattern) {
    for (const [rel, text] of files) {
      if (CITATION_EXEMPT_FILES.has(rel)) continue;
      const markdown = rel.endsWith(".md") ? scanMarkdownBlocks(text) : null;
      const headingLines = new Set(
        markdown?.headings.flatMap((heading) => heading.lineNumbers) ?? [],
      );
      const ordinaryLines = SHAPE_GUARD_EXEMPT_FILES.has(rel)
        ? []
        : ordinaryAuditLines(rel, text).filter(({ number }) => !headingLines.has(number));
      const identifierAuditLines = markdown
        ? [...ordinaryLines, ...markdown.literalAudit].sort(
            (left, right) => left.number - right.number,
          )
        : ordinaryLines;
      for (const { number, text: line } of identifierAuditLines) {
        for (const match of line.matchAll(livePrefixIdentifierContinuationPattern)) {
          problems.push(
            `${match[0]} at ${rel}:${number} extends an invariant id with the identifier ` +
              `continuation ${match[2]}. Invariant ids end after exactly three digits; ` +
              "use punctuation or whitespace after the id, and put any explanatory " +
              "word outside the identifier.",
          );
        }
      }
    }
  }

  return problems;
}

/**
 * Every file under {@link INVARIANT_DIR} is linked from the index.
 *
 * Stricter than general reachability on purpose — reaching an invariant file
 * through some other document is not good enough, because the index is what a
 * reader is told to open first and it is authoritative for id -> file.
 */
export function auditInvariantFilesLinkedFromIndex(files) {
  const indexText = files.get(INVARIANT_INDEX);
  if (indexText === undefined) {
    return [
      `${INVARIANT_INDEX} is missing. It is the root of the invariants tree: every ` +
        "domain file is linked from it and every id is catalogued in it.",
    ];
  }

  const linked = new Set(markdownLinkTargets(INVARIANT_INDEX, indexText));
  const problems = [];
  for (const rel of [...files.keys()].sort()) {
    if (!rel.startsWith(INVARIANT_DIR) || !rel.endsWith(".md")) continue;
    if (!linked.has(rel)) {
      problems.push(
        `${rel} is not linked from ${INVARIANT_INDEX}. Every invariant file is reached ` +
          "through the index, so a file it does not name is a file nobody opens — and " +
          "its rules are exactly as unreachable as they were before the split.",
      );
    }
  }
  return problems;
}

/**
 * Every defined id has exactly one catalogue row in the index, and
 * every catalogue row names a defined id.
 *
 * This is what stops the index rotting, which is the part the issue's own
 * watchpoint predicts will rot first.
 */
export function auditIndexRows(files) {
  const indexText = files.get(INVARIANT_INDEX);
  if (indexText === undefined) return []; // already reported above

  const rows = new Map();
  for (const { number, text: line } of scannableLines(indexText)) {
    const match = line.match(INDEX_ROW_PATTERN);
    if (match) {
      if (!rows.has(match[1])) rows.set(match[1], []);
      rows.get(match[1]).push(`${INVARIANT_INDEX}:${number}`);
    }
  }

  const definitions = collectDefinitions(files);
  const problems = [];

  for (const [id, places] of [...definitions].sort()) {
    const listed = rows.get(id);
    if (!listed) {
      problems.push(
        `${id} is defined at ${places[0]} but has no row in ${INVARIANT_INDEX}. The ` +
          "index is the only part anyone reads in full, so a rule missing from it can " +
          "only be found by someone who already knew it was there. Add a row, in file " +
          "order, with a description of twelve words or fewer.",
      );
    } else if (listed.length > 1) {
      problems.push(
        `${id} has ${listed.length} rows in ${INVARIANT_INDEX} (${listed.join(", ")}). ` +
          "One id, one row: two rows drift apart and a reader believes whichever they " +
          "found first.",
      );
    }
  }

  for (const [id, places] of [...rows].sort()) {
    if (!definitions.has(id)) {
      problems.push(
        `${INVARIANT_INDEX} lists ${id} (${places.join(", ")}) but nothing under ` +
          `${INVARIANT_DIR} defines it. Either the definition was lost in a move, or ` +
          "the row is a leftover from a rule that was renamed.",
      );
    }
  }

  return problems;
}

/**
 * Every heading named in {@link STABLE_INDEX_HEADINGS} is still a `##` heading
 * of the index, spelled exactly the same way.
 *
 * Opt-in rather than unconditional, the same shape as
 * {@link auditPermanentInvariantIds}: the expectation is a fact about THIS
 * repository's index, and hard-wiring it into the pure audit would force every
 * in-memory fixture to carry ten production heading names it has no other use
 * for. `main` supplies the list; a test asserts that wiring, and a planted
 * rename was run through the real CLI to prove the message fires.
 */
export function auditStableIndexHeadings(files, stableHeadings) {
  if (!Array.isArray(stableHeadings) || stableHeadings.length === 0) {
    return [
      "auditStableIndexHeadings was given no headings to pin. An empty list " +
        "makes this audit vacuous, which is worse than not having it: it " +
        "reports a pass it has not earned. Restore STABLE_INDEX_HEADINGS.",
    ];
  }

  const indexText = files.get(INVARIANT_INDEX);
  if (indexText === undefined) return []; // reported by the linked-files audit

  const present = new Set();
  for (const { text: line } of scannableLines(indexText)) {
    const match = line.match(INDEX_SECTION_HEADING_PATTERN);
    if (match) present.add(match[1]);
  }

  const problems = [];
  for (const heading of stableHeadings) {
    if (present.has(heading)) continue;
    problems.push(
      `${INVARIANT_INDEX} no longer has the "## ${heading}" heading. It is one ` +
        "of the ten pre-split domain headings the index keeps verbatim so that " +
        "anchors written before the split still resolve. Those anchors live " +
        "OUTSIDE this repository — in a fork, a merged commit, a closed issue, " +
        "a shipped release — so nothing here can find them and nothing can fix " +
        "them once they break. Restore the heading exactly, including its " +
        "capitalisation and hyphenation; if the section's content genuinely " +
        "moved, keep the heading and put a pointer under it. Adding NEW " +
        "sections is free and needs no change here.",
    );
  }
  return problems;
}

/**
 * The rows of the `AGENTS.md` routing table, as `{ number, text }`.
 *
 * Separator rows are dropped; the header row is kept and simply contributes
 * nothing, because it names no prefix and links to nothing.
 */
export function routingTableRows(agentsText) {
  const rows = [];
  let inTable = false;
  for (const line of scannableLines(agentsText)) {
    if (ROUTING_TABLE_HEADING.test(line.text)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^#{1,6}\s/.test(line.text)) break;
    if (!line.text.trimStart().startsWith("|")) continue;
    if (/^\s*\|[\s|:-]*\|?\s*$/.test(line.text)) continue; // `| --- | --- |`
    rows.push(line);
  }
  return rows;
}

/**
 * The routing table resolves.
 *
 * Three directions, all of them cheap and none of them needing an exemption:
 *
 *  1. every `` `INV-XXX` `` the table routes is a prefix something under
 *     {@link INVARIANT_DIR} actually declares;
 *  2. every declared prefix has at least one row, so a new invariant family
 *     cannot be added without becoming findable;
 *  3. every document the table links to exists.
 *
 * What this deliberately does NOT check is the converse of (3) — that every
 * document under `docs/` has a row. There are roughly two hundred of them and
 * most are correctly reached through a feature hub rather than through
 * `AGENTS.md`, so that rule would be almost entirely exemptions. General
 * reachability ({@link auditDocReachability}) is the guard that covers those.
 */
export function auditRoutingTable(files) {
  const agentsText = files.get(ROUTING_TABLE_FILE);
  if (agentsText === undefined) {
    return [
      `${ROUTING_TABLE_FILE} is missing. It carries the routing table, which is how ` +
        "an agent finds the documents that bind the change it is about to make.",
    ];
  }

  const rows = routingTableRows(agentsText);
  if (rows.length === 0) {
    return [
      `No routing table found in ${ROUTING_TABLE_FILE}. This audit anchors on the ` +
        "heading `### Routing table`; if the section was renamed, update " +
        "ROUTING_TABLE_HEADING in this script so the table keeps being checked " +
        "rather than silently stopping.",
    ];
  }

  const problems = [];
  const routedPrefixes = new Set();

  for (const { number, text: row } of rows) {
    for (const match of row.matchAll(ROUTING_PREFIX_PATTERN)) {
      routedPrefixes.add(match[1]);
    }
    for (const target of markdownLinkTargets(ROUTING_TABLE_FILE, row)) {
      if (!files.has(target)) {
        problems.push(
          `The routing table row at ${ROUTING_TABLE_FILE}:${number} links to ${target}, ` +
            "which is not a tracked file. A row that points at nothing is worse than a " +
            "missing row: it reads as an answer. Fix the path, or drop the row if the " +
            "document was retired.",
        );
      }
    }
  }

  const declaredPrefixes = new Set(
    [...collectDefinitions(files).keys()].map(prefixOf),
  );

  for (const prefix of [...routedPrefixes].sort()) {
    if (!declaredPrefixes.has(prefix)) {
      problems.push(
        `The routing table routes INV-${prefix} but nothing under ${INVARIANT_DIR} ` +
          "declares that prefix. Either the prefix is mistyped, or its file was renamed " +
          "without the table following.",
      );
    }
  }

  for (const prefix of [...declaredPrefixes].sort()) {
    if (!routedPrefixes.has(prefix)) {
      problems.push(
        `INV-${prefix} is declared under ${INVARIANT_DIR} but no routing table row in ` +
          `${ROUTING_TABLE_FILE} names it. An agent who does not already know the family ` +
          "exists will never be sent to it. Add a row saying, in plain English, what kind " +
          "of change the family binds.",
      );
    }
  }

  return problems;
}

/**
 * Nobody cites a line number into the invariants. No exceptions.
 *
 * A line reference into a domain file is stale the next time somebody edits
 * above it, and it fails silently — the reader lands on unrelated text and
 * believes it. The permanent ids exist precisely so that citation never has to
 * be written, so the rule is unconditional: no allowlist, no grandfather
 * register, nothing to keep in step with the tree. The only file that may write
 * the forbidden form is this check's own test, via
 * {@link CITATION_EXEMPT_FILES}, because its fixtures are what assert the
 * rejection.
 */
export function auditLineNumberCitations(files) {
  const problems = [];

  for (const rel of [...files.keys()].sort()) {
    if (CITATION_EXEMPT_FILES.has(rel)) continue;
    for (const { number, text: line } of ordinaryAuditLines(rel, files.get(rel))) {
      for (const match of line.matchAll(INVARIANT_LINE_CITATION_PATTERN)) {
        problems.push(
          `${rel}:${number} cites ${match[1]}:${match[2]} — an invariants document by ` +
            "LINE NUMBER. That pointer is stale the next time anybody edits above it, " +
            "and it goes stale silently: the reader lands on unrelated text and believes " +
            `it. Cite the permanent id instead (INV-CAP-021 style); ${INVARIANT_INDEX} ` +
            "maps every id to the file it lives in.",
        );
      }
    }
  }

  return problems;
}

/**
 * No tracked text file is double-encoded or carries a byte-order
 * mark.
 *
 * `docs/invariants/member-guest-consent.md` was once committed with a UTF-8 BOM
 * and 29 double-encoded em dashes, and NOTHING caught it: lint, typecheck,
 * linkcheck, knip and every other assertion in this file stayed green, and the
 * one census test over that document passed because its assertions happened not
 * to contain an em dash. This repository has been bitten by the same family of
 * problem before, when migration SQL went CRLF on Windows against an LF seed
 * source (#2399).
 *
 * Fenced blocks are NOT skipped here: corruption inside a fence is still
 * corruption, and a fence is exactly where a pasted transcript lands.
 */
export function auditEncoding(files) {
  const problems = [];

  for (const rel of [...files.keys()].sort()) {
    const text = files.get(rel);
    if (text.startsWith(BYTE_ORDER_MARK)) {
      problems.push(
        `${rel} starts with a UTF-8 byte-order mark (U+FEFF). Nothing in this repository ` +
          "wants one: it breaks shebangs, leading front matter and exact-match assertions, " +
          "and it is invisible in every editor. It usually arrives from a Windows tool " +
          'that saved the file as "UTF-8 with BOM" — PowerShell\'s Out-File and Set-Content ' +
          "on Windows PowerShell 5.1 both do it. Re-save as UTF-8 without a BOM.",
      );
    }

    text.split(/\r?\n/).forEach((line, index) => {
      const hits = [...line.matchAll(MOJIBAKE_PATTERN)];
      if (hits.length === 0) return;
      problems.push(
        `${rel}:${index + 1} contains ${hits.length} double-encoded sequence(s) ` +
          `(${[...new Set(hits.map((hit) => JSON.stringify(hit[0])))].join(", ")}). This is ` +
          "mojibake: the file was UTF-8, some tool read it as Windows cp1252 and wrote it " +
          `back out as UTF-8, so every non-ASCII character became two or three. An em dash ` +
          `comes back as ${JSON.stringify(MOJIBAKE_EXAMPLE)}, a curly quote and a non-breaking ` +
          "space have their own signatures. On Windows the usual culprit is a PowerShell " +
          "redirect, Set-Content without -Encoding utf8, or an editor with a stale " +
          "encoding setting. Restore the file from git and re-apply the edit with a " +
          "UTF-8-clean tool rather than hand-repairing the characters.",
      );
    });
  }

  return problems;
}

/**
 * Every Markdown file under `docs/` is reachable from a front door by following
 * relative Markdown links.
 *
 * Scope is Markdown, because a doc is a page a reader reads: the assets beside
 * them (`docs/images/**`, the lobby-display HTML mockups, the Codex profile
 * TOMLs) are referenced from their own pages and are covered by
 * `npm run docs:linkcheck` instead.
 */
export function auditDocReachability(files) {
  const markdown = new Set(
    [...files.keys()].filter((rel) => rel.toLowerCase().endsWith(".md")),
  );

  const seen = new Set();
  const queue = [];
  for (const root of REACHABILITY_ROOTS) {
    if (markdown.has(root) && !seen.has(root)) {
      seen.add(root);
      queue.push(root);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    for (const target of markdownLinkTargets(current, files.get(current))) {
      if (markdown.has(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }

  const problems = [];
  for (const rel of [...markdown].sort()) {
    if (!rel.startsWith("docs/")) continue;
    if (seen.has(rel) || UNREACHABLE_ALLOWLIST.has(rel)) continue;
    problems.push(
      `${rel} is not reachable from any of ${REACHABILITY_ROOTS.join(", ")} by ` +
        "following relative Markdown links. Link it from its nearest hub — the feature " +
        "README beside it, or docs/README.md — so somebody can find it without already " +
        "knowing the path.",
    );
  }
  return problems;
}

/**
 * Every prefix's numbers run from `001` to its highest with no
 * gaps (issue #2889).
 *
 * ## Why contiguity is the property, and why it is enough
 *
 * `SCHEME.md` §1.3 allocates a new invariant `max + 1`. Nothing used to check
 * the arithmetic, and a wrong number is irreversible: §1.4 makes an id permanent
 * the moment it merges, so a skipped block of numbers is a hole this repository
 * keeps forever.
 *
 * Density is what makes `max + 1` *forced* rather than merely instructed. Every
 * number below the maximum is taken, and no id may be defined twice (the
 * duplicate-definition audit), so the only number a new invariant can have is
 * one more than the highest.
 * Any other choice is either a duplicate — caught there — or a hole, caught
 * here. Between the two, the allocation rule is mechanical.
 *
 * It also catches an interior deletion. Deleting the highest id or every id in
 * a prefix leaves no hole; {@link auditPermanentInvariantIds} closes those two
 * revision-shaped gaps instead.
 *
 * ## Why there is no allowlist
 *
 * `main` needed none when this was turned on, so nothing had to be closed or
 * excused first. The live totals are printed by the check rather than repeated
 * here, where concurrent invariant additions would make them stale.
 *
 * Nor is there a legitimate gap to allow. An id is never deleted — a superseded
 * rule keeps its heading and gains a status line, a retired one keeps its
 * heading and gains a reason — so a hole has exactly two causes, a wrong number
 * and a forbidden deletion, and both are things to fix rather than to register.
 * A register would only ever be the mechanism by which a wrong number becomes
 * permanent, which is the failure this assertion exists to prevent.
 *
 * If a prefix ever genuinely wants a reserved range, the answer is a new prefix.
 * Reserving numbers inside an existing one gives away the density that makes
 * `max + 1` forced, and buys nothing an id's location-independence (§1.4) does
 * not already give for free.
 */
export function auditNumberSequences(files) {
  const byPrefix = new Map();
  for (const [id, places] of collectDefinitions(files)) {
    const prefix = prefixOf(id);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push({ id, number: numberOf(id), at: places[0] });
  }

  const problems = [];
  for (const prefix of [...byPrefix.keys()].sort()) {
    const ids = byPrefix.get(prefix).sort((a, b) => a.number - b.number);
    const lowest = ids[0];
    const highest = ids.at(-1);

    if (lowest.number !== 1) {
      problems.push(
        `INV-${prefix} starts at ${lowest.id} (${lowest.at}), not 001. A prefix numbers ` +
          "from 001 — the first rule of a new family is 001, not whatever number was next " +
          "in the file it was copied from. Renumber it down, which is free until the id " +
          `merges (${INVARIANT_DIR}SCHEME.md §1.3), and fix its row in ${INVARIANT_INDEX}.`,
      );
    }

    const taken = new Set(ids.map((entry) => entry.number));
    const missing = [];
    for (let n = lowest.number + 1; n < highest.number; n += 1) {
      if (!taken.has(n)) missing.push(n);
    }

    if (missing.length > 0) {
      problems.push(
        `INV-${prefix} is missing ${formatNumberRuns(missing)}. It defines ${ids.length} ` +
          `id(s) but its highest is ${highest.id} (${highest.at}), so the numbering has a ` +
          "hole. A prefix's numbers are dense from 001, and that is what makes the next " +
          "number mechanical: every number below the maximum is taken and no id may be " +
          "defined twice, so max + 1 is the only number a new invariant can have. Two " +
          "causes, both worth a look. Either a new id took the wrong number, in which case " +
          `renumber it to INV-${prefix}-${formatNumberRuns([missing[0]])} and fix its row ` +
          `in ${INVARIANT_INDEX} — free until it merges, never afterwards. The usual reason ` +
          "is reading the maximum off a repo-wide grep, which returns illustrative ids from " +
          "prose, from fenced examples and from this check's own test fixtures alongside the " +
          `real definitions; read it off the prefix's tables in ${INVARIANT_INDEX} instead. ` +
          "Or a rule was deleted, which the scheme forbids: a superseded or retired rule " +
          "keeps its heading so an old citation still lands on an explanation. Restore it.",
      );
    }
  }

  return problems;
}

/**
 * Merged invariant ids are append-only: every definition present in the base
 * revision must still be defined in the current tree.
 *
 * The density audit cannot prove this on its own. Removing the highest number
 * leaves the remaining sequence dense, and removing every id in a prefix makes
 * the prefix disappear from the census altogether. Comparing revisions closes
 * both holes without trying to infer history from the current snapshot.
 */
export function auditPermanentInvariantIds(
  files,
  baselineFiles,
  baselineLabel = "the base revision",
) {
  const current = collectDefinitions(files);
  const baseline = collectDefinitions(baselineFiles);
  const missingByPrefix = new Map();

  for (const [id, places] of baseline) {
    if (current.has(id)) continue;
    const prefix = prefixOf(id);
    if (!missingByPrefix.has(prefix)) missingByPrefix.set(prefix, []);
    missingByPrefix.get(prefix).push({ id, number: numberOf(id), at: places[0] });
  }

  const currentPrefixes = new Set([...current.keys()].map(prefixOf));
  const problems = [];
  for (const prefix of [...missingByPrefix.keys()].sort()) {
    const missing = missingByPrefix.get(prefix).sort((a, b) => a.number - b.number);
    const ids = missing.map((entry) => entry.id).join(", ");
    const places = missing.map((entry) => entry.at).join(", ");
    if (!currentPrefixes.has(prefix)) {
      problems.push(
        `The entire INV-${prefix} prefix disappeared relative to ${baselineLabel}: ` +
          `${ids} were defined at ${places}. Merged invariant ids are permanent and ` +
          "append-only. Restore every heading; a superseded rule keeps its heading and " +
          "gains a `Superseded by` line, and a retired rule keeps its heading and gains " +
          "a reason.",
      );
      continue;
    }

    problems.push(
      `${ids} disappeared relative to ${baselineLabel} (previously ${places}). Merged ` +
        "invariant ids are permanent and append-only. Density cannot detect removal of " +
        "the highest number in a prefix, so the base revision is the authority here. " +
        "Restore each heading and supersede or retire the rule in place instead of " +
        "deleting it.",
    );
  }

  return problems;
}

/**
 * The whole check, over an in-memory map of repo-relative path -> file text.
 *
 * Pure, so the rules are testable without a repository. Returns a list of
 * plain-English problems; an empty list is a pass.
 */
export function auditDocs(
  files,
  {
    baselineFiles = null,
    baselineLabel = "the base revision",
    stableIndexHeadings = null,
  } = {},
) {
  return [
    ...auditDefinitionHeadingShapes(files),
    ...auditInvariantIds(files),
    ...auditInvariantFilesLinkedFromIndex(files),
    ...auditIndexRows(files),
    ...auditRoutingTable(files),
    ...auditLineNumberCitations(files),
    ...auditDocReachability(files),
    ...auditEncoding(files),
    ...auditNumberSequences(files),
    ...(baselineFiles
      ? auditPermanentInvariantIds(files, baselineFiles, baselineLabel)
      : []),
    ...(stableIndexHeadings
      ? auditStableIndexHeadings(files, stableIndexHeadings)
      : []),
  ];
}

/**
 * Read every nonempty tracked text file, keyed by repo-relative path.
 *
 * Git owns both halves of that classification: its index supplies the tracked
 * tree, and `grep -I` applies Git's binary/text rules instead of a file-extension
 * allowlist that inevitably omits a new source or configuration form. Empty
 * files are absent because grep has no line to return; they cannot contain an
 * invariant token, a byte-order mark, mojibake, a link or a definition.
 */
export function loadTrackedFiles(repoRoot) {
  const listed = spawnSync("git", ["grep", "-Il", "-z", "-e", "", "--"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (listed.error) throw listed.error;
  if (listed.status !== 0 && listed.status !== 1) {
    throw new Error(
      `git grep could not classify tracked text files (status ${listed.status}): ` +
        listed.stderr.trim(),
    );
  }

  const trackedText = listed.stdout
    .split("\0")
    .filter(Boolean);

  const files = new Map();
  for (const entry of trackedText) {
    const rel = entry.replace(/\\/g, "/");
    const absolute = path.join(repoRoot, rel);
    // A tracked-but-deleted path in a dirty working tree is not this check's
    // business; git status reports it and reading it would throw here.
    if (!fs.existsSync(absolute)) continue;
    files.set(rel, fs.readFileSync(absolute, "utf8"));
  }
  return files;
}

/** Resolve a git ref to a commit, returning null when it does not exist. */
function tryResolveCommit(repoRoot, ref) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * An all-zero object id. GitHub sends this as a push event's `before` when the
 * ref did not exist beforehand, and git never resolves it to a commit. The
 * 64-zero form is the same thing in a sha256 repository. Mirrors `isNullSha` in
 * `scripts/lib/file-size-base.ts`, which the file-size ratchet uses for the
 * identical field.
 */
function isNullSha(sha) {
  return /^0{40}$/.test(sha) || /^0{64}$/.test(sha);
}

/** Resolve a required baseline ref, failing instead of silently weakening scope. */
function resolveRequiredCommit(repoRoot, ref, source) {
  const resolved = tryResolveCommit(repoRoot, ref);
  if (!resolved) {
    throw new Error(`${source} ${ref} does not resolve to a commit`);
  }
  return resolved;
}

/** Find the immutable branch point for a local feature branch. */
function tryMergeBase(repoRoot, left, right) {
  try {
    return execFileSync("git", ["merge-base", left, right], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The branch point of `head` against whichever spelling of main this checkout
 * has, or null when it has neither. Shared by the epic-branch push path and the
 * local feature-branch fallback, which want the same commit for the same
 * reason: it is the last point at which the branch and main agreed, so it is
 * the set of ids the branch is answerable for retaining.
 */
function mergeBaseAgainstMain(repoRoot, head) {
  for (const candidate of ["origin/main", "main"]) {
    if (!tryResolveCommit(repoRoot, candidate)) continue;
    const mergeBase = tryMergeBase(repoRoot, head, candidate);
    if (mergeBase) return mergeBase;
  }
  return null;
}

/**
 * Pick the revision whose already-merged ids the current tree must retain.
 *
 * Pull requests compare with the immutable base SHA from their event. Pushes to
 * `main` and to an `epic/**` integration branch (#3002) compare with the event's
 * immutable pre-push SHA — except the push that CREATES an epic branch, which
 * carries no such SHA and compares with the branch point instead. Local feature
 * branches compare with their merge-base against `origin/main` (or `main`).
 * Every event/explicit ref fails closed when missing; `HEAD^1` is not a safe
 * feature-branch fallback because it may be a feature commit made after a
 * forbidden deletion.
 */
export function resolveInvariantBaselineRef(repoRoot, env = process.env) {
  const explicit = env.DOC_INDEX_BASE_REF?.trim();
  const head = tryResolveCommit(repoRoot, "HEAD");
  if (!head) throw new Error("HEAD does not resolve to a commit");

  const eventName = env.GITHUB_EVENT_NAME?.trim();
  const prBase = env.PR_BASE_SHA?.trim();
  const pushBase = env.PUSH_BASE_SHA?.trim();

  // The webhook kind is the event identity. A pull-request `synchronize`
  // payload also has a top-level `before` field, so the workflow's immutable
  // PUSH_BASE_SHA mapping is populated even though that SHA is the previous PR
  // head, not a push baseline. Never infer a second event from an unrelated
  // payload field when GitHub has already named the event.
  if (eventName === "pull_request") {
    if (explicit) {
      throw new Error(
        "DOC_INDEX_BASE_REF cannot be set for a pull-request event; PR_BASE_SHA is " +
          "authoritative and an inherited diagnostic override must not replace it",
      );
    }
    if (!prBase) {
      throw new Error(
        "PR_BASE_SHA is required for a pull-request invariant baseline; a branch name " +
          "can drift after the event and is not an exact substitute",
      );
    }
    return resolveRequiredCommit(repoRoot, prBase, "PR_BASE_SHA");
  }

  if (eventName === "push") {
    const isMainRef =
      env.GITHUB_REF === "refs/heads/main" || env.GITHUB_REF_NAME === "main";
    // `epic/**` integration branches (#3002). An epic's children merge into one
    // and the branch reaches `main` as a single merge, so `ci.yml` triggers on
    // pushes to it as well — which makes this path reachable for the first time.
    // WIDENED PRECISELY, and the refusal below is not a leftover: for any OTHER
    // ref the invariant-retention baseline genuinely means nothing. A push to
    // `feature/x` has no relationship to `PUSH_BASE_SHA` that this check can
    // interpret, so it still fails closed rather than measuring against a
    // baseline it cannot justify.
    const isEpicRef =
      env.GITHUB_REF?.trim().startsWith("refs/heads/epic/") === true ||
      env.GITHUB_REF_NAME?.trim().startsWith("epic/") === true;
    if (!isMainRef && !isEpicRef) {
      throw new Error(
        "Invariant push baselines are supported only for pushes to main or an " +
          "epic/** integration branch; refusing to interpret PUSH_BASE_SHA for a " +
          "different ref",
      );
    }
    const pushLabel = isMainRef ? "main-push" : "epic-branch-push";
    if (explicit) {
      throw new Error(
        `DOC_INDEX_BASE_REF cannot be set for a ${pushLabel} event; PUSH_BASE_SHA is ` +
          "authoritative and an inherited diagnostic override must not replace it",
      );
    }
    // A ref-CREATING push carries an all-zero `before`, and epic branches are
    // created routinely now. `main` cannot be created by a push (branch
    // protection blocks creating and deleting it), so an all-zero there is a
    // fact about the event that this check must not paper over — it fails.
    // On an epic branch it is ordinary, and the branch point against `main` is
    // the honest baseline: it is where the branch and main last agreed, which
    // is exactly the set of ids the branch is answerable for retaining. Failing
    // instead would redden `verify` on every epic branch's first push, which is
    // the same defect this widening exists to remove.
    if (isEpicRef && (!pushBase || isNullSha(pushBase))) {
      const branchPoint = mergeBaseAgainstMain(repoRoot, head);
      if (!branchPoint) {
        throw new Error(
          "This push created the epic branch, so its event carries no 'before' " +
            "commit, and neither origin/main nor main is present to take a branch " +
            "point from. Fetch origin/main (actions/checkout with fetch-depth: 0)",
        );
      }
      return branchPoint;
    }
    if (!pushBase) {
      throw new Error(
        `PUSH_BASE_SHA is required for a ${pushLabel} invariant baseline; HEAD^1 can ` +
          "postdate a deletion when one push contains several commits",
      );
    }
    if (isNullSha(pushBase)) {
      throw new Error(
        `PUSH_BASE_SHA is the all-zero object id, which is how a push event says the ` +
          `ref did not exist before the push. ${env.GITHUB_REF_NAME ?? "This ref"} ` +
          "cannot be created by a push, so this is not a baseline that can be trusted",
      );
    }
    return resolveRequiredCommit(repoRoot, pushBase, "PUSH_BASE_SHA");
  }

  if (eventName) {
    // Fail closed rather than guess — but note what that costs if the workflow's
    // triggers change. This matches `.github/workflows/ci.yml`'s triggers exactly
    // as they stand. Adding `merge_group` (which GitHub merge queues require) or
    // `workflow_dispatch` there without also giving that event a baseline here
    // would make `verify` — a required check — fail on every run with the message
    // below. If you add a trigger, add its baseline in the same PR. Relevant
    // because #2686 put branch protection on `main`.
    //
    // #3002 is the worked example of exactly that, and of the near miss: adding
    // `push: branches: [epic/**]` to ci.yml did not add an EVENT, it widened an
    // existing one, so it slipped past the sentence above and made the
    // ref-specific refusal in the `push` branch reachable instead — same
    // outcome, `verify` red on every epic-branch push. WIDENING A TRIGGER'S REF
    // FILTER COUNTS. Give the new refs a baseline in the same PR, and keep
    // refusing the ones that still have no meaningful one.
    throw new Error(
      `Unsupported GitHub event ${eventName}; refusing to infer an invariant ` +
        "baseline from environment fields that belong to another event shape",
    );
  }

  const isPullRequest =
    Boolean(env.GITHUB_BASE_REF?.trim()) ||
    Boolean(prBase);
  const isMainPush =
    Boolean(pushBase) ||
    env.GITHUB_REF === "refs/heads/main" ||
    env.GITHUB_REF_NAME === "main";

  if (isPullRequest && isMainPush) {
    throw new Error(
      "Conflicting pull-request and push baseline identity; refusing to choose one",
    );
  }

  if (isPullRequest) {
    if (explicit) {
      throw new Error(
        "DOC_INDEX_BASE_REF cannot be set for a pull-request event; PR_BASE_SHA is " +
          "authoritative and an inherited diagnostic override must not replace it",
      );
    }
    if (!prBase) {
      throw new Error(
        "PR_BASE_SHA is required for a pull-request invariant baseline; a branch name " +
          "can drift after the event and is not an exact substitute",
      );
    }
    return resolveRequiredCommit(repoRoot, prBase, "PR_BASE_SHA");
  }

  if (isMainPush) {
    if (explicit) {
      throw new Error(
        "DOC_INDEX_BASE_REF cannot be set for a main-push event; PUSH_BASE_SHA is " +
          "authoritative and an inherited diagnostic override must not replace it",
      );
    }
    if (!pushBase) {
      throw new Error(
        "PUSH_BASE_SHA is required for a main-push invariant baseline; HEAD^1 can " +
          "postdate a deletion when one push contains several commits",
      );
    }
    return resolveRequiredCommit(repoRoot, pushBase, "PUSH_BASE_SHA");
  }

  if (explicit) {
    return resolveRequiredCommit(repoRoot, explicit, "DOC_INDEX_BASE_REF");
  }

  const mergeBase = mergeBaseAgainstMain(repoRoot, head);
  if (mergeBase) return mergeBase;

  throw new Error(
    "Cannot resolve an invariant-id baseline. Fetch origin/main or set " +
      "DOC_INDEX_BASE_REF; HEAD^1 is deliberately not a feature-branch fallback.",
  );
}

/** Read invariant Markdown exactly as stored at a git revision. */
export function loadInvariantFilesAtRef(repoRoot, ref) {
  const resolved = resolveRequiredCommit(repoRoot, ref, "Invariant baseline ref");
  const listed = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", "--name-only", resolved, "--", INVARIANT_DIR],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1 << 24,
    },
  )
    .split("\0")
    .filter((entry) => entry.endsWith(".md"));

  const files = new Map();
  for (const rel of listed) {
    files.set(
      rel,
      execFileSync("git", ["show", `${resolved}:${rel}`], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 1 << 24,
      }),
    );
  }
  return files;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const repoRoot = path.resolve(path.join(import.meta.dirname, "..", ".."));
  try {
    const files = loadTrackedFiles(repoRoot);
    const baselineRef = resolveInvariantBaselineRef(repoRoot);
    const baselineFiles = loadInvariantFilesAtRef(repoRoot, baselineRef);
    const definitions = collectDefinitions(files);
    const problems = auditDocs(files, {
      baselineFiles,
      baselineLabel: baselineRef.slice(0, 12),
      stableIndexHeadings: STABLE_INDEX_HEADINGS,
    });

    if (problems.length > 0) {
      console.error(
        `Documentation index integrity failed (#2691) — ${problems.length} problem(s):\n`,
      );
      for (const problem of problems) console.error(`  - ${problem}\n`);
      process.exitCode = 1;
    } else {
      const prefixes = new Set([...definitions.keys()].map(prefixOf));
      const routedRows = routingTableRows(files.get(ROUTING_TABLE_FILE) ?? "").length;
      console.log(
        `Doc index check passed: ${definitions.size} invariant id(s) across ` +
          `${prefixes.size} prefix(es), each numbering densely from 001 so the next id in ` +
          "a prefix can only be max + 1, every citation resolves, every id is indexed, " +
          `every id present at base ${baselineRef.slice(0, 12)} is still defined, ` +
          `every docs/ page is reachable, ${routedRows} routing row(s) resolve, all ` +
          `${STABLE_INDEX_HEADINGS.length} pre-split index headings are intact, no line ` +
          "number is cited into the invariants, and no file is BOM'd or double-encoded. " +
          `Scanned ${files.size} tracked file(s).`,
      );
    }
  } catch (error) {
    console.error(`Documentation index integrity check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
