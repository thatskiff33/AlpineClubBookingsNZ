// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
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

beforeEach(() => {
  sentry.replay = undefined;
  sentry.replayIntegration.mockReset();
  sentry.addIntegration.mockReset().mockImplementation(() => {
    sentry.replay = { start: vi.fn(), stop: vi.fn() };
  });
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://example.invalid");
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

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
});
