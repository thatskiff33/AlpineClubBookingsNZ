/** Public endpoint exposes only the opt-in, never retention or member details. */
export const SENTRY_REPLAY_POLICY_PATH = "/api/privacy/replay";
export const SENTRY_REPLAY_POLICY_CHANGED = "sentry-replay-policy-changed";

/** Public browser destination, delivered from the server at runtime. */
export const SENTRY_BROWSER_CONFIG_PATH = "/api/observability/browser-config";
