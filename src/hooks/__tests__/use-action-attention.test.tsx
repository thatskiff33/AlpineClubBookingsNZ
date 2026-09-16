// @vitest-environment jsdom

// The rule that decides where an admin's attention goes after an action (#2934):
// failure wins, success positions at the top of the resulting screen, an editor
// is revealed only for the explicit action that opened it, and a passive
// re-render moves nothing. Each case here is the discriminating test for one
// clause of that rule; the primitives themselves are pinned in
// `src/lib/__tests__/use-scroll-to-feedback.test.ts`.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useActionAttention,
  useRevealAttention,
} from "@/hooks/use-scroll-to-feedback";
import {
  expectRevealed,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
  type ScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

let scrollIntoView: ScrollIntoViewSpy;

beforeEach(() => {
  scrollIntoView = installScrollIntoViewSpy();
});

afterEach(() => {
  cleanup();
  removeScrollIntoViewSpy();
});

function ActionSurface({
  error,
  success,
  attentionKey,
}: {
  error: string;
  success: string;
  attentionKey?: number;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useActionAttention({
    error,
    errorTarget: errorRef,
    attentionKey,
    success,
    successTarget: pageRef,
  });
  return (
    <main style={{ overflowY: "auto" }}>
      <div ref={pageRef} data-testid="page">
        <h1>Settings</h1>
        <div ref={errorRef} role="alert" data-testid="error">
          {error}
        </div>
        <p role="status">{success}</p>
      </div>
    </main>
  );
}

describe("useActionAttention", () => {
  it("focuses the failure when it arrives, and never the success position as well", () => {
    // Both messages land in the same commit, which is what a surface that
    // leaves an earlier success standing produces when the next save fails.
    const view = render(<ActionSurface error="" success="Saved." />);
    const page = view.getByTestId("page");
    const main = page.parentElement as HTMLElement;
    main.scrollTo = vi.fn();
    // The mount carried a success, so the top position ran once for it.
    expect(document.activeElement).toBe(page);
    (main.scrollTo as ReturnType<typeof vi.fn>).mockClear();

    view.rerender(<ActionSurface error="Refused." success="Saved." />);

    const alert = view.getByTestId("error");
    expect(document.activeElement).toBe(alert);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(alert);
    expect(main.scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the failure's position while the failure is showing", () => {
    const view = render(<ActionSurface error="Refused." success="" />);
    const alert = view.getByTestId("error");
    const main = view.getByTestId("page").parentElement as HTMLElement;
    main.scrollTo = vi.fn();
    expect(document.activeElement).toBe(alert);

    // A success arriving alongside a live failure does not displace it — and
    // does not re-run the failure position either: the same failure is one
    // arrival, however many other things change around it.
    view.rerender(<ActionSurface error="Refused." success="Saved." />);

    expect(document.activeElement).toBe(alert);
    expect(main.scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("positions at the top of the resulting screen when a save succeeds", () => {
    const view = render(<ActionSurface error="" success="" />);
    const page = view.getByTestId("page");
    const main = page.parentElement as HTMLElement;
    main.scrollTo = vi.fn();
    expect(document.activeElement).toBe(document.body);

    view.rerender(<ActionSurface error="" success="Saved." />);

    expect(document.activeElement).toBe(page);
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("moves nothing for a passive re-render with the same messages", () => {
    const view = render(<ActionSurface error="Refused." success="" />);
    const alert = view.getByTestId("error");
    const main = view.getByTestId("page").parentElement as HTMLElement;
    main.scrollTo = vi.fn();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // The admin has moved on to fix the problem.
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    view.rerender(<ActionSurface error="Refused." success="" />);
    view.rerender(<ActionSurface error="Refused." success="" />);

    expect(document.activeElement).toBe(input);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(main.scrollTo).not.toHaveBeenCalled();
    expect(alert).toHaveTextContent("Refused.");
    input.remove();
  });

  it("re-takes attention for an identical failure only when the attention key changes", () => {
    const view = render(
      <ActionSurface error="Refused." success="" attentionKey={1} />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Same message, same key: a re-render, not a second refusal.
    view.rerender(
      <ActionSurface error="Refused." success="" attentionKey={1} />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Same message, new key: the retry failed the same way, and the admin who
    // moved away to retry must be brought back.
    view.rerender(
      <ActionSurface error="Refused." success="" attentionKey={2} />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("runs the success position again only when a new success arrives", () => {
    const view = render(<ActionSurface error="" success="Saved." />);
    const main = view.getByTestId("page").parentElement as HTMLElement;
    main.scrollTo = vi.fn();

    view.rerender(<ActionSurface error="" success="Saved." />);
    expect(main.scrollTo).not.toHaveBeenCalled();

    view.rerender(<ActionSurface error="" success="" />);
    view.rerender(<ActionSurface error="" success="Saved." />);
    expect(main.scrollTo).toHaveBeenCalledTimes(1);
  });
});

function Editor({ revealKey }: { revealKey: number | null }) {
  const regionRef = useRef<HTMLDivElement>(null);
  useRevealAttention(regionRef, revealKey);
  return (
    <div>
      <button type="button">Edit</button>
      <div ref={regionRef} data-testid="editor">
        <input aria-label="Name" />
      </div>
    </div>
  );
}

describe("useRevealAttention", () => {
  it("does not reveal an editor that no action has opened", () => {
    render(<Editor revealKey={0} />);
    expect(document.activeElement).toBe(document.body);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals the editor once per explicit open, not per render", () => {
    const view = render(<Editor revealKey={null} />);
    const editor = view.getByTestId("editor");

    view.rerender(<Editor revealKey={1} />);
    expectRevealed(scrollIntoView, editor);

    // The admin tabs into the field; the editor re-renders (a keystroke, a
    // background refresh) with the same key, and must not pull them back out.
    const input = view.getByLabelText("Name");
    act(() => input.focus());
    view.rerender(<Editor revealKey={1} />);
    expect(document.activeElement).toBe(input);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Re-opening — a second explicit action — reveals it again.
    view.rerender(<Editor revealKey={2} />);
    expect(document.activeElement).toBe(editor);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
