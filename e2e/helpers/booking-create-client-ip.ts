import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

/**
 * Closed census of E2E tests that submit `POST /api/bookings`.
 *
 * Ordinary journeys and setup calls are `isolated-setup`: they receive one
 * deterministic private-IP bucket per test attempt through
 * {@link bookingCreateIsolation}. A test whose PURPOSE is exercising the
 * limiter is `intentional-limiter` and must use {@link bookingCreateLimiterProbe}
 * instead. Both paths still traverse the real production limiter; the separate
 * typed allocators make an intentional probe visible without letting it become
 * an ordinary setup-call precedent.
 */
export const E2E_BOOKING_CREATE_CENSUS = [
  {
    key: "admin-override-seed",
    file: "e2e/admin-override-dates.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "admin-retroactive-record",
    file: "e2e/admin-retroactive-booking.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "admin-retroactive-member-rejection",
    file: "e2e/admin-retroactive-booking.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "adult-hosting-refusal",
    file: "e2e/adult-member-hosting.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "adult-hosting-cross-booking",
    file: "e2e/adult-member-hosting.spec.ts",
    transport: "api",
    classification: "isolated-setup",
    requestsPerAttempt: 2,
  },
  {
    // #3232's linked move: the covering booking and the booking that depends on
    // it, created by two different officers in one attempt so the relationship
    // under test is Booking.memberId rather than createdById.
    key: "linked-move-pair",
    file: "e2e/adult-member-hosting.spec.ts",
    transport: "api",
    classification: "isolated-setup",
    requestsPerAttempt: 2,
  },
  {
    key: "booking-payment-pending",
    file: "e2e/booking.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "booking-create-shared-store-proof",
    file: "e2e/booking-create-rate-isolation.spec.ts",
    transport: "api",
    classification: "intentional-limiter",
    requestsPerAttempt: 3,
  },
  {
    key: "double-bed-capacity",
    file: "e2e/double-bed-sharing.spec.ts",
    transport: "api",
    classification: "isolated-setup",
    requestsPerAttempt: 2,
  },
  {
    key: "double-bed-allocation",
    file: "e2e/double-bed-sharing.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "dual-hat-member-create",
    file: "e2e/dual-hat-booking.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "dual-hat-officer-draft",
    file: "e2e/dual-hat-booking.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "locked-out-self-refusal",
    file: "e2e/locked-out-pickup-and-pay.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "locked-out-on-behalf-draft",
    file: "e2e/locked-out-pickup-and-pay.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "member-exception-compliant",
    file: "e2e/member-policy-exception-requests.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-exception-minimum-refusal",
    file: "e2e/member-policy-exception-requests.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-exception-replacement",
    file: "e2e/member-policy-exception-requests.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-exception-approval",
    file: "e2e/member-policy-exception-requests.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-guest-consent-approve",
    file: "e2e/member-guest-consent.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "member-guest-consent-decline",
    file: "e2e/member-guest-consent.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "multi-lodge-member-edit",
    file: "e2e/multi-lodge/member-guest-edit-path.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "multi-lodge-officer-edit",
    file: "e2e/multi-lodge/member-guest-edit-path.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "on-behalf-inline-owner",
    file: "e2e/book-on-behalf-nonmember.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "on-behalf-existing-owner",
    file: "e2e/book-on-behalf-nonmember.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "on-behalf-walk-in-owner",
    file: "e2e/book-on-behalf-nonmember.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "stripe-success",
    file: "e2e/stripe-payment.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "stripe-decline",
    file: "e2e/stripe-payment.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "waitlist-placement",
    file: "e2e/waitlist.spec.ts",
    transport: "api",
    classification: "isolated-setup",
    requestsPerAttempt: 2,
  },
  {
    key: "whole-lodge-held-anchor",
    file: "e2e/whole-lodge-request.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
] as const satisfies ReadonlyArray<{
  key: string;
  file: string;
  transport: "api" | "browser";
  classification: "isolated-setup" | "intentional-limiter";
  requestsPerAttempt?: number;
}>;

type BookingCreateCensusEntry =
  (typeof E2E_BOOKING_CREATE_CENSUS)[number];

export type BookingCreateIsolationKey = Extract<
  BookingCreateCensusEntry,
  { classification: "isolated-setup" }
>["key"];

export type BookingCreateLimiterProbeKey = Extract<
  BookingCreateCensusEntry,
  { classification: "intentional-limiter" }
>["key"];

type BookingCreateCensusKey = BookingCreateCensusEntry["key"];

export type BookingCreateIsolation = Readonly<{
  key: BookingCreateCensusKey;
  retry: number;
  clientIp: string;
  headers: Readonly<Record<"x-forwarded-for", string>>;
}>;

/**
 * Return the one private booking-create bucket allocated to a logical spec
 * attempt. The third octet is the registered census slot; the fourth is the
 * Playwright retry number plus one. That makes repeated calls within an attempt
 * stable while separating every registered spec and retry without a hash
 * collision.
 *
 * `10.240.0.0/16` is deliberately disjoint from the login helper's
 * `10.99.0.0/16` and the whole-lodge submission worlds' `10.77.1.0/24`.
 */
function bookingCreateClientIdentity(
  key: BookingCreateCensusKey,
  retry: number,
  classification: BookingCreateCensusEntry["classification"],
): BookingCreateIsolation {
  if (!Number.isSafeInteger(retry) || retry < 0 || retry > 253) {
    throw new RangeError(`booking-create retry must be an integer from 0 to 253; got ${retry}`);
  }

  const slotIndex = E2E_BOOKING_CREATE_CENSUS.findIndex((entry) => entry.key === key);
  if (slotIndex < 0) {
    throw new Error(`unregistered E2E booking-create isolation key: ${key}`);
  }
  const entry = E2E_BOOKING_CREATE_CENSUS[slotIndex];
  if (entry.classification !== classification) {
    throw new Error(
      `booking-create key ${key} is ${entry.classification}, not ${classification}`,
    );
  }

  const slot = slotIndex + 1;
  const clientIp = `10.240.${slot}.${retry + 1}`;
  return Object.freeze({
    key,
    retry,
    clientIp,
    headers: Object.freeze({ "x-forwarded-for": clientIp }),
  });
}

export function bookingCreateIsolation(
  key: BookingCreateIsolationKey,
  retry: number,
): BookingCreateIsolation {
  return bookingCreateClientIdentity(key, retry, "isolated-setup");
}

/**
 * Allocate a deterministic per-attempt identity for an explicitly declared
 * limiter test. This is not an escape hatch for setup calls: the key's census
 * entry must be `intentional-limiter`, and the structural contract rejects an
 * intentional entry consumed through {@link bookingCreateIsolation} (or vice
 * versa).
 */
export function bookingCreateLimiterProbe(
  key: BookingCreateLimiterProbeKey,
  retry: number,
): BookingCreateIsolation {
  return bookingCreateClientIdentity(key, retry, "intentional-limiter");
}

type BookingCreatePostOptions = NonNullable<
  Parameters<APIRequestContext["post"]>[1]
>;

/**
 * Submit one direct E2E booking-create request through its registered bucket.
 *
 * Keeping the exact route literal in this one helper lets the executable census
 * reject every raw `APIRequestContext.post` call in a spec, including a call
 * whose path is hidden behind a simple const alias. Per-request headers are
 * merged so an existing scenario header is preserved; only `x-forwarded-for`
 * is deliberately replaced by the registered isolation identity.
 */
/**
 * Resolve the lodge this session may book, for a create that did not name one.
 *
 * #2701: `POST /api/bookings` no longer fills a missing `lodgeId` with the
 * club's default lodge, because on a CREATE that is how somebody ends up paid
 * up at a lodge they were never shown. Every real client now names its lodge,
 * so these direct creates do too — otherwise the census helper would be the one
 * caller in the world still exercising a signature the product no longer emits.
 *
 * The member-visible endpoint is used deliberately: it returns exactly the
 * lodges THIS session may book, so a multi-lodge fixture resolves to the
 * booker's own eligible lodge rather than to whichever row happens to be
 * marked default.
 */
export async function resolveBookableLodgeId(
  request: APIRequestContext,
): Promise<string | null> {
  const response = await request.get("/api/lodges");

  if (!response.ok()) {
    // `null`, NOT a throw, when the caller has no session. Two specs post here
    // deliberately unauthenticated — the booking-create rate limiter runs
    // BEFORE authentication, so proving retry-key isolation requires reaching
    // the route with no cookies at all. Throwing turned "the route refused
    // you", which is the measurement, into "the harness exploded", which is
    // not: the probe never reached `POST /api/bookings` and the shared counter
    // never moved. A session that may not list lodges cannot create a booking
    // either, so skipping the fill costs nothing and the create refuses on its
    // own terms.
    //
    // `status()` is read only on this failure path, so a happy-path response
    // double need not implement it.
    const status = response.status();
    if (status === 401 || status === 403) return null;
    throw new Error(
      `resolve bookable lodge for a booking create (${status})`,
    );
  }
  const body = (await response.json()) as { lodges?: Array<{ id: string }> };
  const lodgeId = body.lodges?.[0]?.id;
  if (!lodgeId) {
    // Authenticated and still no lodge is a broken fixture, not a refusal.
    throw new Error(
      "resolve bookable lodge for a booking create: this session may book no lodge",
    );
  }
  return lodgeId;
}

export async function postBookingCreate(
  request: APIRequestContext,
  isolation: BookingCreateIsolation,
  options: BookingCreatePostOptions,
): Promise<APIResponse> {
  // A create that already names its lodge is passed through untouched; only the
  // blank is filled, and it is filled HERE rather than by the server (#2701).
  const data = options.data as Record<string, unknown> | undefined;
  const needsLodge =
    data !== undefined &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    data.lodgeId === undefined;
  const resolvedLodgeId = needsLodge
    ? await resolveBookableLodgeId(request)
    : null;
  const filled = needsLodge && resolvedLodgeId !== null;

  return request.post("/api/bookings", {
    ...options,
    ...(filled ? { data: { ...data, lodgeId: resolvedLodgeId } } : {}),
    headers: {
      ...options.headers,
      ...isolation.headers,
    },
  });
}

/**
 * One browser-driven booking-create action, split into the gesture that emits
 * the create and the wait that proves what the create did.
 *
 * Both halves run with the interception installed. Splitting them is what lets
 * the helper keep the route registered across the whole action instead of
 * tearing it down the moment the click resolves.
 */
export type BookingCreateBrowserAction<T> = Readonly<{
  /** Fire exactly the UI gesture that emits `POST /api/bookings`. */
  trigger: () => Promise<T>;
  /**
   * Await this journey's OWN authoritative outcome for that create: the exact
   * `/bookings/<id>` URL it navigates to, the wizard step it reveals, or the
   * refusal it renders. Not a generic "some page rendered" wait.
   */
  waitForOutcome: (triggered: T) => Promise<void>;
}>;

/**
 * Add the synthetic IP to exactly one browser-driven booking-create action.
 * Other page requests — including login, policy requests and availability —
 * retain their original headers. The completed action must issue exactly one
 * `POST /api/bookings`, so a stale census entry fails loudly.
 *
 * The interception is held across BOTH halves of the action and removed only
 * once `waitForOutcome` has resolved. Playwright implements `page.unroute` by
 * recomputing Chromium's global Fetch interception patterns, so a teardown that
 * overlaps a navigation the trigger just started is a race by construction:
 * the client-side `router.push` the create issues, and the RSC GET it starts
 * within a few milliseconds, are both in flight while the patterns are being
 * rewritten. Holding the route until the caller has seen its outcome keeps
 * teardown outside that window.
 *
 * This is test-harness hygiene, not a proven diagnosis of #2610. The stall
 * reproduces only on the hosted runners, so the shape above is also the A/B
 * being measured there; do not read it as a root-cause fix.
 */
export async function withBookingCreateClientIp<T>(
  page: Page,
  isolation: BookingCreateIsolation,
  action: BookingCreateBrowserAction<T>,
): Promise<T> {
  let matchingRequests = 0;
  const routePattern = "**/api/bookings";
  const isBookingCreate = (request: {
    method(): string;
    url(): string;
  }): boolean =>
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/api/bookings";
  const handler: Parameters<Page["route"]>[1] = async (route) => {
    const request = route.request();
    if (!isBookingCreate(request)) {
      await route.continue();
      return;
    }

    matchingRequests += 1;
    await route.continue({
      headers: { ...request.headers(), ...isolation.headers },
    });
  };

  await page.route(routePattern, handler);
  const requestObserved = page.waitForRequest(isBookingCreate);
  let completed = false;
  try {
    const [triggered] = await Promise.all([action.trigger(), requestObserved]);
    await action.waitForOutcome(triggered);
    completed = true;
    return triggered;
  } finally {
    await page.unroute(routePattern, handler);
    if (completed && matchingRequests !== 1) {
      throw new Error(
        `booking-create action ${isolation.key} issued ${matchingRequests} ` +
          "matching requests; expected exactly one",
      );
    }
  }
}
