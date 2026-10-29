import { test as setup } from "./helpers/accessibility";
import { loginPersona, signIn, storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { personas } from "./helpers/personas";

// Signs the booking persona in once (completing TOTP enrollment on a freshly
// seeded database) and saves the browser storage state for the booking and
// payment specs. The two-factor spec deliberately does not reuse this state —
// it drives login itself with its own persona.
setup("sign in booking persona", async ({ page }) => {
  await signIn(page, personas.booker);
  await page.context().storageState({ path: storageStatePath(personas.booker.email) });
});

// Signs the E2E full admin in ONCE and saves its storage state so every admin
// spec can reuse it via storageStatePath(E2E_ADMIN.email) instead of a fresh
// UI login. That collapses ~10 per-spec admin logins to this single one, giving
// rateLimiters.login (10 / 15 min, keyed per synthetic IP-per-email) ample
// headroom — the suite previously sat exactly at that ceiling and one extra
// admin spec would 429-stall the tail spec's beforeAll (#1779).
//
// loginPersona (not signIn) because a full admin may not land on /dashboard;
// the first login also enrolls TOTP on a clean database and stores the secret
// under e2e/.auth so this setup can re-run (the verify path) against a
// non-reseeded database without re-enrolling.
setup("sign in E2E admin", async ({ page }) => {
  await loginPersona(page, E2E_ADMIN.email);
  await page.context().storageState({ path: storageStatePath(E2E_ADMIN.email) });
});
