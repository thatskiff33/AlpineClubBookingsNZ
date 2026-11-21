/**
 * Shared module-mock factory for `@/lib/password-hashing` (#4934).
 *
 * Sign-in suites replace `verifyPassword` (and sometimes `hashPassword`) with
 * a per-suite mock. The real `burnDummyPasswordCompare` calls the module's own
 * `verifyPassword` binding, which a module mock cannot reach, so each suite
 * must re-derive it from the override. Keeping that derivation here means a
 * change to the module's wrappers is made once, and no suite can silently fall
 * through to the real native compare for its dummy-compare (#4639) checks.
 *
 * Use it from a `vi.mock` factory with a dynamic import, because `vi.mock` is
 * hoisted above static imports:
 *
 *   vi.mock("@/lib/password-hashing", async (importOriginal) => {
 *     const { passwordHashingModuleMock } = await import(
 *       "@/lib/__tests__/helpers/password-hashing-mock"
 *     );
 *     return passwordHashingModuleMock(await importOriginal(), { verifyPassword: mockCompare });
 *   });
 */
type PasswordHashingModule = typeof import("@/lib/password-hashing");

type PasswordHashingOverrides = {
  verifyPassword: (plain: string, encodedHash: string) => unknown;
  hashPassword?: (plain: string) => unknown;
  burnPasswordCostShortfall?: (plain: string, encodedHash: string) => unknown;
};

export function passwordHashingModuleMock(actual: unknown, overrides: PasswordHashingOverrides) {
  const real = actual as PasswordHashingModule;
  const burnDummyPasswordCompare = (plain: string) =>
    overrides.verifyPassword(plain, real.DUMMY_PASSWORD_HASH);
  return {
    ...real,
    ...overrides,
    burnDummyPasswordCompare,
    // The real top-up hashes natively (#5261); here it spends nothing, except
    // that an unreadable hash still falls back to the derived dummy compare.
    burnPasswordCostShortfall:
      overrides.burnPasswordCostShortfall ??
      (async (plain: string, encodedHash: string) => {
        if (real.passwordHashCost(encodedHash) === null) await burnDummyPasswordCompare(plain);
      }),
  };
}
