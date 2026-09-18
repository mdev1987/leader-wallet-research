declare const Bun: {
  file(path: string): {
    exists(): Promise<boolean>;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
  };
  write(path: string, data: string): Promise<number>;
};

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(signal: string, listener: () => void): void;
};
