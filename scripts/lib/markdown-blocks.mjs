/** Shared Markdown block scanner for documentation contracts and capture selection. */
/** The underline that turns the active paragraph into a Setext heading. */
export const SETEXT_HEADING_UNDERLINE_PATTERN = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK_PATTERN =
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

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
export function scanMarkdownBlocks(text) {
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
