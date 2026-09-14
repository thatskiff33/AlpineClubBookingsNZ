import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

/*
  The kiosk PIN must not be readable by administrator Raw CSS (#2981).

  ## The defect this pins closed

  `(website)` and `(website-dynamic)` inject the club's Raw CSS from Admin > Site
  Appearance, and the hut-leader instructions page — in `(website-dynamic)` — asks
  for a shared six-digit kiosk PIN. React's controlled-input pattern mirrors the
  live value into the DOM `value` ATTRIBUTE (react-dom writes `node.defaultValue`
  on every update, and `defaultValue` reflects to that attribute), and CSS matches
  attributes. So `input#hut-leader-pin[value^="14"]` was a working prefix oracle:
  a styling administrator — deliberately outside the PIN trust boundary, the same
  boundary #2827 drew for the group-join payment token — could recover the PIN a
  character at a time through conditional resource loads.

  Confirmed in real browsers before the fix was written, because jsdom is not
  evidence about a browser: Chromium 153, Firefox 155 and WebKit 26.6 all mirrored
  every keystroke into the attribute and all three matched the growing prefix
  selectors. `SecretInput` (`src/components/ui/secret-input.tsx`) closes it by
  rendering an UNCONTROLLED input, so no `value` attribute exists at all.

  ## Why this test can only be a browser test

  The property/attribute distinction is a browser and react-dom runtime fact, and
  the selector half is a CSS-engine fact. Neither is observable from a source scan
  and neither is trustworthy from jsdom. The oracle used here is
  `getComputedStyle().outlineColor`: if the engine can select the element by its
  typed prefix, the matching rule wins and the computed colour changes. No remote
  beacon is needed and none is used — nothing leaves the machine.

  The static half (which fields are owed this treatment, and that `SecretInput`
  still passes no `value` prop) is
  `src/lib/__tests__/raw-css-secret-input-census.test.ts`.
*/

test.describe.configure({ mode: "serial" });

/** The PIN this spec types. Every digit distinct, so a prefix match is unambiguous. */
const PIN = "142536";

/** What the control rule paints when NO attribute selector matches. */
const CONTROL_OUTLINE = "rgb(7, 7, 7)";

/**
 * Probe rules appended to the club's Raw CSS. The first is a control: it must
 * apply, which is what proves Raw CSS really reaches this page and really targets
 * this element — without it every "no leak" assertion below could pass because the
 * stylesheet never arrived. The rest are the oracle: each only paints if the CSS
 * engine can see the typed value in a selectable attribute.
 */
const PROBE_CSS = [
  "input#hut-leader-pin { outline-color: rgb(7, 7, 7); }",
  'input#hut-leader-pin[value] { outline-color: rgb(8, 8, 8); }',
  'input#hut-leader-pin[value=""] { outline-color: rgb(9, 9, 9); }',
  'input#hut-leader-pin[value^="1"] { outline-color: rgb(1, 1, 1); }',
  'input#hut-leader-pin[value^="14"] { outline-color: rgb(2, 2, 2); }',
  'input#hut-leader-pin[value^="142"] { outline-color: rgb(3, 3, 3); }',
  'input#hut-leader-pin[value^="1425"] { outline-color: rgb(4, 4, 4); }',
  'input#hut-leader-pin[value^="14253"] { outline-color: rgb(5, 5, 5); }',
  'input#hut-leader-pin[value="142536"] { outline-color: rgb(6, 6, 6); }',
].join("\n");

/** Every prefix an attacker would walk, plus the two "is there a value at all" probes. */
const ORACLE_SELECTORS = [
  "input#hut-leader-pin[value]",
  'input#hut-leader-pin[value=""]',
  'input#hut-leader-pin[value^="1"]',
  'input#hut-leader-pin[value^="14"]',
  'input#hut-leader-pin[value^="142"]',
  'input#hut-leader-pin[value^="1425"]',
  'input#hut-leader-pin[value^="14253"]',
  'input#hut-leader-pin[value="142536"]',
];

type ThemeValues = {
  brandGold: string;
  brandDeep: string;
  brandSafety: string;
  headingFontKey: string;
  bodyFontKey: string;
  logoUrl: string | null;
  logoDataUrl: string | null;
  rawCss: string;
};

let admin: APIRequestContext;
let originalTheme: ThemeValues;

async function readTheme(request: APIRequestContext): Promise<ThemeValues> {
  const res = await request.get("/api/admin/site-style");
  expect(res.ok(), `GET /api/admin/site-style (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { theme: ThemeValues };
  return body.theme;
}

async function writeRawCss(
  request: APIRequestContext,
  base: ThemeValues,
  rawCss: string,
): Promise<void> {
  const res = await request.put("/api/admin/site-style", {
    data: {
      brandGold: base.brandGold,
      brandDeep: base.brandDeep,
      brandSafety: base.brandSafety,
      headingFontKey: base.headingFontKey,
      bodyFontKey: base.bodyFontKey,
      logoUrl: base.logoUrl ?? "",
      logoDataUrl: base.logoDataUrl ?? "",
      rawCss,
    },
  });
  expect(res.ok(), `PUT /api/admin/site-style (${res.status()})`).toBeTruthy();
}

/** One observation of the field, across all three layers the issue asks about. */
async function observe(page: Page) {
  return page.evaluate((selectors: string[]) => {
    const el = document.querySelector<HTMLInputElement>("input#hut-leader-pin");
    if (!el) throw new Error("input#hut-leader-pin is not in the document");
    return {
      property: el.value,
      attribute: el.getAttribute("value"),
      defaultValue: el.defaultValue,
      matched: selectors.filter(
        (selector) => document.querySelector(selector) !== null,
      ),
      outlineColor: getComputedStyle(el).outlineColor,
    };
  }, ORACLE_SELECTORS);
}

/**
 * The whole assertion, in one place: the secret is in the property and NOWHERE a
 * selector can reach. `expectedProperty` keeps it from passing vacuously on a page
 * that simply stopped accepting input.
 */
async function expectNoSelectableSecret(page: Page, expectedProperty: string) {
  const seen = await observe(page);
  expect(seen.property).toBe(expectedProperty);
  expect(seen.attribute).toBeNull();
  expect(seen.defaultValue).toBe("");
  expect(seen.matched).toEqual([]);
  // The control rule still wins, which is both "no oracle matched" and "the Raw
  // CSS is still live on this page".
  //
  // Treat this as the SECONDARY oracle, not the primary one. Measured on the
  // mutated build (#2981, 14 Sep 2026): while a controlled input was leaking,
  // `querySelector` matched every growing prefix immediately but the computed
  // colour lagged a keystroke behind — Chromium does not always recompute style
  // the instant react-dom rewrites the attribute. So a computed-style check alone
  // could under-report a real leak. The attribute and selector assertions above
  // are exact and never lag; this line's job is to prove the stylesheet arrived.
  expect(seen.outlineColor).toBe(CONTROL_OUTLINE);
}

test.beforeAll(async ({ playwright, baseURL }) => {
  admin = await playwright.request.newContext({
    baseURL,
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  originalTheme = await readTheme(admin);
  await writeRawCss(
    admin,
    originalTheme,
    `${originalTheme.rawCss}\n${PROBE_CSS}`.trim(),
  );
});

test.afterAll(async () => {
  if (originalTheme) {
    await writeRawCss(admin, originalTheme, originalTheme.rawCss).catch(() => {});
  }
  await admin.dispose();
});

test.describe("kiosk PIN entry under administrator Raw CSS", () => {
  // Anonymous: this is the page a hut leader opens from their assignment email.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("no typed PIN character is ever selectable by a stylesheet", async ({
    page,
  }) => {
    // `?a=` only has to be PRESENT for the PIN form to render — the reference is
    // checked by the API, not by the client — so this spec needs no live
    // assignment and cannot be broken by seed drift.
    await page.goto("/hut-leader-instructions?a=e2e-2981-assignment");

    const field = page.locator("input#hut-leader-pin");
    await expect(field).toBeVisible();

    // Positive control FIRST. If Raw CSS were not reaching this page, every
    // assertion after it would be meaningless.
    expect((await observe(page)).outlineColor).toBe(CONTROL_OUTLINE);
    await expectNoSelectableSecret(page, "");

    // Keystroke by keystroke — the exact walk an oracle performs.
    await field.click();
    for (const [index, character] of [...PIN].entries()) {
      await page.keyboard.type(character);
      await expectNoSelectableSecret(page, PIN.slice(0, index + 1));
    }

    // The submit control still tracks the value, so the secret really is reaching
    // the application — this is what stops the fix being "the field stopped
    // working".
    const submit = page.getByRole("button", { name: "View instructions" });
    await expect(submit).toBeEnabled();

    // Paste.
    await field.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expectNoSelectableSecret(page, "");
    await page.keyboard.insertText(PIN);
    await expectNoSelectableSecret(page, PIN);

    // Edit in the middle (backspace then retype) — a rerender path with a caret
    // that is not at the end.
    await page.keyboard.press("Backspace");
    await expectNoSelectableSecret(page, PIN.slice(0, -1));
    await page.keyboard.type(PIN.slice(-1));
    await expectNoSelectableSecret(page, PIN);

    // Submit: the reference is not a real assignment, so the API refuses and the
    // component rerenders with an error. A rerender is the moment a controlled
    // input would rewrite the attribute, so this is the important one.
    await submit.click();
    // The exact refusal is the 401 ("That link and PIN don't match"); the regex
    // keeps the pin about the RERENDER rather than about which refusal arrived.
    await expect(
      page.getByText(/don't match|went wrong|Too many attempts/),
    ).toBeVisible();
    await expectNoSelectableSecret(page, PIN);

    // Clear.
    await field.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expectNoSelectableSecret(page, "");
  });

  test("the input filter still rejects non-digits and caps the length", async ({
    page,
  }) => {
    await page.goto("/hut-leader-instructions?a=e2e-2981-assignment");
    const field = page.locator("input#hut-leader-pin");
    await expect(field).toBeVisible();

    await field.click();
    await page.keyboard.type("1a2b3c4d5e6f7g8h");
    // Digits only, six at most — and the rejected characters must not have leaked
    // into a selectable attribute on the way through either.
    await expectNoSelectableSecret(page, "123456");
  });
});
