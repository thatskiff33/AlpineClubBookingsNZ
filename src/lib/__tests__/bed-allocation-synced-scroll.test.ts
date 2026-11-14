// @vitest-environment jsdom

import { fireEvent } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { createSyncedScrollGroup } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/use-synced-scroll";

function createScheduledGroup() {
  const callbacks: FrameRequestCallback[] = [];
  const group = createSyncedScrollGroup({
    requestAnimationFrame: (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancelAnimationFrame: () => undefined,
  });

  return {
    group,
    callbacks,
    flushNextFrame() {
      const callback = callbacks.shift();
      if (callback) callback(0);
    },
  };
}

function dispatchingScrollElement() {
  const element = document.createElement("div");
  let scrollLeft = 0;
  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
      element.dispatchEvent(new Event("scroll"));
    },
  });
  return element;
}

describe("createSyncedScrollGroup", () => {
  it("propagates scrollLeft from one registered scroller to the others", () => {
    const { group, callbacks, flushNextFrame } = createScheduledGroup();
    const source = document.createElement("div");
    const targetA = document.createElement("div");
    const targetB = document.createElement("div");

    group.register(source);
    group.register(targetA);
    group.register(targetB);

    source.scrollLeft = 96;
    fireEvent.scroll(source);

    expect(callbacks).toHaveLength(1);
    expect(targetA.scrollLeft).toBe(0);
    expect(targetB.scrollLeft).toBe(0);

    flushNextFrame();

    expect(targetA.scrollLeft).toBe(96);
    expect(targetB.scrollLeft).toBe(96);
    expect(callbacks).toHaveLength(0);

    group.destroy();
  });

  it("ignores scroll events caused by propagation so echoes do not loop", () => {
    const { group, callbacks, flushNextFrame } = createScheduledGroup();
    const source = document.createElement("div");
    const echoingTarget = dispatchingScrollElement();

    group.register(source);
    group.register(echoingTarget);

    source.scrollLeft = 42;
    fireEvent.scroll(source);

    expect(callbacks).toHaveLength(1);
    flushNextFrame();

    expect(echoingTarget.scrollLeft).toBe(42);
    expect(callbacks).toHaveLength(0);

    group.destroy();
  });

  it("aligns scrollers that register after the group already has an offset", () => {
    const { group, flushNextFrame } = createScheduledGroup();
    const source = document.createElement("div");
    const lateTarget = document.createElement("div");

    group.register(source);
    source.scrollLeft = 128;
    fireEvent.scroll(source);
    flushNextFrame();

    group.register(lateTarget);

    expect(lateTarget.scrollLeft).toBe(128);

    group.destroy();
  });
});
