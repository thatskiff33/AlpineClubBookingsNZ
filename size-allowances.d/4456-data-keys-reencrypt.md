# File-size allowances for #4456 (the re-encrypt, PR 2)

file: src/lib/setup-readiness.ts
lines: 2286
reason: the readiness report is assembled in one place, and the Data
  Encryption Key step must be told whose key ring it is reading: the running
  app's (Admin → Setup) or a shell's (`setup:check`), so that only the app's
  page names its current key and the fingerprint to give the re-encrypt
  (#4456 review). That is one optional input field and its one-line doc; the
  step's logic stays in `src/lib/setup-readiness-data-keys.ts`. Splitting the
  assembler for two lines would scatter the category order across files.
