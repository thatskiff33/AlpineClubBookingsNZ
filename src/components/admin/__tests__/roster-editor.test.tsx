// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RosterEditor, type RosterData } from "@/components/admin/roster-editor"
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus"
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy"

/**
 * #2668 — what the editor says when it never read an answer, as opposed to what
 * it says when the SERVER told it the save was refused. Built from the shared
 * helper rather than pasted, so a change to the wording has one place to happen
 * and this suite follows it.
 */
const UNVERIFIED = unverifiedWriteMessage(
  "the roster was saved",
  "Your draft is still here. Reload the roster to see what it holds before saving again.",
)

const BASE: RosterData = {
  date: "2026-08-10",
  lodgeId: "lodge-1",
  revision: "revision-1",
  guestCount: 4,
  guests: [
    { id: "older", bookingId: "booking-a", bookingGroupLabel: "Booking for Aroha Bell", firstName: "Aroha", lastName: "Bell", ageTier: "ADULT" },
    { id: "younger", bookingId: "booking-a", bookingGroupLabel: "Booking for Aroha Bell", firstName: "Mika", lastName: "Bell", ageTier: "CHILD" },
    { id: "unknown-a", bookingId: "booking-b", bookingGroupLabel: "Booking for Taylor Chen", firstName: "Alex", lastName: "Chen", ageTier: "ADULT" },
    { id: "unknown-z", bookingId: "booking-b", bookingGroupLabel: "Booking for Taylor Chen", firstName: "Zoe", lastName: "Chen", ageTier: "YOUTH" },
  ],
  assignments: [
    { id: "a-1", choreTemplateId: "kitchen", choreTemplateName: "Kitchen", choreDescription: null, choreSortOrder: 1, bookingGuestId: "older", guestName: "Aroha Bell", guestAgeTier: "ADULT", bookingId: "booking-a", status: "SUGGESTED" },
    { id: "a-2", choreTemplateId: "wood", choreTemplateName: "Firewood", choreDescription: null, choreSortOrder: 2, bookingGuestId: "older", guestName: "Aroha Bell", guestAgeTier: "ADULT", bookingId: "booking-a", status: "SUGGESTED" },
  ],
  templates: [
    { id: "kitchen", name: "Kitchen", description: null, recommendedPeopleMin: 1, recommendedPeopleMax: 3, isEssential: true, ageRestriction: "ANY", conditionalNote: null, minAge: 0, sortOrder: 1, active: true, isDueOnDate: true },
    { id: "wood", name: "Firewood", description: null, recommendedPeopleMin: 1, recommendedPeopleMax: 1, isEssential: false, ageRestriction: "ANY", conditionalNote: null, minAge: 0, sortOrder: 2, active: true, isDueOnDate: true },
    { id: "bathrooms", name: "Bathrooms", description: null, recommendedPeopleMin: 1, recommendedPeopleMax: 1, isEssential: true, ageRestriction: "ANY", conditionalNote: null, minAge: 0, sortOrder: 3, active: true, isDueOnDate: true },
    { id: "weekly", name: "Weekly check", description: null, recommendedPeopleMin: 1, recommendedPeopleMax: 1, isEssential: false, ageRestriction: "ANY", conditionalNote: null, minAge: 0, sortOrder: 4, active: true, isDueOnDate: false },
  ],
  guestHistory: {},
}

function renderEditor(roster: RosterData = BASE) {
  const onRosterUpdate = vi.fn()
  const onDirtyChange = vi.fn()
  const onEditingChange = vi.fn()
  render(
    <RosterEditor
      roster={roster}
      canEdit
      saveUrl="/api/admin/roster/2026-08-10?lodgeId=lodge-1"
      onRosterUpdate={onRosterUpdate}
      onDirtyChange={onDirtyChange}
      onEditingChange={onEditingChange}
    />,
  )
  return { onRosterUpdate, onDirtyChange, onEditingChange }
}

describe("RosterEditor staged whole-roster editing", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("loads read-only, saves one changed row without swapping another assignment, and re-seeds from the server", async () => {
    const authoritative = {
      ...BASE,
      revision: "revision-2",
      assignments: BASE.assignments.map((assignment) => assignment.id === "a-1"
        ? { ...assignment, bookingGuestId: "unknown-a", bookingId: "booking-b", guestName: "Alex Chen" }
        : assignment),
    }
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(authoritative), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { onRosterUpdate } = renderEditor()

    expect(screen.queryAllByRole("combobox")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[]
    fireEvent.change(selects[0], { target: { value: "unknown-a" } })
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({
      action: "save",
      baseRevision: "revision-1",
      acknowledgeCompletedReset: false,
      assignments: [
        { rowKey: "a-1", assignmentId: "a-1", choreTemplateId: "kitchen", bookingGuestId: "unknown-a" },
        { rowKey: "a-2", assignmentId: "a-2", choreTemplateId: "wood", bookingGuestId: "older" },
      ],
    })
    expect(onRosterUpdate).toHaveBeenCalledWith(authoritative)
    expect(screen.getByText(/Roster saved/)).toBeTruthy()
    expect(screen.queryAllByRole("combobox")).toHaveLength(0)
  })

  it("Cancel restores the complete authoritative snapshot without a request", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const first = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    fireEvent.change(first, { target: { value: "younger" } })
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove assignment/ })[1])
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getAllByText("Aroha Bell").length).toBeGreaterThan(0)
    expect(screen.getByText("Firewood")).toBeTruthy()
  })

  it("keeps Save invalid for an empty new row, explains it beside the dropdown, and focuses that row", () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const kitchen = screen.getByText("Kitchen").closest("div")?.parentElement?.parentElement
    fireEvent.click(within(kitchen as HTMLElement).getByRole("button", { name: "+ Add Person" }))
    const emptySelect = (screen.getAllByRole("combobox") as HTMLSelectElement[]).find((select) => select.value === "")!
    expect(emptySelect).toBe(document.activeElement)
    expect(emptySelect.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByText("Choose a person before saving this roster.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Save roster" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("explains a cleared retained row and gives every row a chore-specific accessible name", () => {
    renderEditor()
    expect(screen.getByRole("heading", { level: 2, name: "Roster assignments" })).toBeTruthy()
    expect(screen.getByRole("heading", { level: 2, name: "Kitchen" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const kitchen = screen.getByRole("combobox", { name: "Person for Kitchen, assignment 1" }) as HTMLSelectElement
    expect(screen.getByRole("button", { name: "Remove assignment 1 from Kitchen" })).toBeTruthy()
    fireEvent.change(kitchen, { target: { value: "" } })
    expect(kitchen.getAttribute("aria-invalid")).toBe("true")
    expect(kitchen.getAttribute("aria-describedby")).toBeTruthy()
    expect(screen.getByText("Choose a person before saving this roster.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Save roster" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("does not enter edit mode when the completed-reset warning is declined, then acknowledges and clears only on Save", async () => {
    const completed = {
      ...BASE,
      assignments: [{ ...BASE.assignments[0], status: "COMPLETED" as const }],
    }
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true)
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...completed,
      revision: "revision-2",
      assignments: [{ ...completed.assignments[0], status: "SUGGESTED" as const }],
    }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor(completed)

    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    expect(screen.queryAllByRole("combobox")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    expect(screen.getAllByRole("combobox")).toHaveLength(1)
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "younger" } })
    expect(screen.getByText(/Cancel leaves completion unchanged/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).acknowledgeCompletedReset).toBe(true)
    expect(confirmMock).toHaveBeenCalledTimes(2)
  })

  it("does not pull focus to an invalid row while the admin is fixing a different one (#2934)", () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const kitchen = screen.getByText("Kitchen").closest("div")?.parentElement?.parentElement
    fireEvent.click(within(kitchen as HTMLElement).getByRole("button", { name: "+ Add Person" }))
    const emptySelect = (screen.getAllByRole("combobox") as HTMLSelectElement[]).find((select) => select.value === "")!
    expect(emptySelect).toBe(document.activeElement)

    // The admin leaves the empty row for later and changes a different, valid
    // row. That re-renders the row errors; it is not a new failure, and focus
    // stays where the admin put it.
    const first = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    first.focus()
    fireEvent.change(first, { target: { value: "younger" } })
    expect(document.activeElement).toBe(first)
    expect(screen.getByText("Choose a person before saving this roster.")).toBeTruthy()
  })

  it("preserves the draft and focuses actionable global and row failures", async () => {
    const stale = "This roster changed while you were editing. Your changes were not saved. Reload the latest roster and try again."
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "ROSTER_STALE", error: stale }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "ROSTER_GUEST_INELIGIBLE",
        error: "Roster not saved. This person is no longer eligible for this lodge night. Choose another person or reload the roster.",
        details: { rowKey: "a-1" },
      }), { status: 400 }))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const first = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    fireEvent.change(first, { target: { value: "younger" } })
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(stale)).toBeTruthy())
    await expectRecoveryAlertToHoldFocus(screen.getByText(stale))
    expect(first.value).toBe("younger")

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(first).toBe(document.activeElement))
    expect(first.value).toBe("younger")
    expect(first.getAttribute("aria-describedby")).toBeTruthy()
  })

  /**
   * #2668. The three attempts here are deliberately three DIFFERENT kinds of
   * failure, and the editor no longer collapses them into one sentence:
   *
   * - 403: the server refused, and said so. It may claim "Roster not saved".
   * - 500 `ROSTER_SERVICE_UNAVAILABLE`: also the server's own answer, so the
   *   same confident copy stands.
   * - a rejected `fetch`: NO answer was read. The request may have arrived and
   *   committed, so the browser claims nothing about the stored roster.
   */
  it("uses exact permission and network save copy while preserving the draft", async () => {
    const permission = "Roster not saved. Your account no longer has Lodge edit access. Ask a full admin to update it."
    const network = "Roster not saved because the service could not be reached. Your draft is still here; try Save again."
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "ROSTER_SERVICE_UNAVAILABLE", error: "internal detail" }), { status: 500 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const first = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    fireEvent.change(first, { target: { value: "younger" } })

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(permission)).toBeTruthy())
    await expectRecoveryAlertToHoldFocus(screen.getByText(permission))
    expect(first.value).toBe("younger")

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(network)).toBeTruthy())
    await expectRecoveryAlertToHoldFocus(screen.getByText(network))
    expect(first.value).toBe("younger")

    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    // #2668: the third attempt is the rejected `fetch`, and it says something
    // different from the two the server answered — the browser read no answer,
    // so it makes no claim about the roster row.
    await waitFor(() => expect(screen.getByText(UNVERIFIED)).toBeTruthy())
    await expectRecoveryAlertToHoldFocus(screen.getByText(UNVERIFIED))
    expect(screen.queryByText(network)).toBeNull()
    expect(first.value).toBe("younger")
  })

  /**
   * #2668 review. A 4xx with no `error` field IS a refusal — the route rejects
   * before it writes — so "Roster not saved" stands. What it is not is a
   * connection problem, and the fallback used to say it was, sending the
   * operator to check their network after the server had just answered them.
   */
  it("names a reason-less refusal as a refusal, not as an unreachable service", async () => {
    const network = "Roster not saved because the service could not be reached. Your draft is still here; try Save again."
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 400 }))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const first = screen.getAllByRole("combobox")[0] as HTMLSelectElement
    fireEvent.change(first, { target: { value: "younger" } })
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))

    const refused = await screen.findByText(/The server refused the save and did not say why/)
    await expectRecoveryAlertToHoldFocus(refused)
    expect(screen.queryByText(network)).toBeNull()
    // Not the unverified copy either: the server answered, so the roster row
    // genuinely did not move.
    expect(screen.queryByText(UNVERIFIED)).toBeNull()
    expect(first.value).toBe("younger")
  })

  /**
   * #2668. The server answered `200 OK`. Whatever it did, it has already done —
   * and it called the save a success. Telling the operator "Roster not saved"
   * here contradicted the only party that knew, which is why this case no
   * longer shares its copy with the genuinely-unreachable service.
   */
  it("treats a malformed successful response as an unread outcome and retains the draft", async () => {
    const network = "Roster not saved because the service could not be reached. Your draft is still here; try Save again."
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const { onRosterUpdate } = renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const first = screen.getByRole("combobox", { name: "Person for Kitchen, assignment 1" }) as HTMLSelectElement
    fireEvent.change(first, { target: { value: "younger" } })
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(UNVERIFIED)).toBeTruthy())
    await expectRecoveryAlertToHoldFocus(screen.getByText(UNVERIFIED))
    expect(screen.queryByText(network)).toBeNull()
    expect(first.value).toBe("younger")
    expect(onRosterUpdate).not.toHaveBeenCalled()
  })

  it("clears failed-draft feedback on Cancel and saved feedback on the next Edit", async () => {
    const network = UNVERIFIED
    const authoritative = {
      ...BASE,
      revision: "revision-2",
      assignments: BASE.assignments.map((assignment) => assignment.id === "a-1"
        ? { ...assignment, bookingGuestId: "younger", guestName: "Mika Bell" }
        : assignment),
    }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify(authoritative), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    fireEvent.change(screen.getByRole("combobox", { name: "Person for Kitchen, assignment 1" }), { target: { value: "younger" } })
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(network)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByText(network)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    fireEvent.change(screen.getByRole("combobox", { name: "Person for Kitchen, assignment 1" }), { target: { value: "younger" } })
    fireEvent.click(screen.getByRole("button", { name: "Save roster" }))
    await waitFor(() => expect(screen.getByText(/Roster saved/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    expect(screen.queryByText(/Roster saved/)).toBeNull()
  })

  it("always shows due staffing and booking-grouped zero/one/two/three assignment checks", () => {
    const roster = {
      ...BASE,
      assignments: [
        ...BASE.assignments,
        { ...BASE.assignments[1], id: "a-3" },
        { ...BASE.assignments[0], id: "a-4", bookingGuestId: "younger", guestName: "Mika Bell", guestAgeTier: "CHILD" },
        { ...BASE.assignments[0], id: "a-5", bookingGuestId: "unknown-a", bookingId: "booking-b", guestName: "Alex Chen" },
        { ...BASE.assignments[1], id: "a-6", bookingGuestId: "unknown-a", bookingId: "booking-b", guestName: "Alex Chen" },
      ],
    }
    renderEditor(roster)
    expect(screen.getByText("Kitchen:").parentElement?.textContent).toBe("Kitchen: 3 assigned — within recommendation 1–3")
    expect(screen.getByText("Firewood:").parentElement?.textContent).toBe("Firewood: 3 assigned — over recommendation 1")
    expect(screen.getByText("Bathrooms:").parentElement?.textContent).toBe("Bathrooms: 0 assigned — under recommendation 1")
    expect(screen.queryByText("Weekly check:")).toBeNull()
    const familyA = screen.getByRole("region", { name: "Booking for Aroha Bell" })
    expect(within(familyA).getByText(/3 assignments: Kitchen, Firewood ×2/)).toBeTruthy()
    expect(within(familyA).getByText(/1 assignment: Kitchen/)).toBeTruthy()
    const familyB = screen.getByRole("region", { name: "Booking for Taylor Chen" })
    expect(within(familyB).getByText(/2 assignments: Kitchen, Firewood/)).toBeTruthy()
    expect(within(familyB).getByText("No chore assigned")).toBeTruthy()
  })

  it("lists everyone in the lodge today, including the people leaving this morning (#2622)", () => {
    const roster: RosterData = {
      ...BASE,
      guests: [
        { ...BASE.guests[0], isDeparting: true },
        { ...BASE.guests[1] },
        { ...BASE.guests[2], isArriving: true },
        { ...BASE.guests[3] },
      ],
    }
    renderEditor(roster)
    fireEvent.click(screen.getByRole("button", { name: "Edit roster" }))
    const options = (screen.getAllByRole("combobox")[0] as HTMLSelectElement).options
    const labels = [...options].map((option) => option.textContent)
    // A departing guest is a selectable person, not a filtered-out one.
    expect(labels).toContain("Aroha Bell (departing today)")
    expect(labels).toContain("Alex Chen (arriving today)")
    expect(labels).toContain("Mika Bell")
    expect(labels).toContain("Zoe Chen")
  })

  it("MUTATION PROBE: badges stay on their own side of midday (#2622)", () => {
    // Swapping the two labels puts "Arriving" on the person who is here this
    // morning, which is the opposite of what the hut leader needs to see.
    const roster: RosterData = {
      ...BASE,
      guests: [
        { ...BASE.guests[0], isDeparting: true },
        { ...BASE.guests[1] },
        { ...BASE.guests[2], isArriving: true },
        { ...BASE.guests[3] },
      ],
    }
    renderEditor(roster)
    const familyA = screen.getByRole("region", { name: "Booking for Aroha Bell" })
    expect(within(familyA).getByText("Departing")).toBeTruthy()
    expect(within(familyA).queryByText("Arriving")).toBeNull()
    const familyB = screen.getByRole("region", { name: "Booking for Taylor Chen" })
    expect(within(familyB).getByText("Arriving")).toBeTruthy()
    expect(within(familyB).queryByText("Departing")).toBeNull()
  })

  it("shows no badge and no time for someone here all day", () => {
    renderEditor()
    expect(screen.queryByText("Arriving")).toBeNull()
    expect(screen.queryByText("Departing")).toBeNull()
    // The midday boundary is definitional (D-M3): no clock time is rendered
    // anywhere, and no "arrives at"/"leaves at" copy exists to render one.
    expect(document.body.textContent).not.toMatch(/\d{1,2}[:.]\d{2}\s*(am|pm)?/i)
    expect(document.body.textContent).not.toMatch(/midday|noon|arrival time/i)
  })
})
