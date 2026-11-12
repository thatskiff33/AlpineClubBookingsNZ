# File-size allowances for #4938

file: src/lib/auth.ts
lines: 926
reason: `auth()` must be wrapped in React `cache()` at its one definition,
  because `cache()` memoises per function identity and a wrapper elsewhere
  would be a second memo. The growth is the `react` import and a five-line
  note on the memo's lifetime; the full explanation lives in docs/SECURITY.md.
