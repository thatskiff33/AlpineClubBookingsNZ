// E2E bootstrap: turn on the global modules the Critical/High E2E journeys
// need (Admin > Setup > Modules). A fresh ClubModuleSettings row defaults these
// off, so the suite would otherwise 404 the feature-gated routes. Run by
// scripts/e2e-stack.sh after seeding, before the app starts.
//
//   - twoFactor         → global two-factor enrollment (e2e/two-factor-login)
//   - waitlist          → /admin/waitlist, waitlist-confirm, force-confirm
//   - kiosk + chores    → /lodge/* and /lodge/roster (LODGE role boundary)
//   - financeDashboard  → /finance (FINANCE_USER/FINANCE_ADMIN boundary)
//   - bedAllocation     → /admin/bed-allocation, /admin/rooms-beds (#1300)
//
// internetBankingPayments and xeroIntegration stay OFF here; the internet-
// banking spec toggles them on itself and restores them, so the rest of the
// suite keeps the default card-payment flow.
import { PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

// multiLodge stays OFF by default so the blocking suite proves single-lodge
// parity (ADR-002) byte-for-byte. The advisory two-lodge project (#1568) sets
// E2E_ENABLE_MULTI_LODGE=1 for its own stack ONLY, turning the lodge step, the
// per-lodge scoping and the cross-lodge waitlist flow on for those specs.
const MODULES = {
  twoFactor: true,
  waitlist: true,
  kiosk: true,
  chores: true,
  financeDashboard: true,
  bedAllocation: true,
  multiLodge: process.env.E2E_ENABLE_MULTI_LODGE === "1",
} as const;

async function main() {
  const settings = await prisma.clubModuleSettings.upsert({
    where: { id: "default" },
    update: MODULES,
    create: { id: "default", ...MODULES },
  });
  console.log(
    `E2E modules enabled (settings id: ${settings.id}): ${Object.entries(MODULES)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(", ")}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
