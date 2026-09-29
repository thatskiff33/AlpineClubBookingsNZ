import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Companion to `scripts/ci/check-prerendered-script-nonces.mjs` (#2356), and the
 * mirror of the same guard on `/display` (`display-screen.test.ts`, fork #54).
 *
 * The CI script is the real gate — it inspects the emitted build — but it needs
 * a full `pnpm run build` to run. This runs in the unit suite, so deleting the
 * export fails in seconds instead of at the end of CI.
 */
describe("global not-found render mode", () => {
  it("forces dynamic rendering so inline scripts carry the CSP nonce (issue #2356)", async () => {
    // Prerendered, this route ships Next's inline bootstrap scripts with no
    // nonce and the production nonce-only CSP blocks every one of them. It also
    // freezes the build-time render: no database, so the admin-authored /404 CMS
    // page can never appear and the club name falls back to the template
    // placeholder.
    const notFound = await import("@/app/not-found");
    expect(notFound.dynamic).toBe("force-dynamic");
  });
});
