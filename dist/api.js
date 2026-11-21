"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Providers = exports.ApiError = void 0;
const transport_1 = require("./transport");
class ApiError extends Error {
    status;
    provider;
    constructor(status, provider) {
        super(provider + ' API HTTP ' + status);
        this.status = status;
        this.provider = provider;
    }
}
exports.ApiError = ApiError;
class Providers {
    githubToken;
    gitlabToken;
    rootGroup;
    gitEnvironment;
    constructor(githubToken, gitlabToken, rootGroup) {
        this.githubToken = githubToken;
        this.gitlabToken = gitlabToken;
        this.rootGroup = rootGroup;
        this.gitEnvironment = (0, transport_1.gitEnv)(githubToken, gitlabToken);
    }
    async request(url, provider, method = 'GET', data) {
        const headers = provider === 'github' ? {
            Authorization: 'Bearer ' + this.githubToken,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        } : { 'PRIVATE-TOKEN': this.gitlabToken, Accept: 'application/json' };
        if (data !== undefined)
            headers['Content-Type'] = 'application/json';
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const response = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined,
                    signal: AbortSignal.timeout(30000) });
                if (response.status === 404 && method === 'GET')
                    return null;
                if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
                    const retry = response.headers.get('retry-after') || '';
                    const ms = /^\d+$/.test(retry) ? Math.min(60000, Number(retry) * 1000) : 5000 * 2 ** attempt;
                    await new Promise(resolve => setTimeout(resolve, ms));
                    continue;
                }
                if (!response.ok)
                    throw new ApiError(response.status, provider);
                return await response.json();
            }
            catch (err) {
                if (err instanceof ApiError)
                    throw err;
                if (attempt === 3)
                    throw new Error(provider + ' API unavailable after retries');
                await new Promise(resolve => setTimeout(resolve, 5000 * 2 ** attempt));
            }
        }
        throw new Error('API retries exhausted');
    }
    async githubUser() {
        const data = await this.request('https://api.github.com/user', 'github');
        if (typeof data?.login !== 'string')
            throw new Error('GitHub token cannot resolve user login');
        return data.login;
    }
    async githubRepositories() {
        const output = [];
        for (let page = 1; page <= 100; page++) {
            const url = 'https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&page=' + page;
            const batch = await this.request(url, 'github');
            if (!Array.isArray(batch))
                throw new Error('GitHub returned invalid repository list');
            output.push(...batch);
            if (batch.length < 100)
                return output;
        }
        throw new Error('GitHub repository pagination exceeded safety limit');
    }
    async gitlabUser() {
        const data = await this.request('https://gitlab.com/api/v4/user', 'gitlab');
        if (typeof data?.username !== 'string')
            throw new Error('GitLab token cannot resolve personal namespace');
        return data.username;
    }
    async verifyRootGroup() {
        const group = await this.request('https://gitlab.com/api/v4/groups/' + encodeURIComponent(this.rootGroup), 'gitlab');
        if (!group || group.visibility !== 'private' || group.full_path !== this.rootGroup || !Number.isSafeInteger(group.id)) {
            throw new Error('Configured GitLab root group missing, public or mismatched');
        }
        return group.id;
    }
    async ensurePrivateSubgroup(owner, rootId) {
        const slug = owner.toLowerCase();
        const destination = this.rootGroup + '/' + slug;
        let data = await this.request('https://gitlab.com/api/v4/groups/' + encodeURIComponent(destination), 'gitlab');
        if (!data) {
            data = await this.request('https://gitlab.com/api/v4/groups', 'gitlab', 'POST', {
                name: owner, path: slug, parent_id: rootId, visibility: 'private',
            });
        }
        if (data?.full_path !== destination || data.visibility !== 'private' || data.parent_id !== rootId) {
            throw new Error('GitLab subgroup not private or not owned by configured root');
        }
        return destination;
    }
    async gitlabRefs(namespaceAndName) {
        const data = await this.request('https://gitlab.com/api/v4/projects/' + encodeURIComponent(namespaceAndName), 'gitlab');
        if (!data)
            return null;
        if (String(data.path_with_namespace).toLowerCase() !== namespaceAndName.toLowerCase() || data.visibility !== 'private') {
            throw new Error('GitLab project identity/privacy check failed');
        }
        if (typeof data.http_url_to_repo !== 'string' || !data.http_url_to_repo.startsWith('https://gitlab.com/')) {
            throw new Error('GitLab clone URL must be https://gitlab.com');
        }
        return (0, transport_1.refs)(data.http_url_to_repo, this.gitEnvironment);
    }
    githubRefs(url) {
        if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(url))
            throw new Error('Unexpected GitHub clone URL');
        return (0, transport_1.refs)(url, this.gitEnvironment);
    }
}
exports.Providers = Providers;
