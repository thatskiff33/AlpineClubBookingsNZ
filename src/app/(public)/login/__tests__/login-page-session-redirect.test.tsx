import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// The authenticated self-heal: /login must never render the sign-in form for
// a live session (the silent login loop, #1669) — it redirects through the
// same gates as login/verify: forced password change, then the two-factor
// funnel, then the sanitised callbackUrl.

const { mockAuth, mockRedirect, mockReadReturnCookie } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
  mockReadReturnCookie: vi.fn<() => Promise<string | null>>(),
}));

// #2827: the self-heal branch reads the family-invite return address from an
// HttpOnly cookie. Mocked at the reader, not at `next/headers`, because
// `cookies()` throws outside a request scope. #2974: the reader hands back the
// RAW cookie value — `<nonce>.<path>` — and the resolver pairs it with the
// `?inviteReturn=` nonce this request presented.
vi.mock("@/lib/family-invite-return-address-cookie", () => ({
  readFamilyInviteReturnCookieValue: () => mockReadReturnCookie(),
}));

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/public-layout-config", () => ({
  getCachedEffectiveModuleFlags: () => Promise.resolve({ magicLink: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: (path: string) => mockRedirect(path),
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Alpine Club" }),
}));

import LoginPage from "../page";

function sessionUser(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: "member-1",
      email: "member@example.com",
      forcePasswordChange: false,
      twoFactorRequired: false,
      twoFactorVerified: false,
      twoFactorEnrolled: false,
      twoFactorMethod: null,
      ...overrides,
    },
  };
}

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {}
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"])
  ) as Record<string, AdminPermissionLevel>;
  return { ...base, ...overrides } as AdminPermissionMatrix;
}

async function runLoginPage(
  params: Record<string, string | string[] | undefined> = {}
) {
  return LoginPage({ searchParams: Promise.resolve(params) });
}

const TOKEN = "e7c1b93a5d0f4826".repeat(4);
const INVITE_PATH = `/family-invite/${TOKEN}`;
const NONCE = "3f9c17ae42b0d85610c73fe29ab4d051";
const INVITE_COOKIE = `${NONCE}.${INVITE_PATH}`;

describe("LoginPage authenticated self-heal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadReturnCookie.mockResolvedValue(null);
    mockRedirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it("redirects an authenticated visitor to the callbackUrl", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/bookings");
  });

  it("falls back to /dashboard when no callbackUrl is present", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    await expect(runLoginPage()).rejects.toThrow("redirect:/dashboard");
  });

  it("self-heals an admin with no preference to their first accessible admin page", async () => {
    // Admin access but the overview area is denied, so the resolver must land on
    // the next accessible admin page (never a literal /admin/dashboard), proving
    // the self-heal honours getFirstAccessibleAdminHref rather than a constant.
    mockAuth.mockResolvedValue(
      sessionUser({
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ bookings: "edit" }),
      })
    );

    await expect(runLoginPage()).rejects.toThrow("redirect:/admin/bookings");
  });

  it("lets an explicit callbackUrl win over an admin's role default", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ overview: "edit" }),
      })
    );

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/bookings");
  });

  it("honours a MEMBER_DASHBOARD preference for an admin self-heal", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        postLoginLanding: "MEMBER_DASHBOARD",
        adminPermissionMatrix: matrix({ overview: "edit" }),
      })
    );

    await expect(runLoginPage()).rejects.toThrow("redirect:/dashboard");
  });

  it("never redirects back into /login (loop guard)", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    await expect(
      runLoginPage({ callbackUrl: "/login?callbackUrl=%2Fdashboard" })
    ).rejects.toThrow("redirect:/dashboard");
  });

  it("drops an external callbackUrl and uses the default", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    await expect(
      runLoginPage({ callbackUrl: "https://evil.example/phish" })
    ).rejects.toThrow("redirect:/dashboard");
  });

  it("sends a forced password change to /change-password first", async () => {
    mockAuth.mockResolvedValue(sessionUser({ forcePasswordChange: true }));

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/change-password");
  });

  it("sends an unverified enrolled session to /login/verify with the callbackUrl", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
      })
    );

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/login/verify?callbackUrl=%2Fbookings");
  });

  it("sends a passkey-only session to /login/verify", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: false,
        twoFactorMethod: null,
        hasPasskey: true,
      }),
    );

    await expect(runLoginPage({ callbackUrl: "/bookings" })).rejects.toThrow(
      "redirect:/login/verify?callbackUrl=%2Fbookings",
    );
  });

  it("sends an unverified unenrolled session to /login/enroll with the callbackUrl", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ twoFactorRequired: true, twoFactorEnrolled: false })
    );

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/login/enroll?callbackUrl=%2Fbookings");
  });

  it("sends an admin with no deep link into the detour WITHOUT baking a landing", async () => {
    // Determinism (#2090): the self-heal must not materialise the resolved
    // admin landing into the detour callbackUrl. With no explicit deep link the
    // detour carries no callbackUrl at all; /login/enroll re-resolves the same
    // default, so every entry into the detour lands identically.
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: false,
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ finance: "view" }),
      })
    );

    // Anchored so a baked-in "?callbackUrl=…" cannot slip past a substring match.
    await expect(runLoginPage()).rejects.toThrow(/redirect:\/login\/enroll$/);
  });

  it("still carries a genuine deep link into the detour callbackUrl", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ finance: "view" }),
      })
    );

    await expect(
      runLoginPage({ callbackUrl: "/nominations/tok" })
    ).rejects.toThrow("redirect:/login/verify?callbackUrl=%2Fnominations%2Ftok");
  });

  it("redirects a verified two-factor session to the callbackUrl", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorVerified: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
      })
    );

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/bookings");
  });

  it("returns a Google sign-in to the family-invite address in the cookie (#2827)", async () => {
    // This branch is where a Google sign-in from an invite comes back: the
    // provider callbackUrl is "/login?inviteReturn=<nonce>" whenever there is no
    // explicit deep link, so without the cookie read here the one flow with no
    // client post-auth seam would land on the dashboard and the invite would be
    // forgotten.
    mockAuth.mockResolvedValue(sessionUser());
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    await expect(
      runLoginPage({ inviteReturn: NONCE }),
    ).rejects.toThrow(`redirect:${INVITE_PATH}`);
  });

  /**
   * THE #2974 PROPERTY at this landing site, and the shared-kiosk case in one
   * test: the cookie is alive, but this sign-in did not come from the tab that
   * opened the invitation, so it presents no nonce and must land on the member's
   * ordinary home rather than on a stranger's invitation.
   */
  it("ignores the cookie for a sign-in that presents no nonce (#2974)", async () => {
    mockAuth.mockResolvedValue(sessionUser());
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    await expect(runLoginPage()).rejects.toThrow("redirect:/dashboard");
  });

  it("ignores the cookie for a nonce from some other tab (#2974)", async () => {
    mockAuth.mockResolvedValue(sessionUser());
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    await expect(
      runLoginPage({ inviteReturn: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" }),
    ).rejects.toThrow("redirect:/dashboard");
  });

  it("lets an explicit callbackUrl outrank the family-invite cookie (#2827)", async () => {
    mockAuth.mockResolvedValue(sessionUser());
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    await expect(
      runLoginPage({ callbackUrl: "/bookings", inviteReturn: NONCE }),
    ).rejects.toThrow("redirect:/bookings");
  });

  it("never materialises the family-invite address into the 2FA detour URL (#2827)", async () => {
    // The invite token must not reappear in a URL the login page RENDERS or
    // redirects through with a query string — the detour carries only a genuinely
    // explicit deep link plus the tokenless #2974 nonce, and /login/verify
    // re-reads the cookie for itself.
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
      }),
    );
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    await expect(runLoginPage({ inviteReturn: NONCE })).rejects.toThrow(
      `redirect:/login/verify?inviteReturn=${NONCE}`,
    );
  });

  it("carries the tokenless nonce — and nothing else — into the detour (#2974)", async () => {
    // The nonce has to survive the hop or a 2FA member from an invitation lands
    // on their dashboard. What must NOT survive is the invite path or its token.
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
      }),
    );
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    const redirected = await runLoginPage({ inviteReturn: NONCE }).then(
      () => "no redirect happened",
      (error: Error) => error.message,
    );

    expect(redirected).toBe(`redirect:/login/verify?inviteReturn=${NONCE}`);
    expect(redirected).not.toContain(TOKEN);
    expect(redirected).not.toContain("family-invite");
  });

  it("drops a malformed nonce rather than forwarding it into the detour (#2974)", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
      }),
    );
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    await expect(
      runLoginPage({ inviteReturn: "../../admin?x=1" }),
    ).rejects.toThrow("redirect:/login/verify");
  });

  it("still renders the form for an anonymous visitor", async () => {
    mockAuth.mockResolvedValue(null);

    const html = renderToStaticMarkup(await runLoginPage({}));

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(html).toContain("Sign in to your account to manage bookings");
  });

  it("renders the form when auth() returns a session without a user", async () => {
    mockAuth.mockResolvedValue({ user: undefined });

    const html = renderToStaticMarkup(await runLoginPage({}));

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(html).toContain("Sign in to your account to manage bookings");
  });
});
