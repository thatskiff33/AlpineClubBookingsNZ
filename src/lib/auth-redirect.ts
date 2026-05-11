import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

const DEFAULT_POST_LOGIN_PATH = "/dashboard";
const DEFAULT_BOOKING_PATH = "/book";

export function resolvePostLoginPath(
  candidate?: string | null,
  fallback: string = DEFAULT_POST_LOGIN_PATH
) {
  const safeFallback = getSafeInternalReturnPath(fallback) ?? DEFAULT_POST_LOGIN_PATH;
  const safeCandidate = getSafeInternalReturnPath(candidate);

  if (!safeCandidate) {
    return safeFallback;
  }

  if (safeCandidate === "/login" || safeCandidate.startsWith("/login?")) {
    return safeFallback;
  }

  return safeCandidate;
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
