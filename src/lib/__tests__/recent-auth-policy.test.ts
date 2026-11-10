/**
 * #4616 (INV-AUTH-008): the pure recent-authentication rules, on the frozen
 * clock. The end-to-end proof through the Auth.js handler is
 * `auth-recent-auth-claim.test.ts`; the guard's HTTP shape is
 * `recent-auth.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  RECENT_AUTH_REQUIRED_CODE,
  RECENT_AUTH_WINDOW_MS,
  hasAuthenticatorApp,
  isRecentAuthRefusal,
  isRecentlyAuthenticated,
  recentAuthRequiredBody,
  resolveStepUpMethods,
} from "@/lib/recent-auth-policy";

const SECOND_MS = 1000;

describe("the recent-authentication window (#4616)", () => {
  it("is five minutes, a fixed floor", () => {
    expect(RECENT_AUTH_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it("counts a proof made now, and one exactly five minutes old, as recent", () => {
    const now = Date.now();
    expect(isRecentlyAuthenticated(now, now)).toBe(true);
    expect(isRecentlyAuthenticated(now - 4 * 60 * SECOND_MS - 59 * SECOND_MS, now)).toBe(true);
    expect(isRecentlyAuthenticated(now - RECENT_AUTH_WINDOW_MS, now)).toBe(true);
  });

  it("refuses a proof five minutes and one second old, and one a millisecond past the window", () => {
    const now = Date.now();
    expect(isRecentlyAuthenticated(now - RECENT_AUTH_WINDOW_MS - SECOND_MS, now)).toBe(false);
    expect(isRecentlyAuthenticated(now - RECENT_AUTH_WINDOW_MS - 1, now)).toBe(false);
    expect(isRecentlyAuthenticated(now - 7 * 24 * 60 * 60 * SECOND_MS, now)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", String(Date.now())],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("fails closed on a %s stamp", (_label, stamp) => {
    expect(isRecentlyAuthenticated(stamp, Date.now())).toBe(false);
  });

  it("never counts a stamp from the future, however near", () => {
    const now = Date.now();
    expect(isRecentlyAuthenticated(now + 1, now)).toBe(false);
    expect(isRecentlyAuthenticated(now + RECENT_AUTH_WINDOW_MS, now)).toBe(false);
  });
});

describe("which step-up method a person uses (#4616)", () => {
  const app = { twoFactorEnabled: true, twoFactorMethod: "TOTP" as const, totpSecret: "v2:k:iv:tag:ct" };

  it("asks for the app code when the person has an authenticator app", () => {
    expect(hasAuthenticatorApp(app)).toBe(true);
    expect(resolveStepUpMethods(app)).toEqual(["TOTP"]);
  });

  it("asks for the password when the person has no app: emailed codes never count", () => {
    const emailed = { twoFactorEnabled: true, twoFactorMethod: "EMAIL" as const, totpSecret: null };
    const none = { twoFactorEnabled: false, twoFactorMethod: null, totpSecret: null };
    expect(hasAuthenticatorApp(emailed)).toBe(false);
    expect(resolveStepUpMethods(emailed)).toEqual(["PASSWORD"]);
    expect(resolveStepUpMethods(none)).toEqual(["PASSWORD"]);
  });

  it("does not count an app that is switched off or has no stored secret", () => {
    expect(hasAuthenticatorApp({ ...app, twoFactorEnabled: false })).toBe(false);
    expect(hasAuthenticatorApp({ ...app, totpSecret: null })).toBe(false);
    expect(hasAuthenticatorApp({ ...app, totpSecret: "" })).toBe(false);
  });

  it("never offers an emailed or recovery code", () => {
    for (const member of [
      app,
      { twoFactorEnabled: true, twoFactorMethod: "EMAIL" as const, totpSecret: null },
    ]) {
      const methods: string[] = resolveStepUpMethods(member);
      expect(methods).not.toContain("EMAIL");
      expect(methods).not.toContain("RECOVERY");
    }
  });
});

describe("recognising the refusal (#4616)", () => {
  it("recognises requireRecentAuth's body at its status, and leaves the body readable", async () => {
    const refusal = Response.json(recentAuthRequiredBody(), { status: 403 });
    expect(await isRecentAuthRefusal(refusal)).toBe(true);
    expect(await refusal.json()).toEqual({
      error: "Please confirm it's you to continue.",
      code: RECENT_AUTH_REQUIRED_CODE,
    });
  });

  it("does not mistake another 403, the code at another status, or a non-JSON body", async () => {
    expect(await isRecentAuthRefusal(Response.json({ error: "Forbidden" }, { status: 403 }))).toBe(false);
    expect(await isRecentAuthRefusal(Response.json(recentAuthRequiredBody(), { status: 401 }))).toBe(false);
    expect(await isRecentAuthRefusal(Response.json(recentAuthRequiredBody(), { status: 200 }))).toBe(false);
    expect(await isRecentAuthRefusal(new Response("nope", { status: 403 }))).toBe(false);
  });
});
