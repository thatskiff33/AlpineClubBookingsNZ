// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #4987: the compose page shows who a send will reach before Send is pressed,
// per kind of message, and words the confirmation and the result without
// calling a member who never chose "opted out". The count is the GET on the
// send route, the same query the send uses.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "u1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "view",
          membership: "edit",
          finance: "view",
          lodge: "view",
          content: "view",
          support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}));

import CommunicationsPage from "@/app/(admin)/admin/messages/communications/page";

const PREVIEW = {
  clubNotice: { totalRecipients: 400, eligibleRecipients: 398, optedOut: 2, neverOptedIn: 0 },
  newsletter: { totalRecipients: 400, eligibleRecipients: 3, optedOut: 0, neverOptedIn: 397 },
} as const;

let sendBody: Record<string, unknown> | null = null;
let countedUrls: string[] = [];

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  sendBody = null;
  countedUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/admin/communications/send") {
        if (init?.method === "POST") {
          sendBody = JSON.parse(String(init.body));
          return json({ success: true, ...PREVIEW.newsletter, queued: 3 });
        }
        const category = url.searchParams.get("category") as
          | keyof typeof PREVIEW
          | null;
        if (category) {
          countedUrls.push(`${url.pathname}${url.search}`);
          return json({ limit: 1, windowSeconds: 3600, ...PREVIEW[category] });
        }
        return json({ limit: 1, windowSeconds: 3600 });
      }
      if (url.pathname === "/api/admin/communications/history") {
        return json({ history: [] });
      }
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function preview() {
  return screen.getByTestId("communications-recipient-preview");
}

describe("Communications compose page (#4987)", () => {
  it("asks for the kind of message before it counts recipients or allows a send", async () => {
    render(<CommunicationsPage />);
    fireEvent.change(await screen.findByLabelText(/Subject/i), {
      target: { value: "Lodge closed" },
    });
    fireEvent.change(screen.getByLabelText(/Message Body/i), {
      target: { value: "Closed 14-16 August" },
    });

    expect(preview()).toHaveTextContent(/Choose the kind of message/i);
    expect(screen.getByRole("button", { name: /Send to Members/i })).toBeDisabled();
  });

  it("shows the recipient count for the chosen kind and updates it when the kind changes", async () => {
    render(<CommunicationsPage />);

    fireEvent.click(await screen.findByLabelText(/Club notice/i));
    await waitFor(() =>
      expect(preview()).toHaveTextContent(
        "Will be sent to 398 of 400 people (2 opted out).",
      ),
    );

    fireEvent.click(screen.getByLabelText(/Club newsletter/i));
    await waitFor(() =>
      expect(preview()).toHaveTextContent(
        "Will be sent to 3 of 400 people (397 never opted in).",
      ),
    );
    expect(countedUrls).toEqual([
      "/api/admin/communications/send?recipientFilter=all&category=clubNotice",
      "/api/admin/communications/send?recipientFilter=all&category=newsletter",
    ]);
  });

  it("sends the chosen kind and reports never-opted-in members apart from opted-out ones", async () => {
    render(<CommunicationsPage />);
    fireEvent.change(await screen.findByLabelText(/Subject/i), {
      target: { value: "Winter newsletter" },
    });
    fireEvent.change(screen.getByLabelText(/Message Body/i), {
      target: { value: "News" },
    });
    fireEvent.click(screen.getByLabelText(/Club newsletter/i));
    fireEvent.click(screen.getByRole("button", { name: /Send to Members/i }));

    // The confirmation names the kind of message and says who is left out,
    // each group in its own words.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Kind of message: Club newsletter.");
    expect(dialog).toHaveTextContent("Not sent to: 397 never opted in.");
    expect(sendBody).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send to 3 people" }),
    );

    expect(
      await screen.findByText("Sent to 3 recipients (397 never opted in)."),
    ).toBeInTheDocument();
    expect(sendBody).toMatchObject({ category: "newsletter", recipientFilter: "all" });
  });

  it("asks for a fresh choice of kind once a message has been sent", async () => {
    render(<CommunicationsPage />);
    fireEvent.change(await screen.findByLabelText(/Subject/i), {
      target: { value: "Winter newsletter" },
    });
    fireEvent.change(screen.getByLabelText(/Message Body/i), {
      target: { value: "News" },
    });
    fireEvent.click(screen.getByLabelText(/Club newsletter/i));
    fireEvent.click(screen.getByRole("button", { name: /Send to Members/i }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Send to 3 people",
      }),
    );

    await screen.findByText(/^Sent to 3 recipients/);
    expect(screen.getByLabelText(/Club newsletter/i)).not.toBeChecked();
    expect(screen.getByLabelText(/Club notice/i)).not.toBeChecked();
    expect(preview()).toHaveTextContent(/Choose the kind of message/i);
  });

  // The count for each kind answers only when the test lets it, so the order
  // of the answers is the test's to choose.
  function holdCounts() {
    const answer = new Map<string, () => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/admin/communications/history") {
          return json({ history: [] });
        }
        const category = url.searchParams.get("category") as
          | keyof typeof PREVIEW
          | null;
        if (!category) return json({ limit: 1, windowSeconds: 3600 });
        return new Promise<Response>((resolve) => {
          answer.set(category, () =>
            resolve(json({ limit: 1, windowSeconds: 3600, ...PREVIEW[category] })),
          );
        });
      }),
    );
    return answer;
  }

  it("does not show the previous kind's count while the new kind's count loads", async () => {
    const answer = holdCounts();
    render(<CommunicationsPage />);

    fireEvent.click(await screen.findByLabelText(/Club notice/i));
    await waitFor(() => expect(answer.has("clubNotice")).toBe(true));
    await act(async () => answer.get("clubNotice")!());
    await waitFor(() => expect(preview()).toHaveTextContent("Will be sent to 398 of 400 people"));

    fireEvent.click(screen.getByLabelText(/Club newsletter/i));
    await waitFor(() => expect(answer.has("newsletter")).toBe(true));

    expect(preview()).toHaveTextContent("Counting recipients...");
    expect(preview()).not.toHaveTextContent("398");
  });

  it("drops a count that arrives after a newer choice has replaced it", async () => {
    const answer = holdCounts();
    render(<CommunicationsPage />);

    fireEvent.click(await screen.findByLabelText(/Club notice/i));
    fireEvent.click(screen.getByLabelText(/Club newsletter/i));
    await waitFor(() => expect(answer.has("newsletter")).toBe(true));

    // The newest choice answers first; the earlier one arrives late.
    await act(async () => answer.get("newsletter")!());
    await waitFor(() =>
      expect(preview()).toHaveTextContent(
        "Will be sent to 3 of 400 people (397 never opted in).",
      ),
    );
    await act(async () => answer.get("clubNotice")!());

    expect(preview()).toHaveTextContent(
      "Will be sent to 3 of 400 people (397 never opted in).",
    );
    expect(preview()).not.toHaveTextContent("398");
  });
});
