# GitLab Code Review Plugin

Automated code review for GitLab merge requests. Several agents review the change in parallel,
a second agent validates every candidate finding, and only the findings that survive are posted,
each as an inline discussion on the line it is about.

Reviews are incremental: the first run covers the whole merge request, and every later run covers
only the commits pushed since the previous review.

## Command

### `/glab-code-review <merge-request-iid> [<project-id-or-path>]`

**This command writes to the merge request.** It posts inline comments and a summary note every
time it runs; there is no terminal-only mode. The summary note records the reviewed commit and is
what makes the next review incremental, so it is posted even when no issues are found.

It runs in two places:

- **On a developer's machine**, from a clone of the project. Use the command, or ask in plain
  words:

  ```text
  /glab-code-review 123 4567
  Fai la code review della merge request numero 123 del progetto numero 4567
  ```

  The project is a numeric ID or a path such as `group/app`. Without one, the review uses the
  project of the clone. The comments go straight onto the merge request on GitLab. See
  [Running locally](#running-locally).
- **In a GitLab CI merge request pipeline**, where the project and the commits come from the
  pipeline. See [Running in CI](#running-in-ci).

**What it does:**

1. **Resolves the range to review** with `scripts/review-range.sh`, which also reads the merge
   request's title, description and URL. It stops without posting when the merge request is
   closed, merged, locked or a draft, or has no new commits since the last review. On a
   developer's machine it fetches the merge request's commits when the clone lacks them.
2. **Triages the merge request**, and skips it when it plainly needs no review, such as an
   automated dependency bump.
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
7. **Posts one summary note** with `scripts/post-summary-note.sh`, ending with
   `<!-- claude-review: <sha> -->`, the commit it reviewed.

The agents read the code at the reviewed commit through git, never from the working tree, so the
branch checked out locally does not matter.

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

## Running locally

Requirements:

- A clone of the project, with a remote (`origin` by default) that points at it on GitLab. The
  branch checked out does not matter, and uncommitted changes are left alone. When the clone lacks
  the merge request's commits, the review runs
  `git fetch origin refs/merge-requests/<iid>/head`; set `CLAUDE_REVIEW_REMOTE` to use another
  remote.
- `glab` authenticated against the GitLab host (`glab auth login`) with the `api` scope, plus
  `git` and `jq` on `PATH`.

Comments and the summary note are posted as your GitLab account.

### Permissions

Run as `/glab-code-review`, the command's `allowed-tools` pre-approve every call the review makes.

Asked in plain words, the model invokes the command itself, and Claude Code 2.1.280 does not apply
`allowed-tools` to that invocation, although the documentation says it should. In an interactive
session Claude Code then asks before each call to one of the plugin's scripts; in `claude -p`
those calls are denied. To skip those prompts,
allow the scripts in `~/.claude/settings.json`, with your home directory in place of
`/home/you`:

```json
{
  "permissions": {
    "allow": [
      "Bash(/home/you/.claude/plugins/cache/algoritma-marketplace/gitlab-code-reviewer/*/scripts/*.sh *)"
    ]
  }
}
```

The `*` in place of the version keeps the rule working across plugin updates.

### Local and CI reviews of the same merge request

Each run only trusts the review markers of the account it runs as, so a local run does not see
where the CI bot left off and reviews the whole merge request again. To share the progress, list
the other account in `CLAUDE_REVIEW_TRUSTED_AUTHORS`, comma-separated, for example the CI bot's
username in your shell profile and your own in the CI job.

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
| `CLAUDE_REVIEW_TRUSTED_AUTHORS` | Optional. Comma-separated GitLab usernames whose review markers count besides the job's own account. See [Local and CI reviews](#local-and-ci-reviews-of-the-same-merge-request). |

The pipeline variables are used only when the job belongs to the merge request being reviewed;
otherwise the review reads base and head from the API, as it does locally.

`ANTHROPIC_API_KEY` must not be set: it switches Claude Code to metered API billing.

The repository must be checked out with full history (`GIT_DEPTH: 0`): the review diffs against
the merge base and against the previously reviewed commit.

### CI permissions

Do not add `--permission-mode bypassPermissions`. The command's `allowed-tools` list covers every
call the review makes, subagents included, and in `-p` mode any other call is denied without a
prompt. Bypassing that list gains nothing and hands the job's `api`-scoped `GITLAB_TOKEN` to
whatever the merge request diff or description manages to inject into the prompt. Checked with
Claude Code 2.1.280.

### Incremental reviews

Each summary note ends with `<!-- claude-review: <sha> -->`. The next run finds the newest such
marker written by the same GitLab account, or by one listed in `CLAUDE_REVIEW_TRUSTED_AUTHORS`,
and reviews only the commits after it. A marker written by anyone else is ignored, so a quoted or
pasted marker cannot steer or silence the reviewer.

The run falls back to a full review from the merge base when the marker is no longer an ancestor
of the head (after a force-push) or names a commit the clone does not have.

## Scripts

The command calls these scripts; each can also be run by hand, locally or in a CI job. A body or
summary file of `-` reads stdin.

| Script | Does | Exit codes |
|---|---|---|
| `review-range.sh <iid> [<project>]` | Prints a JSON object: `project_id`, `iid`, `from`, `to`, `range`, `title`, `description`, `web_url`. | 0 printed, 3 nothing to review (reason on stderr), 1 failure |
| `claude-md-files.sh <from>..<to>` | Prints the CLAUDE.md files that govern the changed files, as they exist in `<to>`. | 0, 1 failure |
| `post-inline-comment.sh <project_id> <iid> <to> <path> <line> <body-file>` | Posts one inline discussion on `<line>` of `<to>`. Falls back to a plain note when GitLab rejects the position. | 0 posted by either route, 1 not posted at all |
| `post-summary-note.sh <project_id> <iid> <to> <summary-file>` | Posts the summary note, adding the heading and the marker for `<to>`. | 0 posted, 1 failure |

## Troubleshooting

### `run the review from a clone of project N`

The review needs the merge request's commits. Run it from a clone of that project; if the clone's
GitLab remote is not `origin`, set `CLAUDE_REVIEW_REMOTE`.

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

The token cannot write to the merge request. Check that the token (`GITLAB_TOKEN` in CI, the one
`glab auth login` stored locally) has the `api` scope and at least Reporter access to the project.

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
