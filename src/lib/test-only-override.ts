// The one test-only override rule (#4908, INV-SSOT): a value a test may
// install, which refuses to be set outside NODE_ENV=test and re-checks on every
// read, so a changed environment cannot retain it. No environment variable or
// request reaches it. The Xero and Stripe client seams are both built from it.
export function createTestOnlyOverride<T>(label: string) {
  let installed: T | null = null;
  const refuse = (): never => { throw new Error(`${label} override is test-only`); };
  return {
    set(value: T | null): void {
      if (process.env.NODE_ENV !== "test") refuse();
      installed = value;
    },
    reset(): void {
      installed = null;
    },
    /** The installed value, or null. Throws if one is somehow set outside a test. */
    read(): T | null {
      if (installed !== null && process.env.NODE_ENV !== "test") refuse();
      return installed;
    },
  };
}
