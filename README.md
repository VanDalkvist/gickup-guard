# Gickup Guard

**Don't just run backups. Verify they actually synced.**

Back up only changed GitHub repositories to private GitLab mirrors, **verify branches and tags by Git SHA**, and automatically retry incomplete transfers. Powered by [Gickup](https://github.com/cooperspencer/gickup); runs in GitHub Actions with no separate server or database.

## Why Gickup Guard?

A successful backup command isn't the same as a verified backup. A transient API error, missing project, or incomplete Git push can leave a mirror behind while the next scheduled run moves on.

Gickup Guard closes that gap for **developers and small teams using GitLab as a secondary home for their GitHub repositories**:

| What it does | Why it matters |
| --- | --- |
| **Check before transfer** | Skip repositories whose source branch/tag refs already match GitLab. |
| **Sync only mismatches** | Avoid repeatedly transferring everything in your configured activity window. |
| **Verify after transfer** | Mark the job successful only when the selected source refs are confirmed at their captured SHA (or a verified newer source SHA). |
| **Retry incomplete backups** | Keep failed repositories in a persistent queue even after their last push becomes older than the activity window. |
| **Stay private** | Keep GitHub/GitLab tokens, repository inventories, reports, and retry artifacts in your own private caller repository. |

### One small, verifiable pipeline

```text
Discover recent + unfinished repos
          ↓
Snapshot Git refs → Compare GitLab
          ↓
Gickup transfers only mismatches
          ↓
Verify captured SHA → Success or retry
```

**What a green run means:** all selected Git refs were matched or verified in GitLab for that run. **It does not mean** every historical repository was audited, all Git objects were restore-tested, or GitHub issues, releases, LFS, and wikis were backed up. Those are deliberately outside this Action's scope.

**Scope:** GitHub.com sources (one personal account and optional organizations) → private GitLab.com mirrors. This is a Git-specific safety layer around Gickup, **not** a generic backup engine or a replacement for [Rclone](https://rclone.org/) / [Restic](https://restic.net/).

## Quick start

1. Create a **private** repository for your backup job. The GitHub Actions artifacts and logs will contain repository names and reference data from your sources.
2. Copy [examples/config.json](examples/config.json) into `github-backup/config.json`, replacing the fabricated names with your own.
3. Add `GH_SOURCE_TOKEN` (classic GitHub PAT with `repo` scope and organizational access) and `GITLAB_TOKEN` (GitLab token with API access) as repository Actions **secrets**. Set `GITLAB_BACKUP_GROUP` to a private GitLab root group path in repository Actions **variables**; create that root group first.
4. Copy [examples/backup.yml](examples/backup.yml) to `.github/workflows/backup.yml`. **Pin** `uses:` to a reviewed full commit SHA of this Action, not the placeholder.
5. Run the workflow manually. The next run will restore its retry backlog from the preceding artifact. Scheduled runs use the same code path.

The reusable Action requires `actions: read` for its own artifact lookup and `contents: read` for checkout. It runs on GitHub-hosted `ubuntu-latest` runners with Node.js 24, Docker, Git and `unzip`.

## Configuration

[Example (only fictional entities)](examples/config.json):

```json
{
  "version": 1,
  "source": {
    "github": {
      "owners": [
        { "name": "example-user", "kind": "user", "minVisible": 0 },
        { "name": "example-organization", "kind": "org", "minVisible": 0 }
      ],
      "excludeForks": true,
      "exclude": ["example-organization/oversized-demo"]
    }
  },
  "destination": { "gitlab": { "visibility": "private" } },
  "sync": { "activityHours": 48 }
}
```

- `kind: user` is the personal account named by the GitHub source PAT, stored in the GitLab account named by the GitLab token. Exactly one user entry is required.
- `kind: org` is stored under `<GITLAB_BACKUP_GROUP>/<lowercase-org-name>/<repo-name>` in a private subgroup.
- `minVisible` fails closed if the source PAT unexpectedly sees fewer repositories than configured; `0` disables this protection for that owner.
- `exclude` contains **full** `owner/repo` names. Forks are always excluded.
- `activityHours` chooses which repos are inspected, plus any previously unsuccessful repos irrespective of age. Inactive clean repositories are not scanned.

## How it works

1. **Preflight** lists metadata for configured owners; it reads Git SHA refs only for recently pushed repositories and previously unfinished ones. It snapshots refs and compares them with the corresponding private GitLab projects. Already matched repositories are not transferred.
2. **Gickup** receives an exact include-list for each owner with pending work. If a repository name is ambiguous across owners, that source fails closed and remains pending. GitLab destinations are private, `force: false`; Gickup must not delete existing GitLab repositories.
3. **Postflight** compares the destination against the refs captured in step 1. Concurrent new pushes are not required retroactively. Persistent errors, missing refs and failed checks leave the Action red, with retry names carried forward to the next run.

The retry queue is kept in `gickup-guard-pending` **Actions artifacts in the caller's repository** for 90 days; full reports are retained for 30 days. This uses artifact storage rather than a separate service or database. It cannot guarantee continuity if workflows are disabled beyond retention or if artifact access is revoked.

**Guarantee boundary:** compares exact branch/tag refs (including annotated tags' peeled refs), not the existence of every historical Git object, Git LFS data, releases, issues, wikis, or restoration of arbitrary objects. Retained GitLab-only refs do not fail the test. This workflow does not audit older unrelated repositories outside the activity window and pending backlog.

## Privacy and security

- The public repository contains **only source code, synthetic tests, and fictional examples**. Never copy private configuration, token values, private backup reports or real repository inventories here.
- Run backups in a **private consumer repository**. Artifacts and logs are uploaded only to that consumer's Actions, not to this Action repository.
- Credentials are passed as masked Action inputs and process environment variables. Temporary Gickup configurations contain environment-variable references, not credential values; they are removed after execution.
- Preflight checks destination project privacy and group ownership before running Gickup. Gickup is pinned to a specific container digest.
- This Action's runtime calls `https://api.github.com` and `https://gitlab.com`. Third-party Git hosts and self-hosted GitLab are not supported in v0.1.
- Review scopes carefully. A classic GitHub PAT with `repo` scope is powerful and **not read-only**; use a dedicated credential where practical.

## Development

```bash
npm install
npm test
```

Built JavaScript is committed to `dist/` because GitHub Actions must run the Action without requiring an `npm install` in the calling repository. The CI verifies that `dist/` is synchronized with `src/` and tests use **mocked synthetic providers**, not real personal data or credentials.

## License

MIT. Gickup is an independently maintained project, invoked as an external Docker image.
