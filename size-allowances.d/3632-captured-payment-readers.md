# File-size allowances for #3632

`group-cancel.ts` grows only by the comment #3632's acceptance criteria require:
the recorded reason its child refund test stays `SUCCEEDED`-only rather than
taking the shared aggregate captured predicate. The reason belongs at the
condition it explains; moving it to another file would let the two drift.

file: src/lib/group-cancel.ts
lines: 947
reason: four comment lines recording why the group refund planner's SUCCEEDED-only child test is deliberately not the shared captured predicate (#3503 / #3653).
