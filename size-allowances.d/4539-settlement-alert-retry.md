# Settlement alert retry visibility (#4446)

file: src/lib/stuck-state-dashboard.ts
lines: 1173
reason: The new count and critical Finance item belong beside the existing payment recovery items. The sweep and query live in their own module; extracting the dashboard's item construction and dependency wiring for this one signal would widen a small bug fix into a dashboard refactor.
