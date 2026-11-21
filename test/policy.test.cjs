'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../dist/config');
const { selectCandidates, isRecent, refDifferences, ambiguousNames, validatePending } = require('../dist/policy');
const { FileState } = require('../dist/state');
const { gickupConfig, gitEnv } = require('../dist/transport');
const { preflight, postflight } = require('../dist/pipeline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configuration() {
  return {
    version: 1,
    source: { github: { owners: [
      { name: 'example-user', kind: 'user', minVisible: 1 },
      { name: 'example-org', kind: 'org', minVisible: 0 },
    ], excludeForks: true, exclude: ['example-org/huge-archive'] } },
    destination: { gitlab: { visibility: 'private' } },
    sync: { activityHours: 48 },
  };
}
const now = new Date('2026-11-21T20:00:00Z');
function repo(name, owner='example-user', pushed_at='2026-11-21T17:00:00Z', fork=false) {
  return { full_name: owner + '/' + name, owner: { login: owner }, name,
    fork, pushed_at, clone_url: 'https://github.com/' + owner + '/' + name + '.git' };
}

// All fixtures and identifiers in this file are fabricated and non-user-specific.
test('configuration validates public example and rejects unsafe config', () => {
  const cfg = validateConfig(configuration());
  assert.equal(cfg.sync.activityHours, 48);
  assert.throws(() => validateConfig({ ...cfg, destination: { gitlab: { visibility: 'public' } } }), /Only private/);
  assert.throws(() => validateConfig({ ...cfg, source: { github: { ...cfg.source.github, excludeForks: false } } }), /excludeForks/);
  const duplicate = configuration();
  duplicate.source.github.owners.push({name:'EXAMPLE-USER',kind:'org', minVisible:0});
  assert.throws(() => validateConfig(duplicate), /Duplicate/);
});

test('48-hour cutoff inclusive and invalid activity excluded', () => {
  assert.equal(isRecent('2026-11-19T20:00:00Z', now, 48), true);
  assert.equal(isRecent('2026-11-19T19:59:59Z', now, 48), false);
  assert.equal(isRecent('2026-11-21T20:00:01Z', now, 48), false);
  assert.equal(isRecent('invalid', now, 48), false);
});

test('source selection skips inactive, forks, exclusion, but includes retry backlog', () => {
  const all = [repo('fresh'), repo('old', 'example-user', '2020-01-01T00:00:00Z'),
    repo('old-retry', 'example-user', '2020-01-01T00:00:00Z'),
    repo('fork', 'example-user', '2026-11-21T17:00:00Z', true),
    repo('huge-archive', 'example-org'), repo('other', 'unconfigured')];
  assert.deepEqual(selectCandidates(all, configuration(), new Set(['example-user/old-retry']), now).map(x => x.name),
    ['fresh', 'old-retry']);
});

test('GitLab-only retained historical refs are tolerated; mismatching source refs are not', () => {
  const expected = {'refs/heads/main':'a'.repeat(40), 'refs/tags/v1':'b'.repeat(40)};
  const observed = {'refs/heads/main':'a'.repeat(40), 'refs/heads/history':'c'.repeat(40)};
  assert.deepEqual(refDifferences(expected, observed), {'refs/tags/v1':'b'.repeat(40)});
});

test('ambiguous name owned by different accounts is rejected before Gickup', () => {
  const same = [repo('overlap'), repo('overlap', 'example-org')];
  assert.deepEqual([...ambiguousNames([{name:'example-user/overlap',repo:'overlap'}], same)],
    ['example-user/overlap']);
});

test('Gickup configuration never embeds credentials and targets exact included names', () => {
  const yaml = gickupConfig('example-user', 'safe-backups/example-user', ['alpha', 'beta'], ['example-user/skip']);
  assert.match(yaml, /include: \["alpha","beta"\]/);
  assert.match(yaml, /exclude: \["skip"\]/);
  assert.match(yaml, /user: "safe-backups\/example-user"/);
  assert.match(yaml, /token: GH_SOURCE_TOKEN/);
  assert.match(yaml, /token: GITLAB_TOKEN/);
});

test('Git credentials only in subprocess environment; no token in Git command argv', () => {
  const env = gitEnv('fake-github-token-123', 'fake-gitlab-token-456');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.ok(!Object.keys(env).some(k => k.includes('fake-')));
});

test('pending state persists even when last source activity is old', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-synthetic-'));
  try {
    const state = new FileState(dir);
    state.setPending(['example-user/old-retry']);
    assert.deepEqual([...state.getPending()], ['example-user/old-retry']);
    assert.deepEqual(selectCandidates([repo('old-retry', 'example-user', '2020-01-01T00:00:00Z')],
      configuration(), state.getPending(), now).map(x => x.name), ['old-retry']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('invalid retry state cannot silently clear backlog', () => {
  assert.throws(() => validatePending({version:3, names:['example-user/fake']}), /Invalid/);
  assert.throws(() => validatePending({version:1, names:[5]}), /Invalid/);
});

test('preflight only checks active synthetic sources and records missing target', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-synthetic-'));
  try {
    const state = new FileState(dir);
    const all = [repo('fresh'), repo('old','example-user','2020-01-01T00:00:00Z')];
    const checked = [];
    const provider = {
      rootGroup:'safe-backups',
      githubRepositories:async()=>all,
      githubUser:async()=> 'example-user', gitlabUser:async()=> 'mirror-user',
      verifyRootGroup:async()=>1234,
      githubRefs:async url=>{checked.push(url);return {'refs/heads/main':'a'.repeat(40)};},
      gitlabRefs:async()=>null,
    };
    const plan = await preflight({provider, state, config:configuration(), workspace:dir, githubToken:'dummy', gitlabToken:'dummy'});
    assert.equal(plan.examined,1);
    assert.equal(plan.queued.length,1);
    assert.equal(plan.queued[0].target,'mirror-user/fresh');
    assert.deepEqual(checked,['https://github.com/example-user/fresh.git']);
    assert.deepEqual([...state.getPending()],['example-user/fresh']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('preflight inspection error is persisted as a retry without transfer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-synthetic-'));
  try {
    const state = new FileState(dir);
    const provider = {
      rootGroup:'safe-backups', githubRepositories:async()=>[repo('fresh')],
      githubUser:async()=> 'example-user', gitlabUser:async()=> 'mirror-user',
      verifyRootGroup:async()=>1234,
      githubRefs:async()=>({'refs/heads/main':'a'.repeat(40)}),
      gitlabRefs:async()=>{throw new Error('HTTP 429 from synthetic mock');},
    };
    const plan = await preflight({provider, state, config:configuration(), workspace:dir, githubToken:'dummy', gitlabToken:'dummy'});
    assert.equal(plan.errors.length,1);
    assert.equal(plan.queued.length,0);
    assert.deepEqual([...state.getPending()],['example-user/fresh']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('postflight clears queue only when target SHA matches captured snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-synthetic-'));
  try {
    const state = new FileState(dir);
    const plan = { version:1,startedAt:now.toISOString(),examined:1,matched:0,empty:0,errors:[],queued:[{
      name:'example-user/fresh',owner:'example-user',repo:'fresh',target:'mirror-user/fresh',
      refs:{'refs/heads/main':'a'.repeat(40)},pushedAt:now.toISOString(),carriedFromPrevious:false,
    }]};
    const source = { provider:{ rootGroup:'safe-backups',
      gitlabRefs:async()=>({'refs/heads/main':'b'.repeat(40)}),
      githubRefs:async()=>({'refs/heads/main':'a'.repeat(40)}) },state,
      config:configuration(),workspace:dir,githubToken:'dummy',gitlabToken:'dummy'};
    let result = await postflight(source,plan);
    assert.equal(result.pending.length,1);
    assert.deepEqual([...state.getPending()],['example-user/fresh']);
    source.provider.gitlabRefs = async()=>({'refs/heads/main':'a'.repeat(40)});
    result = await postflight(source,plan);
    assert.deepEqual(result.pending,[]);
    assert.deepEqual([...state.getPending()],[]);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
