# GitLab Code Review Plugin

Automated code review for GitLab merge requests. Several agents review the change in parallel,
a second agent validates every candidate finding, and only the findings that survive are posted,
each as an inline discussion on the line it is about.

Reviews are incremental: the first run covers the whole merge request, and every later run covers
only the commits pushed since the previous review.

## Command

### `/glab-code-review <merge-request-iid>`

**This command writes to the merge request.** It posts inline comments and a summary note every
time it runs; there is no terminal-only mode. The summary note records the reviewed commit and is
what makes the next review incremental, so it is posted even when no issues are found.

The command currently runs only inside a GitLab CI merge request pipeline: it reads the pipeline's
`CI_*` variables, and outside a CI job it stops with a message naming the missing variable.

**What it does:**

1. **Resolves the range to review** with `scripts/review-range.sh`. It stops without posting when
   the merge request is closed, merged, locked or a draft, or has no new commits since the last
   review.
2. **Reads the merge request** (title, description, project URL) and skips it when it plainly
   needs no review, such as an automated dependency bump.
3. **Lists the CLAUDE.md files** that govern the changed files with `scripts/claude-md-files.sh`:
   the root one and any in the directory of a changed file or its parents.
4. **Reviews the change** with 4 agents in parallel:
   - 2 agents check CLAUDE.md compliance
   - 1 agent scans the diff alone for obvious bugs
   - 1 agent looks for bugs, security issues and wrong logic in the changed code, reading the
     surrounding code as needed
5. **Validates the findings**: merges duplicates, then has one agent per file and kind check each
   finding, and drops the ones it cannot confirm.
6. **Posts each confirmed finding** as an inline discussion with `scripts/post-inline-comment.sh`,
   with a committable suggestion when the fix is small and complete.
7. **Posts one summary note** ending with `<!-- claude-review: <sha> -->`, the commit it reviewed.

### What gets flagged

Only high-signal issues:

- Code that will fail to compile or parse: syntax errors, type errors, missing imports,
  unresolved references
- Logic that produces wrong results regardless of input
- Clear violations of a CLAUDE.md rule that applies to the file, quoting the rule

### What is never flagged

- Anything under `vendor/` or `node_modules/`. The agents read that code to understand what the
  change calls, but never review it.
- Issues that existed before the change
- Style, naming and general quality concerns, unless a CLAUDE.md requires them
- Issues a linter will catch
- Issues that depend on specific inputs or state
- CLAUDE.md issues the code explicitly silences, for example with a lint ignore comment

## Models

| Step | Model |
|---|---|
| Main agent: range, triage, filtering, posting | The session model: `--model` if given, otherwise the account default |
| CLAUDE.md review, 2 agents | Sonnet |
| Bug review, 2 agents | Opus |
| Validation of bug findings, one agent per file | Opus |
| Validation of CLAUDE.md findings, one agent per file | Sonnet |

The main agent only orchestrates, so `--model sonnet` on the `claude -p` call lowers the cost of a
run without changing the review agents. To change a review or validation model, edit
`commands/glab-code-review.md`.

## Running in CI

The command runs headless in a merge request pipeline:

```yaml
claude-review:
  stage: test
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0
  # One review at a time per merge request. A second pipeline waits and then
  # reviews only what the first one did not cover.
  resource_group: claude-review-$CI_MERGE_REQUEST_IID
  script:
    - claude plugin marketplace add algoritma-dev/claude-plugins
    - claude plugin install gitlab-code-reviewer@algoritma-marketplace
    - claude -p "/glab-code-review $CI_MERGE_REQUEST_IID" --model sonnet
```

The job image needs `claude`, `glab`, `git` and `jq` on `PATH`.

### Variables

| Variable | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude subscription token from `claude setup-token`. |
| `GITLAB_TOKEN` | GitLab token with the `api` scope, used by `glab`. With `read_api` every write returns 403. |
| `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, `CI_MERGE_REQUEST_DIFF_BASE_SHA`, `CI_COMMIT_SHA` | Supplied by GitLab. |
| `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` | Supplied by GitLab in merged results pipelines only. When set, it is the head the review covers instead of `CI_COMMIT_SHA`, which is then a temporary merge commit. |

`ANTHROPIC_API_KEY` must not be set: it switches Claude Code to metered API billing.

The repository must be checked out with full history (`GIT_DEPTH: 0`): the review diffs against
the merge base and against the previously reviewed commit.

### Permissions

Do not add `--permission-mode bypassPermissions`. The command's `allowed-tools` list covers every
call the review makes, subagents included, and in `-p` mode any other call is denied without a
prompt. Bypassing that list gains nothing and hands the job's `api`-scoped `GITLAB_TOKEN` to
whatever the merge request diff or description manages to inject into the prompt. Checked with
Claude Code 2.1.280.

### Incremental reviews

Each summary note ends with `<!-- claude-review: <sha> -->`. The next run finds the newest such
marker written by the same GitLab account and reviews only the commits after it. A marker written
by anyone else is ignored, so a quoted or pasted marker cannot steer or silence the reviewer.

The run falls back to a full review from the merge base when the marker is no longer an ancestor
of the head (after a force-push) or names a commit the clone does not have.

## Scripts

The command calls these scripts; each can also be run by hand inside a CI job.

| Script | Does | Exit codes |
|---|---|---|
| `review-range.sh <iid>` | Prints the `<from>..<to>` range to review. | 0 range printed, 3 nothing to review (reason on stderr), 1 failure |
| `claude-md-files.sh <from>..<to>` | Prints the CLAUDE.md files that govern the changed files, as they exist in `<to>`. | 0, 1 failure |
| `post-inline-comment.sh <iid> <path> <line> <body-file>` | Posts one inline discussion on `<line>` of the reviewed head; a body file of `-` reads stdin. Falls back to a plain note when GitLab rejects the position. | 0 posted by either route, 1 not posted at all |

## Troubleshooting

### No comment appears on the merge request

The job log shows why:

- `review-range: merge request N is closed` (or `merged`, `locked`, `a draft`): nothing to
  review. Mark the merge request ready and push, or rerun the job.
- `review-range: no new commits since <sha>`: the head was already reviewed.
- The main agent skipped the merge request as trivial or automated.

### The whole merge request is reviewed again on every run

- The clone is shallow. Set `GIT_DEPTH: 0`.
- The branch was force-pushed, so the previous marker is no longer an ancestor of the head. This
  is expected.
- The summary note was deleted, or was written by a different GitLab account than the one
  `GITLAB_TOKEN` belongs to.

### A finding appears as a plain note instead of an inline discussion

The job log says why:

- `inline position rejected for <path>:<line> (<GitLab's answer>)`: GitLab could not place the
  comment, for example because the line is outside the merge request diff.
- `merge request N has no diff version for <sha>`: GitLab has not yet recorded a diff version
  for the reviewed commit.

The finding is kept as a note that starts with the file, the line and the commit the line number
refers to.

### A comment is shown on an older version of the diff

Someone pushed while the review was running. Comments are anchored to the diff version of the
commit that was reviewed, so they stay on the lines the agents read; GitLab shows them on that
version and marks them outdated once the lines change. The next run reviews the new commits.

### `could not post the finding at all`

The token cannot write to the merge request. Check that `GITLAB_TOKEN` has the `api` scope and
at least Reporter access to the project.

## Tests

```bash
sh plugins/gitlab-code-review/tests/run-tests.sh
```

The tests stub `glab` and build throwaway git repositories; they need `git` and `jq`. GitHub
Actions runs them, with `shellcheck`, on every change to the plugin.

## Version

1.2.1

## Author

Algoritma Team (info@algoritma.it)
