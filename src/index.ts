import { readConfig } from './config';
import { Providers } from './api';
import { FileState, hideToken } from './state';
import { runPipeline } from './pipeline';
import { validatePending } from './policy';
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error('Missing required Action input: ' + key);
  return value;
}

async function restore(): Promise<void> {
  const repo = requiredEnv('GITHUB_REPOSITORY');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid GitHub Actions repository');
  const token = requiredEnv('GG_STATE_TOKEN');
  hideToken(token);
  const state = new FileState(requiredEnv('GITHUB_WORKSPACE'));
  // Fail closed by writing an empty state only when the API has confirmed no
  // prior artifact. Otherwise preserve the prior retry artifact for reruns.
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28' };
  const api = 'https://api.github.com/repos/' + repo + '/actions/artifacts?name=gickup-guard-pending&per_page=100';
  const response = await fetch(api, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Cannot list prior retry artifacts (HTTP ' + response.status + ')');
  const body = await response.json() as any;
  if (!Array.isArray(body.artifacts)) throw new Error('Invalid GitHub artifact response');
  const artifacts = body.artifacts.filter((a: any) => !a.expired && a.workflow_run?.id)
    .sort((a: any, b: any) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!artifacts.length) {
    state.initializePending();
    process.stdout.write('No previous pending backlog; using activity-window discovery\n');
    return;
  }
  const id = artifacts[0].id;
  if (!Number.isSafeInteger(id)) throw new Error('Invalid previous artifact identifier');
  const download = await fetch('https://api.github.com/repos/' + repo + '/actions/artifacts/' + id + '/zip',
    { headers, signal: AbortSignal.timeout(60000) });
  if (!download.ok) throw new Error('Cannot download previous backlog artifact (HTTP ' + download.status + ')');
  const file = path.join(state.directory, 'pending-restore.zip');
  try {
    fs.writeFileSync(file, Buffer.from(await download.arrayBuffer()), { mode: 0o600 });
    const result = child.spawnSync('unzip', ['-p', file, 'pending.json'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('Cannot extract prior pending.json artifact');
    const names = validatePending(JSON.parse(result.stdout));
    // Preserve original case if present in the artifact. Matching is case-insensitive.
    const raw = JSON.parse(result.stdout) as { names: string[] };
    state.setPending(raw.names);
    process.stdout.write('Restored ' + names.size + ' previously pending repository names\n');
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function run(): Promise<void> {
  const githubToken = requiredEnv('GG_GITHUB_TOKEN');
  const gitlabToken = requiredEnv('GG_GITLAB_TOKEN');
  hideToken(githubToken);
  hideToken(gitlabToken);
  const group = requiredEnv('GG_GITLAB_GROUP');
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(group)) throw new Error('Invalid GitLab root group path');
  const workspace = requiredEnv('GITHUB_WORKSPACE');
  const config = readConfig(requiredEnv('GG_CONFIG'), workspace);
  const state = new FileState(workspace);
  await runPipeline({ provider: new Providers(githubToken, gitlabToken, group), config, state,
    workspace, githubToken, gitlabToken });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'restore') return restore();
  if (mode === 'run') return run();
  throw new Error('Usage: node dist/index.js restore|run');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write('::error::' + message.replaceAll('\n', ' ') + '\n');
  process.exitCode = 1;
});
