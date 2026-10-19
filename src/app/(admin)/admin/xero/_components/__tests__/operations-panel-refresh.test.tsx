// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OperationsPanel } from "../operations-panel"

const navigation = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => "/admin/xero",
  useSearchParams: () => navigation.params,
}))
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access"),
  useAdminAreaEditAccess: () => true,
}))

const queuedRequest = {
  paymentId: "pay_1",
  paymentUrl: "/admin/xero/records/Payment/pay_1",
  bookingId: "booking_1",
  refundRequestId: "rr_1",
  voidedNotes: [{ xeroObjectId: "cn_100", xeroObjectNumber: "CN-100", status: "VOIDED" }],
  amountCents: 5000,
  activeOperationId: "queue_1",
}

function mockFetch(notes: () => Response) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === "/api/admin/xero/operations/voided-request-notes") return notes()
    if (url.startsWith("/api/admin/xero/operations?")) {
      return Response.json({ data: [], total: 0 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function renderPanel() {
  return render(<OperationsPanel connected open onToggle={vi.fn()} onMessage={vi.fn()} onRefreshDiagnostics={vi.fn()} refreshToken={0} />)
}

afterEach(() => vi.unstubAllGlobals())

describe("OperationsPanel Refresh", () => {
  it("reloads the real notes panel so a queued request disappears once its replacement is live", async () => {
    let replacementLive = false
    const fetchMock = mockFetch(() => Response.json({ data: replacementLive ? [] : [queuedRequest] }))
    renderPanel()
    expect(await screen.findByText("A credit note for this request is queued for Xero.")).toBeInTheDocument()
    await screen.findByRole("button", { name: "Refresh" })

    replacementLive = true
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    await waitFor(() => expect(screen.queryByText("Voided refund request notes")).not.toBeInTheDocument())
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/admin/xero/operations?"))).toHaveLength(2)
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/admin/xero/operations/voided-request-notes")).toHaveLength(2)
  })

  it("recovers a failed notes GET when the officer presses Refresh", async () => {
    let failing = true
    mockFetch(() => failing
      ? Response.json({ error: "Notes temporarily unavailable" }, { status: 500 })
      : Response.json({ data: [queuedRequest] }))
    renderPanel()
    expect(await screen.findByText("Notes temporarily unavailable")).toBeInTheDocument()
    await screen.findByRole("button", { name: "Refresh" })

    failing = false
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    expect(await screen.findByText("A credit note for this request is queued for Xero.")).toBeInTheDocument()
    expect(screen.queryByText("Notes temporarily unavailable")).not.toBeInTheDocument()
  })
})
