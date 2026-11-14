# Size allowances for #5117

file: src/lib/setup-readiness.ts
lines: 2300
reason: delivers the browser Sentry DSN at runtime; those lines sit inside
  this file, which was already over its limit before this change, and lifting
  it apart is a refactor of its own, not part of this fix.
