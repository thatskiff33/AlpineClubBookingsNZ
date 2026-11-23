// The column values every demo member is seeded with unless a fixture says
// otherwise: the one definition `createDemoMember` writes and the E2E resets
// restore (#5407). A pure leaf with no imports, so the Playwright loader can
// read it; `demo-seed-writers.ts` itself reaches `server-only` through the
// password hasher and must never be imported from `e2e/`.
export const DEMO_MEMBER_DEFAULTS = {
  role: "USER",
  ageTier: "ADULT",
  active: true,
  canLogin: true,
  emailVerified: true,
  forcePasswordChange: false,
} as const;
