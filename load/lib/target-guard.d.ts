// #4940: the TypeScript surface of `target-guard.js`, which stays JavaScript
// because the k6 load harness imports it under the k6 runtime. The volume
// seeder (`prisma/load-volume-seed.ts`) and
// `src/lib/__tests__/load-target-guard.test.ts` import it from TypeScript; keep
// this in step with the `.js`.
export declare function assertSafeTarget(
  env: Readonly<Record<string, string | undefined>>,
  name?: string,
): string;
export declare function assertSafeDatabaseTarget(
  env: Readonly<Record<string, string | undefined>>,
): string;
