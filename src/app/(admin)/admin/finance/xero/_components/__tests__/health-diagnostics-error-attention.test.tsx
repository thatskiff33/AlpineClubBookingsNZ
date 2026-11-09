// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { HealthAndDiagnosticsPanels } from "../health-diagnostics-panel"
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus"

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  postJson: vi.fn(),
}))

vi.mock("../api", () => ({
  fetchJson: mocks.fetchJson,
  postJson: mocks.postJson,
}))

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

const RETRY_MESSAGE =
  "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying."

const health = {
  unlinkedMembers: { count: 0, href: "/admin/members" },
  failedOperations: { count: 0, legacyCount: 0 },
  pendingOperations: { count: 0 },
  lastMembershipRefresh: { at: null, lastCronStatus: null },
  contactGroupMismatches: { count: 0, cacheReady: true },
  contactLinkMismatches: { count: 0, cacheReady: true },
  apiBudget: {
    usagePercent: 0,
    totalCalls: 0,
    failedCalls: 0,
    status: "healthy",
  },
  missingInvoices: { count: 1 },
}

describe("Xero health action error attention (#2597)", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mocks.fetchJson.mockResolvedValue(health)
    mocks.postJson.mockRejectedValue(new Error(RETRY_MESSAGE))
    scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      })
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it("keeps the health controls and focuses a failed recovery action", async () => {
    render(
      <HealthAndDiagnosticsPanels
        connected
        shortCode={null}
        currentXeroPath="/admin/xero"
        healthOpen
        contactGroupMismatchesOpen={false}
        contactLinkMismatchesOpen={false}
        onToggle={vi.fn()}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
        refreshToken={0}
        scrollToSection={vi.fn()}
      />,
    )

    const alert = document.getElementById("xero-health-error")
    expect(alert).toHaveAttribute("role", "alert")
    expect(alert).toBeEmptyDOMElement()
    expect(alert).toHaveClass("sr-only")

    fireEvent.click(
      await screen.findByRole("button", { name: "Trigger All Missing" }),
    )

    await waitFor(() => expect(alert).toHaveTextContent(RETRY_MESSAGE))
    await expectRecoveryAlertToHoldFocus(alert)
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    })
    expect(
      screen.getByRole("button", { name: "Trigger All Missing" }),
    ).toBeEnabled()
  })
})
