const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.join(path.resolve(process.argv[2]), 'package.json'));
const { chromium } = req('@playwright/test');
const base = new URL(process.argv[3] || 'htt[historical local path omitted]');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Loopback only');
const out = path.join(__dirname, 'evidence');
async function main() {
  const browser = await chromium.launch();
  const data = {};
  try {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await mobile.newPage();
    await page.goto(new URL('/fees', base).href);
    const edit = page.getByRole('button', { name: 'Edit Winter UI fixture', exact: true });
    await edit.waitFor();
    data.initialMoneyInputs = await page.locator('input[inputmode="decimal"]').count();
    data.before = await edit.evaluate(button => {
      const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
      return { viewportWidth: innerWidth, documentScrollWidth: document.documentElement.scrollWidth, button: rect(button), actionGroup: rect(button.parentElement), header: rect(button.parentElement.parentElement), headerClass: button.parentElement.parentElement.className, actionGroupClass: button.parentElement.className };
    });
    await page.screenshot({ path: path.join(out, 'mobile-fees-initial-header.png'), clip: { x: 0, y: 0, width: 390, height: 650 } });
    await edit.evaluate(button => button.parentElement.remove());
    data.afterRemovingOnlySavedSeasonActions = await page.evaluate(() => ({ viewportWidth: innerWidth, documentScrollWidth: document.documentElement.scrollWidth, moneyInputs: document.querySelectorAll('input[inputmode="decimal"]').length }));
    await page.screenshot({ path: path.join(out, 'mobile-fees-initial-without-season-actions.png'), clip: { x: 0, y: 0, width: 390, height: 650 } });
    await page.goto(new URL('/fees', base).href);
    await page.getByRole('button', { name: 'Edit joining fees', exact: true }).click();
    await page.locator('#entrance-amount').fill('12.34');
    await page.getByRole('region', { name: 'Joining fees', exact: true }).screenshot({ path: path.join(out, 'mobile-joining-fees-focus.png') });
    await page.goto(new URL('/refund', base).href);
    await page.getByRole('button', { name: 'Request Refund Appeal', exact: true }).click();
    await page.locator('#amount').fill('12.34');
    await page.locator('#amount').focus(); await page.keyboard.press('Tab');
    data.keyboardFocus = await page.evaluate(() => { const element = document.activeElement; const css = getComputedStyle(element); return { tag: element.tagName, label: element.getAttribute('aria-label'), outlineStyle: css.outlineStyle, outlineWidth: css.outlineWidth, outlineColor: css.outlineColor, boxShadow: css.boxShadow }; });
    await page.screenshot({ path: path.join(out, 'mobile-refund-keyboard-focus.png') });
    await mobile.close();
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const dp = await desktop.newPage();
    await dp.goto(new URL('/fees', base).href);
    await dp.getByRole('button', { name: 'Edit joining fees', exact: true }).click();
    await dp.locator('#entrance-amount').fill('12.34');
    await dp.locator('#entrance-amount').focus(); await dp.keyboard.press('Tab');
    await dp.getByRole('region', { name: 'Joining fees', exact: true }).screenshot({ path: path.join(out, 'desktop-joining-fees-focus.png') });
    await desktop.close();
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, 'focused-inspection.json'), JSON.stringify(data, null, 2));
  console.log(JSON.stringify(data, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

