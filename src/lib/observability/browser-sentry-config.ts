import "server-only";

/** Browser destination only; server DSN and upload credentials never leave here. */
export function getBrowserSentryDsn(env: Record<string, string | undefined> = process.env): string | null {
  return env.NEXT_PUBLIC_SENTRY_DSN?.trim() || null;
}
