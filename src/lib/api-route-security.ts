export type ApiRouteBoundary =
  | "public"
  | "webhook"
  | "member"
  | "admin"
  | "finance"
  | "lodge"
  | "cron";

export type ApiRouteSecurityMetadata = {
  boundary: ApiRouteBoundary;
  reason: string;
};

export const explicitPublicApiRoutes = {
  "src/app/api/address-autocomplete/details/[id]/route.ts": {
    boundary: "public",
    reason: "Anonymous Addy address detail proxy with rate limiting.",
  },
  "src/app/api/address-autocomplete/search/route.ts": {
    boundary: "public",
    reason: "Anonymous Addy address search proxy with rate limiting.",
  },
  "src/app/api/age-tier-settings/route.ts": {
    boundary: "public",
    reason: "Public age-tier and rate configuration.",
  },
  "src/app/api/applications/route.ts": {
    boundary: "public",
    reason: "Anonymous membership application submission with validation and rate limiting.",
  },
  "src/app/api/auth/[...nextauth]/route.ts": {
    boundary: "public",
    reason: "Auth.js sign-in endpoint with login rate limiting.",
  },
  "src/app/api/auth/confirm-email-change/route.ts": {
    boundary: "public",
    reason: "Token-bearing email-change confirmation endpoint.",
  },
  "src/app/api/auth/forgot-password/route.ts": {
    boundary: "public",
    reason: "Password reset request endpoint with non-enumerating behavior and rate limiting.",
  },
  "src/app/api/auth/register/route.ts": {
    boundary: "public",
    reason: "Disabled legacy registration endpoint returning 410.",
  },
  "src/app/api/auth/resend-verification/route.ts": {
    boundary: "public",
    reason: "Verification email resend endpoint with rate limiting.",
  },
  "src/app/api/auth/reset-password/route.ts": {
    boundary: "public",
    reason: "Token-bearing password reset submission endpoint.",
  },
  "src/app/api/auth/verify-email/route.ts": {
    boundary: "public",
    reason: "Token-bearing email verification endpoint.",
  },
  "src/app/api/booking-requests/quote/route.ts": {
    boundary: "public",
    reason: "Anonymous indicative non-member pricing quote for the booking request form, gated by the pricing-visibility setting and rate limited.",
  },
  "src/app/api/booking-requests/route.ts": {
    boundary: "public",
    reason: "Anonymous non-member booking request submission with validation, CRLF stripping and rate limiting; creates only an unverified BookingRequest, never a booking.",
  },
  "src/app/api/booking-requests/settings/route.ts": {
    boundary: "public",
    reason: "Public read of the booking request pricing-visibility flag used to label the request form; rate limited.",
  },
  "src/app/api/booking-requests/verify/[token]/route.ts": {
    boundary: "public",
    reason: "Token-bearing booking request email verification endpoint; returns only non-PII summary fields and is rate limited.",
  },
  "src/app/api/chores/[token]/route.ts": {
    boundary: "public",
    reason: "Guest chore token endpoint with rate limiting and read-only mutation behavior.",
  },
  "src/app/api/committee/route.ts": {
    boundary: "public",
    reason: "Public committee contact endpoint.",
  },
  "src/app/api/contact/route.ts": {
    boundary: "public",
    reason: "Anonymous contact form with validation and rate limiting.",
  },
  "src/app/api/health/ready/route.ts": {
    boundary: "public",
    reason: "Readiness endpoint for load balancers and deploy checks.",
  },
  "src/app/api/health/route.ts": {
    boundary: "public",
    reason: "Public health endpoint with redacted provider detail.",
  },
  "src/app/api/pay/[token]/payment-intent/route.ts": {
    boundary: "public",
    reason: "Token-authenticated Stripe payment intent for a tokenised booking payment link; revalidates status/capacity like the session path and is rate limited.",
  },
  "src/app/api/pay/[token]/route.ts": {
    boundary: "public",
    reason: "Token-authenticated public payment link page data; only the matching token resolves a booking and it is rate limited.",
  },
  "src/app/api/images/[id]/route.ts": {
    boundary: "public",
    reason: "Serves uploaded page-content images embedded in public website pages.",
  },
  "src/app/api/webhooks/ses-sns/route.ts": {
    boundary: "webhook",
    reason: "AWS SNS signed SES feedback webhook.",
  },
  "src/app/api/webhooks/stripe/route.ts": {
    boundary: "webhook",
    reason: "Stripe signed payment webhook.",
  },
  "src/app/api/webhooks/xero/route.ts": {
    boundary: "webhook",
    reason: "Xero HMAC signed webhook.",
  },
} as const satisfies Record<string, ApiRouteSecurityMetadata>;

export function getExplicitPublicApiRoute(path: string) {
  return explicitPublicApiRoutes[
    path as keyof typeof explicitPublicApiRoutes
  ];
}
