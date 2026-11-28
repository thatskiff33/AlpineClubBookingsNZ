# Size allowances for #5239 (ALP-692)

file: src/lib/policies/adult-member-hosting.ts
lines: 1015
reason: adds hostingModeQueuesCoverageReevaluation beside hostingModeIsActive
  and hostingModeCanRefuseStranding, the two mode predicates it is read
  against. It is one more answer to "what does this mode do", and the reason
  those predicates live together is that a second home for one of them is how
  the readers drifted before (#3232). Splitting the mode predicates out of
  the policy module is a refactor of its own, not part of this fix.
