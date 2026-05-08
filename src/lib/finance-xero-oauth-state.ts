import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  getOAuthCookieDomain,
  isValidXeroOAuthState,
} from "@/lib/xero-oauth-state";
import { getAuthSecret } from "@/lib/runtime-config";

export const FINANCE_XERO_OAUTH_STATE_COOKIE = "finance_xero_oauth_state";
const FINANCE_XERO_OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const FINANCE_XERO_OAUTH_STATE_PATH = "/api/finance/xero";
const FINANCE_XERO_OAUTH_STATE_VERSION = "v1";

type FinanceXeroOAuthStatePayload = {
  version: typeof FINANCE_XERO_OAUTH_STATE_VERSION;
  memberBinding: string;
  nonce: string;
};

function encodeStatePayload(payload: FinanceXeroOAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeStatePayload(value: string): FinanceXeroOAuthStatePayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

    if (
      parsed?.version !== FINANCE_XERO_OAUTH_STATE_VERSION ||
      typeof parsed.memberBinding !== "string" ||
      typeof parsed.nonce !== "string" ||
      parsed.nonce.length < 32
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function signStatePayload(encodedPayload: string): string {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is required for finance Xero OAuth state");
  }

  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function createMemberBinding(memberId: string): string {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is required for finance Xero OAuth state");
  }

  return createHmac("sha256", secret)
    .update(`finance-xero-oauth:${memberId}`)
    .digest("base64url");
}

function isTimingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function createFinanceXeroOAuthState(memberId: string): string {
  const encodedPayload = encodeStatePayload({
    version: FINANCE_XERO_OAUTH_STATE_VERSION,
    memberBinding: createMemberBinding(memberId),
    nonce: randomBytes(32).toString("base64url"),
  });

  return `${encodedPayload}.${signStatePayload(encodedPayload)}`;
}

export function isValidFinanceXeroOAuthState(
  expectedState?: string | null,
  receivedState?: string | null,
  memberId?: string | null
): boolean {
  if (
    !memberId ||
    !isValidXeroOAuthState(expectedState, receivedState) ||
    !receivedState
  ) {
    return false;
  }

  const [encodedPayload, signature, ...extraParts] = receivedState.split(".");
  if (!encodedPayload || !signature || extraParts.length > 0) {
    return false;
  }

  const expectedSignature = signStatePayload(encodedPayload);
  if (!isTimingSafeEqual(signature, expectedSignature)) {
    return false;
  }

  const payload = decodeStatePayload(encodedPayload);
  return Boolean(
    payload && isTimingSafeEqual(payload.memberBinding, createMemberBinding(memberId))
  );
}

export function getFinanceXeroOAuthStateCookieOptions(requestUrl?: string) {
  const nextAuthUrl = process.env.NEXTAUTH_URL;
  const isSecure =
    nextAuthUrl?.startsWith("https://") ||
    requestUrl?.startsWith("https://") ||
    process.env.NODE_ENV === "production";
  const domain = getOAuthCookieDomain(requestUrl);

  return {
    httpOnly: true,
    secure: !!isSecure,
    sameSite: "lax" as const,
    maxAge: FINANCE_XERO_OAUTH_STATE_MAX_AGE_SECONDS,
    path: FINANCE_XERO_OAUTH_STATE_PATH,
    ...(domain ? { domain } : {}),
  };
}

export function getExpiredFinanceXeroOAuthStateCookieOptions(
  requestUrl?: string
) {
  return {
    ...getFinanceXeroOAuthStateCookieOptions(requestUrl),
    maxAge: 0,
  };
}
