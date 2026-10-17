// @vitest-environment jsdom

/**
 * #4214 (owner decision): Xero Operations' list of refund requests whose own
 * Xero credit note was voided in Xero, and its "Raise a fresh credit note".
 *
 * A finance editor confirms, then the panel posts the request to the re-raise
 * route and reports what it said; a view-only finance admin reads the same
 * list but the action stays disabled; a request already queued, or whose
 * voided amount cannot be read, offers no action at all; and an empty list
 * renders nothing.
 */

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { VoidedRequestNotesPanel } from "../voided-request-notes-panel"

const voided = {
  paymentId: "pay_1",
  paymentUrl: "/admin/xero/records/Payment/pay_1",
  bookingId: "booking_1",
  refundRequestId: "rr_1",
  voidedNotes: [{ xeroObjectId: "cn_100", xeroObjectNumber: "CN-100", status: "VOIDED" }],
  amountCents: 5000,
  activeOperationId: null,
}

function stubFetch(list: unknown[], reraise: { status: number; body: unknown } = { status: 202, body: { ok: true, message: "Queued." } }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/reraise")) {
      return { ok: reraise.status < 400, status: reraise.status, json: async () => reraise.body } as unknown as Response
    }
    void init
    return { ok: true, status: 200, json: async () => ({ data: list }) } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function renderPanel(canEdit: boolean | undefined) {
  const onMessage = vi.fn()
  const onChanged = vi.fn()
  render(<VoidedRequestNotesPanel canEdit={canEdit} refreshToken={0} onMessage={onMessage} onChanged={onChanged} />)
  return { onMessage, onChanged }
}

describe("voided refund request notes panel (#4214)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("a finance editor confirms and the request is posted to the re-raise route", async () => {
    const fetchMock = stubFetch([voided])
    const { onMessage, onChanged } = renderPanel(true)

    expect(await screen.findByText(/Voided in Xero: CN-100 \(VOIDED\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Raise a fresh credit note" }))
    // The confirmation names the amount before anything is sent.
    expect(await screen.findByText(/queues a new Xero credit note for \$50\.00/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reraise"))).toBe(false)
    const dialogButtons = screen.getAllByRole("button", { name: "Raise a fresh credit note" })
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!)

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("Queued."))
    const reraiseCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/reraise"))!
    expect(reraiseCall[1]).toMatchObject({ method: "POST" })
    expect(JSON.parse(String(reraiseCall[1]!.body))).toEqual({ paymentId: "pay_1", refundRequestId: "rr_1" })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("MUTATION: cancelling the confirmation posts nothing", async () => {
    const fetchMock = stubFetch([voided])
    const { onMessage } = renderPanel(true)

    fireEvent.click(await screen.findByRole("button", { name: "Raise a fresh credit note" }))
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reraise"))).toBe(false)
    expect(onMessage).not.toHaveBeenCalled()
  })

  it("MUTATION: a view-only finance admin sees the request but cannot raise a note", async () => {
    const fetchMock = stubFetch([voided])
    renderPanel(false)

    expect(await screen.findByText(/Voided in Xero: CN-100/)).toBeInTheDocument()
    const button = screen.getByRole("button", { name: /Raise a fresh credit note/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reraise"))).toBe(false)
  })

  it("shows the server's refusal, such as a second officer's click", async () => {
    stubFetch([voided], { status: 409, body: { error: "A credit note for this refund request is already queued or being sent to Xero." } })
    renderPanel(true)

    fireEvent.click(await screen.findByRole("button", { name: "Raise a fresh credit note" }))
    const dialogButtons = await screen.findAllByRole("button", { name: "Raise a fresh credit note" })
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!)
    expect(await screen.findByText(/already queued or being sent to Xero/)).toBeInTheDocument()
  })

  it("offers no action for a request already queued, or one whose amount cannot be read", async () => {
    stubFetch([
      { ...voided, activeOperationId: "queue_1" },
      { ...voided, refundRequestId: "rr_2", amountCents: null },
    ])
    renderPanel(true)

    expect(await screen.findByText(/is queued for Xero/)).toBeInTheDocument()
    expect(screen.getByText(/Raise the replacement by hand in Xero/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Raise a fresh credit note/ })).not.toBeInTheDocument()
  })

  it("renders nothing when no request's note is voided", async () => {
    const fetchMock = stubFetch([])
    renderPanel(true)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByText(/Voided refund request notes/)).not.toBeInTheDocument()
  })
})
