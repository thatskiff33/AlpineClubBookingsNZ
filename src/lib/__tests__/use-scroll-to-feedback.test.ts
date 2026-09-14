// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNearestScrollContainer,
  resolveScrollBehavior,
  revealEditor,
  scrollToError,
  scrollToTop,
} from "@/hooks/use-scroll-to-feedback";

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && matches,
      media: query,
    })),
  );
}

describe("use-scroll-to-feedback", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects the nearest scrollable ancestor instead of the window", () => {
    const outer = document.createElement("main");
    outer.style.overflowY = "auto";
    const inner = document.createElement("section");
    const feedback = document.createElement("div");
    inner.append(feedback);
    outer.append(inner);
    document.body.append(outer);

    const scrollTo = vi.fn();
    outer.scrollTo = scrollTo;

    expect(getNearestScrollContainer(feedback)).toBe(outer);

    scrollToTop({ current: feedback });

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("success positioning focuses the resulting page or card, not only the scroll container", () => {
    // #2934: a mouse user sees the page jump to the top; a keyboard or
    // screen-reader user needs a focus target there too, or their cursor is
    // still on the Save button they pressed, wherever that now is.
    const outer = document.createElement("main");
    outer.style.overflowY = "auto";
    const page = document.createElement("div");
    outer.append(page);
    document.body.append(outer);
    outer.scrollTo = vi.fn();

    scrollToTop({ current: page });

    expect(page.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(page);
  });

  it("focuses and scrolls the feedback element with sticky-nav spacing", () => {
    const feedback = document.createElement("div");
    feedback.id = "feedback";
    document.body.append(feedback);

    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    feedback.focus = focus;
    feedback.scrollIntoView = scrollIntoView;

    scrollToError("#feedback");

    expect(feedback.getAttribute("tabindex")).toBe("-1");
    expect(feedback.style.scrollMarginTop).toBe("5rem");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("centres a recovery alert when asked to", () => {
    const alert = document.createElement("div");
    alert.scrollIntoView = vi.fn();
    document.body.append(alert);

    scrollToError(alert, { block: "center" });

    expect(alert.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("never drops a natively focusable control out of the tab order", () => {
    // The failure target can be the invalid control itself. `tabIndex` is 0 for
    // a select even with no attribute, so writing `tabindex="-1"` onto it would
    // silently remove it from the sequential tab order.
    const select = document.createElement("select");
    select.scrollIntoView = vi.fn();
    document.body.append(select);

    scrollToError(select);

    expect(select.hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).toBe(select);
  });

  it("reveals an editor region by focusing it and bringing it under the sticky header", () => {
    const region = document.createElement("section");
    region.scrollIntoView = vi.fn();
    document.body.append(region);

    revealEditor({ current: region });

    expect(document.activeElement).toBe(region);
    expect(region.getAttribute("tabindex")).toBe("-1");
    expect(region.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("does nothing for a target that is not mounted", () => {
    expect(() => revealEditor({ current: null })).not.toThrow();
    expect(() => scrollToError(null)).not.toThrow();
    expect(() => scrollToTop(undefined)).not.toThrow();
  });

  describe("reduced motion", () => {
    it("is a smooth scroll when the platform states no preference", () => {
      stubReducedMotion(false);
      expect(resolveScrollBehavior()).toBe("smooth");
    });

    it("is an instant jump under prefers-reduced-motion, on every primitive", () => {
      stubReducedMotion(true);
      expect(resolveScrollBehavior()).toBe("auto");

      const outer = document.createElement("main");
      outer.style.overflowY = "auto";
      outer.scrollTo = vi.fn();
      const target = document.createElement("div");
      target.scrollIntoView = vi.fn();
      outer.append(target);
      document.body.append(outer);

      scrollToError(target);
      revealEditor(target);
      scrollToTop(target);

      expect(target.scrollIntoView).toHaveBeenNthCalledWith(1, {
        behavior: "auto",
        block: "start",
      });
      expect(target.scrollIntoView).toHaveBeenNthCalledWith(2, {
        behavior: "auto",
        block: "start",
      });
      expect(outer.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    });
  });
});
