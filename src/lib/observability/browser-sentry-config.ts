import "server-only";

/** The one operator sentence for "browser Sentry is off", shared by Setup and System Health. */
export const BROWSER_SENTRY_OFF_DETAIL = "Browser Sentry is off: NEXT_PUBLIC_SENTRY_DSN is missing or blank at runtime.";

/** Browser destination only; server DSN and upload credentials never leave here. */
export function getBrowserSentryDsn(env: Record<string, string | undefined> = process.env): string | null {
  return env.NEXT_PUBLIC_SENTRY_DSN?.trim() || null;
}
