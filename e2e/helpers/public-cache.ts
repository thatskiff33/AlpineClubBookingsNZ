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
 * What a pass inside it proves depends on which cache the page is served from:
 *
 *  • A STORED CMS page lives 300 seconds, so a spec that warms the page and then
 *    writes (`static-cms-pages.spec.ts`) has still proved the write cleared the
 *    store: the page could not have aged out in 10.
 *  • The TAGGED layout caches live 15 seconds from when the entry was last
 *    rebuilt, which a spec does not control. For those (analytics settings, the
 *    theme) the poll only waits for the change to be served; it is not evidence
 *    that the write invalidated anything. The unit tier pins those invalidations.
 *
 * Keep it well under the 300-second backstop, and do not replace the poll with a
 * sleep, which proves nothing about when the change landed.
 */
const ADMIN_WRITE_VISIBLE_WITHIN_MS = 10_000;

/** Poll steps: the first probe is immediate, so a write that has landed costs nothing. */
const PROBE_INTERVALS_MS = [50, 100, 250, 500];

/**
 * The timing every "has the write landed" poll shares. Fits both `expect.poll`
 * and `toPass`; the failure message is the caller's, passed the way each takes it.
 */
export const ADMIN_WRITE_VISIBLE_POLL = {
  timeout: ADMIN_WRITE_VISIBLE_WITHIN_MS,
  intervals: PROBE_INTERVALS_MS,
};

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
    .poll(async () => (await request.get(path)).status(), {
      message,
      ...ADMIN_WRITE_VISIBLE_POLL,
    })
    .toBe(status);
}
