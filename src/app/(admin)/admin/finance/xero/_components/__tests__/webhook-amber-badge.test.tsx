// @vitest-environment jsdom
/**
 * The amber webhook badge's "Xero Setup" shortcut (#4972) opens the Webhooks
 * step through the one helper that also names the wizard's step, so a renamed
 * step or parameter cannot leave it opening the first step instead.
 */
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { WebhookAmberBadge } from "../webhook-amber-badge";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
const status = (value: unknown) => new Response(JSON.stringify(value));

describe("webhook amber badge", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", h.fetch);
  });

  it("links Xero Setup at its Webhooks step when webhooks are not verified", async () => {
    h.fetch.mockResolvedValue(status({ verified: false, webhooksVerifiable: true }));
    render(<WebhookAmberBadge connected />);
    const link = await screen.findByRole("link", { name: "Xero Setup" });
    expect(link).toHaveAttribute("href", "/admin/xero/setup?step=webhooks");
  });

  it("offers no link where webhooks cannot be verified on this deployment", async () => {
    h.fetch.mockResolvedValue(status({ verified: false, webhooksVerifiable: false }));
    render(<WebhookAmberBadge connected />);
    expect(await screen.findByText(/can.t verify on this deployment/)).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
