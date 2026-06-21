export const CSP_HEADER = "Content-Security-Policy";
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_NONCE_HEADER = "x-nonce";

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
} as const;

export function createCspNonce() {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function setSecurityHeaders(headers: Headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
}

export function buildContentSecurityPolicy(nonce: string) {
  const isDev = process.env.NODE_ENV === "development";

  const directives = [
    "default-src 'self'",
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      ...(isDev ? ["'unsafe-eval'"] : []),
      "https://js.stripe.com",
      "https://snowhq.com",
      "https://*.snowhq.com",
      "https://snow.nz",
      "https://*.snow.nz",
      "https://www.snow.nz",
    ].join(" "),
    // Keep inline styles during the script nonce rollout; Tailwind/Radix and
    // third-party widgets can still emit runtime style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.stripe.com https://js.stripe.com https://*.ingest.sentry.io https://snowhq.com https://*.snowhq.com https://snow.nz https://*.snow.nz https://www.snow.nz",
    "frame-src https://js.stripe.com https://hooks.stripe.com https://snowhq.com https://*.snowhq.com https://snow.nz https://*.snow.nz https://www.snow.nz",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  return directives.join("; ");
}
