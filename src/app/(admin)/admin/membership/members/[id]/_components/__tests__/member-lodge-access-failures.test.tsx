// @vitest-environment jsdom

/**
 * A failed lodge-access load or save says why (ALP-649, #4976 follow-up).
 *
 * Both requests parsed the reply as JSON before checking `ok`, so an HTML
 * error page from the proxy in front of the app reached the officer as a JSON
 * parse error. Each now throws the refusal through `apiRefusalFromResponse`:
 * the route's own sentence when it sent one, this card's fallback otherwise,
 * and the fallback again when the request never arrives.
 */

import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases"

vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/components/lodge-select")),
  useLodgeOptions: () => ({
    lodges: LODGES,
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
}))

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}))

import { MemberLodgeAccessCard } from "../member-lodge-access-card"

const LODGES = [
  { id: "lodge-a", name: "Lodge A" },
  { id: "lodge-b", name: "Lodge B" },
]

type Answer = () => Response | Promise<Response>

const GRANTS = () =>
  Response.json({ lodgeAccess: [{ id: "grant-1", lodgeId: "lodge-a", kind: "BOOKING_RESTRICTION" }] })

function stubFetch({ load = GRANTS, save = GRANTS }: { load?: Answer; save?: Answer }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT" ? save() : load(),
    ),
  )
}

async function saveAccess(answer: Answer) {
  stubFetch({ save: answer })
  render(<MemberLodgeAccessCard memberId="member-1" />)
  fireEvent.click(await screen.findByRole("button", { name: "Save Lodge Access" }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Member lodge access: a failed load says why", () => {
  itShowsEveryRefusal({
    submit: async (answer) => {
      stubFetch({ load: answer })
      render(<MemberLodgeAccessCard memberId="member-1" />)
    },
    fallback: "Failed to load lodge access",
  })

  it("ticks the stored grants when the load succeeds", async () => {
    stubFetch({})
    render(<MemberLodgeAccessCard memberId="member-1" />)
    expect(await screen.findByRole("button", { name: "Save Lodge Access" })).toBeInTheDocument()
    expect(screen.getAllByLabelText("Lodge A")[0]).toBeChecked()
  })
})

describe("Member lodge access: a refused save says why", () => {
  itShowsEveryRefusal({ submit: saveAccess, fallback: "Failed to save lodge access" })

  it("confirms a successful save", async () => {
    await saveAccess(GRANTS)
    expect(await screen.findByText("Lodge access saved.")).toBeInTheDocument()
  })
})
