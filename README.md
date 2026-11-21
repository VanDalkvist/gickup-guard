# Gickup Guard

**Know when your GitHub-to-GitLab backup has caught up.**

Gickup Guard is a GitHub Action that checks recently changed Git repositories, copies only missing or outdated refs to GitLab using [Gickup](https://github.com/cooperspencer/gickup), and verifies the result by Git SHA. Failed backups stay on a retry list, even after the normal activity window expires.

It runs on GitHub Actions. You do not need to run a server or maintain a database.

## Who it's for

You keep code on GitHub and want a second copy on GitLab. You might have repositories across a personal account and several organizations. A scheduled backup command can finish without telling you which mirrors are still behind.

Gickup Guard gives each run a clear result: **which repositories were already current, which needed copying, and which still need another attempt**.

## What happens on each run

| Step | What happens |
| --- | --- |
| **Check** | Read Git refs for repositories pushed within your activity window and for previous failures. Compare their branch and tag SHAs with GitLab. |
| **Copy** | Ask Gickup to transfer only repositories with missing or different refs. Repositories that already match are skipped. |
| **Verify** | Recheck the GitLab refs against the snapshot captured before the transfer. A newer ref is accepted only when it also matches the current GitHub source. |
| **Retry** | Keep unfinished repositories in the private caller repository's Actions artifacts for the next run, even if they are now older than the activity window. |

A passing run means **all selected Git refs were confirmed** at the destination. A failed run identifies the unresolved repositories and retains them for the next attempt.

### The limit of that guarantee

The Action compares Git branch/tag references, including annotated tag targets. It does **not** test restoration of arbitrary Git objects, audit inactive repositories outside the activity window, or back up GitHub Issues, pull requests, releases, Git LFS, or wikis. Extra historical refs kept by GitLab are allowed. Its retry state is retained for 90 days; a long-disabled workflow can lose that queue.

## Get started

Use a **private GitHub repository** to run backups. It keeps your tokens, repo inventory, logs, and retry reports away from the public Action's repository.

1. Copy [the example config](examples/config.json) to \`github-backup/config.json\` in your private repository. Change the fictional account names to your own.
2. Add \`GH_SOURCE_TOKEN\` and \`GITLAB_TOKEN\` to your private repository's **Actions secrets**. Give the GitHub token access to the configured repositories and the GitLab token API access to your private destination.
3. Create a private GitLab root group for organization mirrors. Store its path as the **Actions variable** \`GITLAB_BACKUP_GROUP\`.
4. Copy [the example workflow](examples/backup.yml) to \`.github/workflows/backup.yml\`. Replace its placeholder Action reference with a reviewed [release](https://github.com/VanDalkvist/gickup-guard/releases) tag or, for stronger version pinning, a full commit SHA.
5. Start the workflow manually in the private repository's **Actions** tab. Future scheduled runs use the same configuration.

**Needs:** a GitHub-hosted \`ubuntu-latest\` runner with Docker, Git, unzip and Node.js 24; \`actions: read\` and \`contents: read\` workflow permissions. A classic GitHub PAT with \`repo\` scope is **not read-only**, so use the narrowest workable credential and review organization access.

### Example configuration

\`\`\`json
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
\`\`\`

The example uses **fictional identifiers** and contains no credentials.

- **\`owners\`** — exactly one \`kind: user\`, plus optional \`kind: org\` entries. The personal account maps to the GitLab account in \`GITLAB_TOKEN\`; organizations map to private subgroups of \`GITLAB_BACKUP_GROUP\`.
- **\`minVisible\`** — fail if the GitHub token unexpectedly sees fewer repositories for that owner. Set \`0\` to disable this check.
- **\`exclude\`** — omit specific repositories by full \`owner/repo\` name. Forks are always excluded.
- **\`activityHours\`** — inspect recently pushed repositories plus anything left unfinished in previous runs. This isn't a full inventory audit.

For the complete workflow, see [\`examples/backup.yml\`](examples/backup.yml).

## What Gickup Guard adds to Gickup

[Gickup](https://github.com/cooperspencer/gickup) handles cloning and mirroring Git repositories. Gickup Guard adds **before/after ref checks** and **a durable retry list** around Gickup's existing transfer machinery. It does not attempt to replace Gickup or build a general-purpose backup framework.

The public Action contains only TypeScript source, generated JavaScript, synthetic tests, documentation, and fictional examples. The backup job's reports and queue are written to **the caller's** GitHub Actions artifacts (\`gickup-guard-report\` retained 30 days; \`gickup-guard-pending\` retained 90 days). No backup state is uploaded to this public repository.

### Security boundaries

- GitLab destinations must be private; the Action checks project/group privacy before transfer.
- Gickup runs with \`force: false\`. The Action does not deliberately delete GitHub or GitLab repositories.
- Tokens are supplied as Action inputs and passed into the runner as environment variables. Do not commit them to configuration files.
- Gickup runs as an external Docker image pinned by digest.
- v0.1 supports **GitHub.com → GitLab.com**. Self-hosted instances, other Git providers, full object verification, and other backup formats are out of scope.
- GitHub Actions artifacts can expose repository names and refs; keep the caller repository private.

## Develop

\`\`\`bash
npm install
npm test
\`\`\`

The Action's TypeScript builds to checked-in \`dist/\`. CI tests it with **synthetic mocks** and checks that the generated JavaScript matches the source. No real users, repository inventories, or credentials are used in tests.

See [product positioning and unvalidated assumptions](docs/positioning.md) for the reasoning behind this narrow scope.

## License

MIT. Gickup is independently maintained and runs as an external Docker image.
