import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { HUT_LEADER_PIN_LENGTH } from "@/lib/hut-leader-pin";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import {
  readClubTheme,
  writeClubRawCss,
  type AdminClubTheme,
} from "./helpers/site-style";

/*
  The kiosk PIN must not be readable by administrator Raw CSS (#2981).

  Rule, mechanism, browser evidence and scope: `docs/SECURITY.md` -> "Secret
  entry on pages that carry Raw CSS". Not restated here.

  ## Why this can only be a browser test

  The property/attribute distinction is a browser and react-dom runtime fact, and
  the selector half is a CSS-engine fact. Neither is observable from a source scan
  and neither is trustworthy from jsdom, which is the whole reason this issue's
  first evidence had to be re-taken. The oracle is the DOM attribute plus live
  `querySelector` matching, with computed style as a secondary check; no remote
  beacon is needed and none is used, so nothing leaves the machine.

  The static half — which fields are owed this, and that `SecretInput` still
  passes no value into the DOM — is
  `src/lib/__tests__/raw-css-secret-input-census.test.ts`. The filtering and caret
  half is `src/components/ui/__tests__/secret-input.test.tsx`.
*/

test.describe.configure({ mode: "serial" });

/** The PIN this spec types. Every digit distinct, so a prefix match is unambiguous. */
const PIN = "142536";

/** What the control rule paints when NO attribute selector matches. */
const CONTROL_OUTLINE = "rgb(7, 7, 7)";

/** Each growing prefix of the PIN: the exact walk an oracle performs. */
const PIN_PREFIXES = [...PIN].map((_, index) => PIN.slice(0, index + 1));

/**
 * Probe rules appended to the club's Raw CSS, derived from `PIN` so the ladder
 * cannot drift from the value typed below.
 *
 * The first rule is a control: it must apply, which is what proves Raw CSS really
 * reaches this page and really targets this element — without it every "no leak"
 * assertion could pass because the stylesheet never arrived. The rest are the
 * oracle: each only paints if the CSS engine can see the typed value in a
 * selectable attribute.
 */
const PROBE_CSS = [
  `input#hut-leader-pin { outline-color: ${CONTROL_OUTLINE}; }`,
  "input#hut-leader-pin[value] { outline-color: rgb(8, 8, 8); }",
  'input#hut-leader-pin[value=""] { outline-color: rgb(9, 9, 9); }',
  ...PIN_PREFIXES.map(
    (prefix, index) =>
      `input#hut-leader-pin[value^="${prefix}"] { outline-color: rgb(${index + 1}, ${index + 1}, ${index + 1}); }`,
  ),
  `input#hut-leader-pin[value="${PIN}"] { outline-color: rgb(0, 100, 0); }`,
].join("\n");

/** Every selector those rules key on, in the same order. */
const ORACLE_SELECTORS = [
  "input#hut-leader-pin[value]",
  'input#hut-leader-pin[value=""]',
  ...PIN_PREFIXES.map((prefix) => `input#hut-leader-pin[value^="${prefix}"]`),
  `input#hut-leader-pin[value="${PIN}"]`,
];

let admin: APIRequestContext | undefined;
let originalTheme: AdminClubTheme | undefined;

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
  originalTheme = await readClubTheme(admin);
  await writeClubRawCss(
    admin,
    originalTheme,
    `${originalTheme.rawCss}\n${PROBE_CSS}`.trim(),
  );
});

test.afterAll(async () => {
  // The theme is club-wide state every other spec renders through, so a failed
  // restore is REPORTED rather than swallowed: leaving the probe rules behind
  // would otherwise surface as an unrelated spec failing for no visible reason.
  try {
    if (admin && originalTheme) {
      await writeClubRawCss(admin, originalTheme, originalTheme.rawCss);
    }
  } catch (error) {
    console.error(
      "[raw-css-secret-reflection] FAILED to restore the club's Raw CSS; the " +
        "probe rules are still saved on this stack.",
      error,
    );
    throw error;
  } finally {
    await admin?.dispose();
  }
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

    // Keystroke by keystroke.
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

    // A REAL mid-string edit: put the caret two characters from the end and type
    // a character the filter rejects. The value must not change, the caret must
    // not move, and — the point of this spec — nothing may become selectable in
    // the middle of that repair.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const caretBefore = await field.evaluate(
      (el: HTMLInputElement) => el.selectionStart,
    );
    expect(caretBefore).toBe(PIN.length - 2);
    await page.keyboard.type("a");
    await expectNoSelectableSecret(page, PIN);
    expect(
      await field.evaluate((el: HTMLInputElement) => el.selectionStart),
    ).toBe(caretBefore);

    // Backspace mid-string, then retype, so a rerender happens with the caret
    // away from the end.
    await page.keyboard.press("Backspace");
    await expectNoSelectableSecret(page, `${PIN.slice(0, 3)}${PIN.slice(4)}`);
    await page.keyboard.type(PIN[3] as string);
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
    // Twice as many digits as fit, each behind a letter the filter must drop.
    const digits = "12345678";
    await page.keyboard.type(
      [...digits].map((digit, index) => digit + "abcdefgh"[index]).join(""),
    );
    // Digits only, no longer than a PIN — and the rejected characters must not
    // have leaked into a selectable attribute on the way through either.
    await expectNoSelectableSecret(
      page,
      digits.slice(0, HUT_LEADER_PIN_LENGTH),
    );
  });
});
