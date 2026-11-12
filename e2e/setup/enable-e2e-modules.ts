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
//   - skifieldWhakapapa → /admin/mountain-conditions, /api/skifield-whakapapa
//                         (#4932; the screenshot tool captures the admin page)
//
// internetBankingPayments and xeroIntegration stay OFF here; the internet-
// banking spec (e2e/internet-banking.spec.ts) and the Xero setup wizard spec
// (e2e/xero-setup-wizard.spec.ts) each toggle xeroIntegration on for their own
// run and restore it afterwards, so the rest of the suite keeps the default
// card-payment flow. Both restore in afterAll, and workers=1 keeps them serial,
// so the toggle-and-restore choreography never collides.
import { PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

const MODULES = {
  twoFactor: true,
  waitlist: true,
  kiosk: true,
  chores: true,
  financeDashboard: true,
  bedAllocation: true,
  skifieldWhakapapa: true,
} as const;

async function main() {
  const settings = await prisma.clubModuleSettings.upsert({
    where: { id: "default" },
    update: MODULES,
    create: { id: "default", ...MODULES },
  });
  console.log(
    `E2E modules enabled (settings id: ${settings.id}): ${Object.keys(MODULES).join(", ")}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
