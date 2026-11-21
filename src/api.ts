import type { GithubRepo, RefMap } from './types';
import { refs, gitEnv } from './transport';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly provider: string) {
    super(provider + ' API HTTP ' + status);
  }
}

export class Providers {
  private gitEnvironment: Record<string, string>;
  constructor(private readonly githubToken: string, private readonly gitlabToken: string,
              public readonly rootGroup: string) {
    this.gitEnvironment = gitEnv(githubToken, gitlabToken);
  }

  private async request(url: string, provider: 'github' | 'gitlab', method = 'GET', data?: object): Promise<any | null> {
    const headers: Record<string, string> = provider === 'github' ? {
      Authorization: 'Bearer ' + this.githubToken,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    } : { 'PRIVATE-TOKEN': this.gitlabToken, Accept: 'application/json' };
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined,
          signal: AbortSignal.timeout(30000) });
        if (response.status === 404 && method === 'GET') return null;
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
          const retry = response.headers.get('retry-after') || '';
          const ms = /^\d+$/.test(retry) ? Math.min(60000, Number(retry) * 1000) : 5000 * 2 ** attempt;
          await new Promise(resolve => setTimeout(resolve, ms));
          continue;
        }
        if (!response.ok) throw new ApiError(response.status, provider);
        return await response.json();
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (attempt === 3) throw new Error(provider + ' API unavailable after retries');
        await new Promise(resolve => setTimeout(resolve, 5000 * 2 ** attempt));
      }
    }
    throw new Error('API retries exhausted');
  }

  async githubUser(): Promise<string> {
    const data = await this.request('https://api.github.com/user', 'github');
    if (typeof data?.login !== 'string') throw new Error('GitHub token cannot resolve user login');
    return data.login;
  }

  async githubRepositories(): Promise<GithubRepo[]> {
    const output: GithubRepo[] = [];
    for (let page = 1; page <= 100; page++) {
      const url = 'https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&page=' + page;
      const batch = await this.request(url, 'github');
      if (!Array.isArray(batch)) throw new Error('GitHub returned invalid repository list');
      output.push(...batch);
      if (batch.length < 100) return output;
    }
    throw new Error('GitHub repository pagination exceeded safety limit');
  }

  async gitlabUser(): Promise<string> {
    const data = await this.request('https://gitlab.com/api/v4/user', 'gitlab');
    if (typeof data?.username !== 'string') throw new Error('GitLab token cannot resolve personal namespace');
    return data.username;
  }

  async verifyRootGroup(): Promise<number> {
    const group = await this.request('https://gitlab.com/api/v4/groups/' + encodeURIComponent(this.rootGroup), 'gitlab');
    if (!group || group.visibility !== 'private' || group.full_path !== this.rootGroup || !Number.isSafeInteger(group.id)) {
      throw new Error('Configured GitLab root group missing, public or mismatched');
    }
    return group.id;
  }

  async ensurePrivateSubgroup(owner: string, rootId: number): Promise<string> {
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

  async gitlabRefs(namespaceAndName: string): Promise<RefMap | null> {
    const data = await this.request('https://gitlab.com/api/v4/projects/' + encodeURIComponent(namespaceAndName), 'gitlab');
    if (!data) return null;
    if (String(data.path_with_namespace).toLowerCase() !== namespaceAndName.toLowerCase() || data.visibility !== 'private') {
      throw new Error('GitLab project identity/privacy check failed');
    }
    if (typeof data.http_url_to_repo !== 'string' || !data.http_url_to_repo.startsWith('https://gitlab.com/')) {
      throw new Error('GitLab clone URL must be https://gitlab.com');
    }
    return refs(data.http_url_to_repo, this.gitEnvironment);
  }

  githubRefs(url: string): Promise<RefMap> {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(url)) throw new Error('Unexpected GitHub clone URL');
    return refs(url, this.gitEnvironment);
  }
}
