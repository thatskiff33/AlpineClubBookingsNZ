import { test, expect } from "../../e2e/helpers/accessibility";

const good = '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Ready</h1><a href="/next">Next</a></main></body></html>';
const bad = good.replace("<h1>Ready</h1>", '<h1>Ready</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">');

test("a clean page passes and locator chaining still works", async ({ page }) => {
  await page.route("https://fixture.test/**", (route) => route.fulfill({ contentType: "text/html", body: good }));
  await page.goto("https://fixture.test/good");
  await expect(page.getByRole("main").getByRole("heading")).toHaveText("Ready");
  await page.getByRole("main").getByRole("link").first().click();
  await expect(page).toHaveURL("https://fixture.test/next");
});

for (const manualContext of [false, true]) {
  test(`axe catches a violation before leaving a page (manual context: ${manualContext})`, async ({ browser, page }) => {
    test.fail(true, "The fixture must fail at teardown and attach image-alt evidence");
    const context = manualContext ? await browser.newContext() : page.context();
    const target = manualContext ? await context.newPage() : page;
    await target.route("https://fixture.test/**", (route) => route.fulfill({
      contentType: "text/html", body: route.request().url().endsWith("/bad") ? bad : good,
    }));
    await target.goto("https://fixture.test/bad");
    await expect(target.getByRole("heading")).toHaveText("Ready");
    await target.goto("https://fixture.test/good");
    await target.close();
    if (manualContext) await context.close();
  });
}

test("axe audits a popup before it closes", async ({ page }) => {
  test.fail(true, "Popup must attach the image-alt violation");
  await page.context().route("https://fixture.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: route.request().url().endsWith("/bad") ? bad : good.replace('href="/next"', 'href="/bad" target="_blank"'),
  }));
  await page.goto("https://fixture.test/good");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link").click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading")).toHaveText("Ready");
  await popup.close();
});

test("axe audits a client-side destination before the next action", async ({ page }) => {
  test.fail(true, "Client navigation must attach the image-alt violation");
  await page.route("https://fixture.test/**", (route) => route.fulfill({ contentType: "text/html", body: good }));
  await page.goto("https://fixture.test/good");
  await page.getByRole("link").click();
  await expect(page).toHaveURL("https://fixture.test/next");
  await page.evaluate((html) => {
    history.pushState(null, "", "/bad");
    document.documentElement.innerHTML = html;
  }, bad);
  await expect(page.getByRole("heading")).toHaveText("Ready");
  await page.getByRole("link").click();
  await expect(page).toHaveURL("https://fixture.test/next");
});

test("axe audits both pages when actions run concurrently", async ({ context }) => {
  test.fail(true, "Concurrent navigation must attach the image-alt violation");
  await context.route("https://fixture.test/**", (route) => route.fulfill({
    contentType: "text/html", body: route.request().url().endsWith("/bad") ? bad : good,
  }));
  const clean = await context.newPage();
  const broken = await context.newPage();
  await clean.goto("https://fixture.test/good");
  await broken.goto("https://fixture.test/bad");
  await Promise.all([clean.getByRole("link").click(), broken.getByRole("link").click()]);
  await expect(broken).toHaveURL("https://fixture.test/next");
});

test("axe audits a changed wizard step at the same URL", async ({ page }) => {
  test.fail(true, "A later wizard step must attach the image-alt violation");
  await page.route("https://fixture.test/**", (route) => route.fulfill({ contentType: "text/html", body: good }));
  await page.goto("https://fixture.test/flow");
  await page.evaluate((html) => {
    const link = document.querySelector("a")!;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      document.documentElement.innerHTML = html;
    }, { once: true });
  }, bad);
  await page.getByRole("link").click();
  await expect(page).toHaveURL("https://fixture.test/flow");
  await page.getByRole("link").click();
  await expect(page).toHaveURL("https://fixture.test/next");
});
