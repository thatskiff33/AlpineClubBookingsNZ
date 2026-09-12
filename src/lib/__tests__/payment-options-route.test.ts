import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  loadInternetBankingPaymentSettings: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/internet-banking-settings", async () => {
  const actual = (await vi.importActual("@/lib/internet-banking-settings")) as typeof import("@/lib/internet-banking-settings");
  return {
    ...actual,
    loadInternetBankingPaymentSettings:
      mocks.loadInternetBankingPaymentSettings,
  };
});

import { GET } from "@/app/api/payments/options/route";

const session = { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } };
const defaultSettings = {
  holdBedSlots: false,
  holdDays: 3,
  minimumDaysBeforeCheckIn: 0,
};

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

describe("payments options route", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.requireActiveSessionUser.mockReset();
    mocks.loadEffectiveModuleFlags.mockReset();
    mocks.loadInternetBankingPaymentSettings.mockReset();

    mocks.auth.mockResolvedValue(session);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.loadEffectiveModuleFlags.mockResolvedValue({
      xeroIntegration: true,
      internetBankingPayments: true,
    });
    mocks.loadInternetBankingPaymentSettings.mockResolvedValue(defaultSettings);
  });

  it("returns expanded Internet Banking state when the module is on", async () => {
    const response = await GET(request("/api/payments/options"));

    await expect(response.json()).resolves.toMatchObject({
      methods: {
        stripe: { enabled: true, default: true },
        internetBanking: {
          enabled: true,
          moduleEnabled: true,
          unavailableReason: null,
          holdPolicy: {
            holdBedSlots: false,
            holdDays: 3,
          },
          cutoff: {
            allowed: true,
            minimumDaysBeforeCheckIn: 0,
            checkIn: null,
          },
        },
      },
    });
  });

  it("blocks Internet Banking for invalid check-in query values", async () => {
    const response = await GET(request("/api/payments/options?checkIn=nope"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid checkIn. Expected YYYY-MM-DD.",
    });
  });

  it("surfaces the configured lead-time cutoff", async () => {
    mocks.loadInternetBankingPaymentSettings.mockResolvedValue({
      holdBedSlots: true,
      holdDays: 2,
      minimumDaysBeforeCheckIn: 365,
    });

    const response = await GET(request("/api/payments/options?checkIn=2026-07-01"));
    const body = await response.json();

    expect(body.methods.internetBanking.enabled).toBe(false);
    expect(body.methods.internetBanking.holdPolicy).toMatchObject({
      holdBedSlots: true,
      holdDays: 2,
    });
    expect(body.methods.internetBanking.cutoff).toMatchObject({
      allowed: false,
      minimumDaysBeforeCheckIn: 365,
      checkIn: "2026-07-01",
    });
    expect(body.methods.internetBanking.unavailableReason).toContain(
      "365 days before check-in",
    );
  });

  it("keeps Internet Banking unavailable when required modules are off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue({
      xeroIntegration: false,
      internetBankingPayments: true,
    });

    const response = await GET(request("/api/payments/options"));
    const body = await response.json();

    expect(body.methods.internetBanking).toMatchObject({
      enabled: false,
      moduleEnabled: false,
      xeroIntegrationEnabled: false,
      unavailableReason: "Xero integration is not enabled.",
    });
  });

  it("mirrors the groupBookings module flag for the booking wizard", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue({
      xeroIntegration: false,
      internetBankingPayments: false,
      groupBookings: true,
    });

    let body = await (await GET(request("/api/payments/options"))).json();
    expect(body.groupBookingsEnabled).toBe(true);

    mocks.loadEffectiveModuleFlags.mockResolvedValue({
      xeroIntegration: false,
      internetBankingPayments: false,
      groupBookings: false,
    });

    body = await (await GET(request("/api/payments/options"))).json();
    expect(body.groupBookingsEnabled).toBe(false);
  });
});
