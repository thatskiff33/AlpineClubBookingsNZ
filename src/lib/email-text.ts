const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "table",
  "ul",
  "ol",
  "li",
]);

const TABLE_CELL_TAGS = new Set(["td", "th"]);

type HtmlTag = {
  name: string;
  closing: boolean;
  attrs: string;
  endIndex: number;
  malformed: boolean;
};

type AnchorContext = {
  href: string;
  text: string;
};

function decodePlainTextEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized === "lt" || normalized === "gt") {
      return match;
    }

    switch (normalized) {
      case "nbsp":
        return " ";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
      case "#39":
        return "'";
      default:
        break;
    }

    if (normalized.startsWith("#x")) {
      const value = Number.parseInt(normalized.slice(2), 16);
      return decodeNumericEntity(value, match);
    }

    if (normalized.startsWith("#")) {
      const value = Number.parseInt(normalized.slice(1), 10);
      return decodeNumericEntity(value, match);
    }

    return match;
  });
}

function decodeNumericEntity(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value === 60 || value === 62) {
    return fallback;
  }

  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

function isTagNameStart(char: string | undefined) {
  return Boolean(char && /[A-Za-z]/.test(char));
}

function isTagNameChar(char: string | undefined) {
  return Boolean(char && /[A-Za-z0-9:-]/.test(char));
}

function skipWhitespace(source: string, index: number) {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function parseHtmlTag(source: string, startIndex: number): HtmlTag | null {
  if (source[startIndex] !== "<") {
    return null;
  }

  let cursor = startIndex + 1;
  let closing = false;

  if (source[cursor] === "/") {
    closing = true;
    cursor += 1;
  }

  cursor = skipWhitespace(source, cursor);
  if (!isTagNameStart(source[cursor])) {
    return null;
  }

  const nameStart = cursor;
  while (isTagNameChar(source[cursor])) {
    cursor += 1;
  }

  const name = source.slice(nameStart, cursor).toLowerCase();
  const closeIndex = source.indexOf(">", cursor);
  if (closeIndex === -1) {
    return {
      name,
      closing,
      attrs: source.slice(cursor),
      endIndex: cursor,
      malformed: true,
    };
  }

  return {
    name,
    closing,
    attrs: source.slice(cursor, closeIndex),
    endIndex: closeIndex + 1,
    malformed: false,
  };
}

function readAttribute(attrs: string, targetName: string): string | null {
  let cursor = 0;

  while (cursor < attrs.length) {
    cursor = skipWhitespace(attrs, cursor);
    if (attrs[cursor] === "/" || attrs[cursor] === ">") {
      cursor += 1;
      continue;
    }

    const nameStart = cursor;
    while (
      cursor < attrs.length &&
      !/\s|=|\/|>/.test(attrs[cursor])
    ) {
      cursor += 1;
    }

    const name = attrs.slice(nameStart, cursor).toLowerCase();
    cursor = skipWhitespace(attrs, cursor);
    if (attrs[cursor] !== "=") {
      continue;
    }

    cursor += 1;
    cursor = skipWhitespace(attrs, cursor);

    let value = "";
    const quote = attrs[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < attrs.length && attrs[cursor] !== quote) {
        cursor += 1;
      }
      value = attrs.slice(valueStart, cursor);
      if (attrs[cursor] === quote) {
        cursor += 1;
      }
    } else {
      const valueStart = cursor;
      while (cursor < attrs.length && !/\s|>/.test(attrs[cursor])) {
        cursor += 1;
      }
      value = attrs.slice(valueStart, cursor);
    }

    if (name === targetName) {
      return decodePlainTextEntities(value).trim();
    }
  }

  return null;
}

function skipCommentOrDeclaration(source: string, startIndex: number): number | null {
  if (source.startsWith("<!--", startIndex)) {
    const end = source.indexOf("-->", startIndex + 4);
    return end === -1 ? source.length : end + 3;
  }

  if (source[startIndex + 1] === "!" || source[startIndex + 1] === "?") {
    const end = source.indexOf(">", startIndex + 2);
    return end === -1 ? source.length : end + 1;
  }

  return null;
}

function findDangerousBlockEnd(source: string, tagName: string, startIndex: number) {
  let cursor = startIndex;

  while (cursor < source.length) {
    const candidate = source.indexOf("</", cursor);
    if (candidate === -1) {
      return source.length;
    }

    const tag = parseHtmlTag(source, candidate);
    if (tag?.closing && tag.name === tagName) {
      return tag.endIndex;
    }

    cursor = candidate + 2;
  }

  return source.length;
}

function appendAnchorText(anchor: AnchorContext): string {
  const label = normalizePlainText(anchor.text);
  const href = anchor.href.trim();

  if (!label) {
    return href;
  }

  if (label === href) {
    return href;
  }

  return `${label}: ${href}`;
}

function normalizePlainText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToPlainText(html: string): string {
  let cursor = 0;
  let output = "";
  const anchors: AnchorContext[] = [];
  let previousTableCellClosed = false;

  const append = (value: string) => {
    if (!value) {
      return;
    }

    if (value.trim()) {
      previousTableCellClosed = false;
    }

    const activeAnchor = anchors[anchors.length - 1];
    if (activeAnchor) {
      activeAnchor.text += value;
    } else {
      output += value;
    }
  };

  while (cursor < html.length) {
    const nextTag = html.indexOf("<", cursor);
    if (nextTag === -1) {
      append(decodePlainTextEntities(html.slice(cursor)));
      break;
    }

    append(decodePlainTextEntities(html.slice(cursor, nextTag)));

    const commentOrDeclarationEnd = skipCommentOrDeclaration(html, nextTag);
    if (commentOrDeclarationEnd !== null) {
      cursor = commentOrDeclarationEnd;
      continue;
    }

    const tag = parseHtmlTag(html, nextTag);
    if (!tag) {
      append("<");
      cursor = nextTag + 1;
      continue;
    }

    cursor = tag.endIndex;

    if ((tag.name === "script" || tag.name === "style") && !tag.closing) {
      cursor = tag.malformed
        ? tag.endIndex
        : findDangerousBlockEnd(html, tag.name, tag.endIndex);
      continue;
    }

    if (tag.name === "a") {
      if (tag.closing) {
        const anchor = anchors.pop();
        if (anchor) {
          append(appendAnchorText(anchor));
        }
      } else {
        const href = readAttribute(tag.attrs, "href");
        if (href) {
          anchors.push({ href, text: "" });
        }
      }
      continue;
    }

    if (!tag.closing && tag.name === "br") {
      append("\n");
      continue;
    }

    if (!tag.closing && tag.name === "li") {
      append("\n- ");
      continue;
    }

    if (!tag.closing && TABLE_CELL_TAGS.has(tag.name)) {
      if (previousTableCellClosed) {
        append(" | ");
      }
      previousTableCellClosed = false;
      continue;
    }

    if (tag.closing && TABLE_CELL_TAGS.has(tag.name)) {
      previousTableCellClosed = true;
      continue;
    }

    if (tag.closing && BLOCK_TAGS.has(tag.name)) {
      previousTableCellClosed = false;
      append("\n");
    }
  }

  while (anchors.length > 0) {
    const anchor = anchors.pop();
    if (anchor) {
      append(appendAnchorText(anchor));
    }
  }

  return normalizePlainText(output);
}
