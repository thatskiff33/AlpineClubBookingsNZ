// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useActionFailure } from "../use-action-failure";

describe("useActionFailure", () => {
  it("bumps the attention key on every failure, including an identical repeat", () => {
    const { result } = renderHook(() => useActionFailure());
    expect(result.current.actionError).toBe("");

    act(() => result.current.failAction("Sync failed"));
    const first = result.current.attentionKey;
    expect(result.current.actionError).toBe("Sync failed");

    // No clear in between: the message is identical, only the key can re-announce it.
    act(() => result.current.failAction("Sync failed"));
    expect(result.current.actionError).toBe("Sync failed");
    expect(result.current.attentionKey).not.toBe(first);
  });

  it("clears the message without minting a new arrival", () => {
    const { result } = renderHook(() => useActionFailure());
    act(() => result.current.failAction("Sync failed"));
    const key = result.current.attentionKey;
    act(() => result.current.clearActionError());
    expect(result.current.actionError).toBe("");
    expect(result.current.attentionKey).toBe(key);
  });
});
