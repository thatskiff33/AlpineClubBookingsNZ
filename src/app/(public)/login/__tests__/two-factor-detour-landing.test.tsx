import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// The /login/enroll and /login/verify pages are the single authoritative site
// that resolves the post-login DEFAULT landing after the 2FA detour (#2090).
// Resolving here — server-side, from the live session's preference + admin
// matrix — makes the post-detour destination deterministic (D-D4): an
// admin-access member reaching enrollment/verification with no deep link lands
// on their first accessible admin page, a genuine deep link still wins, and a
// plain member lands on /dashboard. No raced post-signIn resolver fetch is
// involved, so the detour never bakes a stale /dashboard default (the alice/bob
// asymmetry this suite guards against).

const { mockAuth, mockRedirect, mockReadReturnCookie, mockRetiredCodes } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
  mockReadReturnCookie: vi.fn<() => Promise<string | null>>(),
  mockRetiredCodes: vi.fn<(memberId: string) => Promise<boolean>>(async () => false),
}));

// #4456: the verify page asks whether the member's recovery codes were retired.
vi.mock("@/lib/two-factor", () => ({
  memberHoldsRetiredRecoveryCodes: (memberId: string) => mockRetiredCodes(memberId),
}));

// #2827: both detour pages read the family-invite return address from an
// HttpOnly cookie so a 2FA-enabled member still lands back on their invite.
// Mocked at the reader, not at `next/headers`, because `cookies()` throws
// outside a request scope. #2974: the reader hands back the RAW cookie value,
// and the page pairs it with the `?inviteReturn=` nonce the detour hop carried.
vi.mock("@/lib/family-invite-return-address-cookie", () => ({
  readFamilyInviteReturnCookieValue: () => mockReadReturnCookie(),
}));

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

// Capture the callbackUrl the page hands the panel without rendering the real
// (client, hook-driven) panel — the page returns the element, so its props are
// the post-detour destination under test.
vi.mock("../two-factor-panels", () => ({
  TwoFactorEnrollPanel: (props: { callbackUrl: string }) => props,
  TwoFactorVerifyPanel: (props: {
    callbackUrl: string;
    enrolledMethod: string;
  }) => props,
}));

import EnrollPage from "../enroll/page";
import VerifyPage from "../verify/page";

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
  ) as Record<string, AdminPermissionLevel>;
  return { ...base, ...overrides } as AdminPermissionMatrix;
}

function sessionUser(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: "member-1",
      forcePasswordChange: false,
      twoFactorRequired: true,
      twoFactorVerified: false,
      twoFactorEnrolled: false,
      twoFactorMethod: null,
      postLoginLanding: null,
      adminPermissionMatrix: matrix(),
      ...overrides,
    },
  };
}

function detourParams(callbackUrl?: string, inviteReturn?: string) {
  return {
    ...(callbackUrl ? { callbackUrl } : {}),
    ...(inviteReturn ? { inviteReturn } : {}),
  };
}

async function runEnroll(callbackUrl?: string, inviteReturn?: string) {
  return EnrollPage({
    searchParams: Promise.resolve(detourParams(callbackUrl, inviteReturn)),
  });
}

async function runVerify(callbackUrl?: string, inviteReturn?: string) {
  return VerifyPage({
    searchParams: Promise.resolve(detourParams(callbackUrl, inviteReturn)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadReturnCookie.mockResolvedValue(null);
  mockRedirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
});

describe("/login/enroll post-detour landing (#2090)", () => {
  it("resolves an admin-access enrollee with no deep link to their first admin page", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    const element = (await runEnroll()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/admin/payments");
  });

  it("lets a genuine deep link win over the admin role default", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    const element = (await runEnroll("/nominations/tok")) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe("/nominations/tok");
  });

  it("lands a plain member on /dashboard", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    const element = (await runEnroll()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });

  it("honours a MEMBER_DASHBOARD preference for an admin enrollee", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        postLoginLanding: "MEMBER_DASHBOARD",
        adminPermissionMatrix: matrix({ finance: "view" }),
      }),
    );

    const element = (await runEnroll()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });

  it("redirects an already-enrolled session to /login/verify with no baked landing", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorEnrolled: true,
        twoFactorMethod: "TOTP",
        adminPermissionMatrix: matrix({ finance: "view" }),
      }),
    );

    // Anchored: a baked-in "?callbackUrl=…" would defeat this assertion if it
    // were a substring match (vitest toThrow(string) matches substrings).
    await expect(runEnroll()).rejects.toThrow(/redirect:\/login\/verify$/);
  });

  it("redirects an already-verified session to the resolved landing", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorVerified: true,
        adminPermissionMatrix: matrix({ finance: "view" }),
      }),
    );

    await expect(runEnroll()).rejects.toThrow("redirect:/admin/payments");
  });

  it("sends an anonymous visitor back to /login", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(runEnroll()).rejects.toThrow(/redirect:\/login/);
  });
});

describe("/login/verify post-detour landing (#2090)", () => {
  const enrolled = { twoFactorEnrolled: true, twoFactorMethod: "TOTP" as const };

  it("resolves an admin-access member with no deep link to their first admin page", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ ...enrolled, adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    const element = (await runVerify()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/admin/payments");
  });

  it("lets a genuine deep link win over the admin role default", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ ...enrolled, adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    const element = (await runVerify("/nominations/tok")) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe("/nominations/tok");
  });

  it("lands a plain member on /dashboard", async () => {
    mockAuth.mockResolvedValue(sessionUser(enrolled));

    const element = (await runVerify()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });

  it.each([true, false])(
    "tells the panel whether this member's recovery codes were retired (%s) (#4456)",
    async (retired) => {
      mockAuth.mockResolvedValue(sessionUser(enrolled));
      mockRetiredCodes.mockResolvedValueOnce(retired);

      const element = (await runVerify()) as unknown as {
        props: { recoveryCodesRetired: boolean };
      };
      expect(mockRetiredCodes).toHaveBeenCalledExactlyOnceWith("member-1");
      expect(element.props.recoveryCodesRetired).toBe(retired);
    },
  );

  it("redirects an unenrolled session to /login/enroll with no baked landing", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    // Anchored so a baked-in "?callbackUrl=…" cannot slip past a substring match.
    await expect(runVerify()).rejects.toThrow(/redirect:\/login\/enroll$/);
  });
});

describe("2FA detour honours the family-invite return address (#2827, #2974)", () => {
  const TOKEN = "e7c1b93a5d0f4826".repeat(4);
  const INVITE_PATH = `/family-invite/${TOKEN}`;
  const NONCE = "3f9c17ae42b0d85610c73fe29ab4d051";
  const OTHER_NONCE = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
  const INVITE_COOKIE = `${NONCE}.${INVITE_PATH}`;
  const enrolled = { twoFactorEnrolled: true, twoFactorMethod: "TOTP" as const };

  it("hands /login/verify's panel the invite path, over the role default", async () => {
    // A 2FA-enabled member who came from an invite must still land back on it. The
    // panel only ever passes this value to `router.replace()`, never into a
    // rendered attribute — which is why it may hold the token at all.
    mockAuth.mockResolvedValue(
      sessionUser({ ...enrolled, adminPermissionMatrix: matrix({ finance: "view" }) }),
    );
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    const element = (await runVerify(undefined, NONCE)) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe(INVITE_PATH);
  });

  it("hands /login/enroll's panel the invite path too", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ adminPermissionMatrix: matrix({ finance: "view" }) }),
    );
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    const element = (await runEnroll(undefined, NONCE)) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe(INVITE_PATH);
  });

  /**
   * THE #2974 PROPERTY at the detour: a 2FA member signing in from a tab that
   * never opened the invitation carries no nonce across the hop, so the panel is
   * handed their ordinary landing and never a stranger's invite path.
   */
  it("ignores the cookie when the detour hop carried no nonce (#2974)", async () => {
    mockAuth.mockResolvedValue(sessionUser(enrolled));
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    const element = (await runVerify()) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });

  it("ignores the cookie for a nonce from another tab (#2974)", async () => {
    // An unenrolled session, so /login/enroll RENDERS its panel rather than
    // handing back to /login/verify — the panel's callbackUrl is the landing
    // under test.
    mockAuth.mockResolvedValue(sessionUser());
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    const element = (await runEnroll(undefined, OTHER_NONCE)) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });

  it("carries the nonce — and never the invite path — across the second hop (#2974)", async () => {
    // /login/verify hands an unenrolled session to /login/enroll, and /login/enroll
    // hands an enrolled one back. The nonce has to survive both hops, and the token
    // must not appear in either URL.
    mockAuth.mockResolvedValue(
      sessionUser({ twoFactorEnrolled: false, twoFactorMethod: null }),
    );
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    await expect(runVerify(undefined, NONCE)).rejects.toThrow(
      `redirect:/login/enroll?inviteReturn=${NONCE}`,
    );

    mockAuth.mockResolvedValue(sessionUser(enrolled));

    await expect(runEnroll(undefined, NONCE)).rejects.toThrow(
      `redirect:/login/verify?inviteReturn=${NONCE}`,
    );
  });

  it("still lets a genuine deep link outrank it", async () => {
    mockAuth.mockResolvedValue(sessionUser(enrolled));
    mockReadReturnCookie.mockResolvedValue(INVITE_COOKIE);

    const element = (await runVerify("/nominations/tok", NONCE)) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe("/nominations/tok");
  });

  it("degrades to the ordinary landing when the cookie has expired", async () => {
    mockAuth.mockResolvedValue(sessionUser(enrolled));
    mockReadReturnCookie.mockResolvedValue(null);

    const element = (await runVerify(undefined, NONCE)) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });
});
