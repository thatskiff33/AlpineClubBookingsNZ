const DEFAULT_APP_BASE_URL = "http://localhost:3000";

function isHttpUrl(value: URL): boolean {
  return value.protocol === "http:" || value.protocol === "https:";
}

/**
 * The site's own origin, from configuration (`NEXTAUTH_URL`) and from nowhere
 * else. It takes no argument on purpose: a link the club sends, stores or shows
 * must never be built from a request's `Host` or `X-Forwarded-Host` header, or
 * from `request.nextUrl.origin`, which is derived from them. A caller can set
 * those wherever a proxy does not overwrite them.
 */
export function getAppBaseUrl(): string {
  const candidate = process.env.NEXTAUTH_URL?.trim() || DEFAULT_APP_BASE_URL;

  try {
    const parsed = new URL(candidate);
    if (!isHttpUrl(parsed)) {
      throw new Error("Invalid app base URL protocol");
    }

    return parsed.origin;
  } catch {
    return DEFAULT_APP_BASE_URL;
  }
}

function resolveUrlCandidate(input: string, baseUrl: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  try {
    if (
      trimmed.startsWith("/") ||
      trimmed.startsWith("?") ||
      trimmed.startsWith("#")
    ) {
      return new URL(trimmed, baseUrl);
    }

    return new URL(trimmed);
  } catch {
    return null;
  }
}

/**
 * The page of THIS site that a caller-supplied address names: its path, query
 * and fragment, placed on the configured origin. The host the caller sent is
 * discarded, so the result cannot point anywhere else, whatever was submitted
 * and whatever headers the request carried. `null` when the input is not a
 * relative reference or an http(s) address.
 *
 * Used where a member tells us which page they were on (the issue-report
 * widget posts `window.location.href`), and again when a stored value is read
 * back, so a row written before this rule existed is held to it too.
 */
export function rebaseOntoAppOrigin(input: string): string | null {
  const baseUrl = getAppBaseUrl();
  const resolved = resolveUrlCandidate(input, baseUrl);

  if (!resolved || !isHttpUrl(resolved)) {
    return null;
  }

  const rebased = new URL(baseUrl);
  // One leading slash only: a path that begins `//host` reads as another site
  // to anything that later treats it as a relative reference.
  rebased.pathname = resolved.pathname.replace(/^\/{2,}/, "/");
  rebased.search = resolved.search;
  rebased.hash = resolved.hash;

  // The setters above cannot change the host, and this says so in code: a
  // result on any other origin is refused rather than returned.
  return rebased.origin === new URL(baseUrl).origin ? rebased.toString() : null;
}

export function sanitizeEmailHref(
  input: string,
  options?: { baseUrl?: string; sameOrigin?: boolean }
): string {
  const baseUrl = options?.baseUrl || getAppBaseUrl();
  const resolved = resolveUrlCandidate(input, baseUrl);

  if (!resolved || !isHttpUrl(resolved)) {
    return baseUrl;
  }

  if (options?.sameOrigin && resolved.origin !== new URL(baseUrl).origin) {
    return baseUrl;
  }

  return resolved.toString();
}
