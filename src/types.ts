export type RefMap = Record<string, string>;

export interface OwnerConfig {
  name: string;
  kind: 'user' | 'org';
  minVisible: number;
}

export interface GuardConfig {
  version: 1;
  source: {
    github: {
      owners: OwnerConfig[];
      excludeForks: true;
      exclude: string[];
    };
  };
  destination: { gitlab: { visibility: 'private' } };
  sync: { activityHours: number };
}

export interface GithubRepo {
  full_name: string;
  name: string;
  clone_url: string;
  pushed_at: string | null;
  fork: boolean;
  owner: { login: string };
}

export interface PlannedItem {
  name: string;
  repo: string;
  owner: string;
  target: string;
  refs: RefMap;
  pushedAt: string | null;
  carriedFromPrevious: boolean;
}

export interface PlanError { name: string; reason: string }
export interface Plan {
  version: 1;
  startedAt: string;
  examined: number;
  matched: number;
  empty: number;
  queued: PlannedItem[];
  errors: PlanError[];
}

export interface Pending {
  version: 1;
  names: string[];
}

export interface PostResult {
  version: 1;
  verified: string[];
  pending: PlanError[];
}
