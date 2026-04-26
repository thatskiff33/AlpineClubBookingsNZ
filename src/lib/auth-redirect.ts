const DEFAULT_POST_LOGIN_PATH = "/dashboard";
const DEFAULT_BOOKING_PATH = "/book";

export function resolvePostLoginPath(
  candidate?: string | null,
  fallback: string = DEFAULT_POST_LOGIN_PATH
) {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return fallback;
  }

  if (candidate === "/login" || candidate.startsWith("/login?")) {
    return fallback;
  }

  return candidate;
}

export function buildLoginPath(callbackPath?: string | null) {
  const params = new URLSearchParams({
    callbackUrl: resolvePostLoginPath(callbackPath),
  });

  return `/login?${params.toString()}`;
}

export function buildBookingLoginPath() {
  return buildLoginPath(DEFAULT_BOOKING_PATH);
}
