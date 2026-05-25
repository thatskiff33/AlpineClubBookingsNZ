/**
 * Typed helpers for Prisma mocks and transaction doubles.
 *
 * Tests in this repo commonly mock @/lib/prisma at module load and then
 * cast individual delegates with `as any` to override return values.
 * The helpers here keep types honest while still allowing per-test
 * overrides.
 */
import { vi, type Mock } from "vitest";

/**
 * Build a transaction shim that calls a passed callback with the
 * supplied client. Use when a service does
 * `prisma.$transaction((tx) => ...)` and you want the tx delegate to be
 * the same mock client.
 */
export function transactionShim<T extends object>(
  client: T,
): (callback: (tx: T) => Promise<unknown>) => Promise<unknown> {
  return (callback) => callback(client);
}

/**
 * Replace each value in `delegate` with `vi.fn()` while preserving the
 * delegate shape. Returns the mocked delegate typed as a record of
 * mocks so callers can call `delegate.findMany.mockResolvedValue(...)`
 * without `as any`.
 */
export function mockDelegate<K extends string>(
  methods: readonly K[],
): Record<K, Mock> {
  return methods.reduce(
    (acc, key) => {
      acc[key] = vi.fn();
      return acc;
    },
    {} as Record<K, Mock>,
  );
}

/**
 * Common Prisma delegate method names grouped by the methods most often
 * mocked in this repo. Use these to seed `mockDelegate` instead of
 * repeating the list inline.
 */
export const READ_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
] as const;

export const WRITE_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const;

export const FULL_DELEGATE_METHODS = [
  ...READ_METHODS,
  ...WRITE_METHODS,
] as const;
