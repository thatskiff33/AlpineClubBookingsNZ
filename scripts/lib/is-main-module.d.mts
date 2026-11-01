// #4598: the TypeScript surface of `is-main-module.mjs`, imported by the `.ts`
// scripts run through `tsx`. Keep this in step with its `export` statements.
export function isMainModule(importMetaUrl: string, argvPath?: string): boolean;
