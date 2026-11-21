import type { GuardConfig, GithubRepo, Plan, PlannedItem, PlanError, PostResult, RefMap } from './types';
import { Providers } from './api';
import { FileState, appendSummary } from './state';
import { selectCandidates, refDifferences, ambiguousNames } from './policy';
import { runGickup } from './transport';

export interface RunServices {
  provider: Providers;
  state: FileState;
  config: GuardConfig;
  workspace: string;
  githubToken: string;
  gitlabToken: string;
}

function ownedRepos(all: GithubRepo[], config: GuardConfig): GithubRepo[] {
  const names = new Set(config.source.github.owners.map(o => o.name.toLowerCase()));
  return all.filter(x => names.has(x.owner.login.toLowerCase()));
}

function destinationFor(repo: GithubRepo, config: GuardConfig, gitlabUser: string, group: string): string {
  const owner = config.source.github.owners.find(o => o.name.toLowerCase() === repo.owner.login.toLowerCase());
  if (!owner) throw new Error('Unconfigured owner');
  return (owner.kind === 'user' ? gitlabUser : group + '/' + owner.name.toLowerCase()) + '/' + repo.name;
}

export async function preflight(services: RunServices): Promise<Plan> {
  const { provider, state, config } = services;
  const prior = state.getPending();
  const [all, githubUser, gitlabUser] = await Promise.all([
    provider.githubRepositories(), provider.githubUser(), provider.gitlabUser(),
  ]);
  const expectedUser = config.source.github.owners.find(o => o.kind === 'user')!;
  if (githubUser.toLowerCase() !== expectedUser.name.toLowerCase()) {
    throw new Error('GitHub token user does not match configured personal account');
  }
  const rootId = await provider.verifyRootGroup();
  if (!Number.isSafeInteger(rootId)) throw new Error('Invalid GitLab root group ID');
  const included = ownedRepos(all, config);
  for (const owner of config.source.github.owners) {
    const count = included.filter(x => x.owner.login.toLowerCase() === owner.name.toLowerCase()).length;
    if (count < owner.minVisible) throw new Error('GitHub token visibility below configured baseline for ' + owner.name);
  }
  const visible = new Set(included.map(x => x.full_name.toLowerCase()));
  const unreachable = [...prior].filter(x => !visible.has(x));
  if (unreachable.length) throw new Error('Previously pending repositories are no longer visible; refusing to drop retry state');
  const selected = selectCandidates(included, config, prior, new Date());
  const plan: Plan = { version: 1, startedAt: new Date().toISOString(), examined: selected.length,
    matched: 0, empty: 0, queued: [], errors: [] };
  for (const repo of selected) {
    try {
      const sourceRefs = await provider.githubRefs(repo.clone_url);
      if (Object.keys(sourceRefs).length === 0) {
        plan.empty++;
        continue;
      }
      const target = destinationFor(repo, config, gitlabUser, provider.rootGroup);
      const existing = await provider.gitlabRefs(target);
      if (existing === null || Object.keys(refDifferences(sourceRefs, existing)).length > 0) {
        plan.queued.push({ name: repo.full_name, repo: repo.name, owner: repo.owner.login,
          target, refs: sourceRefs, pushedAt: repo.pushed_at,
          carriedFromPrevious: prior.has(repo.full_name.toLowerCase()) });
      } else {
        plan.matched++;
      }
    } catch (error) {
      plan.errors.push({ name: repo.full_name, reason: String(error instanceof Error ? error.message : error) });
    }
  }
  const unsafe = ambiguousNames(plan.queued.map(x => ({ name: x.name, repo: x.repo })), all);
  if (unsafe.size) {
    for (const name of unsafe) plan.errors.push({ name, reason: 'Duplicate repository name across owners; cannot safely use Gickup include' });
    plan.queued = plan.queued.filter(x => !unsafe.has(x.name));
  }
  state.writePlan(plan);
  state.setPending([...plan.queued.map(x => x.name), ...plan.errors.map(x => x.name)]);
  appendSummary('## Gickup Guard / preflight\n\n' +
    '| Selected (recent + retry) | Already matched | Needs transfer | Errors | Empty sources |\n' +
    '| ---: | ---: | ---: | ---: | ---: |\n' +
    `| ${plan.examined} | ${plan.matched} | ${plan.queued.length} | ${plan.errors.length} | ${plan.empty} |\n`);
  return plan;
}

async function transfer(services: RunServices, plan: Plan): Promise<PlanError[]> {
  const errors: PlanError[] = [];
  const { provider, config, workspace, githubToken, gitlabToken } = services;
  const byOwner = new Map<string, PlannedItem[]>();
  for (const item of plan.queued) {
    const items = byOwner.get(item.owner) ?? [];
    items.push(item);
    byOwner.set(item.owner, items);
  }
  for (const [ownerName, items] of byOwner) {
    const cfg = config.source.github.owners.find(o => o.name.toLowerCase() === ownerName.toLowerCase())!;
    const namespace = cfg.kind === 'user' ? items[0].target.split('/')[0]
      : provider.rootGroup + '/' + ownerName.toLowerCase();
    try {
      if (cfg.kind === 'org') await provider.ensurePrivateSubgroup(ownerName, await provider.verifyRootGroup());
      runGickup(ownerName, namespace, items.map(x => x.repo), config.source.github.exclude,
        workspace, githubToken, gitlabToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ name: ownerName, reason: message });
      process.stdout.write('::warning::Transfer reported an error for a configured owner\n');
    }
  }
  return errors;
}

export async function postflight(services: RunServices, plan: Plan): Promise<PostResult> {
  const { provider, state } = services;
  const result: PostResult = { version: 1, verified: [], pending: [...plan.errors] };
  for (const item of plan.queued) {
    try {
      const actual = await provider.gitlabRefs(item.target);
      if (actual === null) throw new Error('Missing GitLab project');
      let differences = refDifferences(item.refs, actual);
      if (Object.keys(differences).length) {
        // A concurrent source push is not part of this run's snapshot. A new
        // GitLab SHA is acceptable only when it now matches live GitHub.
        const fresh = await provider.githubRefs('https://github.com/' + item.name + '.git');
        differences = Object.fromEntries(Object.entries(differences).filter(
          ([key]) => actual[key] !== fresh[key] || fresh[key] === undefined));
      }
      if (Object.keys(differences).length) throw new Error('Unverified captured refs: ' + Object.keys(differences).length);
      result.verified.push(item.name);
    } catch (error) {
      result.pending.push({ name: item.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  state.setPending(result.pending.map(x => x.name));
  state.writeResult(result);
  appendSummary('## Gickup Guard / postflight\n\n' +
    '| Verified against initial refs | Still pending |\n| ---: | ---: |\n' +
    `| ${result.verified.length} | ${result.pending.length} |\n` +
    (result.pending.length ? '\nUnresolved entries were saved for retry.\n' : '\nAll required Git refs verified.\n'));
  return result;
}

export async function runPipeline(services: RunServices): Promise<void> {
  const plan = await preflight(services);
  // Snapshot and conservative retry backlog are persisted before any transfer.
  const transferErrors = await transfer(services, plan);
  if (transferErrors.length) process.stdout.write('::warning::Gickup reported transfer errors; postflight will determine actual delivery\n');
  const result = await postflight(services, plan);
  if (result.pending.length) throw new Error(result.pending.length + ' repositories still require a verified backup');
}
