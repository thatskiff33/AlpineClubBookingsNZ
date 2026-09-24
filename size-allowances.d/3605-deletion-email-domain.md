# File-size allowance for #3600 / PR #3605

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1283
reason: importing the existing reserved-email domain adds one line to this already-oversized deletion route; splitting a lifecycle writer to avoid one import would separate its transaction and safety context without reducing complexity.
