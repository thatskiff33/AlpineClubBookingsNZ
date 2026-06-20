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
    reason:
      "Anonymous membership application submission with validation and rate limiting.",
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
    reason:
      "Password reset request endpoint with non-enumerating behavior and rate limiting.",
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
    reason:
      "Anonymous indicative non-member pricing quote for the booking request form, gated by the pricing-visibility setting and rate limited.",
  },
  "src/app/api/booking-requests/route.ts": {
    boundary: "public",
    reason:
      "Anonymous non-member booking request submission with validation, CRLF stripping and rate limiting; creates only an unverified BookingRequest, never a booking.",
  },
  "src/app/api/booking-requests/school/route.ts": {
    boundary: "public",
    reason:
      "Anonymous school group booking request submission with validation, CRLF stripping and rate limiting; creates only an unverified SCHOOL BookingRequest, never a booking.",
  },
  "src/app/api/booking-requests/settings/route.ts": {
    boundary: "public",
    reason:
      "Public read of the booking request pricing-visibility flag used to label the request form; rate limited.",
  },
  "src/app/api/booking-requests/verify/[token]/route.ts": {
    boundary: "public",
    reason:
      "Token-bearing booking request email verification endpoint; returns only non-PII summary fields and is rate limited.",
  },
  "src/app/api/chores/[token]/route.ts": {
    boundary: "public",
    reason:
      "Guest chore token endpoint with rate limiting and read-only mutation behavior.",
  },
  "src/app/api/committee/route.ts": {
    boundary: "public",
    reason: "Public committee contact endpoint.",
  },
  "src/app/api/contact/route.ts": {
    boundary: "public",
    reason: "Anonymous contact form with validation and rate limiting.",
  },
  "src/app/api/group-bookings/[code]/join-request/route.ts": {
    boundary: "public",
    reason: "Anonymous non-member group join request submission; mirrors /api/booking-requests with strict validation, controlled JSON parsing, a neutral anti-enumeration response and rate limiting. Creates only an unverified GroupBookingJoin staging row, never a booking or payment.",
  },
  "src/app/api/group-bookings/join/verify/[token]/route.ts": {
    boundary: "public",
    reason: "Token-bearing non-member group join confirmation; only the matching SHA-256 token resolves a staged join, the create is idempotent and rate limited, and it mirrors the booking-request approval conversion (non-login member, PENDING child booking, pay link).",
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
    reason:
      "Token-authenticated Stripe payment intent for a tokenised booking payment link; revalidates status/capacity like the session path and is rate limited.",
  },
  "src/app/api/pay/[token]/refresh/route.ts": {
    boundary: "public",
    reason:
      "Token-authenticated self-service re-issue of an expired booking payment link; only the matching token resolves a booking and it is rate limited.",
  },
  "src/app/api/pay/[token]/route.ts": {
    boundary: "public",
    reason:
      "Token-authenticated public payment link page data; only the matching token resolves a booking and it is rate limited.",
  },
  "src/app/api/images/[id]/route.ts": {
    boundary: "public",
    reason:
      "Serves uploaded page-content images embedded in public website pages.",
  },
  "src/app/api/images/uploaded/[...path]/route.ts": {
    boundary: "public",
    reason:
      "Serves Image Manager uploads from the shared images volume at runtime.",
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
  return explicitPublicApiRoutes[path as keyof typeof explicitPublicApiRoutes];
}

export type ApiRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type MixedMethodApiRouteMetadata = {
  methods: Partial<
    Record<ApiRouteMethod, { boundary: ApiRouteBoundary; reason: string }>
  >;
};

/**
 * Route files where different exported HTTP methods sit on different boundaries
 * (for example a public read paired with a member-only write in the same file).
 *
 * The file-level boundary allowlist/test classifies a whole route.ts by the
 * single strongest guard marker it can find, so a mixed file like this would
 * otherwise be recorded only as "member" and its genuinely public method would
 * become an invisible boundary. Listing it here documents each method's intended
 * boundary and lets the boundary test enforce per-method guards (issue #812).
 */
export const mixedMethodApiRoutes = {
  "src/app/api/group-bookings/[code]/route.ts": {
    methods: {
      GET: {
        boundary: "public",
        reason:
          "Anonymous join-code summary returning only safe non-PII fields (code, status, payment mode, organiser first name, dates, joinable flag); rate limited; unknown codes 404 uniformly.",
      },
      PATCH: {
        boundary: "member",
        reason:
          "Organiser close/reopen; requires an active session and service-level ownership before mutating the group.",
      },
    },
  },
} as const satisfies Record<string, MixedMethodApiRouteMetadata>;
