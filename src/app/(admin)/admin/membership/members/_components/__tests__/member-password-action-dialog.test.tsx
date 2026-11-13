// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemberPasswordActionDialog } from "../member-password-action-dialog"
import type { PasswordActionTarget } from "../../_types"

const inviteTarget: PasswordActionTarget = {
  label: "2 members",
  inviteIds: ["m1", "m2"],
  resendInviteIds: [],
  resetIds: [],
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("MemberPasswordActionDialog — in-dialog progress / errors (#1446)", () => {
  it("shows in-dialog progress while invites are sending", async () => {
    let resolveFetch: (value: Response) => void = () => {}
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
    vi.stubGlobal("fetch", fetchMock)

    render(
      <MemberPasswordActionDialog
        open
        target={inviteTarget}
        onOpenChange={vi.fn()}
        onComplete={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Send Invite" }))

    await waitFor(() => {
      expect(screen.getByText(/Sending 2 invite\(s\)/)).toBeInTheDocument()
    })

    // Let the in-flight request settle so React state updates are flushed.
    resolveFetch(
      jsonResponse({
        sent: 2,
        failed: 0,
        skipped: 0,
        results: [
          { memberId: "m1", email: "a@test.com", name: "Alice A", status: "sent" },
          { memberId: "m2", email: "b@test.com", name: "Bob B", status: "sent" },
        ],
      })
    )
    await waitFor(() => {
      expect(screen.queryByText(/Sending 2 invite\(s\)/)).not.toBeInTheDocument()
    })
  })

  it("keeps the dialog open and shows failures inside it on a pure failure, and Retry re-runs the send", async () => {
    const failBody = {
      sent: 0,
      failed: 2,
      skipped: 0,
      results: [
        { memberId: "m1", email: "a@test.com", name: "Alice A", status: "failed", error: "Email delivery failed" },
        { memberId: "m2", email: "b@test.com", name: "Bob B", status: "failed", error: "Email delivery failed" },
      ],
    }
    const fetchMock = vi.fn(async () => jsonResponse(failBody))
    vi.stubGlobal("fetch", fetchMock)

    const onOpenChange = vi.fn()
    const onComplete = vi.fn()
    render(
      <MemberPasswordActionDialog
        open
        target={inviteTarget}
        onOpenChange={onOpenChange}
        onComplete={onComplete}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Send Invite" }))

    await waitFor(() => {
      expect(screen.getByText(/2 setup invite\(s\) failed to send/)).toBeInTheDocument()
    })
    // Failures are surfaced inside the dialog, listing each affected member.
    expect(screen.getByText(/Alice A/)).toBeInTheDocument()
    expect(screen.getByText(/Bob B/)).toBeInTheDocument()
    // Pure failure: the dialog stays open (never auto-closed) and no success toast fired.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(onComplete).not.toHaveBeenCalled()

    // Retry re-runs the send, targeting the failed members.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    const secondCallBody = JSON.parse(String(calls[1][1].body))
    expect(secondCallBody.memberIds).toEqual(["m1", "m2"])
  })

  it("auto-closes and fires the success toast on a full success", async () => {
    const okBody = {
      sent: 2,
      failed: 0,
      skipped: 0,
      results: [
        { memberId: "m1", email: "a@test.com", name: "Alice A", status: "sent" },
        { memberId: "m2", email: "b@test.com", name: "Bob B", status: "sent" },
      ],
    }
    const fetchMock = vi.fn(async () => jsonResponse(okBody))
    vi.stubGlobal("fetch", fetchMock)

    const onOpenChange = vi.fn()
    const onComplete = vi.fn()
    render(
      <MemberPasswordActionDialog
        open
        target={inviteTarget}
        onOpenChange={onOpenChange}
        onComplete={onComplete}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Send Invite" }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(onComplete).toHaveBeenCalledWith(expect.stringContaining("Sent 2 setup invite(s)."))
  })
})
