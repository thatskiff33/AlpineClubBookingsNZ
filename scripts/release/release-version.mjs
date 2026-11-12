/**
 * The one parser for strict `vX.Y.Z` release tags (#4465, shared by #4979).
 *
 * `cut-release.mjs` works out versions with it and `upgrade-docs.mjs` compares
 * the upgrade documents' named release against it, so the two can never
 * disagree about what counts as a release or which of two is newer.
 */

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `{ major, minor, patch }` for a strict `vX.Y.Z` tag, or `null`. */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(String(tag).trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareReleaseParts(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** `X.Y.Z` for parsed parts. */
export function formatReleaseParts({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}
