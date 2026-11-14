// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useActionFailure } from "../use-action-failure";

describe("useActionFailure", () => {
  it("bumps the attention key on every failure, including an identical repeat", () => {
    const { result } = renderHook(() => useActionFailure());
    expect(result.current.error).toBe("");

    act(() => result.current.fail("Sync failed"));
    const first = result.current.attentionKey;
    expect(result.current.error).toBe("Sync failed");

    // No clear in between: the message is identical, only the key can re-announce it.
    act(() => result.current.fail("Sync failed"));
    expect(result.current.error).toBe("Sync failed");
    expect(result.current.attentionKey).not.toBe(first);
  });

  it("clears the message without minting a new arrival", () => {
    const { result } = renderHook(() => useActionFailure());
    act(() => result.current.fail("Sync failed"));
    const key = result.current.attentionKey;
    act(() => result.current.clear());
    expect(result.current.error).toBe("");
    expect(result.current.attentionKey).toBe(key);
  });
});
