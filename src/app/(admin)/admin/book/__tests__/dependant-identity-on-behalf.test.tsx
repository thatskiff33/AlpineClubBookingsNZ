// @vitest-environment jsdom

/*
  #2721 (`INV-GUEST-019`) — the OFFICER is asked the own-dependant question too.

  ## What this pins, and why it is a screen test rather than a unit one

  The owner's decision (D1 option A, 15 Sep 2026) removed the authorised
  on-behalf exemption from the server guard. That alone would have made things
  worse rather than better: an officer typing a name matching one of the
  member's dependants would be refused with nowhere to answer, which blocks the
  booking instead of redirecting it. The decision says so in as many words — the
  control is part of the work.

  So what has to hold is not "the guard runs" (the route suite owns that) but
  "the officer can answer it here": the question is drawn on the guest step, the
  step will not be left while it is unanswered, and each of the two answers does
  what it says — one moves the row to the member path, the other sends the
  declaration the server accepts.

  ## The candidate set is the MEMBER's, which is half the rule

  Every dependant name on this screen comes from the on-behalf family picker,
  keyed on the member the booking is FOR. An officer must never be shown their
  own family's names on somebody else's booking, and a set derived from the
  officer would also miss every real collision. The picker request is asserted
  directly, because a screen showing no names is indistinguishable from a screen
  asking about the right family and finding nothing.
*/

import "@testing-library/jest-dom/vitest"
import { useEffect } from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const LODGES = [{ id: "lodge-a", name: "Lodge A" }]

/** The member this booking is for, and their recorded dependant. */
const MEMBER = {
  id: "member-1",
  firstName: "Alex",
  lastName: "Member",
  email: "alex@example.test",
  ageTier: "ADULT",
}
const OWN_DEPENDANT = { id: "dep-sam", firstName: "Sam", lastName: "Member" }

/** A SECOND member the officer might switch to, with a dependant of their own. */
const OTHER_MEMBER = {
  id: "member-2",
  firstName: "Blair",
  lastName: "Other",
  email: "blair@example.test",
  ageTier: "ADULT",
}
const OTHER_DEPENDANT = { id: "dep-kim", firstName: "Kim", lastName: "Other" }

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

/*
  PARTIAL, not a replacement: `ViewOnlyActionButton` reads
  `ADMIN_VIEW_ONLY_ACTION_REASON` from this module at render time, and this test
  reaches the review step where that button lives. A wholesale mock throws there
  — the widened-module-graph failure `AGENTS.md` names.
*/
vi.mock(import("@/hooks/use-admin-area-edit-access"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAdminAreaEditAccess: () => true,
}))

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 30 }),
}))

/*
  Both members stay pickable after a selection, so a test can switch owners while
  the first owner's family request is still in flight — the race in which one
  family's dependant NAMES can land on another family's booking.
*/
vi.mock("@/components/admin/member-picker", () => ({
  MemberPicker: ({
    selected,
    onSelect,
  }: {
    selected?: { firstName: string } | null
    onSelect: (member: typeof MEMBER) => void
  }) => (
    <div>
      {selected ? <span>Booking for {selected.firstName}</span> : null}
      <button onClick={() => onSelect(MEMBER)}>Pick member</button>
      <button onClick={() => onSelect(OTHER_MEMBER)}>Pick other member</button>
    </div>
  ),
}))

vi.mock("@/components/admin/non-member-contact-form", () => ({
  NonMemberContactForm: () => null,
}))

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: LODGES,
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
  LodgeSelect: ({
    value,
    onChange,
  }: {
    value: string | null
    onChange: (lodgeId: string | null) => void
  }) => {
    useEffect(() => {
      if (value === null) onChange("lodge-a")
    }, [onChange, value])
    return <div data-testid="lodge-select" />
  },
}))

vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: ({
    onDateSelect,
  }: {
    onDateSelect: (checkIn: string, checkOut: string) => Promise<void>
  }) => (
    <button
      type="button"
      onClick={() => void onDateSelect("2026-08-10", "2026-08-12")}
    >
      Choose dates
    </button>
  ),
}))

/*
  A guest-form stub that reports the party back, so the relink assertion can read
  what the panel actually did to the row rather than how it was rendered. The
  "second row" button seeds a party whose colliding row is NOT first: identity
  resolved positionally would convert the wrong person, and this is the shape
  that shows it.
*/
type StubGuest = {
  firstName: string
  lastName: string
  ageTier: string
  isMember: boolean
  memberId?: string
}
vi.mock("@/components/guest-form", () => ({
  GuestForm: ({
    guests,
    onGuestsChange,
  }: {
    guests: StubGuest[]
    onGuestsChange: (guests: StubGuest[]) => void
  }) => (
    <div data-testid="guest-form" data-party={JSON.stringify(guests)}>
      <button
        type="button"
        onClick={() =>
          onGuestsChange([
            {
              firstName: "Sam",
              lastName: "Member",
              ageTier: "CHILD",
              isMember: false,
            },
          ])
        }
      >
        Type Sam Member
      </button>
      <button
        type="button"
        onClick={() =>
          onGuestsChange([
            {
              firstName: "Robin",
              lastName: "Visitor",
              ageTier: "ADULT",
              isMember: false,
            },
            {
              firstName: "Sam",
              lastName: "Member",
              ageTier: "CHILD",
              isMember: false,
            },
          ])
        }
      >
        Type a visitor then Sam Member
      </button>
      <button
        type="button"
        onClick={() =>
          onGuestsChange([
            {
              firstName: "Robin",
              lastName: "Visitor",
              ageTier: "ADULT",
              isMember: false,
            },
          ])
        }
      >
        Type an unrelated guest
      </button>
      <button
        type="button"
        onClick={() =>
          onGuestsChange([
            {
              firstName: "Kim",
              lastName: "Other",
              ageTier: "CHILD",
              isMember: false,
            },
          ])
        }
      >
        Type Kim Other
      </button>
    </div>
  ),
}))

vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => null,
}))

import AdminBookPage from "@/app/(admin)/admin/book/page"
import { DIFFERENT_PERSON_SAME_NAME } from "@/lib/booking-dependant-identity"

function response(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as Response
}

let fetchMock: ReturnType<typeof vi.fn>
let familyPayload: {
  familyMembers: unknown[]
  ownDependants: typeof OWN_DEPENDANT[]
}
let createResponse: Response

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit
  return JSON.parse(String(init.body))
}

function callsTo(fragment: string) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).includes(fragment),
  )
}

beforeEach(() => {
  familyPayload = { familyMembers: [], ownDependants: [OWN_DEPENDANT] }
  createResponse = response({ id: "booking-new" })
  fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes("/api/admin/bookings/eligible-family")) {
      return response(familyPayload)
    }
    if (url.includes("/api/availability/check")) {
      return response({
        minAvailable: 20,
        lodgeCapacity: 30,
        nightDetails: [{ occupiedBeds: 10, availableBeds: 20 }],
      })
    }
    if (url.includes("/api/payments/options")) {
      return response({ methods: { internetBanking: { enabled: false } } })
    }
    if (url.includes("/api/bookings/quote")) {
      return response({
        guests: [{ ageTier: "CHILD", isMember: false, nights: 2, priceCents: 0 }],
        totalPriceCents: 0,
        availableCreditCents: 0,
      })
    }
    if (url.includes("/api/bookings")) {
      return createResponse
    }
    return response({})
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** Select the member, pick dates, and land on the guest step. */
async function reachGuestStep() {
  render(<AdminBookPage />)
  fireEvent.click(screen.getByRole("button", { name: "Pick member" }))
  await waitFor(() => expect(callsTo("eligible-family")).toHaveLength(1))
  fireEvent.click(screen.getByRole("button", { name: "Choose dates" }))
  await screen.findByTestId("guest-form")
}

function party(): StubGuest[] {
  return JSON.parse(
    screen.getByTestId("guest-form").getAttribute("data-party") ?? "[]",
  )
}

describe("admin booking on behalf — own-dependant identity (#2721)", () => {
  it("asks the officer the question when a typed name is one of the member's dependants", async () => {
    await reachGuestStep()

    fireEvent.click(screen.getByRole("button", { name: "Type Sam Member" }))

    // Third person throughout: the dependant is the member's, and the officer is
    // not the parent, so "your dependant" would be wrong in both halves.
    expect(
      await screen.findByText("Is this Alex's own family member?"),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Sam Member is recorded as Alex's dependant\./),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "This is a different person with the same name",
      }),
    ).toBeInTheDocument()
  })

  it("asks nothing at all about a guest who is nobody's dependant", async () => {
    await reachGuestStep()

    fireEvent.click(
      screen.getByRole("button", { name: "Type an unrelated guest" }),
    )

    await waitFor(() =>
      expect(party()).toEqual([
        expect.objectContaining({ firstName: "Robin" }),
      ]),
    )
    expect(
      screen.queryByText("Is this Alex's own family member?"),
    ).not.toBeInTheDocument()
  })

  it("will not leave the guest step while the question is unanswered", async () => {
    await reachGuestStep()
    fireEvent.click(screen.getByRole("button", { name: "Type Sam Member" }))
    await screen.findByText("Is this Alex's own family member?")

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    // No price was even asked for: the party is stopped while it is still a
    // proposal, before anything downstream reads it.
    await waitFor(() => expect(callsTo("/api/bookings/quote")).toHaveLength(0))
    expect(screen.getByTestId("guest-form")).toBeInTheDocument()
    expect(
      screen.getByText(
        /has the same name as somebody recorded as this member's own dependant/,
      ),
    ).toBeInTheDocument()
  })

  it("sends the declaration naming that dependant once the officer answers 'different person'", async () => {
    await reachGuestStep()
    fireEvent.click(screen.getByRole("button", { name: "Type Sam Member" }))
    await screen.findByText("Is this Alex's own family member?")

    fireEvent.click(
      screen.getByRole("button", {
        name: "This is a different person with the same name",
      }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(callsTo("/api/bookings/quote")).toHaveLength(1))

    fireEvent.click(screen.getByRole("button", { name: "Save as Draft" }))
    await waitFor(() =>
      expect(
        callsTo("/api/bookings").filter(
          ([input]) => !String(input).includes("quote"),
        ),
      ).toHaveLength(1),
    )

    const createCall = callsTo("/api/bookings").find(
      ([input]) => !String(input).includes("quote"),
    )!
    expect(bodyOf(createCall)).toMatchObject({
      forMemberId: MEMBER.id,
      dependantIdentityDeclarations: [
        {
          kind: DIFFERENT_PERSON_SAME_NAME,
          dependantMemberId: OWN_DEPENDANT.id,
          normalizedName: "sam member",
        },
      ],
    })
  })

  it("moves the row to the member path on 'this is the member's dependant', and picks it by NAME", async () => {
    // The dependant is in the family picker's list, so the member-path answer is
    // open. The colliding row is SECOND: an answer resolved by position would
    // convert the visitor in front of it.
    familyPayload = {
      familyMembers: [
        { ...OWN_DEPENDANT, ageTier: "CHILD", relationship: "dependent" },
      ],
      ownDependants: [OWN_DEPENDANT],
    }
    await reachGuestStep()
    fireEvent.click(
      screen.getByRole("button", { name: "Type a visitor then Sam Member" }),
    )
    await screen.findByText("Is this Alex's own family member?")

    fireEvent.click(
      screen.getByRole("button", {
        name: "This is Alex's dependant — book them as a member",
      }),
    )

    await waitFor(() =>
      expect(party()).toEqual([
        expect.objectContaining({ firstName: "Robin", isMember: false }),
        expect.objectContaining({
          firstName: "Sam",
          isMember: true,
          memberId: OWN_DEPENDANT.id,
        }),
      ]),
    )
    // The row in FRONT of the collision is untouched. A positional answer would
    // have put the dependant's member link on the visitor.
    expect(party()[0]).not.toHaveProperty("memberId")
    // Answered by moving the person, so the question is gone rather than ticked.
    expect(
      screen.queryByText("Is this Alex's own family member?"),
    ).not.toBeInTheDocument()
  })

  it("says what to do when the dependant is recorded but not in the member's family group", async () => {
    // The parent link and family-group membership are different columns, and
    // divergence is ordinary. An officer CAN fix this one, unlike the member.
    await reachGuestStep()
    fireEvent.click(screen.getByRole("button", { name: "Type Sam Member" }))
    await screen.findByText("Is this Alex's own family member?")

    expect(
      screen.getByText(/Put them in the family group under Membership/),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: "This is Alex's dependant — book them as a member",
      }),
    ).not.toBeInTheDocument()
  })

  it("asks the picker about the member the booking is FOR, and draws only that member's names", async () => {
    await reachGuestStep()

    const [input] = callsTo("eligible-family")[0]!
    expect(String(input)).toContain(`forMemberId=${MEMBER.id}`)

    // And nothing else is asked: one request, for one named member. A screen
    // that derived the candidate set from the signed-in officer would both miss
    // every real collision here and disclose another family's names.
    expect(callsTo("eligible-family")).toHaveLength(1)
  })

  it("never lets a slow response for the PREVIOUS member put their dependants on this booking", async () => {
    /*
      The disclosure hazard under a race. An officer who changes their mind about
      who the booking is for leaves the first member's family request in flight;
      if it lands last it writes that family's dependant NAMES onto the second
      member's booking — and every one of them then draws a question about a
      person who has nothing to do with this stay.
    */
    let releaseFirst: (() => void) | null = null
    const firstLanded = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes("eligible-family")) {
        if (url.includes(MEMBER.id)) {
          await firstLanded
          return response({ familyMembers: [], ownDependants: [OWN_DEPENDANT] })
        }
        return response({ familyMembers: [], ownDependants: [OTHER_DEPENDANT] })
      }
      if (url.includes("/api/availability/check")) {
        return response({
          minAvailable: 20,
          lodgeCapacity: 30,
          nightDetails: [{ occupiedBeds: 10, availableBeds: 20 }],
        })
      }
      return response({})
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<AdminBookPage />)
    fireEvent.click(screen.getByRole("button", { name: "Pick member" }))
    fireEvent.click(screen.getByRole("button", { name: "Pick other member" }))
    await waitFor(() => expect(callsTo("eligible-family")).toHaveLength(2))
    await act(async () => {
      releaseFirst?.()
      await firstLanded
    })

    fireEvent.click(screen.getByRole("button", { name: "Choose dates" }))
    await screen.findByTestId("guest-form")

    // The second member's own dependant still raises the question...
    fireEvent.click(screen.getByRole("button", { name: "Type Kim Other" }))
    expect(
      await screen.findByText("Is this Blair's own family member?"),
    ).toBeInTheDocument()

    // ...and the first member's does not, because their late response wrote
    // nothing. Both halves are asserted: a screen that simply never draws the
    // question would satisfy the second on its own.
    fireEvent.click(screen.getByRole("button", { name: "Type Sam Member" }))
    await waitFor(() =>
      expect(
        screen.queryByText("Is this Blair's own family member?"),
      ).not.toBeInTheDocument(),
    )
    expect(screen.queryByText(/Sam Member is recorded as/)).not.toBeInTheDocument()
  })

  it("sends the officer back to the guest step when the server refuses a stale party", async () => {
    // The screen gates first, so this is reached only from a stale tab — but it
    // is the state where "answer the question" is useless advice unless the step
    // can now draw it, which is why the handler refetches the picker.
    createResponse = response(
      {
        code: "DEPENDANT_IDENTITY_UNRESOLVED",
        error: "stale party refused",
      },
      { ok: false, status: 409 },
    )
    await reachGuestStep()
    fireEvent.click(
      screen.getByRole("button", { name: "Type an unrelated guest" }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(callsTo("/api/bookings/quote")).toHaveLength(1))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save as Draft" }))
    })

    expect(await screen.findByTestId("guest-form")).toBeInTheDocument()
    await waitFor(() => expect(callsTo("eligible-family")).toHaveLength(2))
  })
})
