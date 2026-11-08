// @vitest-environment jsdom
/**
 * #4616 (INV-AUTH-008): the "confirm it's you" dialog answers
 * `requireRecentAuth`'s refusal and replays the refused request ONCE, with its
 * body unchanged — so a typed confirmation such as `RESTORE` is neither lost
 * nor acted on twice. `fetch` is the only double: the provider, the hook, the
 * dialog and the refusal detection are the real code.
 */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RecentAuthProvider,
  useRecentAuthFetch,
  type ReplayableRequestInit,
} from "@/components/recent-auth/recent-auth-provider";
import { recentAuthRequiredBody } from "@/lib/recent-auth-policy";

const ACTION_URL = "/api/admin/backups/restore";
const REAUTH_URL = "/api/auth/reauth";
const ACTION_INIT: ReplayableRequestInit = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ confirm: "RESTORE" }),
};

type Reply = () => Response;

const refusal: Reply = () => Response.json(recentAuthRequiredBody(), { status: 403 });
const restored: Reply = () => Response.json({ restored: true }, { status: 200 });

/**
 * A server: the action answers from `actionReplies` in turn; the step-up route
 * offers `methods` and accepts `acceptedSecret`.
 */
function stubServer({
  actionReplies,
  methods = ["TOTP"],
  acceptedSecret = "123456",
}: {
  actionReplies: Reply[];
  methods?: string[];
  acceptedSecret?: string;
}) {
  const replies = [...actionReplies];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === REAUTH_URL && (init?.method ?? "GET") === "GET") {
      return Response.json({ methods });
    }
    if (url === REAUTH_URL) {
      const proof = JSON.parse(String(init?.body)) as { code?: string; password?: string };
      return (proof.code ?? proof.password) === acceptedSecret
        ? Response.json({ ok: true })
        : Response.json({ error: "Invalid code" }, { status: 400 });
    }
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected extra request to ${url}`);
    return reply();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function actionCalls(fetchMock: ReturnType<typeof stubServer>) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === ACTION_URL);
}

function reauthCalls(fetchMock: ReturnType<typeof stubServer>, method: "GET" | "POST") {
  return fetchMock.mock.calls.filter(
    ([input, init]) => String(input) === REAUTH_URL && (init?.method ?? "GET") === method,
  );
}

function RestoreButton({ onResult, label = "Restore" }: { onResult: (r: Response) => void; label?: string }) {
  const send = useRecentAuthFetch();
  return (
    <button type="button" onClick={() => void send(ACTION_URL, ACTION_INIT).then(onResult)}>
      {label}
    </button>
  );
}

async function enterCode(code: string) {
  const field = await screen.findByLabelText("Authenticator code");
  fireEvent.change(field, { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the confirm-it's-you dialog (#4616)", () => {
  it("replays the refused request exactly once, with the same body, after a confirmed app code", async () => {
    const fetchMock = stubServer({ actionReplies: [refusal, restored] });
    const onResult = vi.fn();
    render(
      <RecentAuthProvider>
        <RestoreButton onResult={onResult} />
      </RecentAuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeVisible();
    // Nothing is replayed while the person is still being asked.
    expect(actionCalls(fetchMock)).toHaveLength(1);

    await enterCode("123456");

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    const result = onResult.mock.calls[0]?.[0] as Response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ restored: true });

    const calls = actionCalls(fetchMock);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]?.[1]?.body).toBe(JSON.stringify({ confirm: "RESTORE" }));
    expect(JSON.parse(String(reauthCalls(fetchMock, "POST")[0]?.[1]?.body))).toEqual({
      method: "TOTP",
      code: "123456",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("returns a second refusal as it came, without asking again or sending a third time", async () => {
    const fetchMock = stubServer({ actionReplies: [refusal, refusal] });
    const onResult = vi.fn();
    render(
      <RecentAuthProvider>
        <RestoreButton onResult={onResult} />
      </RecentAuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await enterCode("123456");

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect((onResult.mock.calls[0]?.[0] as Response).status).toBe(403);
    expect(actionCalls(fetchMock)).toHaveLength(2);
    expect(reauthCalls(fetchMock, "GET")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns the original refusal on Cancel, and never sends the request again", async () => {
    const fetchMock = stubServer({ actionReplies: [refusal] });
    const onResult = vi.fn();
    render(
      <RecentAuthProvider>
        <RestoreButton onResult={onResult} />
      </RecentAuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByLabelText("Authenticator code");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    const result = onResult.mock.calls[0]?.[0] as Response;
    expect(result.status).toBe(403);
    // The caller can still read the refusal's message.
    expect(await result.json()).toMatchObject({ error: "Please confirm it's you to continue." });
    expect(actionCalls(fetchMock)).toHaveLength(1);
    expect(reauthCalls(fetchMock, "POST")).toHaveLength(0);
  });

  it("keeps the dialog open on a wrong code, replaying nothing until a right one", async () => {
    const fetchMock = stubServer({ actionReplies: [refusal, restored] });
    const onResult = vi.fn();
    render(
      <RecentAuthProvider>
        <RestoreButton onResult={onResult} />
      </RecentAuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await enterCode("000000");

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid code");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(actionCalls(fetchMock)).toHaveLength(1);
    expect(onResult).not.toHaveBeenCalled();

    await enterCode("123456");
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(actionCalls(fetchMock)).toHaveLength(2);
  });

  it("asks for the password when the server offers only the password", async () => {
    const fetchMock = stubServer({
      actionReplies: [refusal, restored],
      methods: ["PASSWORD"],
      acceptedSecret: "correct horse battery staple",
    });
    const onResult = vi.fn();
    render(
      <RecentAuthProvider>
        <RestoreButton onResult={onResult} />
      </RecentAuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const field = await screen.findByLabelText("Password");
    expect(field).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText("Authenticator code")).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: "correct horse battery staple" } });
    // What is typed never reaches a DOM attribute (SecretInput).
    expect(field).not.toHaveAttribute("value");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(reauthCalls(fetchMock, "POST")[0]?.[1]?.body))).toEqual({
      method: "PASSWORD",
      password: "correct horse battery staple",
    });
    expect(actionCalls(fetchMock)).toHaveLength(2);
  });

  it("sends a request that is not refused once, with no dialog", async () => {
    const fetchMock = stubServer({ actionReplies: [restored] });
    const onResult = vi.fn();
    render(
      <RecentAuthProvider>
        <RestoreButton onResult={onResult} />
      </RecentAuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(actionCalls(fetchMock)).toHaveLength(1);
    expect(reauthCalls(fetchMock, "GET")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks once for two requests refused together, and replays each of them once", async () => {
    const fetchMock = stubServer({ actionReplies: [refusal, refusal, restored, restored] });
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <RecentAuthProvider>
        <RestoreButton onResult={onFirst} label="First" />
        <RestoreButton onResult={onSecond} label="Second" />
      </RecentAuthProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "First" }));
      fireEvent.click(screen.getByRole("button", { name: "Second" }));
    });
    await enterCode("123456");

    await waitFor(() => {
      expect(onFirst).toHaveBeenCalledTimes(1);
      expect(onSecond).toHaveBeenCalledTimes(1);
    });
    expect((onFirst.mock.calls[0]?.[0] as Response).status).toBe(200);
    expect((onSecond.mock.calls[0]?.[0] as Response).status).toBe(200);
    expect(actionCalls(fetchMock)).toHaveLength(4);
    expect(reauthCalls(fetchMock, "GET")).toHaveLength(1);
    expect(reauthCalls(fetchMock, "POST")).toHaveLength(1);
  });

  it("refuses to run outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<RestoreButton onResult={vi.fn()} />)).toThrow(
      "useRecentAuthFetch needs a RecentAuthProvider above it",
    );
  });
});
