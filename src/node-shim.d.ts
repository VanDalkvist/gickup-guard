declare const require: (name: string) => any;
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd(): string;
  exitCode?: number;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};
declare const Buffer: {
  from(data: ArrayBuffer | string): any;
};
