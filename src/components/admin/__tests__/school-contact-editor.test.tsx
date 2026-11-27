// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SchoolContactEditor, type SchoolContactDetails } from "../school-contact-editor"

/**
 * #5245: the officer's "Edit school details" dialog. What a person reads on
 * it: a save another officer beat is refused and offers a reload rather than
 * overwriting, a Xero failure is said in words with its reason and a Retry,
 * and a school Xero has not met yet says when Xero will get the details.
 */

const school = (overrides: Partial<SchoolContactDetails> = {}): SchoolContactDetails => ({
  id: "org-1",
  name: "Tokoroa Primary School",
  email: "office@tokoroa.example",
  phone: "07 886 0000",
  updatedAt: "2026-07-01T00:00:00.000Z",
  hasXeroContact: true,
  xeroSync: null,
  ...overrides,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function openEditor() {
  render(<SchoolContactEditor organisationId="org-1" />)
  fireEvent.click(screen.getByRole("button", { name: "Edit school details" }))
  await screen.findByLabelText("Email address")
}

describe("SchoolContactEditor (#5245)", () => {
  it("sends the version it loaded, and on a conflict offers a reload instead of saving over the other officer", async () => {
    fetchMock.mockResolvedValueOnce(json({ school: school() }))
    fetchMock.mockResolvedValueOnce(json({ error: "Changed" }, 409))
    await openEditor()

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "bursar@tokoroa.example" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText(/Changed by someone else/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe("/api/admin/organisations/org-1/contact")
    expect(JSON.parse(init.body)).toEqual({
      email: "bursar@tokoroa.example",
      phone: "07 886 0000",
      expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
    })

    fetchMock.mockResolvedValueOnce(json({ school: school({ email: "accounts@tokoroa.example", updatedAt: "2026-07-01T00:00:00.002Z" }) }))
    fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(screen.getByLabelText("Email address")).toHaveValue("accounts@tokoroa.example"))
    expect(screen.queryByText(/Changed by someone else/)).not.toBeInTheDocument()
  })

  it("says a Xero failure with its reason, and Retry asks for this school's retry", async () => {
    fetchMock.mockResolvedValueOnce(json({
      school: school({ xeroSync: { operationId: "op-1", status: "FAILED", lastErrorMessage: "Email address is invalid" } }),
    }))
    await openEditor()

    expect(screen.getByRole("alert")).toHaveTextContent("Xero did not take the last change: Email address is invalid")
    fetchMock.mockResolvedValueOnce(json({ ok: true }, 202))
    fetchMock.mockResolvedValueOnce(json({ school: school({ xeroSync: { operationId: "op-1", status: "PENDING", lastErrorMessage: null } }) }))
    fireEvent.click(screen.getByRole("button", { name: "Retry sending to Xero" }))

    expect(await screen.findByText("The last change is queued to send to Xero.")).toBeInTheDocument()
    expect(fetchMock.mock.calls[1][0]).toBe("/api/admin/organisations/org-1/contact/retry")
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" })
  })

  it("tells the officer a school with no Xero contact gets the details on its first invoice", async () => {
    fetchMock.mockResolvedValueOnce(json({ school: school({ hasXeroContact: false }) }))
    await openEditor()

    expect(screen.getByText(/Xero will get these details on the school's first invoice/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument()
  })
})
