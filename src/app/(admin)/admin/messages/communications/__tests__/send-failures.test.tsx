// @vitest-environment jsdom

/**
 * A refused bulk send says why (#4976, ALP-589).
 *
 * The send parsed every reply as JSON and showed the body's `error` bare, so
 * an HTML 502 from the proxy fell into the catch's generic sentence only by
 * accident, and a refusal with no `error` showed an empty result. It now
 * reads a refusal through `apiErrorMessageFromResponse`.
 */

import { cleanup, fireEvent, render, screen, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import CommunicationsPage from "../page";

type Answer = () => Response | Promise<Response>;

const SEND_URL = "/api/admin/communications/send";

function installFetch(send?: Answer) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === SEND_URL && init?.method === "POST") {
      return (send ?? (() => Response.json({ eligibleRecipients: 12, optedOut: 2, neverOptedIn: 0 })))();
    }
    // The count the confirmation names (#4964): a GET that spends no quota.
    if (url.startsWith(`${SEND_URL}?recipientFilter=`)) {
      return Response.json({ totalRecipients: 14, eligibleRecipients: 12, optedOut: 2, neverOptedIn: 0 });
    }
    if (url === SEND_URL) return Response.json({ limit: 500, windowSeconds: 3600 });
    if (url.startsWith("/api/admin/communications/history")) return Response.json({ history: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Submitting the form only opens the confirmation (#4964); the POST that emails
// people waits for the officer to confirm the audience and count.
async function sendAMessage() {
  render(<CommunicationsPage />);
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Working bee" } });
  fireEvent.change(screen.getByLabelText("Message Body"), { target: { value: "Saturday 9am." } });
  // Nothing is preselected (#4987): the sender names the kind of message first.
  fireEvent.click(screen.getByLabelText(/Club newsletter/));
  // The fields are `required`; jsdom holds back a button click on an
  // unvalidated form, so submit the form itself.
  fireEvent.submit(screen.getByLabelText("Subject").closest("form")!);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Send to 12 people" }));
}

describe("sending a bulk message", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
  });

  itShowsEveryRefusal({
    fallback: "Failed to send. Please try again.",
    submit: async (answer) => {
      installFetch(answer);
      await sendAMessage();
    },
  });

  it("shows the fallback for a JSON refusal with no sentence", async () => {
    installFetch(() => Response.json({}, { status: 500 }));
    await sendAMessage();

    expect(await screen.findByText("Failed to send. Please try again.")).toBeInTheDocument();
  });

  it("reports the send and reloads the history", async () => {
    const fetchMock = installFetch();
    await sendAMessage();

    expect(await screen.findByText("Sent to 12 recipients (2 opted out).")).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/admin/communications/history?")),
      ).toHaveLength(2),
    );
  });
});
