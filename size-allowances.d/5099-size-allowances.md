# Size allowances for #5099

file: src/lib/bed-allocation-lifecycle.ts
lines: 2611
reason: caller-held lock checks in bed allocation writers; those lines sit
  inside this file, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.
