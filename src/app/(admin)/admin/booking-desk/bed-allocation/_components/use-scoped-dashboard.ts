"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ScopedDashboardState<T> {
  scopeKey: string;
  value: T;
}

interface UseScopedDashboardOptions<T> {
  scopeKey: string;
  enabled?: boolean;
  load: (signal: AbortSignal) => Promise<T>;
  onLoaded?: (value: T) => void;
}

/**
 * Loads a dashboard partition without ever exposing an earlier partition under
 * a new key. Requests are aborted and sequence-fenced, so an A -> B switch
 * cannot be undone by A completing last. Failed and pending loads fail closed.
 */
export function useScopedDashboard<T>({
  scopeKey,
  enabled = true,
  load,
  onLoaded,
}: UseScopedDashboardOptions<T>) {
  const scopeRef = useRef(scopeKey);
  const callbacksRef = useRef({ load, onLoaded });
  useEffect(() => {
    scopeRef.current = scopeKey;
    callbacksRef.current = { load, onLoaded };
  });
  const requestRef = useRef<{
    sequence: number;
    controller: AbortController;
  } | null>(null);
  const [state, setState] = useState<ScopedDashboardState<T> | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");

  const runLoad = useCallback(async (
    requestedScopeKey: string,
  ): Promise<boolean> => {
    if (scopeRef.current !== requestedScopeKey) return false;

    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const sequence = (requestRef.current?.sequence ?? 0) + 1;
    requestRef.current = { sequence, controller };
    setState(null);
    setError("");
    setLoading(true);

    try {
      const value = await callbacksRef.current.load(controller.signal);
      if (
        controller.signal.aborted ||
        requestRef.current?.sequence !== sequence ||
        scopeRef.current !== requestedScopeKey
      ) {
        return false;
      }
      setState({ scopeKey: requestedScopeKey, value });
      callbacksRef.current.onLoaded?.(value);
      return true;
    } catch (loadError) {
      if (controller.signal.aborted) return false;
      if (
        requestRef.current?.sequence !== sequence ||
        scopeRef.current !== requestedScopeKey
      ) {
        return false;
      }
      setError(
        loadError instanceof Error ? loadError.message : "Unknown error",
      );
      return false;
    } finally {
      if (
        requestRef.current?.sequence === sequence &&
        scopeRef.current === requestedScopeKey
      ) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      requestRef.current?.controller.abort();
      setState(null);
      setError("");
      setLoading(false);
      return;
    }
    void runLoad(scopeKey);
    return () => requestRef.current?.controller.abort();
  }, [enabled, runLoad, scopeKey]);

  const reload = useCallback(async () => {
    if (!enabled) return false;
    return runLoad(scopeRef.current);
  }, [enabled, runLoad]);

  const setValue = useCallback(
    (value: T) => {
      setState((current) =>
        scopeRef.current === scopeKey && current?.scopeKey === scopeKey
          ? { scopeKey, value }
          : current,
      );
    },
    [scopeKey],
  );

  return {
    value: state?.scopeKey === scopeKey ? state.value : null,
    loading,
    error,
    reload,
    setValue,
  };
}
