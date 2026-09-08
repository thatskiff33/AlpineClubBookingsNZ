# File-size allowances for #3318

file: src/lib/xero-operation-retry.ts
lines: 1398
reason: eight lines, seven of them comment. One parameter annotation wrote
  `typeof import("@/lib/xero")` inline, which is one of the two shapes Semgrep
  cannot parse, so the module namespace is now a named type declared beside the
  file's other local type. The module is still loaded dynamically at the one
  call site that does it, and the note says so — without it the next reader
  sees a static-looking type over a dynamic import and "tidies" it. Splitting a
  retry module to rehome a one-line type alias would put the type further from
  the signature that uses it, for no gain.
