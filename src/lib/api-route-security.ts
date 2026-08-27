type ApiRouteBoundary =
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
  "src/app/api/[[...unmatched]]/route.ts": {
    boundary: "public",
    reason:
      "Terminal 404 for /api URLs no real handler claims, bare /api included (#2405). Reads nothing, queries nothing and touches no session. Every method it exports (GET, POST, PUT, PATCH, DELETE, OPTIONS) returns the same frozen {error:\"Not found\"} body, with the same content-type, that src/proxy.ts's module gate returns for a hidden /api path; HEAD is deliberately NOT exported so Next derives it from GET and it carries GET's headers, rather than the hand-written bodyless response with no content-type this route used to send; and a non-standard verb never reaches this file at all, because Next answers those with a bare 400, which the proxy gate now mirrors. Net effect: an /api path under a module-gated prefix that no handler claims answers exactly the same thing whether that module is switched on or off, on every verb, so it cannot be used to probe which optional modules an install runs. Public by necessity — a guard here would answer 401/403 and tell an anonymous prober that the path is real.",
  },
  "src/app/api/address-autocomplete/details/[id]/route.ts": {
    boundary: "public",
    reason:
      "Anonymous Addy address detail proxy with module gating and rate limiting.",
  },
  "src/app/api/address-autocomplete/search/route.ts": {
    boundary: "public",
    reason:
      "Anonymous Addy address search proxy with module gating and rate limiting.",
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
  "src/app/api/auth/magic-link/route.ts": {
    boundary: "public",
    reason:
      "Magic-link sign-in request endpoint with non-enumerating behavior (always {success:true}) and rate limiting; mints a token only for an active, verified member while the module is enabled.",
  },
  "src/app/api/auth/password-policy/route.ts": {
    boundary: "public",
    reason:
      "Public read of the club password-complexity policy (#2033) so the reset/change-password forms can show live hints; discloses only rule metadata (min length, required character classes), no member data, and the server enforces the same policy regardless.",
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
  "src/app/api/booking-messages/route.ts": {
    boundary: "public",
    reason:
      "Public read of admin-configured booking message display text (Internet Banking instructions and policy copy) shown on the booking flow; returns those template strings plus the four club-level values their merge fields resolve to (#2919) — club name, default lodge name, public URL, support email, every one of them already published on the club's own website — and no member data, no lodge door code and no travel note.",
  },
  "src/app/api/booking-requests/quote/route.ts": {
    boundary: "public",
    reason:
      "Anonymous indicative non-member pricing quote for the booking request form, gated by the pricing-visibility setting and rate limited.",
  },
  "src/app/api/booking-requests/respond/[token]/route.ts": {
    boundary: "public",
    reason:
      "Token-bearing booking request quote response endpoint; only the matching SHA-256 quote token resolves the quote, invalid and superseded tokens do not enumerate request state, and actions are rate limited.",
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
  "src/app/api/booking-calendar/[id]/route.ts": {
    boundary: "public",
    reason:
      "Token-bearing .ics download for one booking's stay, linked from the booking-confirmed email's {{ical}} block (fork #35). At /api/booking-calendar rather than /api/calendar because that prefix is module-gated behind eventsCalendar and this download belongs to bookings. Only an HMAC over the signed expiry and the booking id under the app auth secret resolves anything, verified in constant time before any read, and the expiry (checkout + 60 days) is inside the signed message so it cannot be extended; the sender only mints the link for recipients whose booking-link authority (resolveBookingEmailLink) allows the booking id in outbound mail; the payload is the stay dates and lodge name only (no guest names, money or member ids); cancelled/bumped/soft-deleted bookings, expired links and invalid tokens are one indistinguishable 404; GET-only and rate limited.",
  },
  "src/app/api/school-bookings/confirm-attendees/route.ts": {
    boundary: "public",
    reason:
      "Token-bearing school attendee confirmation endpoint (#1101): SHA-256 hashed token rotated per email, identity-only guest renames via the shared quoted-booking machinery, rate limited like the other token flows.",
  },
  "src/app/api/chores/[token]/route.ts": {
    boundary: "public",
    reason:
      "Guest chore token endpoint with rate limiting and read-only mutation behavior.",
  },
  "src/app/api/committee/route.ts": {
    boundary: "public",
    reason:
      "Public committee endpoint returning only published assignment presentation fields; member email stays server-only and phone is flag-controlled.",
  },
  "src/app/api/contact/route.ts": {
    boundary: "public",
    reason: "Anonymous contact form with validation and rate limiting.",
  },
  "src/app/api/group-bookings/[code]/join-request/route.ts": {
    boundary: "public",
    reason: "Anonymous non-member group join request submission; mirrors /api/booking-requests with strict validation, controlled JSON parsing, rate limiting, and a neutral success response for account-state and group-state lookup failures. Creates only an unverified GroupBookingJoin staging row, never a booking or payment.",
  },
  "src/app/api/group-bookings/join/verify/[token]/route.ts": {
    boundary: "public",
    reason: "Token-bearing non-member group join confirmation; only the matching SHA-256 token resolves a staged join, the create is idempotent and rate limited, and it mirrors the booking-request approval conversion (non-login member, PENDING child booking, pay link).",
  },
  "src/app/api/display/state/route.ts": {
    boundary: "public",
    reason:
      "Display-token-authenticated lobby display data feed (#28): sessionless hashed-token credential resolves to one device's lodge; the payload is privacy-reduced in the serialiser (names at configured granularity, minors never individually named, no money/contact/member ids). A full-admin session may alternatively preview via ?previewDevice / ?preview[&templateId&previewLodge] / ?preview (#52, LTV-036) — GET-only, same reduced payload, never stamps lastSeenAt, and may pass ?previewDate=YYYY-MM-DD to simulate the window's start date (#60, preview-only; device fetches ignore it). Additionally a ?previewGrant=<token> — an HMAC-signed, 5-minute, single-purpose blob minted by the admin-only preview-grant endpoint (LTV-036, ADR-003 §5) — authorises exactly one template/lodge preview so an authoring page can embed it inside a sandboxed (opaque-origin) iframe without the admin session; the grant is not a display token, stamps no lastSeenAt, authorises no other route, and its cross-origin (opaque) response carries a permissive CORS header (no credentials sent). Rate limited; module-flag gated at the proxy.",
  },
  "src/app/api/display/pair/route.ts": {
    boundary: "public",
    reason:
      "Lobby display pairing (ADR-001): anonymous start issues a code inside an HMAC-signed httpOnly blob and persists nothing; claim can only present the code from its own signed blob and succeeds only after an admin binds that code to a device. Both actions rate limited; module-flag gated at the proxy.",
  },
  "src/app/api/display/heartbeat/route.ts": {
    boundary: "public",
    reason:
      "Display-token-authenticated heartbeat (ADR-001): sessionless hashed-token credential resolves to one device; updates only that device's lastSeenAt; rejected tokens update nothing. Rate limited; module-flag gated at the proxy.",
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
  "src/app/api/lodge-maintenance/[token]/route.ts": {
    boundary: "public",
    reason:
      "Anonymous lodge maintenance QR endpoint (#2780): no session by design. GET reads what one lodge's form needs and POST submits a fault, both keyed solely by a hashed per-lodge bearer token printed on the lodge sign. Every failure — bad token, paused sign, module off, lodge inactive — returns the SAME generic 404, so it cannot be used to enumerate; module-gated in the proxy, additionally gated by the default-OFF anonymousReportsEnabled setting, IP + token rate limited, and it reveals and mutates nothing about any account.",
  },
  "src/app/api/lodge/instructions/preview/route.ts": {
    boundary: "public",
    reason:
      "Remote pre-arrival lodge-instructions view for non-login hut leaders (#1642): no session by design — verifies a per-assignment id (from the assignment email) plus the 6-digit kiosk PIN with IP lockout + auth-sensitive rate limiting, and returns only the sanitised instruction documents for that assignment's lodge.",
  },
  "src/app/api/skifield-conditions/route.ts": {
    boundary: "public",
    reason:
      "Public server-side proxy for non-sensitive SnowHQ widget data embedded on public website pages; validates the fixed hash shape, rate limits requests, and returns only upstream JSON.",
  },
  "src/app/api/skifield-whakapapa/route.ts": {
    boundary: "public",
    reason:
      "Public cached Whakapapa mountain-condition payload used by public website embed tokens; fixed upstream source, rate limited, no member data.",
  },
  "src/app/api/stripe/publishable-key/route.ts": {
    boundary: "public",
    reason:
      "Runtime delivery of the non-secret Stripe publishable key (#2082): session-free by design because the unauthenticated pay/[token] page loads the card form; returns only the publishable key or null, never the secret key or webhook secret (structurally scoped to the publishable_key credential row).",
  },
  "src/app/api/testing/xero-mock/authorize/route.ts": {
    boundary: "public",
    reason:
      "Mock-Xero OAuth consent endpoint for the E2E harness (#2080). Production-inert: returns 404 unless XERO_MOCK_API_ORIGIN is set AND the runtime is not real production (NODE_ENV=production with a non-staging APP_RUNTIME_ROLE); serves no real data and touches no member state.",
  },
  "src/app/api/testing/xero-mock/chart-of-accounts/route.ts": {
    boundary: "public",
    reason:
      "Mock-Xero chart-of-accounts endpoint for the E2E harness (#2081). Production-inert via the same XERO_MOCK_API_ORIGIN + runtime-role double gate; fixed fake payload only.",
  },
  "src/app/api/testing/xero-mock/connections/route.ts": {
    boundary: "public",
    reason:
      "Mock-Xero connections endpoint for the E2E harness (#2080). Production-inert via the same XERO_MOCK_API_ORIGIN + runtime-role double gate; fixed fake payload only.",
  },
  "src/app/api/testing/xero-mock/items/route.ts": {
    boundary: "public",
    reason:
      "Mock-Xero items endpoint for the E2E harness (#2081). Production-inert via the same XERO_MOCK_API_ORIGIN + runtime-role double gate; fixed fake payload only.",
  },
  "src/app/api/testing/xero-mock/organisation/route.ts": {
    boundary: "public",
    reason:
      "Mock-Xero organisation endpoint for the E2E harness (#2080). Production-inert via the same XERO_MOCK_API_ORIGIN + runtime-role double gate; fixed fake payload only.",
  },
  "src/app/api/testing/xero-mock/send-validation/route.ts": {
    boundary: "public",
    reason:
      "Mock-Xero intent-to-receive trigger for the E2E harness (#2081): signs an empty-events body with the STORED webhook key and POSTs the real /api/webhooks/xero route (production-parity verify). Production-inert via the same XERO_MOCK_API_ORIGIN + runtime-role double gate.",
  },
  "src/app/api/testing/xero-mock/token/route.ts": {
    boundary: "public",
    reason:
      "Mock-Xero token-exchange endpoint for the E2E harness (#2080). Production-inert via the same XERO_MOCK_API_ORIGIN + runtime-role double gate; mints fake tokens consumed only by the gated mock OAuth branch.",
  },
  "src/app/api/webhooks/servernz-posts/route.ts": {
    boundary: "webhook",
    reason:
      "Alpine Central Server signed shared-post doorbell (epic #2992): HMAC over `${timestamp}.${body}` with the registration-issued secret, constant-time compare, 5-minute replay window. The body's CONTENT is ignored -- verification only ever triggers a pull of the authenticated /api/v1/feed/sync, so even a forged pass could not inject content.",
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

type ApiRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type MixedMethodApiRouteMetadata = {
  methods: Partial<
    Record<
      ApiRouteMethod,
      {
        boundary: ApiRouteBoundary;
        reason: string;
        /**
         * Only meaningful on a `public` method, and always an explicit
         * declaration: the handler IS anonymously reachable for a documented
         * subset of requests, and falls back to the shared session guards
         * (`requireActiveSessionUser` / `requireAdmin`) for everything else —
         * the boundary is mixed WITHIN the one method, which the per-method
         * `boundary` vocabulary cannot express on its own.
         *
         * The boundary test enforces this BOTH ways: a public method that
         * contains a shared guard without this field fails (a guard must never
         * appear silently in something documented as public), and a method that
         * declares this field without containing a shared guard fails too (so
         * the declaration cannot rot once the guard is removed). It is NOT a
         * blanket exemption — state exactly which requests are anonymous.
         */
        conditionalAuth?: string;
      }
    >
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
  // #2263 — recorded here for the RATIONALE, not because the file mixes
  // boundaries. Both member whole-lodge routes are single-method and wholly
  // member-boundary; the reason string is the documented home for a route whose
  // response shape is deliberately uniform, and writing it down here keeps the
  // per-method guard enforced (every exported method must be documented and must
  // carry a session guard). They are POINTEDLY ABSENT from
  // `explicitPublicApiRoutes`: listing them there would EXEMPT them from the
  // boundary test's guard check (api-route-boundaries.test.ts returns early for
  // public-registered routes), which is the opposite of what is wanted.
  "src/app/api/booking-requests/whole-lodge/route.ts": {
    methods: {
      POST: {
        boundary: "member",
        reason:
          "Signed-in member submits a whole-lodge (sole-occupancy) booking request (#2263, epic #2245). requireActiveSession; the owning member comes from the session and a memberId in the body is never read. Creates only a VERIFIED BookingRequest with exclusivityRequested=true — never a Booking, never a hold, no capacity is reserved. Rate limited per-IP and per-member (5/hr each, no cheaper than the public school door) with a 2-open-request cap enforced in the service. Its success body is a module-level FROZEN constant, byte-identical for every schema-valid submission and echoing nothing the member sent, and the handler issues NO availability, occupancy, season or pricing query at all — so neither the bytes nor the timing can tell a member whether the lodge is free, full, or already exclusively held for another group (ADR-001 decision 6 / D11).",
      },
    },
  },
  "src/app/api/booking-requests/whole-lodge/[id]/withdraw/route.ts": {
    methods: {
      POST: {
        boundary: "member",
        reason:
          "Signed-in member withdraws their OWN pending whole-lodge request (#2263, D3). requireActiveSession; ownership is part of the status-guarded claim (the WHERE names requestedByMemberId), so there is no read-then-write window and another member's request id behaves exactly like a non-existent one. Refuses (409) any request that holds capacity, because this path has no hold-release machinery and cancelling such a row would strand an AWAITING_REVIEW hold forever. Rate limited per-IP and per-member; the success body is a frozen constant.",
      },
    },
  },
  "src/app/api/members/[id]/photo/route.ts": {
    methods: {
      GET: {
        boundary: "public",
        reason:
          "Scoped member-photo serving (epic #171, MP2). Anonymous fetches succeed only when the target member has an active, published CommitteeAssignment (their photo is committee-public) AND the club's committeePhotoDisplay setting is not NONE; otherwise the handler resolves the session and serves only to the owning member or a membership viewer/admin, returning 404 to everyone else. Committee-public responses carry a short public cache; private responses are no-store. Data-layer authorisation, never the public /api/images path.",
        conditionalAuth:
          "Anonymous ONLY on the committee-public path (active member + published active CommitteeAssignment + committeePhotoDisplay != NONE). Every other request falls through to the shared guards this file's POST/DELETE use — requireActiveSessionUser for the owning member, requireAdmin({ membership: view }) for an admin — so the GET cannot skip the forcePasswordChange and two-factor gates. A guard refusal is deliberately mapped onto the route's 404 (never its own 401/403) so the endpoint never confirms whether a private photo exists (#2242).",
      },
      POST: {
        boundary: "member",
        reason:
          "Member self-upload or membership-edit admin on-behalf upload. A plain member may act only on their own id (requireActiveSessionUser); acting on another member requires requireAdmin({ membership: edit }). Validates content-type (JPEG/PNG/WebP), byte cap and dimension backstop; no server-side resize.",
      },
      DELETE: {
        boundary: "member",
        reason:
          "Member self-remove or membership-edit admin on-behalf remove, same actor gate as POST. Clears Member.photoImageId with audit columns and deletes the MEMBER_PHOTO blob.",
      },
    },
  },
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
