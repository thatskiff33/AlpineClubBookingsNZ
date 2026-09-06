# File-size allowances for #3313

file: src/lib/diagnostics/tools/define.ts
lines: 1001
reason: twenty lines, all of them the corrected measurement of what zod does
  with a reserved key. The old docblocks stated as fact that a strict object
  schema silently strips `__proto__`. zod 4.5 rejects it — but only when the key
  is ENUMERABLE, so two holes survive rather than one, and the second is exactly
  what makes `Object.getOwnPropertyNames` in the scan load-bearing rather than
  incidental. Adversarial review caught the first draft of this text asserting
  the record shape was the only survivor, which is the sentence a future reader
  would have trimmed the guard from. That measurement has to sit against the
  guard it justifies. Already condensed once from eighteen lines to nine before
  the review found the omission; going below the current length means dropping
  either the 4.4.3 history that explains why the test rows turned over or the
  enumerability caveat that stops the guard being deleted as redundant. No split
  helps: the file's seam is entry definition versus invocation, and both the
  constant and its scan sit on the same side of it.
