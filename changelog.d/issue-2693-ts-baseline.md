- **Stricter, more modern TypeScript checking behind the scenes (#2693).** The
  application now compiles against the ES2022 language baseline, refuses unused
  variables, imports and parameters, and requires a class member that replaces
  an inherited one to say so. The unused imports and bindings that turned up
  were removed and two never-read parameters dropped along the way. The
  Playwright browser suite gets its own typecheck project, and no JavaScript
  file is loaded into a TypeScript project any more.

  Nothing an administrator or member sees changes: this is compiler
  configuration and dead-code hygiene, and it is the measured baseline the
  staged `noUncheckedIndexedAccess` adoption (#2694) starts from.
