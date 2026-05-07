function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function anchorToText(_match: string, href: string, label: string): string {
  const strippedLabel = decodeHtmlEntities(
    label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );
  const cleanHref = href.trim();

  if (!strippedLabel) {
    return cleanHref;
  }

  if (strippedLabel === cleanHref) {
    return cleanHref;
  }

  return `${strippedLabel}: ${cleanHref}`;
}

function stripDangerousHtmlBlocks(html: string, tagName: "script" | "style") {
  const blockPattern = new RegExp(
    `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`,
    "gi"
  );
  const danglingTagPattern = new RegExp(`<\\/?${tagName}\\b`, "gi");

  return html.replace(blockPattern, " ").replace(danglingTagPattern, " ");
}

export function htmlToPlainText(html: string): string {
  const sanitizedHtml = stripDangerousHtmlBlocks(
    stripDangerousHtmlBlocks(html, "style"),
    "script"
  );

  return decodeHtmlEntities(
    sanitizedHtml
      .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, anchorToText)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " | ")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|tr|table|ul|ol|li)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
