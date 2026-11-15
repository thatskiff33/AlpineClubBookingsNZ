# File-size allowances for ALP-649

Each file grows by the lines it takes to throw a refusal through the shared
reader before parsing, and to catch what used to be an unhandled rejection
(#4976). Measured against the merged ALP-578/ALP-581/ALP-589 state this lane
is stacked on.

file: src/app/(admin)/admin/chores/page.tsx
lines: 748
reason: the one added line is the shared refusal reader's import; the save,
  delete and toggle handlers it serves stay beside the lodge-scope guard they
  share, and splitting the page shell is its own refactor.

The work-parties page's growth is folded into its existing entry in
`admin-save-failure-messages.md`, one file one allowance.
