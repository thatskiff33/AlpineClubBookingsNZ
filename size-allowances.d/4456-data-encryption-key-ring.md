# File-size allowances for #4456

Two already-oversized files gain the lines that wire the data-encryption key
ring in. The logic itself lives in new, in-budget modules
(`src/lib/data-encryption-keys.ts`, `src/lib/setup-readiness-data-keys.ts`,
`src/components/retired-recovery-codes-notice.tsx`); what remains here is the
import, the call and the one prop or field each file must carry.

file: src/lib/setup-readiness.ts
lines: 2283
reason: the readiness report is assembled in one place; the Data Encryption Key
  step's logic is its own module, and this file gains only its import, its step
  id, its snapshot field and the one line that places it in the foundation
  category. Splitting the assembler to make room for five lines would scatter
  the category order across files.

file: src/app/(authenticated)/profile/page.tsx
lines: 699
reason: the page is the server component that reads the member and renders the
  two-factor card, so it is where the retired-recovery-codes answer (one call
  behind a member check) is read and handed to the card as a prop. The notice
  itself is a shared component; a split of the page is its own job.
