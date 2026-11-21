# Gickup Guard — positioning notes

These are **product hypotheses**, not findings from customer interviews. They are informed by the current implemented behavior and [Ivan Zamesin's Next Move Theory](https://github.com/zamesin/Next-Move-Theory-Canon-and-Skills), especially segment+Job, success criteria, the Critical Chain of Jobs, and communication through demonstrable value. Copy editing follows the structure/factual-proof rules in [Sarycheva and Arkhipov's editing skills](https://github.com/N1arko/redaktura-skills). This document contains **no real user data**.

## Hypothesized segment and Job

**Segment hypothesis:** individual developers and small engineering teams that use GitHub as the working Git host and GitLab as a private secondary mirror, with more repositories than they want to check manually. This is defined by the *Job and its success criteria*, not by team size alone.

**Situation / State A:** a scheduled Git mirror task runs; some repositories have recent pushes, and the user cannot tell from the command exit status alone whether all intended Git refs arrived.

**Core Job / State B:** "When my scheduled mirror runs, I want to confirm that the branches and tags that needed copying have reached GitLab, so I can rely on that second Git copy without checking each repository by hand."

**Higher-level Job (hypothesis):** reduce the chance that losing access to the primary Git host interrupts work.

**Expected success criteria (unvalidated):**
- Know which relevant repositories matched, were transferred, or still failed.
- Confirm the ref SHAs captured at the start of the run, rather than trusting the transfer command alone.
- Retry failures after they age out of the normal recent-activity window.
- Avoid rereading and resending inactive or already matching repositories.
- Keep secrets and private repo metadata in a private caller repository.
- Avoid introducing an always-on server or separate database.

## Current alternative solutions (hypotheses to validate)

Manual spot checks; cron/Actions running Gickup by itself; provider-native Git mirroring; generic Git push scripts. We haven't validated which approach is the dominant alternative for this segment.

## Value proposition

**Category:** GitHub Action for verified incremental GitHub-to-GitLab mirroring.

**One-line offer:** "Check what changed, sync only mismatches, and verify that GitLab has the expected Git refs."

**Differentiation:** the before/after SHA snapshot and persisted retry queue around Gickup. Features are proof of the result; the customer-facing outcome is knowing what got copied and what still needs attention.

**Activation path:** find the Action → read its GitHub/GitLab scope → copy fictional config and workflow → set private credentials → run → inspect preflight and postflight results. The hypothesized Aha Moment is seeing a run confirm exactly which ref updates were delivered, with unfinished transfers visible for retry.

## Claims ledger

| Claim | Status | Evidence or limit |
| --- | --- | --- |
| Checks branch and tag ref SHAs before and after sync | Implemented | Git ref preflight/postflight code and synthetic tests |
| Transfers only selected mismatches through Gickup | Implemented | Transfer selection and Gickup invocation |
| Retains incomplete work for later scheduled runs | Implemented | GitHub Actions artifact-based retry queue, 90-day retention limit |
| Does not require a dedicated server/database | Implemented | Runs within GitHub Actions |
| Reduces developers' time spent checking mirrors | **Hypothesis** | Requires independent users and comparison with current workflows |
| Makes disaster recovery reliable | **Not established** | No restore drill; not all Git objects or GitHub metadata are checked |
| Better than any other backup option | **Not established** | No comparative customer or provider study |

## Riskiest assumptions and cheapest tests

1. **The intended user cares about verified Git refs enough to configure an additional Action.** Test with interviews or observed installs from developers who already mirror GitHub to GitLab; check whether they actually review postflight results.
2. **Installation is understandable without assistance.** Give the README and fictional example to a developer unfamiliar with the project and observe first successful private run.
3. **The limited guarantee is understood.** Ask testers what "green" proves, including whether they mistakenly expect issues, release assets, LFS, or full restore coverage.

## Communication rules

- Begin with the user's backup concern and measurable ref-level outcome.
- Present Gickup as the transfer engine and Gickup Guard as the verification/retry layer.
- Avoid saying "guaranteed backup", "disaster-proof" or "all repositories verified".
- Be explicit that activity filtering skips inactive sources unless they are in the pending queue.
- Use examples with fictional accounts only. Never publish real repository inventories, backup summaries, tokens, logs, or user metrics.
- One first step: copy the example into a private caller repository and run it.
