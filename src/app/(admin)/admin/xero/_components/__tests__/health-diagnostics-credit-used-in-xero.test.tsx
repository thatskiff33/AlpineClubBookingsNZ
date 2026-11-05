// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { render, screen } from "@/lib/__tests__/support/club-time-render"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { HealthAndDiagnosticsPanels } from "../health-diagnostics-panel"

const mocks = vi.hoisted(() => ({ fetchJson: vi.fn(), postJson: vi.fn() }))

vi.mock("../api", () => ({ fetchJson: mocks.fetchJson, postJson: mocks.postJson }))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

const health = {
  unlinkedMembers: { count: 0, href: "/admin/members" },
  failedOperations: { count: 0, legacyCount: 0 },
  pendingOperations: { count: 0 },
  lastMembershipRefresh: { at: null, lastCronStatus: null },
  contactGroupMismatches: { count: 0, cacheReady: true },
  contactLinkMismatches: { count: 0, cacheReady: true },
  apiBudget: { usagePercent: 0, totalCalls: 0, failedCalls: 0, status: "healthy" },
  missingInvoices: { count: 0 },
}

function renderPanel() {
  return render(
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
}

const tile = async () => (await screen.findByText("Credit used in Xero")).closest("div.rounded-xl") as HTMLElement

describe("the Health Snapshot's credit-used-in-Xero count (#4220)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows the count of flagged credit notes, marked for review", async () => {
    mocks.fetchJson.mockResolvedValue({ ...health, creditNotesSpentOutsideApp: { count: 2 } })
    renderPanel()
    const card = await tile()
    expect(card).toHaveTextContent("2")
    expect(card).toHaveTextContent("Review")
    expect(card).toHaveTextContent("the booking repair check lists the bookings")
  })

  it("reads clear at zero", async () => {
    mocks.fetchJson.mockResolvedValue({ ...health, creditNotesSpentOutsideApp: { count: 0 } })
    renderPanel()
    const card = await tile()
    expect(card).toHaveTextContent("0")
    expect(card).toHaveTextContent("Clear")
  })

  it("reads unknown, never clear, when an older server sends no count", async () => {
    mocks.fetchJson.mockResolvedValue(health)
    renderPanel()
    const card = await tile()
    expect(card).toHaveTextContent("Unknown")
    expect(card).toHaveTextContent("did not report the count")
    expect(card).not.toHaveTextContent("Clear")
    expect(card).not.toHaveTextContent("0")
  })
})
