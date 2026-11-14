/**
 * A provider client built from an explicit method table. Reading anything the
 * table lacks throws, so app code that reaches an unmodelled call fails its
 * test instead of falling through to an SDK that could open a connection.
 */
export function strictTestClient<T extends object>(provider: string, methods: object): T {
  return new Proxy(methods, {
    get(target, name) {
      // `await client` probes `then`; an SDK object is not thenable.
      if (name === "then") return undefined;
      if (Reflect.has(target, name)) return Reflect.get(target, name);
      throw new Error(`The ${provider} test transport does not implement ${String(name)}`);
    },
  }) as T;
}
