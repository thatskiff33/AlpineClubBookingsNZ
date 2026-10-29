import { type BrowserContext, expect, test } from "./helpers/accessibility";
import { loginPersona, storageStatePath } from "./helpers/auth";
import { E2E_ADMIN, IB_BOOKING_ID, WAITLISTER } from "./helpers/fixtures";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";

// Critical row (docs/END_TO_END_TEST_MATRIX.md): "Internet Banking/Xero invoice
// settlement distinct from Stripe." Xero is deliberately unconfigured in this
// stack (no connection), so switching a card booking to Internet Banking must
// queue the invoice without calling Xero and without crashing.
//
// A card (Stripe) PAYMENT_PENDING booking owned by Wanda is seeded
// (prisma/demo-seed.ts, id IB_BOOKING_ID). Wanda has a complete, confirmed
// profile, so the booking page is not blocked by the onboarding modal. The
// Internet Banking + Xero modules default off, so this spec turns them on for
// its own run and restores them afterwards, leaving the rest of the suite on
// the default card flow.
test.describe.configure({ mode: "serial" });

let memberContext: BrowserContext;
let adminContext: BrowserContext;
let previousModules: ModuleSettings | undefined;

test.beforeAll(async ({ browser }) => {
  // One fresh login (WAITLISTER) incl. possible first-time two-factor
  // enrollment: needs more than the default 90s hook budget on a loaded runner.
  test.setTimeout(240_000);
  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, WAITLISTER.email);
  await memberPage.close();

  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  // Both flags are required: the switch endpoint 400s unless xeroIntegration
  // and internetBankingPayments are on (src/app/api/payments/switch-to-internet-banking).
  previousModules = await overrideModules(adminContext.request, {
    xeroIntegration: true,
    internetBankingPayments: true,
  });
});

test.afterAll(async () => {
  try {
    if (adminContext && previousModules) {
      await setModuleSettings(adminContext.request, previousModules);
    }
  } finally {
    await adminContext?.close();
    await memberContext?.close();
  }
});

test("member switches a card booking to Internet Banking with Xero absent", async () => {
  const page = await memberContext.newPage();
  await page.goto(`/bookings/${IB_BOOKING_ID}`);

  // The card PAYMENT_PENDING booking offers the switch once the module is on.
  const switchButton = page.getByRole("button", {
    name: "Pay by internet banking instead",
  });
  await expect(switchButton).toBeVisible();
  await switchButton.click();

  // Deterministic outcome: on success the switch triggers a hard reload, so the
  // page re-renders from the server to the Internet Banking card — source
  // Internet Banking with a BOOKING-… reference, the switch affordance gone (a
  // fresh render cannot show it once payment.source is INTERNET_BANKING), and no
  // crash despite Xero being unconfigured (the Xero invoice is queued but never
  // sent while disconnected). The booking stays payment-owed (holdBedSlots
  // defaults off → no bed held, per #737). No soft-refresh race, no reload
  // crutch in the spec (#1148 / #1371 F28) — asserted against the reloaded DOM.
  await expect(switchButton).toHaveCount(0, { timeout: 30_000 });
  // #1400 root cause (confirmed by inspecting the reloaded page's streamed HTML):
  // /bookings/[id] has a loading.tsx, so Next.js wraps this async server page in a
  // Suspense boundary and STREAMS it — the shell flushes first with the skeleton
  // inside <main>, then the real content (including this Internet Banking card)
  // arrives in a trailing `<div hidden id="S:…">` React streaming segment appended
  // to <body>, which an inline reveal script then moves into <main>. On the
  // window.location.reload() after the switch, on a loaded CI runner that
  // reveal/cleanup races: for a window the card exists BOTH revealed in <main> AND
  // still in the not-yet-removed hidden streaming segment, so an unscoped getByText
  // resolves to two elements (one hidden) for the assertion window — the same
  // hard-load streaming/hydration class as the login #email duplicate (#1154/#1207).
  // The hidden copy is a benign framework artefact (the <main> copy IS the correct,
  // complete member-visible render), so scope the post-reload assertions to the
  // <main> region: it targets the revealed server render, and because the streaming
  // segment sits OUTSIDE <main> a hidden artefact can never strict-violate — while a
  // genuine double render INSIDE <main> still trips strict mode and fails, so no
  // real regression is masked. Supersedes the visible=true guard from #1407.
  const main = page.getByRole("main");
  await expect(main.getByText("Internet Banking Payment")).toBeVisible({
    timeout: 30_000,
  });
  await expect(main.getByText(/Reference:/)).toBeVisible();
  await expect(
    main.getByText(`BOOKING-${IB_BOOKING_ID.slice(0, 8).toUpperCase()}`, {
      exact: true,
    }),
  ).toBeVisible();
  await page.close();
});
