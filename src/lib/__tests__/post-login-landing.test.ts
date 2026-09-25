import { describe, expect, it } from "vitest";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionInput,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
  ) as Record<string, AdminPermissionLevel>;
  return { ...base, ...overrides } as AdminPermissionMatrix;
}

function withMatrix(m: AdminPermissionMatrix): AdminPermissionInput {
  return { adminPermissionMatrix: m, canLogin: true };
}

// A Full-Admin-style matrix (overview editable → first accessible = dashboard).
const FULL_ADMIN = withMatrix(
  matrix({
    overview: "edit",
    bookings: "edit",
    membership: "edit",
    finance: "edit",
    lodge: "edit",
    content: "edit",
    support: "edit",
  }),
);

// An admin whose overview area is denied but who can still reach bookings — the
// case that makes a literal /admin/dashboard wrong (D-D3).
const BOOKINGS_ONLY_ADMIN = withMatrix(
  matrix({ overview: "none", bookings: "edit" }),
);

// A plain member — no accessible admin area.
const NON_ADMIN = withMatrix(matrix());

describe("resolvePostLoginLandingPath — role default (no preference)", () => {
  it("sends an admin to their first accessible admin page", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: null,
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/admin/dashboard");
  });

  it("sends an admin whose overview is denied to their first accessible page (no guard bounce)", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: null,
        permissionInput: BOOKINGS_ONLY_ADMIN,
      }),
    ).toBe("/admin/bookings");
  });

  it("keeps a non-admin on /dashboard", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: null,
        permissionInput: NON_ADMIN,
      }),
    ).toBe("/dashboard");
  });
});

describe("resolvePostLoginLandingPath — explicit preference", () => {
  it("MEMBER_DASHBOARD pins /dashboard even for an admin", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: "MEMBER_DASHBOARD",
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/dashboard");
  });

  it("ADMIN_DASHBOARD resolves to the first accessible admin page, not a literal /admin/dashboard", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: "ADMIN_DASHBOARD",
        permissionInput: BOOKINGS_ONLY_ADMIN,
      }),
    ).toBe("/admin/bookings");
  });

  it("a demoted admin holding a stale ADMIN_DASHBOARD preference lands safely on /dashboard", () => {
    expect(
      resolvePostLoginLandingPath({
        landingPreference: "ADMIN_DASHBOARD",
        permissionInput: NON_ADMIN,
      }),
    ).toBe("/dashboard");
  });

  it("a non-admin with any preference stays on /dashboard", () => {
    for (const pref of [null, "MEMBER_DASHBOARD", "ADMIN_DASHBOARD"] as const) {
      expect(
        resolvePostLoginLandingPath({
          landingPreference: pref,
          permissionInput: NON_ADMIN,
        }),
      ).toBe("/dashboard");
    }
  });
});

describe("resolvePostLoginLandingPath — explicit callbackUrl precedence (D-D4)", () => {
  it("a genuinely explicit safe callbackUrl wins over the preference and role default", () => {
    // admin + MEMBER_DASHBOARD, non-admin, admin + no pref: explicit always wins
    expect(
      resolvePostLoginLandingPath({
        explicitCallbackUrl: "/bookings/123",
        landingPreference: "MEMBER_DASHBOARD",
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/bookings/123");
    expect(
      resolvePostLoginLandingPath({
        explicitCallbackUrl: "/nominations/tok",
        landingPreference: null,
        permissionInput: NON_ADMIN,
      }),
    ).toBe("/nominations/tok");
  });

  it("a /login-shaped callbackUrl (a flow-materialised detour URL) is NOT explicit and falls through to the role default", () => {
    expect(
      resolvePostLoginLandingPath({
        explicitCallbackUrl: "/login?callbackUrl=%2Fadmin",
        landingPreference: null,
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/admin/dashboard");
  });

  it("rejects open-redirect attempts and falls through to the role default", () => {
    for (const attempt of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      " /dashboard",
    ]) {
      expect(
        resolvePostLoginLandingPath({
          explicitCallbackUrl: attempt,
          landingPreference: null,
          permissionInput: FULL_ADMIN,
        }),
      ).toBe("/admin/dashboard");
    }
  });
});

/**
 * #2827 — the family-invite return address, carried in an HttpOnly cookie rather
 * than in a `callbackUrl`, because putting it in the URL means rendering the
 * invite token into a link's `href` and so into the address bar, the browser's
 * history and any `Referer` the next hop is shown.
 *
 * #2974 — and honoured only for the TAB that opened the invitation. The resolver
 * takes the RAW cookie value plus the nonce this request presented, and does both
 * the shape check and the nonce match itself, so these cases hold whatever a
 * caller forwards: the only path this input can ever produce is an invite page,
 * and only for a caller holding that invitation's own nonce.
 */
describe("resolvePostLoginLandingPath — private family-invite return address (#2827, #2974)", () => {
  const TOKEN =
    "e7c1b93a5d0f4826" +
    "1af74c02be95d738" +
    "6b0d2e8149a3fc57" +
    "d4938e6017c2ba5f";
  const INVITE_PATH = `/family-invite/${TOKEN}`;
  const NONCE = "3f9c17ae42b0d85610c73fe29ab4d051";
  const OTHER_NONCE = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
  const COOKIE = `${NONCE}.${INVITE_PATH}`;

  it("beats the landing preference and the role default", () => {
    expect(
      resolvePostLoginLandingPath({
        familyInviteReturn: { cookieValue: COOKIE, presentedNonce: NONCE },
        landingPreference: "MEMBER_DASHBOARD",
        permissionInput: FULL_ADMIN,
      }),
    ).toBe(INVITE_PATH);

    expect(
      resolvePostLoginLandingPath({
        familyInviteReturn: { cookieValue: COOKIE, presentedNonce: NONCE },
        landingPreference: null,
        permissionInput: FULL_ADMIN,
      }),
    ).toBe(INVITE_PATH);
  });

  it("loses to a genuinely explicit callbackUrl", () => {
    // Precedence 2, not 1, on purpose: a member bounced out of a member page asked
    // for THAT page on this sign-in attempt, and a lingering invite cookie must
    // not outrank it. The cookie simply expires.
    expect(
      resolvePostLoginLandingPath({
        explicitCallbackUrl: "/nominations/tok",
        familyInviteReturn: { cookieValue: COOKIE, presentedNonce: NONCE },
        landingPreference: null,
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/nominations/tok");
  });

  /**
   * THE #2974 PROPERTY, and the reason this issue exists.
   *
   * On a shared lodge or kiosk browser, somebody opens an invitation, does not
   * sign in, and walks away. The cookie is still there. The next person sits down
   * and signs in — in their own tab, so with no nonce, or with a nonce from some
   * other journey. They must land where they normally would, never on a stranger's
   * invitation with its invited email address and family-group name on the screen.
   */
  it("is NOT honoured by a sign-in that presents no nonce — the shared-kiosk case", () => {
    for (const presentedNonce of [null, undefined, ""]) {
      expect(
        resolvePostLoginLandingPath({
          familyInviteReturn: { cookieValue: COOKIE, presentedNonce },
          landingPreference: "MEMBER_DASHBOARD",
          permissionInput: FULL_ADMIN,
        }),
        String(presentedNonce),
      ).toBe("/dashboard");
    }
  });

  it("is NOT honoured by a nonce from a different tab or journey", () => {
    expect(
      resolvePostLoginLandingPath({
        familyInviteReturn: {
          cookieValue: COOKIE,
          presentedNonce: OTHER_NONCE,
        },
        landingPreference: "MEMBER_DASHBOARD",
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/dashboard");
  });

  it("refuses a nonce that is a prefix, a suffix or a near miss of the real one", () => {
    for (const attempt of [
      NONCE.slice(0, 31),
      `${NONCE}0`,
      NONCE.toUpperCase(),
      `${NONCE.slice(0, 31)}f`,
      ".*",
      `${NONCE} `,
    ]) {
      expect(
        resolvePostLoginLandingPath({
          familyInviteReturn: { cookieValue: COOKIE, presentedNonce: attempt },
          landingPreference: "MEMBER_DASHBOARD",
          permissionInput: FULL_ADMIN,
        }),
        attempt,
      ).toBe("/dashboard");
    }
  });

  it("refuses a cookie in the pre-#2974 format, which carried no nonce", () => {
    // A visitor holding an old-format cookie across a deploy degrades to their
    // ordinary landing for the two minutes it survives. The emailed link still
    // works; nothing errors.
    expect(
      resolvePostLoginLandingPath({
        familyInviteReturn: {
          cookieValue: INVITE_PATH,
          presentedNonce: NONCE,
        },
        landingPreference: "MEMBER_DASHBOARD",
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/dashboard");
  });

  it("refuses an off-origin value — the open-redirect guard", () => {
    for (const attempt of [
      `https://evil.example${INVITE_PATH}`,
      `//evil.example${INVITE_PATH}`,
      `/\\evil.example${INVITE_PATH}`,
      ` ${INVITE_PATH}`,
      `${INVITE_PATH}\n`,
    ]) {
      expect(
        resolvePostLoginLandingPath({
          familyInviteReturn: {
            cookieValue: `${NONCE}.${attempt}`,
            presentedNonce: NONCE,
          },
          landingPreference: null,
          permissionInput: FULL_ADMIN,
        }),
        attempt,
      ).toBe("/admin/dashboard");
    }
  });

  it("refuses a safe internal path that is not an invite page", () => {
    // The narrower half, and why a planted cookie is not a "land anywhere" lever:
    // an attacker who can write this cookie cannot steer a member's post-login
    // landing to an admin page, a payment page or anywhere else.
    for (const attempt of [
      "/admin/members",
      "/dashboard",
      `/pay/${TOKEN}`,
      "/family-invite",
      `/family-invite/${TOKEN}/extra`,
      `${INVITE_PATH}?next=/admin`,
    ]) {
      expect(
        resolvePostLoginLandingPath({
          familyInviteReturn: {
            cookieValue: `${NONCE}.${attempt}`,
            presentedNonce: NONCE,
          },
          landingPreference: null,
          permissionInput: FULL_ADMIN,
        }),
        attempt,
      ).toBe("/admin/dashboard");
    }
  });

  it("degrades to the ordinary landing when there is no cookie at all", () => {
    // An expired or absent address must never be an error: the emailed invite link
    // still works, and the member simply lands where they normally would.
    for (const absent of [null, undefined, ""]) {
      expect(
        resolvePostLoginLandingPath({
          familyInviteReturn: { cookieValue: absent, presentedNonce: NONCE },
          landingPreference: "MEMBER_DASHBOARD",
          permissionInput: FULL_ADMIN,
        }),
        String(absent),
      ).toBe("/dashboard");
    }

    // ...and with no pair supplied at all, which is what every landing site that
    // has nothing to do with invitations passes.
    expect(
      resolvePostLoginLandingPath({
        landingPreference: "MEMBER_DASHBOARD",
        permissionInput: FULL_ADMIN,
      }),
    ).toBe("/dashboard");
  });
});
