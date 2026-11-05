// #4459: the TypeScript surface of the one export a TypeScript test imports from
// `check-workflow-suite-checkout-depth.mjs` (the repository's own workflow
// reader, which stays JavaScript because `verify` runs it with a bare `node`).
// Keep this in step with its `export` statement.
export type WorkflowJob = {
  env?: Record<string, string>;
  needs?: unknown;
  permissions?: Record<string, string>;
  steps?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
export type WorkflowDocument = {
  on?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
  [key: string]: unknown;
};
export function parseWorkflowYaml(source: string): WorkflowDocument;
