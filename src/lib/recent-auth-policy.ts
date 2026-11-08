/**
 * Recent authentication (#4616, `INV-AUTH-008`): the pure rules, shared by the
 * server guard, the step-up route and the "confirm it's you" dialog. Prisma-
 * and server-free, so the client imports the refusal code from here.
 *
 * A session carries `lastAuthenticatedAt`, the epoch milliseconds at which the
 * person last proved who they are: stamped by the `jwt` callback in `auth.ts`
 * when sign-in completes, and refreshed only when that callback consumes a
 * server-minted step-up challenge (`session-reauth-challenge.ts`). Never by the
 * client, and never back-filled from the session's issue time.
 */
import { apiErrorCodeFromBody, readApiErrorBody } from "@/lib/api-error-message";

/**
 * How long a proof counts as recent: five minutes. A security floor, not a
 * club setting (owner decision on #4454, recorded on #4616).
 */
export const RECENT_AUTH_WINDOW_MS = 5 * 60 * 1000;

/** The `code` of the refusal `requireRecentAuth` answers, which the dialog recognises. */
export const RECENT_AUTH_REQUIRED_CODE = "RECENT_AUTH_REQUIRED";

/** The HTTP status of that refusal. */
export const RECENT_AUTH_REQUIRED_STATUS = 403;

/**
 * How a signed-in person may prove themselves again. #4617 adds `"PASSKEY"`
 * here, to `resolveStepUpMethods` and to the step-up route's verifiers; nothing
 * else changes shape. An emailed code and a recovery code are never a step-up
 * method (owner decision 2 on #4454: an emailed code does not prove an officer;
 * recovery codes are for a lost device).
 */
export const STEP_UP_METHODS = ["TOTP", "PASSWORD"] as const;

export type StepUpMethod = (typeof STEP_UP_METHODS)[number];

/** The member fields that decide which step-up methods a person has. */
export type StepUpFactorFacts = {
  twoFactorEnabled: boolean;
  twoFactorMethod: "TOTP" | "EMAIL" | null;
  totpSecret: string | null;
};

/**
 * Whether the member has an authenticator app enrolled: two-factor on, by
 * app, with a stored secret. An emailed-code enrolment is not one. The one
 * home of that fact; `twoFactorEnabled` alone keeps its existing meaning.
 */
export function hasAuthenticatorApp(member: StepUpFactorFacts): boolean {
  return (
    member.twoFactorEnabled &&
    member.twoFactorMethod === "TOTP" &&
    typeof member.totpSecret === "string" &&
    member.totpSecret !== ""
  );
}

/**
 * The step-up methods this person may use, in the order the dialog offers
 * them: the app code when they have an authenticator app, and the password
 * only when they have neither an app nor (from #4617) a passkey.
 */
export function resolveStepUpMethods(member: StepUpFactorFacts): StepUpMethod[] {
  if (hasAuthenticatorApp(member)) return ["TOTP"];
  return ["PASSWORD"];
}

/**
 * The stamp a session token or session user carries, exactly as the server
 * wrote it, or `null` when there is no finite number there.
 */
export function readLastAuthenticatedAtMs(
  holder: Readonly<Record<string, unknown>>,
): number | null {
  const value = holder.lastAuthenticatedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether a proof made at `lastAuthenticatedAt` is recent at `nowMs`: no more
 * than `RECENT_AUTH_WINDOW_MS` old. Fails closed: no stamp, a stamp that is
 * not a finite number, or a stamp later than now is never recent.
 */
export function isRecentlyAuthenticated(
  lastAuthenticatedAt: unknown,
  nowMs: number,
): boolean {
  const stamp = readLastAuthenticatedAtMs({ lastAuthenticatedAt });
  if (stamp === null) return false;
  const elapsedMs = nowMs - stamp;
  return elapsedMs >= 0 && elapsedMs <= RECENT_AUTH_WINDOW_MS;
}

/** The body of the refusal; `requireRecentAuth` sends it with `RECENT_AUTH_REQUIRED_STATUS`. */
export function recentAuthRequiredBody() {
  return {
    error: "Please confirm it's you to continue.",
    code: RECENT_AUTH_REQUIRED_CODE,
  } as const;
}

/**
 * Whether a response is `requireRecentAuth`'s refusal. Reads a clone, so the
 * caller can still read the original body.
 */
export async function isRecentAuthRefusal(response: Response): Promise<boolean> {
  if (response.status !== RECENT_AUTH_REQUIRED_STATUS) return false;
  const body = await readApiErrorBody(response.clone());
  return apiErrorCodeFromBody(body) === RECENT_AUTH_REQUIRED_CODE;
}
