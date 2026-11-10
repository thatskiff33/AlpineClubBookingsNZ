file: src/lib/xero-sync.ts
lines: 1162
reason: The explicit-void classifier must select both the transaction budget
  and the Payment-before-link lock in the existing link funnel. Extracting
  these few lines would separate the lock rule from its statusless exception
  and require exporting the funnel's private link classifier. The lock SQL
  and wait budget remain imported from their existing canonical module.
