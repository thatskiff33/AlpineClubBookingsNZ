// Types for realdb-files.mjs (#4458).
export declare const REALDB_FILE: RegExp;
export declare const QUARANTINE_FILE: string;
export declare function findRealdbFiles(repoRoot?: string): string[];
export declare function readQuarantine(repoRoot?: string): string[];
export declare function realdbFilesToRun(repoRoot?: string): string[];
