# File-size allowances for #3313

file: src/lib/diagnostics/tools/define.ts
lines: 990
reason: nine lines, all of them the corrected measurement of what zod does
  with a reserved key. The old docblock stated as fact that a strict object
  schema silently strips `__proto__`; zod 4.5 rejects it, and the one surviving
  hole is now the record shape. That measurement has to sit against the guard
  it justifies, because a reader who trims the guard will do it from this
  comment — and the comment being stale by one zod version is exactly how the
  guard would come to look redundant. The already-condensed version of this
  text replaced eighteen lines with nine; taking it below that means deleting
  either the 4.4.3 history that explains why the rows changed or the record
  measurement that says why the guard still earns its place. No split is
  available that helps: the file's seam is entry definition versus invocation,
  and both the constant and its scan are on the same side of it.
