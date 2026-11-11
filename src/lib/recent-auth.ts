/**
 * How recently a person must have proved who they are (#4616, INV-AUTH-008).
 *
 * One window and one refusal, shared by the server check and the confirm
 * dialog (`INV-SSOT`). Five minutes is a security floor, not a club setting.
 * Nothing here reads the database or the session, so the dialog can import it.
 */

export const RECENT_AUTH_WINDOW_MS = 5 * 60 * 1000;

/** The refusal `requireRecentAuth` returns and the dialog recognises. */
export const REAUTH_REQUIRED_CODE = "REAUTH_REQUIRED";

/** Factors a step-up proof may use. An emailed code is not one of them. */
export const REAUTH_FACTORS = ["TOTP", "PASSKEY", "PASSWORD"] as const;

export type ReauthFactor = (typeof REAUTH_FACTORS)[number];

export function isReauthFactor(value: unknown): value is ReauthFactor {
  return (
    value === "TOTP" || value === "PASSKEY" || value === "PASSWORD"
  );
}

export function recentAuthRefusalBody() {
  return {
    code: REAUTH_REQUIRED_CODE,
    error: "Confirm it's you before continuing.",
  } as const;
}

/**
 * True when `lastAuthenticatedAt` is a finite epoch millisecond and is not
 * older than the window. Exactly five minutes still passes; one second past
 * it does not. A missing or non-numeric stamp fails closed.
 */
export function isWithinRecentAuthWindow(
  lastAuthenticatedAt: unknown,
  nowMs: number,
): boolean {
  return (
    typeof lastAuthenticatedAt === "number" &&
    Number.isFinite(lastAuthenticatedAt) &&
    nowMs - lastAuthenticatedAt <= RECENT_AUTH_WINDOW_MS
  );
}

/**
 * How a sign-in was proved, from server-side facts only (#4994, INV-AUTH-008).
 * `email` is an emailed code. `recovery` is a recovery code.
 */
export type RecentAuthSignInProof =
  | "password"
  | "TOTP"
  | "passkey"
  | "magic-link"
  | "google"
  | "email"
  | "recovery";

/**
 * Whether this proof starts the five-minute clock.
 *
 * A password counts only when no authenticator factor is still owed. An
 * authenticator-app proof and a passkey always count. An emailed link, Google,
 * an emailed code, and a recovery code never do.
 */
export function recentAuthSignInCounts(
  proof: RecentAuthSignInProof,
  owesAuthenticatorApp: boolean,
): boolean {
  if (proof === "password") return !owesAuthenticatorApp;
  return proof === "TOTP" || proof === "passkey";
}

/**
 * The verify-route method prefixed into a two-factor challenge, as a sign-in
 * proof. Anything else, including a token minted with no prefix, is not one.
 */
export function recentAuthSignInProofFromChallengeKind(
  kind: string | null,
): RecentAuthSignInProof | null {
  if (kind === "TOTP") return "TOTP";
  if (kind === "PASSKEY") return "passkey";
  if (kind === "EMAIL") return "email";
  if (kind === "RECOVERY") return "recovery";
  return null;
}

export function isReauthRequiredPayload(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    (body as { code?: unknown }).code === REAUTH_REQUIRED_CODE
  );
}
