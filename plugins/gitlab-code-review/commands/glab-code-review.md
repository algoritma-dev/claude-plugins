---
allowed-tools: Bash(glab mr view:*), Bash(glab mr note:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/review-range.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/claude-md-files.sh:*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/post-inline-comment.sh:*)
description: Code review a merge request
---

Provide a code review for the given merge request.

**Agent assumptions (applies to all agents and subagents):**
- All tools are functional and will work without error. Do not test tools or make exploratory calls. Make sure this is clear to every subagent that is launched.
- Only call a tool if it is required to complete the task. Every tool call should have a clear purpose.
- Run every command exactly as this file shows it, from the repository root: no `git -C`, no `cd`, nothing chained or piped onto it (`; echo $?`, `| cat -n`). Only the listed command prefixes are permitted and anything else is denied; the Bash tool already reports each exit code. Make sure this is clear to every subagent that is launched.

To do this, follow these steps precisely:

1. Establish what to review.

   Run the range resolver:

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/review-range.sh <MR>
   ```

   - Exit code 3: there is nothing to review. The merge request is closed, merged or a draft, or
     has no new commits since the last review; stderr says which. Stop. Post nothing.
   - Exit code 0: the printed `<from>..<to>` range is what you review. Everything outside it has
     already been reviewed and must not be commented on again.
   - Any other exit code: stop and report the failure.

   Then run `glab mr view <MR> --output json` and `git diff --stat <from>..<to>` yourself, without
   a subagent. Keep the MR title and description: every subagent below receives them, as context
   on the author's intent. Keep the project URL too, for code links: it is the `web_url` field
   with its trailing `/-/merge_requests/<MR>` removed. Stop, and post nothing, only when the merge request plainly does not need a
   code review, such as an automated dependency bump or a trivial change that is obviously
   correct. Do not stop merely because Claude has commented before — that is the normal
   incremental case, and the range already excludes what those comments covered.

Note: Still review Claude generated MRs.

2. List the CLAUDE.md files that apply to the change:

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/claude-md-files.sh <from>..<to>
   ```

   It prints the root CLAUDE.md and every CLAUDE.md in a directory containing a changed file or
   in one of its parents, as they exist in `<to>`. Read them with `git show <to>:<path>`. An empty
   list means there are no guidelines to check; agents 1 and 2 of step 3 are then skipped.

3. Launch 4 agents in parallel to independently review the changes. Every agent reads the diff
   with `git diff <from>..<to>` using the range from step 1, never `glab mr diff`, which always
   returns the whole merge request. Except where agent 3's instructions say otherwise, agents
   read surrounding files freely: the repository is checked out, and the point of reviewing here
   rather than from the diff alone is that the code around the change is available.

   `vendor/` is installed. Open it to understand what the changed code calls — a framework base
   class, an interface the change implements, the signature of a method it passes arguments to.
   Never review it: nothing under `vendor/` is this team's code, and a finding there is always a
   false positive. The same goes for `node_modules/` when present.

   Each agent should return the list of issues, where each issue includes a description and the reason it was flagged (e.g. "CLAUDE.md adherence", "bug"). The agents should do the following:

   Agents 1 + 2: CLAUDE.md compliance sonnet agents
   Give both the list of CLAUDE.md paths from step 2. Audit changes for CLAUDE.md compliance in parallel. Note: When evaluating CLAUDE.md compliance for a file, you should only consider CLAUDE.md files that share a file path with the file or parents.

   Agent 3: Opus bug agent (parallel subagent with agent 4)
   Scan for obvious bugs. Focus only on the diff itself without reading extra context. Flag only significant bugs; ignore nitpicks and likely false positives. Do not flag issues that you cannot validate without looking at context outside of the git diff.

   Agent 4: Opus bug agent (parallel subagent with agent 3)
   Look for problems that exist in the introduced code. This could be security issues, incorrect logic, etc. Only look for issues that fall within the changed code.

   **CRITICAL: We only want HIGH SIGNAL issues.** Flag issues where:
    - The code will fail to compile or parse (syntax errors, type errors, missing imports, unresolved references)
    - The code will definitely produce wrong results regardless of inputs (clear logic errors)
    - Clear, unambiguous CLAUDE.md violations where you can quote the exact rule being broken

   Do NOT flag:
    - Code style or quality concerns
    - Potential issues that depend on specific inputs or state
    - Subjective suggestions or improvements

   If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time.

   In addition to the above, each subagent should be told the MR title and description. This will help provide context regarding the author's intent.

4. For each issue found in the previous step by agents 1, 2, 3 and 4, launch parallel subagents to validate the issue. These subagents should get the MR title and description along with a description of the issue. The agent's job is to review the issue to validate that the stated issue is truly an issue with high confidence. For example, if an issue such as "variable is not defined" was flagged, the subagent's job would be to validate that is actually true in the code. Another example would be CLAUDE.md issues. The agent should validate that the CLAUDE.md rule that was violated is scoped for this file and is actually violated. Use Opus subagents for bugs and logic issues, and sonnet agents for CLAUDE.md violations.

5. Filter out any issues that were not validated in step 4. This step will give us our list of high signal issues for our review.

6. If issues were found, go on to step 7 to post inline comments. If NO issues were found, skip
   to step 9: the summary note is posted either way.

7. Create a list of all comments that you plan on leaving. This is only for you to make sure you are comfortable with the comments. Do not post this list anywhere.

8. Post one inline comment per validated issue. Pass the comment body on stdin with a quoted
   here-doc, so nothing in it is expanded by the shell and no temporary file is needed:

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/post-inline-comment.sh <MR> <path> <line> - <<'CLAUDE_REVIEW_EOF'
   <comment body>
   CLAUDE_REVIEW_EOF
   ```

   `<line>` is the line number in the `<to>` revision from step 1. Take it from `git diff` or
   `git show <to>:<path>`, never from the checked-out file: in a merged results pipeline the
   working tree is a merge with the target branch and its line numbers can differ.

   The script resolves the diff refs itself; do not assemble the position by hand. A position
   GitLab cannot resolve falls back to a plain note automatically, and a non-zero exit means the
   finding reached the merge request by neither route — report that rather than continuing
   silently.

   For each comment:
    - Provide a brief description of the issue
    - For small, self-contained fixes, include a committable suggestion block
    - For larger fixes (6+ lines, structural changes, or changes spanning multiple locations), describe the issue and suggested fix without a suggestion block
    - Never post a committable suggestion UNLESS committing the suggestion fixes the issue entirely. If follow up steps are required, do not leave a committable suggestion.

   **IMPORTANT: Only post ONE comment per unique issue. Do not post duplicate comments.**

9. Post exactly one summary note recording the reviewed head SHA. The next run reads that SHA to
    work out what is new, so this note is mandatory on every successful review, whether or not
    issues were found:

    ```bash
    glab mr note <MR> --message "## Code review

    <one line: 'No issues found. Checked for bugs and CLAUDE.md compliance.' or 'N issue(s) commented inline.'>

    <!-- claude-review: <to-sha-from-step-1> -->"
    ```

    The `<to-sha>` is the right-hand side of the range from step 1 — the full 40-character SHA,
    never an abbreviation. The marker must be the last line of the note.

Use this list when evaluating issues in Steps 3 and 4 (these are false positives, do NOT flag):

- Anything under `vendor/` or `node_modules/` — third-party code, never this team's
- Pre-existing issues
- Something that appears to be a bug but is actually correct
- Pedantic nitpicks that a senior engineer would not flag
- Issues that a linter will catch (do not run the linter to verify)
- General code quality concerns (e.g., lack of test coverage, general security issues) unless explicitly required in CLAUDE.md
- Issues mentioned in CLAUDE.md but explicitly silenced in the code (e.g., via a lint ignore comment)

Notes:

- Use glab CLI to interact with GitLab (e.g., `glab mr view`). Do not use web fetch.
- Create a todo list before starting.
- You must cite and link each issue in inline comments (e.g., if referring to a CLAUDE.md, include a link to it).
- When linking to code in inline comments, start from the project URL kept in step 1, which is right for self-hosted GitLab too, and follow this format precisely, otherwise the Markdown preview won't render correctly: <project-url>/-/blob/c21d3c10bc8e898b7ac1a2d745bdc9bc4e423afe/package.json#L10-15
    - Requires full git sha
    - You must provide the full sha. Commands like `<project-url>/-/blob/$(git rev-parse HEAD)/foo/bar` will not work, since your comment will be directly rendered in Markdown.
    - Repo name must match the repo you're code reviewing
    - # sign after the file name
    - Line range format is L[start]-[end] (no L prefix on the end)
    - Provide at least 1 line of context before and after, centered on the line you are commenting about (eg. if you are commenting about lines 5-6, you should link to `L4-7`)
