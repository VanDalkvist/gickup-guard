import type { GithubRepo, RefMap, GuardConfig } from './types';

export function isRecent(pushedAt: string | null, now: Date, hours: number): boolean {
  if (!pushedAt) return false;
  const ms = Date.parse(pushedAt);
  if (!Number.isFinite(ms)) return false;
  const age = now.getTime() - ms;
  return age >= 0 && age <= hours * 3_600_000;
}

export function selectCandidates(repos: GithubRepo[], config: GuardConfig, prior: Set<string>, now: Date): GithubRepo[] {
  const allowed = new Set(config.source.github.owners.map(x => x.name.toLowerCase()));
  const excluded = new Set(config.source.github.exclude.map(x => x.toLowerCase()));
  return repos.filter(repo => allowed.has(repo.owner.login.toLowerCase()) &&
    !repo.fork && !excluded.has(repo.full_name.toLowerCase()) &&
    (prior.has(repo.full_name.toLowerCase()) || isRecent(repo.pushed_at, now, config.sync.activityHours)))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export function refDifferences(expected: RefMap, actual: RefMap): RefMap {
  return Object.fromEntries(Object.entries(expected).filter(([key, sha]) => actual[key] !== sha));
}

export function ambiguousNames(selected: { name: string; repo: string }[], all: GithubRepo[]): Set<string> {
  const ownersByRepo = new Map<string, Set<string>>();
  for (const repo of all) {
    if (repo.fork) continue;
    const name = repo.name.toLowerCase();
    const owners = ownersByRepo.get(name) ?? new Set<string>();
    owners.add(repo.owner.login.toLowerCase());
    ownersByRepo.set(name, owners);
  }
  return new Set(selected.filter(x => (ownersByRepo.get(x.repo.toLowerCase())?.size ?? 0) > 1).map(x => x.name));
}

export function validatePending(raw: unknown): Set<string> {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid retry state');
  const x = raw as any;
  if (x.version !== 1 || !Array.isArray(x.names) || !x.names.every((n: unknown) =>
    typeof n === 'string' && /^[\w.-]+\/[\w.-]+$/.test(n))) throw new Error('Invalid retry state schema');
  return new Set((x.names as string[]).map(x => x.toLowerCase()));
}
