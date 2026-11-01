// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  replay: undefined as undefined | { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> },
  replayIntegration: vi.fn(), addIntegration: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  getReplay: () => sentry.replay,
  replayIntegration: sentry.replayIntegration,
  addIntegration: sentry.addIntegration,
}));
import { SentryReplayPolicy } from "@/components/sentry-replay-policy";
import { SENTRY_REPLAY_POLICY_CHANGED, SENTRY_REPLAY_POLICY_PATH } from "@/lib/privacy-retention-replay";

beforeEach(() => {
  sentry.replay = undefined;
  sentry.replayIntegration.mockReset();
  sentry.addIntegration.mockReset().mockImplementation(() => {
    sentry.replay = { start: vi.fn(), stop: vi.fn() };
  });
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://example.invalid");
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("club opt-in for Sentry Replay", () => {
  it("creates no recorder when off, including on an error-capable client", () => {
    render(<SentryReplayPolicy enabled={false} />);
    expect(sentry.replayIntegration).not.toHaveBeenCalled();
    expect(sentry.addIntegration).not.toHaveBeenCalled();
  });
  it("starts only after opt-in, masks content, and stops when disabled", () => {
    const view = render(<SentryReplayPolicy enabled />);
    expect(sentry.replayIntegration).toHaveBeenCalledWith({ maskAllText: true, blockAllMedia: true });
    expect(sentry.replay?.start).toHaveBeenCalledOnce();
    const replay = sentry.replay;
    view.rerender(<SentryReplayPolicy enabled={false} />);
    expect(replay?.stop).toHaveBeenCalled();
  });
  it("stays off without a configured Sentry destination", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    render(<SentryReplayPolicy enabled />);
    expect(sentry.addIntegration).not.toHaveBeenCalled();
  });

  it("refreshes the production policy after a settings save and stops recording", async () => {
    const fetchPolicy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true })));
    vi.stubGlobal("fetch", fetchPolicy);
    render(<SentryReplayPolicy />);
    await waitFor(() => expect(sentry.replay?.start).toHaveBeenCalledOnce());
    expect(fetchPolicy).toHaveBeenCalledWith(SENTRY_REPLAY_POLICY_PATH, { cache: "no-store" });
    const replay = sentry.replay;
    fetchPolicy.mockResolvedValue(new Response(JSON.stringify({ enabled: false })));
    window.dispatchEvent(new Event(SENTRY_REPLAY_POLICY_CHANGED));
    await waitFor(() => expect(replay?.stop).toHaveBeenCalled());
  });

  it("fails closed when refocusing a tab cannot read the current policy", async () => {
    const fetchPolicy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true })));
    vi.stubGlobal("fetch", fetchPolicy);
    render(<SentryReplayPolicy />);
    await waitFor(() => expect(sentry.replay?.start).toHaveBeenCalledOnce());
    const replay = sentry.replay;
    fetchPolicy.mockRejectedValue(new Error("Unavailable"));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(replay?.stop).toHaveBeenCalled());
  });

  it("polls already-open tabs and removes the timer on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fetchPolicy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true })))
      .mockResolvedValue(new Response(JSON.stringify({ enabled: false })));
    vi.stubGlobal("fetch", fetchPolicy);
    let view: ReturnType<typeof render>;
    await act(async () => { view = render(<SentryReplayPolicy />); });
    expect(sentry.replay?.start).toHaveBeenCalledOnce();
    const replay = sentry.replay;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchPolicy).toHaveBeenCalledTimes(2);
    expect(replay?.stop).toHaveBeenCalled();
    view!.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchPolicy).toHaveBeenCalledTimes(2);
  });

  it("ignores an older enabled response arriving after the disabled policy", async () => {
    let respond: (response: Response) => void = () => {};
    const fetchPolicy = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { respond = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ enabled: false })));
    vi.stubGlobal("fetch", fetchPolicy);
    render(<SentryReplayPolicy />);
    await act(async () => { window.dispatchEvent(new Event(SENTRY_REPLAY_POLICY_CHANGED)); });
    await act(async () => { respond(new Response(JSON.stringify({ enabled: true }))); });
    expect(sentry.addIntegration).not.toHaveBeenCalled();
  });
});
