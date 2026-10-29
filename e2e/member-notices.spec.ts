import { expect, test, type APIRequestContext } from "./helpers/accessibility";
import { loginPersona, storageStatePath } from "./helpers/auth";
import { signIn } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings } from "./helpers/modules";
import { personas } from "./helpers/personas";

// Member Notices end-to-end (docs/E2E_PLAYWRIGHT.md): a full admin publishes an
// individually-targeted notice via the admin API, an in-audience member sees it
// on the dashboard "Recent News" card as unread and reading it clears the badge
// and records a receipt the admin read report shows, while an out-of-audience
// member sees no card and gets a 404 on the direct URL. Finally, turning the
// module off 404s /notices and hides the dashboard card.
//
// Admin setup is driven through the API (deterministic targeting + receipt
// assertions); the member experience is asserted through the real UI.
test.describe.configure({ mode: "serial" });

const IN_AUDIENCE = personas.booker; // Alice — targeted individually
// Carol is a plain member (no finance access, so no forced 2FA and a member
// /dashboard landing). Bob (personas.enrollee) must NOT be used here: he is
// the reserved un-enrolled 2FA persona — signing him in would enroll him and
// break two-factor-login.spec.ts — and his FINANCE_USER landing is
// /admin/payments, which the signIn helper's /admin/dashboard gate rejects.
const OUT_OF_AUDIENCE_EMAIL = "carol@demo.alpineclub.test";

let admin: APIRequestContext;
let noticeId: string;
let inAudienceMemberId: string;
const noticeTitle = `E2E Committee Notice ${Date.now()}`;

test.beforeAll(async ({ playwright, baseURL }) => {
  admin = await playwright.request.newContext({
    baseURL,
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  // Ensure the module is on before we start.
  await overrideModules(admin, { memberNotices: true });

  // Resolve the in-audience member's id.
  const membersRes = await admin.get(
    `/api/admin/members?search=${encodeURIComponent(IN_AUDIENCE.email)}&pageSize=20`,
  );
  expect(membersRes.ok(), `members lookup ${membersRes.status()}`).toBeTruthy();
  const membersBody = (await membersRes.json()) as {
    members: Array<{ id: string; email: string }>;
  };
  const member = membersBody.members.find(
    (m) => m.email.toLowerCase() === IN_AUDIENCE.email.toLowerCase(),
  );
  expect(member, `found ${IN_AUDIENCE.email}`).toBeTruthy();
  inAudienceMemberId = member!.id;

  // Publish a notice targeted ONLY at the in-audience member.
  const createRes = await admin.post("/api/admin/notices", {
    data: {
      title: noticeTitle,
      bodyHtml: "<p>Committee update for the targeted member only.</p>",
      status: "PUBLISHED",
      audiences: [{ kind: "MEMBER", memberId: inAudienceMemberId }],
    },
  });
  expect(createRes.status(), await createRes.text()).toBe(201);
  const created = (await createRes.json()) as { notice: { id: string } };
  noticeId = created.notice.id;
});

test.afterAll(async () => {
  // Clean up the notice and dispose the admin context.
  if (noticeId) {
    await admin.delete(`/api/admin/notices/${noticeId}`);
  }
  await admin.dispose();
});

test("an in-audience member sees the notice, reads it, and the admin report records the receipt", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, IN_AUDIENCE);

  // Dashboard shows the Recent News card with an unread indicator. During the
  // React streaming reveal the card can briefly exist both revealed and in a
  // hidden streamed segment, tripping strict mode on a bare text match (#21,
  // same class as internet-banking.spec.ts) — filter to the visible instance;
  // a genuine double visible render would still strict-violate and fail.
  await page.goto("/dashboard");
  await expect(
    page.getByText("Recent News").filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByText(noticeTitle).filter({ visible: true }),
  ).toBeVisible();
  // Assert the badge specifically — a bare /unread/i also matches the
  // sr-only "(unread)" marker inside the notice link.
  await expect(
    page.getByText("1 unread", { exact: true }).filter({ visible: true }),
  ).toBeVisible();

  // Open the notice; the read receipt fires on the detail page.
  await page
    .getByRole("link", { name: noticeTitle })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/notices/${noticeId}$`));
  await expect(
    page
      .getByText("Committee update for the targeted member only.")
      .filter({ visible: true }),
  ).toBeVisible();

  // The admin read report now shows a receipt for this member.
  await expect(async () => {
    const readsRes = await admin.get(`/api/admin/notices/${noticeId}/reads`);
    expect(readsRes.ok()).toBeTruthy();
    const body = (await readsRes.json()) as {
      readCount: number;
      rows: Array<{ memberId: string; readAt: string | null }>;
    };
    const row = body.rows.find((r) => r.memberId === inAudienceMemberId);
    expect(row?.readAt).toBeTruthy();
    expect(body.readCount).toBeGreaterThanOrEqual(1);
  }).toPass({ timeout: 15_000 });
});

test("an out-of-audience member sees no card and gets a 404 on the direct URL", async ({
  page,
}) => {
  // Plain-member login via loginPersona: it clears whatever two-factor step
  // the stack demands (enrollment is forced for every member here) without
  // signIn's Alice-only /admin/dashboard landing assertion.
  await loginPersona(page, OUT_OF_AUDIENCE_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/dashboard");
  // The targeted notice must not appear for this member.
  await expect(page.getByText(noticeTitle)).toHaveCount(0);

  // Direct navigation to the notice is indistinguishable from non-existent.
  const response = await page.goto(`/notices/${noticeId}`);
  expect(response?.status()).toBe(404);
});

test("with the module off, /notices 404s and the dashboard card disappears", async ({
  page,
}) => {
  const previous = await overrideModules(admin, { memberNotices: false });
  try {
    await signIn(page, IN_AUDIENCE);

    const listResponse = await page.goto("/notices");
    expect(listResponse?.status()).toBe(404);

    await page.goto("/dashboard");
    await expect(page.getByText("Recent News")).toHaveCount(0);
  } finally {
    // Restore the module settings exactly as they were.
    await setModuleSettings(admin, previous);
  }
});
