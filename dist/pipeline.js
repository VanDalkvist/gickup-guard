"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.preflight = preflight;
exports.postflight = postflight;
exports.runPipeline = runPipeline;
const state_1 = require("./state");
const policy_1 = require("./policy");
const transport_1 = require("./transport");
function ownedRepos(all, config) {
    const names = new Set(config.source.github.owners.map(o => o.name.toLowerCase()));
    return all.filter(x => names.has(x.owner.login.toLowerCase()));
}
function destinationFor(repo, config, gitlabUser, group) {
    const owner = config.source.github.owners.find(o => o.name.toLowerCase() === repo.owner.login.toLowerCase());
    if (!owner)
        throw new Error('Unconfigured owner');
    return (owner.kind === 'user' ? gitlabUser : group + '/' + owner.name.toLowerCase()) + '/' + repo.name;
}
async function preflight(services) {
    const { provider, state, config } = services;
    const prior = state.getPending();
    const [all, githubUser, gitlabUser] = await Promise.all([
        provider.githubRepositories(), provider.githubUser(), provider.gitlabUser(),
    ]);
    const expectedUser = config.source.github.owners.find(o => o.kind === 'user');
    if (githubUser.toLowerCase() !== expectedUser.name.toLowerCase()) {
        throw new Error('GitHub token user does not match configured personal account');
    }
    const rootId = await provider.verifyRootGroup();
    if (!Number.isSafeInteger(rootId))
        throw new Error('Invalid GitLab root group ID');
    const included = ownedRepos(all, config);
    for (const owner of config.source.github.owners) {
        const count = included.filter(x => x.owner.login.toLowerCase() === owner.name.toLowerCase()).length;
        if (count < owner.minVisible)
            throw new Error('GitHub token visibility below configured baseline for ' + owner.name);
    }
    const visible = new Set(included.map(x => x.full_name.toLowerCase()));
    const unreachable = [...prior].filter(x => !visible.has(x));
    if (unreachable.length)
        throw new Error('Previously pending repositories are no longer visible; refusing to drop retry state');
    const selected = (0, policy_1.selectCandidates)(included, config, prior, new Date());
    const plan = { version: 1, startedAt: new Date().toISOString(), examined: selected.length,
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
            if (existing === null || Object.keys((0, policy_1.refDifferences)(sourceRefs, existing)).length > 0) {
                plan.queued.push({ name: repo.full_name, repo: repo.name, owner: repo.owner.login,
                    target, refs: sourceRefs, pushedAt: repo.pushed_at,
                    carriedFromPrevious: prior.has(repo.full_name.toLowerCase()) });
            }
            else {
                plan.matched++;
            }
        }
        catch (error) {
            plan.errors.push({ name: repo.full_name, reason: String(error instanceof Error ? error.message : error) });
        }
    }
    const unsafe = (0, policy_1.ambiguousNames)(plan.queued.map(x => ({ name: x.name, repo: x.repo })), all);
    if (unsafe.size) {
        for (const name of unsafe)
            plan.errors.push({ name, reason: 'Duplicate repository name across owners; cannot safely use Gickup include' });
        plan.queued = plan.queued.filter(x => !unsafe.has(x.name));
    }
    state.writePlan(plan);
    state.setPending([...plan.queued.map(x => x.name), ...plan.errors.map(x => x.name)]);
    (0, state_1.appendSummary)('## Gickup Guard / preflight\n\n' +
        '| Selected (recent + retry) | Already matched | Needs transfer | Errors | Empty sources |\n' +
        '| ---: | ---: | ---: | ---: | ---: |\n' +
        `| ${plan.examined} | ${plan.matched} | ${plan.queued.length} | ${plan.errors.length} | ${plan.empty} |\n`);
    return plan;
}
async function transfer(services, plan) {
    const errors = [];
    const { provider, config, workspace, githubToken, gitlabToken } = services;
    const byOwner = new Map();
    for (const item of plan.queued) {
        const items = byOwner.get(item.owner) ?? [];
        items.push(item);
        byOwner.set(item.owner, items);
    }
    for (const [ownerName, items] of byOwner) {
        const cfg = config.source.github.owners.find(o => o.name.toLowerCase() === ownerName.toLowerCase());
        const namespace = cfg.kind === 'user' ? items[0].target.split('/')[0]
            : provider.rootGroup + '/' + ownerName.toLowerCase();
        try {
            if (cfg.kind === 'org')
                await provider.ensurePrivateSubgroup(ownerName, await provider.verifyRootGroup());
            (0, transport_1.runGickup)(ownerName, namespace, items.map(x => x.repo), config.source.github.exclude, workspace, githubToken, gitlabToken);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ name: ownerName, reason: message });
            process.stdout.write('::warning::Transfer reported an error for a configured owner\n');
        }
    }
    return errors;
}
async function postflight(services, plan) {
    const { provider, state } = services;
    const result = { version: 1, verified: [], pending: [...plan.errors] };
    for (const item of plan.queued) {
        try {
            const actual = await provider.gitlabRefs(item.target);
            if (actual === null)
                throw new Error('Missing GitLab project');
            let differences = (0, policy_1.refDifferences)(item.refs, actual);
            if (Object.keys(differences).length) {
                // A concurrent source push is not part of this run's snapshot. A new
                // GitLab SHA is acceptable only when it now matches live GitHub.
                const fresh = await provider.githubRefs('https://github.com/' + item.name + '.git');
                differences = Object.fromEntries(Object.entries(differences).filter(([key]) => actual[key] !== fresh[key] || fresh[key] === undefined));
            }
            if (Object.keys(differences).length)
                throw new Error('Unverified captured refs: ' + Object.keys(differences).length);
            result.verified.push(item.name);
        }
        catch (error) {
            result.pending.push({ name: item.name, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    state.setPending(result.pending.map(x => x.name));
    state.writeResult(result);
    (0, state_1.appendSummary)('## Gickup Guard / postflight\n\n' +
        '| Verified against initial refs | Still pending |\n| ---: | ---: |\n' +
        `| ${result.verified.length} | ${result.pending.length} |\n` +
        (result.pending.length ? '\nUnresolved entries were saved for retry.\n' : '\nAll required Git refs verified.\n'));
    return result;
}
async function runPipeline(services) {
    const plan = await preflight(services);
    // Snapshot and conservative retry backlog are persisted before any transfer.
    const transferErrors = await transfer(services, plan);
    if (transferErrors.length)
        process.stdout.write('::warning::Gickup reported transfer errors; postflight will determine actual delivery\n');
    const result = await postflight(services, plan);
    if (result.pending.length)
        throw new Error(result.pending.length + ' repositories still require a verified backup');
}
