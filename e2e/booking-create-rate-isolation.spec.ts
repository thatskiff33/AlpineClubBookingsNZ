import {
  type APIRequestContext,
  expect,
  test,
} from "./helpers/accessibility";

import {
  type BookingCreateIsolation,
  bookingCreateLimiterProbe,
  postBookingCreate,
} from "./helpers/booking-create-client-ip";
import { readRateLimitCounters } from "./helpers/rate-limit-counter";

// Provider-independent runtime proof for #2599. The booking-create limiter runs
// before authentication, so deliberately unauthenticated requests can prove
// retry-key isolation without creating bookings or calling Stripe. The direct
// read then proves the route updated the shared PostgreSQL counter rather than
// quietly succeeding through the in-process fallback.
test.use({ storageState: { cookies: [], origins: [] } });

async function postBookingCreateSharedStoreProbe(
  request: APIRequestContext,
  isolation: BookingCreateIsolation,
) {
  const counterId = `booking-create:${isolation.clientIp}`;
  const before = (await readRateLimitCounters([counterId])).get(counterId);
  const response = await postBookingCreate(request, isolation, { data: {} });
  const after = (await readRateLimitCounters([counterId])).get(counterId);
  return {
    isolation,
    counterId,
    before,
    response,
    after,
  };
}

test("Stripe retry dimensions reach distinct shared booking-create counters", async ({
  request,
}) => {
  const probes = [
    await postBookingCreateSharedStoreProbe(
      request,
      bookingCreateLimiterProbe("booking-create-shared-store-proof", 0),
    ),
    await postBookingCreateSharedStoreProbe(
      request,
      bookingCreateLimiterProbe("booking-create-shared-store-proof", 1),
    ),
    await postBookingCreateSharedStoreProbe(
      request,
      bookingCreateLimiterProbe("booking-create-shared-store-proof", 2),
    ),
  ] as const;
  const counterIds = probes.map(
    ({ counterId }) => counterId,
  );
  expect(new Set(counterIds).size).toBe(3);

  for (const [index, { response }] of probes.entries()) {
    expect(
      response.status(),
      `retry dimension ${index} must pass the limiter and stop at auth: ${await response.text()}`,
    ).toBe(401);
  }

  for (const { counterId, before, after } of probes) {
    expect(
      after,
      `${counterId} must exist in the shared PostgreSQL store`,
    ).toBeDefined();
    expect(after!.count, `${counterId} must advance exactly once`).toBe(
      (before?.count ?? 0) + 1,
    );
    expect(
      after!.resetAt.getTime(),
      `${counterId} must have a live fixed window`,
    ).toBeGreaterThan(Date.now());
  }
});
