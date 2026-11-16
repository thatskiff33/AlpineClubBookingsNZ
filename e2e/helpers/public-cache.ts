import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Waiting for an admin write to reach the public site (#5205).
 *
 * The admin write routes clear the public caches with `revalidatePath` and
 * `revalidateTag` (`src/lib/public-content-revalidation.ts`). In a Route Handler,
 * Next applies those as the response finishes, not before it is sent. A spec that
 * issues its next request in the same instant can therefore still be answered
 * from the stored copy: the product is behaving as intended and the spec has
 * simply won a race. A fast runner wins it often.
 *
 * So a spec that asserts "the public site shows what the admin just saved" polls
 * for it, with this bound and no other.
 */

/**
 * How long an admin write may take to show on the public site.
 *
 * Deliberately BELOW both cache lifetimes: the tagged layout caches live 15
 * seconds and a stored CMS page 300. A pass inside this bound is therefore still
 * evidence that the write invalidated the cache, and can never be the cache
 * ageing out by itself. Do not raise it past 15 seconds, and do not replace the
 * poll with a sleep, which proves nothing about when the change landed.
 */
const ADMIN_WRITE_VISIBLE_WITHIN_MS = 10_000;

/** Poll steps: the first probe is immediate, so a write that has landed costs nothing. */
const PROBE_INTERVALS_MS = [50, 100, 250, 500];

/** The options every "has the write landed" poll in the suite shares. */
export function adminWriteVisiblePoll(message: string) {
  return {
    message,
    timeout: ADMIN_WRITE_VISIBLE_WITHIN_MS,
    intervals: PROBE_INTERVALS_MS,
  };
}

/**
 * Assert that `path` answers `status` once the admin write just made has landed.
 * Fails with `message` if it has not within {@link ADMIN_WRITE_VISIBLE_WITHIN_MS}.
 */
export async function expectStatusAfterAdminWrite(
  request: APIRequestContext,
  path: string,
  status: number,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () => (await request.get(path)).status(),
      adminWriteVisiblePoll(message),
    )
    .toBe(status);
}
