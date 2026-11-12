// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  A bulk member email states its audience and recipient count before it sends
  (#4964). Submitting the form — the button, or Enter in Subject — only reads
  the count (a GET that spends no quota) and opens the confirmation dialog; the
  POST that emails people waits for the officer to confirm.
*/

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

import CommunicationsPage from "../page";

const SEND_URL = "/api/admin/communications/send";

type Answer = { status?: number; body: unknown } | "network-error";

let countAnswer: Answer;
let fetchMock: ReturnType<typeof vi.fn>;

function json({ status = 200, body }: { status?: number; body: unknown }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  countAnswer = {
    body: {
      limit: 1,
      windowSeconds: 3600,
      recipientFilter: "all",
      totalRecipients: 320,
      eligibleRecipients: 312,
    },
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/admin/communications/history")) {
      return json({ body: { history: [] } });
    }
    if (url === SEND_URL && init?.method === "POST") {
      return json({
        body: {
          success: true,
          totalRecipients: 320,
          eligibleRecipients: 312,
          queued: 312,
          filteredByPreference: 8,
        },
      });
    }
    if (url === SEND_URL) {
      return json({ body: { limit: 1, windowSeconds: 3600 } });
    }
    if (url.startsWith(`${SEND_URL}?recipientFilter=`)) {
      if (countAnswer === "network-error") throw new TypeError("offline");
      return json(countAnswer);
    }
    throw new Error(`Unstubbed fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function postCalls() {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );
}

async function compose(subject = "Lodge closed this weekend") {
  render(<CommunicationsPage />);
  const subjectInput = await screen.findByLabelText("Subject");
  fireEvent.change(subjectInput, { target: { value: subject } });
  fireEvent.change(screen.getByLabelText("Message Body"), {
    target: { value: "The road is shut." },
  });
  return subjectInput as HTMLInputElement;
}

// The result region, not the view-only banner's (also role="status").
function resultRegion() {
  const region = screen.getByTestId("send-result");
  expect(region).toHaveAttribute("role", "status");
  return region;
}

function pressSend() {
  fireEvent.click(screen.getByRole("button", { name: "Send to Members" }));
}

describe("CommunicationsPage confirmation step (#4964)", () => {
  it("opens a dialog naming the count, audience and subject, and sends nothing yet", async () => {
    await compose();
    pressSend();

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Send this email to 312 people?"),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Audience: All Active Members");
    expect(dialog).toHaveTextContent('Subject: "Lodge closed this weekend"');
    expect(fetchMock).toHaveBeenCalledWith(
      `${SEND_URL}?recipientFilter=all`,
    );
    expect(postCalls()).toHaveLength(0);
  });

  it("treats Enter in Subject (the form's implicit submit) the same way", async () => {
    const subjectInput = await compose();
    // jsdom has no implicit submission, so dispatch the submit Enter causes.
    fireEvent.submit(subjectInput.form!);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(postCalls()).toHaveLength(0);
  });

  it("focuses Cancel first, and cancelling sends nothing", async () => {
    await compose();
    pressSend();

    const dialog = await screen.findByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    fireEvent.click(cancel);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(postCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Send to Members" })).toBeEnabled();
  });

  it("sends exactly once on confirm and announces the result", async () => {
    await compose();
    pressSend();

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send to 312 people" }),
    );

    await waitFor(() =>
      expect(resultRegion()).toHaveTextContent("Sent to 312 recipients (8 opted out)."),
    );
    expect(postCalls()).toHaveLength(1);
    expect(JSON.parse(postCalls()[0][1].body as string)).toEqual({
      subject: "Lodge closed this weekend",
      body: "The road is shut.",
      recipientFilter: "all",
    });
  });

  it("offers no send when nobody would receive it", async () => {
    countAnswer = {
      body: { limit: 1, windowSeconds: 3600, totalRecipients: 3, eligibleRecipients: 0 },
    };
    await compose();
    pressSend();

    await waitFor(() =>
      expect(resultRegion()).toHaveTextContent(
        /nobody would receive this\. Nothing was sent\./,
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(postCalls()).toHaveLength(0);
  });

  it.each<[string, Answer]>([
    ["the count is refused", { status: 500, body: { error: "boom" } }],
    ["the network fails", "network-error"],
  ])("offers no send when %s", async (_case, answer) => {
    countAnswer = answer;
    await compose();
    pressSend();

    await waitFor(() =>
      expect(resultRegion()).toHaveTextContent(
        /Could not check how many people would receive this email, so nothing was sent\./,
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(postCalls()).toHaveLength(0);
  });

  it("keeps the status region mounted before any result", async () => {
    await compose();
    expect(resultRegion()).toBeEmptyDOMElement();
  });

  it("explains who the selected audience reaches", async () => {
    await compose();
    expect(screen.getByText(/^Every active account, including admin, lodge, school/)).toBeInTheDocument();
  });
});
