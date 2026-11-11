"use client";

import { useCallback, useEffect, useMemo } from "react";

type FrameScheduler = (callback: FrameRequestCallback) => number;
type FrameCanceller = (handle: number) => void;

interface SyncedScrollGroupOptions {
  requestAnimationFrame?: FrameScheduler;
  cancelAnimationFrame?: FrameCanceller;
}

function defaultRequestAnimationFrame(callback: FrameRequestCallback) {
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    return window.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(
    () => callback(globalThis.performance.now()),
    0,
  ) as unknown as number;
}

function defaultCancelAnimationFrame(handle: number) {
  if (typeof window !== "undefined" && window.cancelAnimationFrame) {
    window.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}

export function createSyncedScrollGroup(
  options: SyncedScrollGroupOptions = {},
) {
  const requestFrame =
    options.requestAnimationFrame ?? defaultRequestAnimationFrame;
  const cancelFrame =
    options.cancelAnimationFrame ?? defaultCancelAnimationFrame;
  const elements = new Set<HTMLElement>();
  const listeners = new Map<HTMLElement, EventListener>();
  let frame: number | null = null;
  let source: HTMLElement | null = null;
  let scrollLeft = 0;
  let syncing = false;

  function flush() {
    frame = null;
    const currentSource = source;
    source = null;
    if (!currentSource || !elements.has(currentSource)) return;

    scrollLeft = currentSource.scrollLeft;
    syncing = true;
    try {
      for (const element of elements) {
        if (element !== currentSource && element.scrollLeft !== scrollLeft) {
          element.scrollLeft = scrollLeft;
        }
      }
    } finally {
      syncing = false;
    }
  }

  function handleScroll(element: HTMLElement) {
    if (syncing) return;
    source = element;
    if (frame === null) {
      frame = requestFrame(flush);
    }
  }

  function register(element: HTMLElement) {
    if (elements.has(element)) {
      return () => undefined;
    }

    elements.add(element);
    if (elements.size > 1 && element.scrollLeft !== scrollLeft) {
      syncing = true;
      try {
        element.scrollLeft = scrollLeft;
      } finally {
        syncing = false;
      }
    }
    const listener = () => handleScroll(element);
    listeners.set(element, listener);
    element.addEventListener("scroll", listener, { passive: true });

    return () => {
      element.removeEventListener("scroll", listener);
      listeners.delete(element);
      elements.delete(element);
      if (source === element) {
        source = null;
      }
    };
  }

  function destroy() {
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    for (const [element, listener] of listeners.entries()) {
      element.removeEventListener("scroll", listener);
    }
    listeners.clear();
    elements.clear();
    source = null;
    syncing = false;
  }

  return { register, destroy };
}

export function useSyncedScroll() {
  const group = useMemo(() => createSyncedScrollGroup(), []);

  useEffect(() => {
    return () => group.destroy();
  }, [group]);

  return useCallback((element: HTMLElement) => {
    return group.register(element);
  }, [group]);
}
