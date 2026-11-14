import { createHash } from "crypto";

/**
 * HTTP cache validators — ETag, Last-Modified and the conditional-request test
 * that turns a revalidation into a body-less 304 (RFC 9110 §13).
 *
 * One helper for every route that serves a cacheable public image under a
 * short `max-age` (#4935): the member-photo route and the uploaded-image route.
 * A short cache with no validator makes every revalidation a full download.
 */

/**
 * A strong ETag derived from `seed` by digest, so nothing in the seed — an
 * internal id, a file size and timestamp — is disclosed to the client.
 */
export function opaqueEtag(seed: string): string {
  return `"${createHash("sha256").update(seed).digest("hex").slice(0, 32)}"`;
}

/** Strip a weak prefix: `If-None-Match` uses the weak comparison. */
function opaqueTag(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

/**
 * Whether a conditional GET may be answered `304 Not Modified`.
 *
 * `If-None-Match` wins when present (RFC 9110 §13.2.2): it matches `*` or any
 * listed tag. Only without it is `If-Modified-Since` read, and then only when
 * the resource has a `lastModified`; it matches when the resource is no newer
 * than the date, compared at the one-second precision an HTTP date carries.
 */
export function isNotModified(
  headers: Headers,
  validators: { etag: string; lastModified?: Date },
): boolean {
  const ifNoneMatch = headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    const wanted = opaqueTag(validators.etag);
    return ifNoneMatch
      .split(",")
      .map((tag) => tag.trim())
      .some((tag) => tag === "*" || opaqueTag(tag) === wanted);
  }

  const ifModifiedSince = headers.get("if-modified-since");
  if (ifModifiedSince === null || !validators.lastModified) return false;
  const since = Date.parse(ifModifiedSince);
  if (Number.isNaN(since)) return false;
  const modifiedSeconds = Math.floor(validators.lastModified.getTime() / 1000);
  return modifiedSeconds <= Math.floor(since / 1000);
}
