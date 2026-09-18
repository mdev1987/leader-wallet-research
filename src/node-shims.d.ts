declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function appendFile(path: string, data: string, encoding?: string): Promise<void>;
}
