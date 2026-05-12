const INTERNAL_RETURN_ORIGIN = "https://tacbookings.local";
const MAX_RETURN_PATH_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const LEADING_ENCODED_SLASH_OR_BACKSLASH = /^\/(?:%2f|%5c)/i;
const SAFE_FRAGMENT = /^[A-Za-z0-9_-]+$/;

export type InternalReturnPathCandidate =
  | string
  | string[]
  | null
  | undefined;

function firstSearchParamValue(candidate: InternalReturnPathCandidate) {
  if (Array.isArray(candidate)) {
    return candidate[0];
  }

  return candidate;
}

export function getSafeInternalReturnPath(
  candidate: InternalReturnPathCandidate,
) {
  const value = firstSearchParamValue(candidate);

  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  if (
    value.length > MAX_RETURN_PATH_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    value.includes("\\") ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    LEADING_ENCODED_SLASH_OR_BACKSLASH.test(value)
  ) {
    return null;
  }

  try {
    decodeURI(value);
    const url = new URL(value, INTERNAL_RETURN_ORIGIN);

    if (
      url.origin !== INTERNAL_RETURN_ORIGIN ||
      !url.pathname.startsWith("/") ||
      url.pathname.startsWith("//")
    ) {
      return null;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function resolveInternalReturnPath(
  candidate: InternalReturnPathCandidate,
  fallback = "/dashboard",
) {
  return (
    getSafeInternalReturnPath(candidate) ??
    getSafeInternalReturnPath(fallback) ??
    "/dashboard"
  );
}

export function buildPathWithSearch(
  pathname: string,
  searchParams?: URLSearchParams | string | null,
) {
  const query =
    typeof searchParams === "string"
      ? searchParams
      : searchParams?.toString();

  return query ? `${pathname}?${query}` : pathname;
}

export function buildHrefWithReturnTo(
  href: InternalReturnPathCandidate,
  returnTo: InternalReturnPathCandidate,
) {
  const safeHref = getSafeInternalReturnPath(href);
  if (!safeHref) {
    return "#";
  }

  const safeReturnTo = getSafeInternalReturnPath(returnTo);
  if (!safeReturnTo) {
    return safeHref;
  }

  const url = new URL(safeHref, INTERNAL_RETURN_ORIGIN);
  url.searchParams.set("returnTo", safeReturnTo);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildProfilePathWithReturnTo(
  returnTo: InternalReturnPathCandidate,
  fragment?: string,
) {
  const safeReturnTo = getSafeInternalReturnPath(returnTo);
  const safeFragment = getSafeFragment(fragment);

  if (!safeReturnTo) {
    return `/profile${safeFragment}`;
  }

  const params = new URLSearchParams({ returnTo: safeReturnTo });
  return `/profile?${params.toString()}${safeFragment}`;
}

function getSafeFragment(fragment?: string) {
  if (!fragment) {
    return "";
  }

  const value = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return SAFE_FRAGMENT.test(value) ? `#${value}` : "";
}
