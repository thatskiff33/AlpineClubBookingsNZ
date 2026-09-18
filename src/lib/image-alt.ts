/**
 * Derive a human-readable alt fallback from an image src filename so an image
 * whose author omitted `alt` is still announced meaningfully by screen readers
 * (WCAG 1.1.1) instead of the browser reading out the raw `src`. Mirrors the
 * gallery directory-listing branch, which already uses the file name as alt.
 *
 * `data:` URIs carry no filename — returning "" for them avoids emitting a
 * massive base64 blob as alt text (#1947). Callers treat an empty return as
 * "no meaningful label available": the sanitiser backfills alt="" (explicit
 * decorative, silencing the src read-out) and the gallery render component
 * supplies a positional fallback because each gallery image is a link's only
 * content.
 *
 * Pure and dependency-free (no server-only imports) so it can be shared by both
 * the HTML sanitiser (src/lib/page-content-html.ts) and the embed extractor
 * (src/lib/page-content-embeds.ts) without dragging either module's graph into
 * the other.
 */
export function deriveAltFromImageSrc(src: string): string {
  if (/^data:/i.test(src.trim())) {
    return "";
  }
  // `String.prototype.split` always returns at least one element, even for
  // an empty string -- the same guarantee `lastSegment`'s `?? ""` below
  // already leans on.
  const withoutQuery = src.split(/[?#]/)[0] ?? "";
  const lastSegment = withoutQuery.split("/").pop() ?? "";
  let name: string;
  try {
    name = decodeURIComponent(lastSegment);
  } catch {
    name = lastSegment;
  }
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
