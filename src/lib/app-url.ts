const DEFAULT_APP_BASE_URL = "http://localhost:3000";

function isHttpUrl(value: URL): boolean {
  return value.protocol === "http:" || value.protocol === "https:";
}

export function getAppBaseUrl(fallbackOrigin?: string): string {
  const candidate =
    process.env.NEXTAUTH_URL?.trim() || fallbackOrigin || DEFAULT_APP_BASE_URL;

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

export function normalizeInternalAppUrl(
  input: string,
  options?: { baseUrl?: string }
): string | null {
  const baseUrl = options?.baseUrl || getAppBaseUrl();
  const resolved = resolveUrlCandidate(input, baseUrl);

  if (!resolved || !isHttpUrl(resolved)) {
    return null;
  }

  if (resolved.origin !== new URL(baseUrl).origin) {
    return null;
  }

  return resolved.toString();
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
