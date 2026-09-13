# File-size allowances for #2933

Two files, and they are the same three lines twice.

This declared a third, `hut-fees-section.tsx` at 1143 lines. #2938 grew that
same file in the same epic, so 1143 stopped being its length — and a recorded
length that does not equal the real one is precisely what this directory
forbids, because the gate then cannot tell which number is meant. The entry
moved to `2938-season-timeline-and-copy.md`, which carries the current length
and the reasoning below along with its own. Nothing about #2933's growth is
withdrawn; it is restated where it is still true.

file: src/lib/config-transfer/categories/lodge-config.ts
lines: 1011
reason: three lines, and they make the file say less rather than more. The
  inline `const rateBearing = … || …` became a call to the one shared predicate;
  the import is one line and the call spans two more than the expression did
  because the object literal it passes wraps. Nothing here is worth splitting a
  category validator over.

file: src/lib/config-transfer/categories/xero-config.ts
lines: 818
reason: the same three lines as its sibling above, for the same reason: the
  HUT_FEE item-code row validator now asks the shared predicate instead of
  spelling the rate-bearing rule itself.
