import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockFindUnique, mockRedirect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

describe("lodge layout authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it("redirects anonymous users to login before rendering lodge pages", async () => {
    mockAuth.mockResolvedValue(null);

    const { default: LodgeLayout } = await import("@/app/(lodge)/layout");

    await expect(LodgeLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/login?callbackUrl=%2Flodge%2Fkiosk"
    );
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("renders lodge pages for an active authenticated user", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE" },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
    });

    const { default: LodgeLayout } = await import("@/app/(lodge)/layout");
    const result = await LodgeLayout({ children: "secure" });

    expect((result as { props: { children: string } }).props.children).toBe(
      "secure"
    );
  });

  it("redirects inactive authenticated users back to login", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE" },
    });
    mockFindUnique.mockResolvedValue({
      active: false,
      forcePasswordChange: false,
    });

    const { default: LodgeLayout } = await import("@/app/(lodge)/layout");

    await expect(LodgeLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/login"
    );
  });

  it("redirects authenticated users who must change their password", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE" },
    });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: true,
    });

    const { default: LodgeLayout } = await import("@/app/(lodge)/layout");

    await expect(LodgeLayout({ children: "secure" })).rejects.toThrow(
      "redirect:/change-password"
    );
  });
});
