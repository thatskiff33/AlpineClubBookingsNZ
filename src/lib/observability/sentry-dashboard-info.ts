import "server-only";
import { BROWSER_SENTRY_OFF_DETAIL, getBrowserSentryDsn } from "@/lib/observability/browser-sentry-config";

// The admin System Health view of Sentry: whether the server reports, the
// dashboard link when org and project are known, and a warning naming every
// missing piece, including browser Sentry being off at runtime (#4982).

function getTrimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function buildSentryDashboardInfo() {
  const dsn = getTrimmedEnv("SENTRY_DSN");
  const org = getTrimmedEnv("SENTRY_ORG");
  const project = getTrimmedEnv("SENTRY_PROJECT");
  const missingFields = [
    !dsn ? "SENTRY_DSN" : null,
    !org ? "SENTRY_ORG" : null,
    !project ? "SENTRY_PROJECT" : null,
  ].filter((field): field is string => Boolean(field));
  const sentryDashboardUrl =
    missingFields.length === 0 && org && project
      ? `https://sentry.io/organizations/${encodeURIComponent(org)}/issues/?project=${encodeURIComponent(project)}`
      : null;

  const warnings = [
    ...(missingFields.length > 0
      ? [`${missingFields.join(", ")} ${missingFields.length === 1 ? "is" : "are"} not configured; admin health cannot link directly to Sentry.`]
      : []),
    ...(!getBrowserSentryDsn() ? [BROWSER_SENTRY_OFF_DETAIL] : []),
  ];

  return {
    sentryConfigured: Boolean(dsn),
    sentryDashboardUrl,
    sentryConfigWarning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}
