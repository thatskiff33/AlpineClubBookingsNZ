// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useResolveWithNoteDialog, type ResolveWithNoteAnswer } from "../resolve-with-note-dialog"

/**
 * #4421 (owner decision 26 Oct 2026): "Resolve by hand" on a refund credit
 * note asks for the Xero note's number. The field is required; the dialog
 * names the amount, stays open while the route checks Xero, and shows a
 * refusal in place with what was typed kept (review, security F3).
 */
function Harness({ submit }: { submit: (answer: ResolveWithNoteAnswer) => Promise<string | null> }) {
  const { openResolveWithNote, resolveWithNoteDialog } = useResolveWithNoteDialog()
  return (
    <div>
      <button type="button" onClick={() => openResolveWithNote({ amountLabel: "$200.00", submit })}>open</button>
      {resolveWithNoteDialog}
    </div>
  )
}

describe("the refund credit note's resolve dialog (#4421)", () => {
  it("requires the number, names the amount and the contact, and sends the number and reason", async () => {
    const submit = vi.fn(async () => null)
    render(<Harness submit={submit} />)
    fireEvent.click(screen.getByText("open"))

    const resolveButton = await screen.findByRole("button", { name: "Resolve" })
    expect(resolveButton).toHaveProperty("disabled", true)
    expect(screen.getByText(/for \$200\.00, for the booking's Xero contact \(the member's, or the organisation's\), and not allocated to\s+another invoice/)).toBeDefined()
    expect(screen.getByLabelText("Xero credit note number").getAttribute("placeholder")).toBe("CN-0123")

    fireEvent.change(screen.getByLabelText("Xero credit note number"), { target: { value: "  CN-0123 " } })
    expect(resolveButton).toHaveProperty("disabled", false)
    fireEvent.click(resolveButton)

    await waitFor(() => expect(submit).toHaveBeenCalledWith({ creditNoteNumber: "CN-0123", reason: "Made the credit note by hand in Xero" }))
    await waitFor(() => expect(screen.queryByLabelText("Xero credit note number")).toBeNull())
  })

  it("stays open while Xero is checked, then shows the refusal in place, keeping what was typed; Enter in the number field submits", async () => {
    let answer!: (refusal: string | null) => void
    const submit = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)))
    render(<Harness submit={submit} />)
    fireEvent.click(screen.getByText("open"))

    const field = await screen.findByLabelText("Xero credit note number")
    fireEvent.change(field, { target: { value: "CN-0999" } })
    fireEvent.keyDown(field, { key: "Enter" })

    const checking = await screen.findByRole("button", { name: "Checking in Xero…" })
    expect(checking).toHaveProperty("disabled", true)
    expect(screen.getByLabelText("Xero credit note number")).toHaveProperty("disabled", true)

    await act(async () => answer("Credit note CN-0999 is already recorded against another refund or booking here."))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/CN-0999 is already recorded/)
    const numberField = screen.getByLabelText("Xero credit note number") as HTMLInputElement
    expect(numberField.value).toBe("CN-0999")
    expect(numberField.getAttribute("aria-describedby")).toBe(alert.id)
    expect(numberField.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByRole("button", { name: "Resolve" })).toHaveProperty("disabled", false)
  })

  it("closes without sending anything when cancelled", async () => {
    const submit = vi.fn(async () => null)
    render(<Harness submit={submit} />)
    fireEvent.click(screen.getByText("open"))
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByLabelText("Xero credit note number")).toBeNull())
    expect(submit).not.toHaveBeenCalled()
  })
})
