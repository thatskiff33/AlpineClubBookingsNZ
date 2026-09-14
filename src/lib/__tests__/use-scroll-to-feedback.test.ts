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

  it("centres a recovery alert when asked to, WITHOUT sticky-header clearance", () => {
    // The 5rem is clearance for `block: "start"`, where it pushes the target
    // down from under the sticky admin header. Under `block: "center"` the
    // browser centres the box PLUS its scroll margin, so the same 5rem shifts
    // the alert about 2.5rem below the centre it asked for — on all sixteen
    // `FocusedActionError` surfaces, member-facing ones included.
    const alert = document.createElement("div");
    alert.scrollIntoView = vi.fn();
    document.body.append(alert);

    scrollToError(alert, { block: "center" });

    expect(alert.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(alert.style.scrollMarginTop).toBe("");
  });

  it("leaves a clearance the surface declared in a CLASS alone", () => {
    // `element.style.scrollMarginTop` reads only the INLINE declaration, so the
    // old guard saw nothing on a class-styled element and overwrote its choice
    // with 5rem. The Xero section cards declare `scroll-mt-24` (6rem) because
    // their collapsible header is taller than the ordinary one, and the "go to
    // section" reveal targets exactly those cards.
    const style = document.createElement("style");
    style.textContent = ".scroll-mt-24 { scroll-margin-top: 6rem; }";
    document.head.append(style);
    const card = document.createElement("section");
    card.className = "scroll-mt-24";
    card.scrollIntoView = vi.fn();
    document.body.append(card);

    revealEditor({ current: card });

    expect(
      card.style.scrollMarginTop,
      "the surface declared 6rem of clearance; the primitive must not write " +
        "its own 5rem over it",
    ).toBe("");
    expect(window.getComputedStyle(card).scrollMarginTop).toBe("96px");

    style.remove();
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

  it("reveals a success target that sits below the top of its scroll container", () => {
    // #2934, WCAG 2.4.11. "The top of the resulting page OR CARD" is two
    // different scrolls. Scrolling the container to zero for a card screens
    // below the heading — `LodgeCapacityCard` is one — would focus the card
    // while showing the top of the page: no visible focus ring, a Tab that
    // jumps invisibly, and a magnifier following focus off the viewport.
    const outer = document.createElement("main");
    outer.style.overflowY = "auto";
    const heading = document.createElement("h1");
    const card = document.createElement("section");
    outer.append(heading, card);
    document.body.append(outer);

    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    outer.scrollTo = scrollTo;
    card.scrollIntoView = scrollIntoView;
    // jsdom lays nothing out, so the geometry that decides this is stated.
    outer.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700);
    card.getBoundingClientRect = () => new DOMRect(0, 1200, 900, 300);

    scrollToTop({ current: card });

    expect(document.activeElement).toBe(card);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(card.style.scrollMarginTop).toBe("5rem");
    expect(
      scrollTo,
      "a card below the fold must not be reached by scrolling its container to " +
        "the top — that leaves the focused card off-screen",
    ).not.toHaveBeenCalled();
  });

  it("still scrolls the container to zero for a page wrapper at its top", () => {
    const outer = document.createElement("main");
    outer.style.overflowY = "auto";
    const page = document.createElement("div");
    outer.append(page);
    document.body.append(outer);

    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    outer.scrollTo = scrollTo;
    page.scrollIntoView = scrollIntoView;
    outer.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700);
    page.getBoundingClientRect = () => new DOMRect(0, 0, 900, 2400);

    scrollToTop({ current: page });

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("measures the offset against the scrolled content, not the viewport", () => {
    // A container already scrolled down puts its first child's rect ABOVE the
    // container's own rect. Measuring viewport-relative would read that as a
    // negative offset for a card and as "not at the top" for the page wrapper.
    const outer = document.createElement("main");
    outer.style.overflowY = "auto";
    const page = document.createElement("div");
    outer.append(page);
    document.body.append(outer);

    const scrollTo = vi.fn();
    outer.scrollTo = scrollTo;
    outer.scrollTop = 800;
    outer.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700);
    page.getBoundingClientRect = () => new DOMRect(0, -800, 900, 2400);

    scrollToTop({ current: page });

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
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
