/** Instance-local replay policy shared by the provider test doubles. */
export function createReplayWriter(mismatch: () => Error) {
  const keys = new Map<string, { input: string; result: unknown }>();
  return function write<T>(key: string, input: unknown, operation: () => T): T {
    const fingerprint = JSON.stringify(input);
    const previous = keys.get(key);
    if (previous) {
      if (previous.input !== fingerprint) throw mismatch();
      return structuredClone(previous.result) as T;
    }
    // Rejections leave the key available for a corrected request.
    const result = operation();
    keys.set(key, { input: fingerprint, result: structuredClone(result) });
    return structuredClone(result);
  };
}
