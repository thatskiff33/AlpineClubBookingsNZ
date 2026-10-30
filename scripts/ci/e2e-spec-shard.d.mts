// Types for playwright.config.ts, which imports this CI helper (#4397).
export declare const PLAYWRIGHT_TEST_FILE: RegExp;
export declare const MULTI_LODGE_DIR: string;
export declare const PRE_SETUP_DIR: string;
export declare const NOT_CHROMIUM_DIRS: readonly string[];
export declare function notChromiumIgnore(testDir: string): RegExp;
export declare function parseE2eShard(value: string | undefined): { index: number; total: number } | null;
export declare function chromiumSpecFiles(testDir: string): string[];
export declare function dealShards(files: readonly string[], total: number, durations?: Readonly<Record<string, number>>): string[][];
export declare function specsForShard(files: readonly string[], shard: { index: number; total: number }, durations?: Readonly<Record<string, number>>): string[];
export declare function shardTestMatch(testDir: string, shard: { index: number; total: number }): RegExp[];
