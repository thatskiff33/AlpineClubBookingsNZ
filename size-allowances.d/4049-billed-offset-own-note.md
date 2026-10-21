# File-size allowances for #4049

file: src/lib/xero-sync.ts
lines: 1109
reason: `completeXeroSyncOperation` is the one funnel every Xero operation
  completes through, so clearing a stale error on a SUCCEEDED row belongs in
  its single write, beside the status it depends on (three lines: the status
  read once, the guarded clear and its comment). Clearing it anywhere else
  would need every completing caller to remember it.
