import { expect, test, type Page, type Response } from "./helpers/accessibility";
import { PrismaClient, type AccessRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createPrismaPgAdapter } from "../src/lib/prisma-adapter";
import { ensureMemberAccessRoles } from "../src/lib/member-access-role-writes";
import { submitLoginForm, totpCode } from "./helpers/auth";
import { DEMO_PASSWORD } from "./helpers/personas";

// #4060: drive the product's two successful exits directly. loginPersona's
// corrective navigation must never make these completion assertions pass.
// Dedicated accounts are recreated per attempt: neither shared persona
// enrollment nor a previous worker's secret can affect the regression.
// Each case includes two complete sign-ins, matching the sibling TOTP suite.
// Destination assertions keep the shared 15-second observation bound.
test.describe.configure({ timeout: 180_000 });

const accounts = [
  {
    id: "e2e-4060-combined",
    email: "two-factor-combined@demo.alpineclub.test",
    firstName: "NavCombined",
    roles: ["USER", "LODGE"],
    destination: "/dashboard",
  },
  {
    id: "e2e-4060-lodge-only",
    email: "two-factor-lodge-only@demo.alpineclub.test",
    firstName: "NavLodge",
    roles: ["LODGE"],
    destination: "/lodge/kiosk",
  },
] satisfies Array<{
  id: string;
  email: string;
  firstName: string;
  roles: AccessRole[];
  destination: string;
}>;

// The app has no account-creation route that accepts a known password. Follow
// the existing setup-state helper's explicit isolated-stack database contract;
// never let dotenv choose DATABASE_URL for browser fixture writes.
function fixtureClient() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "E2E_DATABASE_URL is required for isolated two-factor fixtures (INV-OPS-003). " +
      "Run through scripts/e2e-stack.sh against the disposable demo stack.",
    );
  }
  return new PrismaClient({ adapter: createPrismaPgAdapter(url) });
}

async function expectUsableKiosk(page: Page, accessResponse: Response, weekResponse: Response) {
  expect(accessResponse.ok(), "Kiosk access request must succeed").toBe(true);
  expect(await accessResponse.json()).toMatchObject({
    tier: "lodge",
    canMarkAttendance: true,
  });
  expect(weekResponse.ok(), "Kiosk week request must succeed").toBe(true);
  const weekData = await weekResponse.json() as { days: Array<{ accessible: boolean }> };
  expect(weekData.days).toHaveLength(7);
  expect(weekData.days.every((day) => day.accessible)).toBe(true);

  const week = page.getByRole("region", { name: "Lodge kiosk week view", exact: true });
  await expect(week.getByRole("heading", { name: "Week View", exact: true })).toBeVisible();
  const days = week.getByRole("button", { name: /^Open / });
  await expect(days).toHaveCount(7);
  for (const day of await days.all()) await expect(day).toBeEnabled();
  await expect(week.getByRole("button", { name: "Next week", exact: true })).toBeEnabled();
}

for (const account of accounts) {
  test(`${account.roles.join("+")} enrollment Continue and fresh-context verification render their protected destination`, async ({ page, browser }) => {
    const prisma = fixtureClient();
    try {
      // A killed attempt is cleaned before creating the same dedicated account.
      // Deleting the member cascades its access roles and challenge credentials.
      await prisma.member.deleteMany({ where: { id: account.id } });
      await prisma.member.create({
        data: {
          id: account.id,
          email: account.email,
          firstName: account.firstName,
          lastName: "Navigation",
          passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12),
          role: "LODGE",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          emailVerified: true,
        },
      });
      await ensureMemberAccessRoles(prisma, {
        memberId: account.id,
        roles: account.roles,
        canLogin: true,
      });
      const assignments = await prisma.memberAccessRole.findMany({
        where: { memberId: account.id },
        select: { role: true },
      });
      expect(assignments.map(({ role }) => role).sort()).toEqual([...account.roles].sort());

      await submitLoginForm(page, account.email);
      await expect(page).toHaveURL(/\/login\/enroll/);
      await expect(page.getByRole("heading", { name: "Set up two-factor authentication", exact: true })).toBeVisible();
      const setupKey = page.locator("div.font-mono").first();
      await expect(setupKey).not.toHaveText(/Preparing setup key/);
      const secret = (await setupKey.innerText()).trim();
      await page.locator("#totp-code").fill(totpCode(secret));
      await page.getByRole("button", { name: "Enroll", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Save your recovery codes", exact: true })).toBeVisible();
      await expect(page.locator("div.font-mono > div")).toHaveCount(10);
      await expect(page).toHaveURL(/\/login\/enroll/);

      // This click, without a later page.goto/reload, must render the server gate.
      if (account.destination === "/lodge/kiosk") {
        const [accessResponse, weekResponse] = await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === "/api/lodge/access", { timeout: 15_000 }),
          page.waitForResponse((response) => new URL(response.url()).pathname === "/api/lodge/week", { timeout: 15_000 }),
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        ]);
        await expectUsableKiosk(page, accessResponse, weekResponse);
      } else {
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        const details = page.getByRole("dialog", { name: "Confirm member details", exact: true });
        await expect(details).toBeVisible();
        await expect(details.getByRole("button", { name: "Save and continue", exact: true })).toBeVisible();
      }
      await expect(page).toHaveURL(new RegExp(`${account.destination}$`));

      // No cookies or corrective persona helper are carried into verification.
      const freshContext = await browser.newContext();
      try {
        const freshPage = await freshContext.newPage();
        await submitLoginForm(freshPage, account.email);
        await expect(freshPage).toHaveURL(/\/login\/verify/);
        await expect(freshPage.getByText("Verify your sign-in", { exact: true })).toBeVisible();
        await freshPage.locator("#two-factor-code").fill(totpCode(secret));
        if (account.destination === "/lodge/kiosk") {
          const [accessResponse, weekResponse] = await Promise.all([
            freshPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/lodge/access", { timeout: 15_000 }),
            freshPage.waitForResponse((response) => new URL(response.url()).pathname === "/api/lodge/week", { timeout: 15_000 }),
            freshPage.getByRole("button", { name: "Verify", exact: true }).click(),
          ]);
          await expectUsableKiosk(freshPage, accessResponse, weekResponse);
        } else {
          await freshPage.getByRole("button", { name: "Verify", exact: true }).click();
          const details = freshPage.getByRole("dialog", { name: "Confirm member details", exact: true });
          await expect(details).toBeVisible();
          await expect(details.getByRole("button", { name: "Save and continue", exact: true })).toBeVisible();
        }
        await expect(freshPage).toHaveURL(new RegExp(`${account.destination}$`));
      } finally {
        await freshContext.close();
      }
    } finally {
      try {
        await prisma.member.deleteMany({ where: { id: account.id } });
      } finally {
        await prisma.$disconnect();
      }
    }
  });
}
