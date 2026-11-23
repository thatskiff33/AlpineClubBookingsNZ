import { PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";

/**
 * Flips the club's site-style setup state directly on the staging database
 * (#2420), for the `pre-setup` Playwright project.
 *
 * Direct database access is the exception in this suite — every other spec
 * drives the app over HTTP — and it is unavoidable here rather than convenient:
 * `saveClubTheme()` resolves `completedAt` as `existing?.completedAt ?? …`, so
 * the app can COMPLETE setup and can never un-complete it. There is no admin
 * route, and deliberately so. Measuring the pre-setup wire behaviour therefore
 * needs either a second differently-seeded stack or this; see the spec header.
 *
 * `E2E_DATABASE_URL` is exported by `scripts/e2e-stack.sh`. Absent, this throws
 * with the reason rather than silently connecting somewhere else. Shared with
 * the one other state no admin route can rewind, the seeded membership
 * applications (`e2e/helpers/reset.ts`, #5407).
 */
export function e2eDatabaseClient() {
  const url = process.env.E2E_DATABASE_URL;

  if (!url) {
    throw new Error(
      "E2E_DATABASE_URL is not set. This step writes to the isolated E2E " +
        "database; run the suite through scripts/e2e-stack.sh, which exports it.",
    );
  }

  // Passed explicitly rather than through DATABASE_URL: the adapter module
  // pulls in `dotenv/config`, and the Playwright process must not end up
  // pointing at whatever a developer's local .env happens to hold.
  return new PrismaClient({ adapter: createPrismaPgAdapter(url) });
}

/**
 * @param complete `false` puts the club back to "setup in progress"; `true`
 *   stamps it complete again. Returns once the row is written — callers still
 *   have to wait out the proxy's own 15-second cache of the state.
 */
export async function setSiteSetupComplete(complete: boolean): Promise<void> {
  const prisma = e2eDatabaseClient();

  try {
    await prisma.clubTheme.update({
      where: { id: "default" },
      data: { completedAt: complete ? new Date() : null },
    });
  } finally {
    await prisma.$disconnect();
  }
}
