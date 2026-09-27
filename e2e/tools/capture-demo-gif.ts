#!/usr/bin/env -S pnpm exec tsx
/**
 * README booking-flow demo GIF (issue #2076).
 *
 * Drives the real member booking wizard against the seeded staging stack and
 * assembles a step-by-step animated GIF for the repository front page:
 *
 *   docs/images/readme/demo-booking.gif
 *
 * The walk is dates → guests → review, as the demo member Alice (the same
 * PAID-subscription booker persona the E2E suite uses). It deliberately stops
 * ON the review step — nothing is confirmed, so no booking, payment, or Xero
 * activity is created and the run is repeatable without a reseed.
 *
 * ## Prerequisites (same seeded stack as the E2E suite)
 *
 *   pnpm run test:e2e:prepare      # boots + seeds the staging stack
 *   pnpm run docs:demo-gif         # capture and assemble the GIF
 *
 * Environment:
 *   E2E_BASE_URL   target app (default http://localhost:3001, matching E2E)
 *
 * Safety and privacy (docs/STYLE_GUIDE.md → "Screenshot conventions"): only
 * ever point this at the local, ephemeral seeded staging stack — never a live
 * deployment. Frames may only ever show demo-seed data.
 *
 * Output is overwritten in place (stable filename, a refresh is a diff). The
 * stay window comes from the E2E `stayWindow(0)` helper, so the calendar dates
 * shown drift with the run date — that is expected and fine for a demo.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginPersona } from "../helpers/auth";
import {
  completeMemberDetailsGateIfShown,
  selectCalendarDay,
} from "../helpers/booking";
import { personas } from "../helpers/personas";
import { stayWindow } from "../helpers/stay-dates";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3001";
const OUT_PATH = path.resolve(
  path.join(import.meta.dirname, "..", "..", "docs", "images", "readme", "demo-booking.gif"),
);

const VIEWPORT = { width: 1280, height: 800 } as const;
const GIF_WIDTH = 960;
/** Per-frame hold in milliseconds (sharp .gif delay). */
const HOLD = 1_600;
const HOLD_LONG = 2_600;

// Same deliberate overlay hide as capture-screenshots.ts: the floating
// "Report issue" widget is not part of any documented feature.
const HIDE_OVERLAYS_CSS =
  '[data-report-issue-ignore="true"] { display: none !important; }';

const frames: Buffer[] = [];
const delays: number[] = [];

async function snap(page: Page, label: string, hold = HOLD): Promise<void> {
  // Let fonts and the just-interacted UI settle so no frame catches a
  // mid-transition paint.
  await Promise.race([
    page.evaluate(() => document.fonts.ready.then(() => undefined)),
    page.waitForTimeout(2_000),
  ]);
  await page.waitForTimeout(450);
  await page.addStyleTag({ content: HIDE_OVERLAYS_CSS }).catch(() => undefined);
  frames.push(await page.screenshot({ type: "png" }));
  delays.push(hold);
  console.log(`  frame ${frames.length}: ${label}`);
}

async function main(): Promise<void> {
  const persona = personas.booker;
  const stay = stayWindow(0);
  console.log(
    `Capturing booking demo as ${persona.email} for ${stay.checkIn} -> ${stay.checkOut} against ${BASE_URL}`,
  );

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await loginPersona(page, persona.email);

    await page.goto("/book", { waitUntil: "load", timeout: 30_000 });
    await completeMemberDetailsGateIfShown(page);
    await page.getByText("Select Your Dates").waitFor({ state: "visible", timeout: 15_000 });
    await snap(page, "dates step (calendar)", HOLD_LONG);

    await selectCalendarDay(page, stay.checkIn);
    await snap(page, "check-in selected");

    await selectCalendarDay(page, stay.checkOut);
    await snap(page, "stay range selected");

    await page.getByRole("button", { name: "Continue", exact: true }).click();
    // The booker is pre-selected once the family list loads (#1680) — and with
    // the booker as the only guest the wizard can auto-advance straight to the
    // review step, so the guests frame is best-effort and the review wait
    // accepts either path (auto-advance or an explicit Continue).
    const addedSelf = page.getByRole("button", {
      name: `✓ ${persona.firstName} ${persona.lastName} (You)`,
    });
    const addedSelfShown = await addedSelf
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (addedSelfShown) {
      await snap(page, "guests step (booker pre-selected)");
    }
    const summary = page.getByText("Booking Summary");
    if (!(await summary.isVisible().catch(() => false))) {
      const guestsContinue = page.getByRole("button", { name: "Continue", exact: true });
      if (await guestsContinue.isVisible().catch(() => false)) {
        await guestsContinue.click();
      }
    }
    // The review viewport shows the priced summary AND the payment-method
    // choice (card vs Internet Banking) in one frame — the flow stops here;
    // the booking is never confirmed.
    await summary.waitFor({ state: "visible", timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap(page, "review step (summary, price, payment options)", HOLD_LONG + 1_000);

    await context.close();
  } finally {
    await browser.close();
  }

  console.log(`Assembling ${frames.length} frames…`);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  // Resize each frame BEFORE the animated join: a .resize() applied after the
  // join flattens the multi-page image back to a single frame.
  const resized = await Promise.all(
    frames.map((f) => sharp(f).resize({ width: GIF_WIDTH }).png().toBuffer()),
  );
  // Encode to a buffer and enforce the size budget BEFORE writing, so an
  // oversized result never lands in the tree.
  const gif = await sharp(resized, { join: { animated: true } })
    .gif({ delay: delays.map((d) => Math.round(d / 10) * 10), loop: 0, effort: 7 })
    .toBuffer();
  const kb = Math.round(gif.length / 1024);
  if (kb > 5 * 1024) {
    console.error(`GIF is ${kb} KB — exceeds the 5 MB budget; reduce frames or width. Not written.`);
    process.exit(1);
  }
  fs.writeFileSync(OUT_PATH, gif);
  const rel = path.relative(process.cwd(), OUT_PATH).replace(/\\/g, "/");
  console.log(`wrote ${rel} (${GIF_WIDTH}px wide, ${frames.length} frames, ${kb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
