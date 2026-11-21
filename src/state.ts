import type { Pending, Plan, PostResult } from './types';
import { validatePending } from './policy';
const fs = require('node:fs');
const path = require('node:path');

export class FileState {
  readonly directory: string;
  constructor(workspace: string) {
    this.directory = path.join(path.resolve(workspace), '.gickup-guard');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private filename(name: string): string { return path.join(this.directory, name); }
  write(name: string, value: object): void {
    fs.writeFileSync(this.filename(name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }
  read<T>(name: string, fallback?: T): T {
    const file = this.filename(name);
    if (!fs.existsSync(file)) {
      if (fallback !== undefined) return fallback;
      throw new Error('Missing state file ' + name);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  }
  initializePending(): void {
    this.write('pending.json', { version: 1, names: [] } satisfies Pending);
  }
  getPending(): Set<string> {
    return validatePending(this.read<Pending>('pending.json', { version: 1, names: [] }));
  }
  setPending(names: Iterable<string>): void {
    this.write('pending.json', { version: 1, names: [...new Set(names)].sort() } satisfies Pending);
  }
  writePlan(plan: Plan): void { this.write('plan.json', plan); }
  writeResult(result: PostResult): void { this.write('result.json', result); }
}

export function appendSummary(message: string): void {
  process.stdout.write(message + '\n');
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, message + '\n');
}

export function hideToken(token: string): void {
  if (token) process.stdout.write('::add-mask::' + token + '\n');
}
