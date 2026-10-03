const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const worktree = path.resolve(process.argv[2] || '');
const base = new URL(process.argv[3] || 'htt[historical local path omitted]');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Loopback only');
const req = createRequire(path.join(worktree, 'package.json'));
const { chromium } = req('@playwright/test');
const out = path.join(__dirname, 'evidence');
fs.mkdirSync(out, { recursive: true });
const caseFilter = new RegExp(process.argv[4] || '.*');
const reportFile = path.join(out, process.argv[5] || 'report.json');
const report = { sha: '7ce3bb1eaa65e45e32185cefc7af93400ab2d763', base: base.href, cases: [], failures: [], limitations: ['Synthetic data and loopback fetch mocks; no app authentication, database or provider integration is asserted.', 'Chromium touch emulation proves geometry and touch dispatch; no physical device or OS decimal keyboard is asserted.'] };

async function caseRun(name, fn) {
  if (!caseFilter.test(name)) return;
  try { const detail = await fn(); report.cases.push({ name, status: 'pass', detail }); }
  catch (error) { report.failures.push({ name, error: String(error), stack: error.stack }); }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
}
async function valueIs(input, value) { assert.equal(await input.inputValue(), value); }
// This advisory query uses POST for its array payload, but writes no data.
async function writes(page) { return page.evaluate(() => window.__uiEvidence.events.filter(event => event.method !== 'GET' && !event.path.endsWith('/link-conflicts'))); }
async function verifyClean(page) {
  const evidence = await page.evaluate(() => window.__uiEvidence);
  assert.equal(evidence.sha, report.sha);
  assert.deepEqual(evidence.unexpected, []);
  assert.deepEqual(evidence.errors, []);
  return evidence;
}
async function open(page, surface, view = '') {
  await page.goto(new URL(`/${surface}${view ? '?view=' + view : ''}`, base).href);
  await page.waitForFunction(() => window.__uiEvidence);
  if (surface === 'fees') await page.getByRole('heading', { name: 'Winter UI fixture' }).waitFor();
  if (surface === 'quotes') {
    if (view === 'readonly') await page.getByText('Synthetic School', { exact: true }).first().waitFor();
    else await page.locator('[id="pricing-mode-ui-school"]').waitFor();
  }
  if (surface === 'refund') await page.getByRole('button', { name: 'Request Refund Appeal' }).waitFor();
  await verifyClean(page);
}
async function geometry(page, name) {
  const metrics = await page.locator('input[inputmode="decimal"]').evaluateAll(inputs => {
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return inputs.map(input => {
      const group = input.parentElement;
      const field = group.parentElement;
      const boxes = [input, ...group.querySelectorAll('button')];
      const bounds = rect(field);
      const checks = boxes.map(element => {
        const r = rect(element);
        const centerX = (r.left + r.right) / 2;
        const centerY = (r.top + r.bottom) / 2;
        const visible = centerX >= 0 && centerX < innerWidth && centerY >= 0 && centerY < innerHeight;
        const hit = visible ? document.elementFromPoint(centerX, centerY) : null;
        return { tag: element.tagName, name: element.getAttribute('aria-label') || input.labels?.[0]?.textContent?.trim(), disabled: element.disabled, readOnly: element.readOnly, rect: r, exceedsField: r.left < bounds.left - 1 || r.right > bounds.right + 1, visibleCenterObstructed: visible && hit !== element && !element.contains(hit), minTouchTarget: r.width >= 24 && r.height >= 24, clipping: [] };
      });
      for (const check of checks) {
        for (let ancestor = group; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
          const css = getComputedStyle(ancestor); const r = rect(ancestor);
          if (['hidden', 'clip'].includes(css.overflowX) && (check.rect.left < r.left - 1 || check.rect.right > r.right + 1)) check.clipping.push({ axis: 'x', ancestor: ancestor.tagName, className: ancestor.className });
          if (['hidden', 'clip'].includes(css.overflowY) && (check.rect.top < r.top - 1 || check.rect.bottom > r.bottom + 1)) check.clipping.push({ axis: 'y', ancestor: ancestor.tagName, className: ancestor.className });
        }
      }
      return { id: input.id, value: input.value, field: bounds, checks };
    });
  });
  const horizontalOverflow = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  const suspicious = metrics.filter(field => field.checks.some(check => check.exceedsField || check.visibleCenterObstructed || check.clipping.length || (check.tag === 'BUTTON' && !check.minTouchTarget)));
  return { screenshot: `${name}.png`, horizontalOverflow, metrics, suspicious };
}
async function dollarActions(page, input, touch) {
  await input.fill('12.34');
  await input.press('ArrowUp'); await valueIs(input, '13.34');
  await input.press('ArrowDown'); await valueIs(input, '12.34');
  const group = input.locator('..');
  const up = group.getByRole('button', { name: /^Increase / });
  const down = group.getByRole('button', { name: /^Decrease / });
  if (touch) { await up.tap(); await valueIs(input, '13.34'); await down.tap(); await valueIs(input, '12.34'); }
  else {
    await input.focus(); await input.press('Tab'); assert.equal(await up.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Space'); await valueIs(input, '13.34');
    await page.keyboard.press('Tab'); assert.equal(await down.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Enter'); await valueIs(input, '12.34');
  }
  await input.fill('12.345'); await valueIs(input, '12.34');
  await input.fill('12.34x'); await valueIs(input, '12.34x');
  assert.equal(await up.isDisabled(), true); assert.equal(await down.isDisabled(), true);
  await input.press('ArrowUp'); await valueIs(input, '12.34x');
  await input.fill('0'); assert.equal(await down.isDisabled(), true);
  await input.fill('21474836.47'); assert.equal(await up.isDisabled(), true);
  await input.fill('12.34');
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const device of [{ name: 'desktop', viewport: { width: 1280, height: 900 }, touch: false }, { name: 'mobile', viewport: { width: 390, height: 844 }, touch: true }]) {
      const context = await browser.newContext({ viewport: device.viewport, hasTouch: device.touch, isMobile: device.touch, deviceScaleFactor: 1 });
      await context.addInitScript(() => {
        const OriginalDate = Date;
        const fixed = OriginalDate.parse('2026-07-01T00:00:00.000Z');
        class FrozenDate extends OriginalDate { constructor(...args) { if (args.length) super(...args); else super(fixed); } static now() { return fixed; } }
        window.Date = FrozenDate;
      });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== base.origin && !url.href.startsWith('data:')) return route.abort('blockedbyclient');
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.failures.push({ name: `${device.name}:pageerror`, error: String(error) }));
      await caseRun(`${device.name}:actual hut fee form`, async () => {
        await open(page, 'fees');
        await page.getByRole('button', { name: 'Edit Winter UI fixture', exact: true }).click();
        const input = page.locator('input[inputmode="decimal"]').first();
        await input.waitFor();
        const prior = await writes(page);
        await dollarActions(page, input, device.touch);
        assert.deepEqual(await writes(page), prior, 'Dollar controls must not submit the actual season form');
        const layout = await geometry(page, `${device.name}-fees-hut`);
        await verifyClean(page);
        return layout;
      });
      await caseRun(`${device.name}:actual joining and annual fee grids`, async () => {
        await open(page, 'fees');
        await page.getByRole('button', { name: 'Edit joining fees', exact: true }).click();
        await dollarActions(page, page.locator('#entrance-amount'), device.touch);
        await page.getByRole('button', { name: 'Edit membership fees', exact: true }).click();
        await page.locator('#membership-amount').fill('250.50');
        const mirror = page.locator('#component-amount-0');
        assert.equal(await mirror.isDisabled(), true);
        assert.equal(await mirror.locator('..').getByRole('button', { name: /^Increase / }).isDisabled(), true);
        await page.getByRole('button', { name: 'Add component', exact: true }).click();
        await page.locator('#component-amount-0').fill('200.25');
        await page.locator('#component-amount-1').fill('50.25');
        const layout = await geometry(page, `${device.name}-fees-finance`);
        assert.deepEqual(await writes(page), []);
        await verifyClean(page);
        return layout;
      });
      await caseRun(`${device.name}:actual quote total and dense rates`, async () => {
        await open(page, 'quotes');
        const input = page.locator('[id="price-ui-school-CATERED"]');
        await dollarActions(page, input, device.touch);
        const total = await geometry(page, `${device.name}-quotes-totals`);
        await page.locator('[id="pricing-mode-ui-school"]').click();
        await page.getByRole('option', { name: 'Per guest-night', exact: true }).click();
        const rates = page.locator('input[inputmode="decimal"]');
        assert.ok(await rates.count() >= 6, 'Dense actual quote rate controls are rendered');
        await dollarActions(page, rates.first(), device.touch);
        const dense = await geometry(page, `${device.name}-quotes-rates`);
        assert.deepEqual(await writes(page), []);
        await verifyClean(page);
        return { total, dense };
      });
      await caseRun(`${device.name}:actual public refund appeal`, async () => {
        await open(page, 'refund');
        await page.getByRole('button', { name: 'Request Refund Appeal', exact: true }).click();
        const input = page.locator('#amount');
        await dollarActions(page, input, device.touch);
        const layout = await geometry(page, `${device.name}-refund`);
        assert.deepEqual(await writes(page), []);
        await page.locator('#reason').fill('Synthetic requested refund reason.');
        await input.fill('45.67');
        await page.getByRole('button', { name: 'Submit Appeal', exact: true }).click();
        await page.getByText(/pending review/).waitFor();
        const posted = await writes(page);
        assert.equal(posted.length, 1); assert.equal(posted[0].body.requestedAmountCents, 4567);
        await verifyClean(page);
        return { layout, submitted: posted[0] };
      });
      await caseRun(`${device.name}:actual consumer read-only gates`, async () => {
        await open(page, 'fees', 'readonly');
        assert.equal(await page.getByRole('button', { name: 'Edit Winter UI fixture', exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Edit joining fees', exact: true }).count(), 0);
        await open(page, 'quotes', 'readonly');
        assert.equal(await page.locator('input[inputmode="decimal"]').count(), 0, 'Actual view-only panel hides its quote editor');
        await verifyClean(page);
        await open(page, 'quotes', 'blocked');
        const inputs = page.locator('input[inputmode="decimal"]');
        assert.ok(await inputs.count() > 0);
        for (const input of await inputs.all()) { assert.equal(await input.isDisabled(), true); for (const button of await input.locator('..').getByRole('button').all()) assert.equal(await button.isDisabled(), true); }
        const layout = await geometry(page, `${device.name}-quotes-readonly`);
        assert.deepEqual(await writes(page), []);
        await verifyClean(page);
        return layout;
      });
      await caseRun(`${device.name}:supplementary signed/read-only/form boundaries`, async () => {
        await open(page, 'boundary');
        const normal = page.getByRole('textbox', { name: 'Form amount', exact: true });
        await dollarActions(page, normal, device.touch);
        assert.equal(await page.evaluate(() => window.__uiEvidence.submissions), 0);
        const signed = page.getByRole('textbox', { name: 'Signed adjustment', exact: true });
        await signed.press('ArrowUp'); await valueIs(signed, '-0.50');
        await signed.press('ArrowUp'); await valueIs(signed, '0.50');
        await signed.press('ArrowDown'); await valueIs(signed, '-0.50');
        for (const label of ['Disabled amount', 'Read only amount']) {
          const input = page.getByRole('textbox', { name: label, exact: true });
          for (const button of await input.locator('..').getByRole('button').all()) assert.equal(await button.isDisabled(), true);
          if (label.startsWith('Read')) { await input.press('ArrowUp'); await valueIs(input, '12.34'); }
        }
        await page.getByRole('button', { name: 'Explicit fixture submit', exact: true }).click();
        assert.equal(await page.evaluate(() => window.__uiEvidence.submissions), 1);
        await verifyClean(page);
        return geometry(page, `${device.name}-boundary`);
      });
      await context.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ sha: report.sha, passed: report.cases.length, failures: report.failures, report: reportFile }, null, 2));
  process.exitCode = report.failures.length ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });

