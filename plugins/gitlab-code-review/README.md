# Code Review Plugin

Automated code review for pull requests using multiple specialized agents with confidence-based scoring to filter false positives.

## Overview

The Code Review Plugin automates pull request review by launching multiple agents in parallel to independently audit changes from different perspectives. It uses confidence scoring to filter out false positives, ensuring only high-quality, actionable feedback is posted.

## Commands

### `/glab-code-review`

Performs automated code review on a pull request using multiple specialized agents.

**What it does:**
1. Resolves the range to review: the whole merge request the first time, and only the
   commits added since its own previous review afterwards
2. Checks whether a review is needed: closed, merged and draft merge requests are skipped by
   the range resolver, and trivial or automated ones by the main agent
3. Lists the CLAUDE.md guideline files that govern the changed files
4. Launches 4 parallel agents to independently review: two for CLAUDE.md compliance and
   two for bugs and logic errors
5. Validates every candidate finding with a second agent, and drops the ones that do not
   survive validation
6. Posts each surviving finding as an inline discussion on the changed line, then one
   summary note recording the reviewed head SHA

**Usage:**
```bash
/glab-code-review <merge-request-iid>
```

**This command writes to the merge request.** It posts inline comments and a summary note
every time it runs; there is no terminal-only mode. The summary note is what makes the next
review incremental, so it is posted even when no issues were found.

It currently requires the GitLab CI environment variables listed under
[Running in CI](#running-in-ci); outside a CI job it stops with a message naming the missing
variable.

**Features:**
- Multiple independent agents for comprehensive review
- Confidence-based scoring reduces false positives (threshold: 80)
- CLAUDE.md compliance checking with explicit guideline verification
- Bug detection focused on changes (not pre-existing issues)
- Historical context analysis via git blame
- Automatic skipping of closed, draft, or already-reviewed PRs
- Links directly to code with full SHA and line ranges

**Review comment format:**
```markdown
## Code review

Found 3 issues:

1. Missing error handling for OAuth callback (CLAUDE.md says "Always handle OAuth errors")

https://github.com/owner/repo/blob/abc123.../src/auth.ts#L67-L72

2. Memory leak: OAuth state not cleaned up (bug due to missing cleanup in finally block)

https://github.com/owner/repo/blob/abc123.../src/auth.ts#L88-L95

3. Inconsistent naming pattern (src/conventions/CLAUDE.md says "Use camelCase for functions")

https://github.com/owner/repo/blob/abc123.../src/utils.ts#L23-L28
```

**Confidence scoring:**
- **0**: Not confident, false positive
- **25**: Somewhat confident, might be real
- **50**: Moderately confident, real but minor
- **75**: Highly confident, real and important
- **100**: Absolutely certain, definitely real

**False positives filtered:**
- Pre-existing issues not introduced in PR
- Code that looks like a bug but isn't
- Pedantic nitpicks
- Issues linters will catch
- General quality issues (unless in CLAUDE.md)
- Issues with lint ignore comments

## Installation

This plugin is included in the Claude Code repository. The command is automatically available when using Claude Code.

## Best Practices

### Using `/glab-code-review`
- Maintain clear CLAUDE.md files for better compliance checking
- Trust the 80+ confidence threshold - false positives are filtered
- Run on all non-trivial pull requests
- Review agent findings as a starting point for human review
- Update CLAUDE.md based on recurring review patterns

### When to use
- All pull requests with meaningful changes
- PRs touching critical code paths
- PRs from multiple contributors
- PRs where guideline compliance matters

### When not to use
- Closed or draft PRs (automatically skipped anyway)
- Trivial automated PRs (automatically skipped)
- Urgent hotfixes requiring immediate merge
- PRs already reviewed (automatically skipped)

## Workflow Integration

### Standard merge request review workflow:
```bash
# Open the merge request, then from a CI job on it:
/glab-code-review 123

# Findings land as inline comments on the changed lines, plus one summary note.
# Push fixes; the next run reviews only the new commits.
```

### As part of CI/CD:

See [Running in CI](#running-in-ci). The job triggers on `merge_request_event`, and the
command skips itself when the merge request is closed, draft, or has no new commits since
its last review.

## Requirements

- A GitLab project, and a token with the `api` scope
- GitLab CLI (`glab`) installed and authenticated
- `jq` and `git` on PATH
- CLAUDE.md files (optional but recommended for guideline checking)

## Troubleshooting

### Review takes too long

**Issue**: Agents are slow on large PRs

**Solution**:
- Normal for large changes - agents run in parallel
- 4 independent agents ensure thoroughness
- Consider splitting large PRs into smaller ones

### Too many false positives

**Issue**: Review flags issues that aren't real

**Solution**:
- Default threshold is 80 (already filters most false positives)
- Make CLAUDE.md more specific about what matters
- Consider if the flagged issue is actually valid

### No review comment posted

**Issue**: `/glab-code-review` runs but no comment appears

**Solution**:
Check if:
- PR is closed (reviews skipped)
- PR is draft (reviews skipped)
- PR is trivial/automated (reviews skipped)
- PR already has review (reviews skipped)
- No issues scored ≥80 (no comment needed)

### Link formatting broken

**Issue**: Code links don't render correctly in GitHub

**Solution**:
Links must follow this exact format:
```
https://github.com/owner/repo/blob/[full-sha]/path/file.ext#L[start]-L[end]
```
- Must use full SHA (not abbreviated)
- Must use `#L` notation
- Must include line range with at least 1 line of context

### GitHub CLI not working

**Issue**: `gh` commands fail

**Solution**:
- Install GitHub CLI: `brew install gh` (macOS) or see [GitHub CLI installation](https://cli.github.com/)
- Authenticate: `gh auth login`
- Verify repository has GitHub remote

## Tips

- **Write specific CLAUDE.md files**: Clear guidelines = better reviews
- **Include context in PRs**: Helps agents understand intent
- **Use confidence scores**: Issues ≥80 are usually correct
- **Iterate on guidelines**: Update CLAUDE.md based on patterns
- **Review automatically**: Set up as part of PR workflow
- **Trust the filtering**: Threshold prevents noise

## Configuration

### Adjusting confidence threshold

The default threshold is 80. To adjust, modify the command file at `commands/glab-code-review.md`:
```markdown
Filter out any issues with a score less than 80.
```

Change `80` to your preferred threshold (0-100).

### Customizing review focus

Edit `commands/glab-code-review.md` to add or modify agent tasks:
- Add security-focused agents
- Add performance analysis agents
- Add accessibility checking agents
- Add documentation quality checks

## Technical Details

### Agent architecture
- **2x CLAUDE.md compliance agents**: Redundancy for guideline checks
- **1x bug detector**: Focused on obvious bugs in changes only
- **1x history analyzer**: Context from git blame and history
- **Nx confidence scorers**: One per issue for independent scoring

### Scoring system
- Each issue independently scored 0-100
- Scoring considers evidence strength and verification
- Threshold (default 80) filters low-confidence issues
- For CLAUDE.md issues: verifies guideline explicitly mentions it

### GitHub integration
Uses `gh` CLI for:
- Viewing PR details and diffs
- Fetching repository data
- Reading git blame and history
- Posting review comments

## Author

Boris Cherny (boris@anthropic.com)

## Version

1.2.1

## Running in CI

The command runs headless under a CI job:

```bash
claude -p "/glab-code-review $CI_MERGE_REQUEST_IID"
```

Do not add `--permission-mode bypassPermissions`. The command's `allowed-tools` list covers every
call the review makes, subagents included, and in `-p` mode any other call is denied without a
prompt. Bypassing that list gains nothing and hands the job's `api`-scoped `GITLAB_TOKEN` to
whatever the merge request diff or description manages to inject into the prompt. Checked with
Claude Code 2.1.280.

Requirements in the job environment:

| Variable | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude subscription token from `claude setup-token`. |
| `GITLAB_TOKEN` | GitLab token with the `api` scope. `read_api` returns 403 on every write. |
| `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, `CI_MERGE_REQUEST_DIFF_BASE_SHA`, `CI_COMMIT_SHA` | Supplied by GitLab. |
| `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` | Supplied by GitLab in merged results pipelines only. When set, it is the head the review covers instead of `CI_COMMIT_SHA`, which is then a temporary merge commit. |

`ANTHROPIC_API_KEY` must not be set: it switches Claude Code to metered API billing.

The repository must be checked out with full history (`GIT_DEPTH: 0`); the review diffs against the
merge base and against the previously reviewed commit.

Reviews are incremental. The command records the reviewed head SHA in its summary note as
`<!-- claude-review: <sha> -->` and the next run reviews only the commits after it, falling back to
a full review when that SHA is no longer an ancestor of the branch head.

## Tests

```bash
sh plugins/gitlab-code-review/tests/run-tests.sh
```
