// #4940: the TypeScript surface of `volume-users.js`, which stays JavaScript
// because the k6 load harness imports it. `prisma/load-volume-plan.ts` and
// `src/lib/__tests__/load-volume-users.test.ts` import it from TypeScript;
// keep this in step with the `.js`.
export declare const LOAD_VOLUME_EMAIL_PREFIX: string;
export declare function volumeMemberLocal(index: number): string;
export declare function volumeUserPool(count: number, domain?: string): string[];
