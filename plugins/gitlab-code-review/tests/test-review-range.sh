#!/bin/sh
# Tests for scripts/review-range.sh.
set -eu

SUITE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(dirname "$SUITE_DIR")
SCRIPT="$PLUGIN_DIR/scripts/review-range.sh"

TEST_TMP=$(mktemp -d)
trap 'rm -rf "$TEST_TMP"' EXIT

failures=0

# Builds a repository with three commits on the main line and one orphaned
# commit that is a real object but not an ancestor of HEAD, which is what a
# force-push leaves behind. Exports BASE, MID, HEAD_SHA and ORPHAN.
setup_repo() {
    WORK=$(mktemp -d "$TEST_TMP/XXXXXX")
    cd "$WORK"
    git init -q .
    git config user.email ci@algoritma.it
    git config user.name CI
    echo one > file.txt && git add file.txt && git commit -qm one
    BASE=$(git rev-parse HEAD)
    echo two >> file.txt && git commit -qam two
    MID=$(git rev-parse HEAD)

    # The orphan: a real commit on a side branch, left unreachable from HEAD.
    git checkout -q -b side
    echo side >> file.txt && git commit -qam side
    ORPHAN=$(git rev-parse HEAD)
    git checkout -q -

    echo three >> file.txt && git commit -qam three
    HEAD_SHA=$(git rev-parse HEAD)

    STUB_DIR=$(mktemp -d "$TEST_TMP/XXXXXX")
    cp "$SUITE_DIR/stub-glab" "$STUB_DIR/glab"
    PATH="$STUB_DIR:$PATH"
    export PATH

    STUB_GLAB_CALLS="$WORK/calls.log"
    STUB_GLAB_REPLY="$WORK/notes.json"
    STUB_GLAB_REPLY_USER="$WORK/user.json"
    STUB_GLAB_REPLY_MR="$WORK/mr.json"
    STUB_GLAB_FAIL_MATCH=""
    export STUB_GLAB_CALLS STUB_GLAB_REPLY STUB_GLAB_REPLY_USER STUB_GLAB_REPLY_MR STUB_GLAB_FAIL_MATCH
    : > "$STUB_GLAB_CALLS"
    printf '{"username":"claude-bot"}\n' > "$STUB_GLAB_REPLY_USER"
    printf '{"state":"opened","draft":false}\n' > "$STUB_GLAB_REPLY_MR"
    printf '[]\n' > "$STUB_GLAB_REPLY"

    CI_PROJECT_ID=42
    CI_MERGE_REQUEST_DIFF_BASE_SHA="$BASE"
    CI_COMMIT_SHA="$HEAD_SHA"
    export CI_PROJECT_ID CI_MERGE_REQUEST_DIFF_BASE_SHA CI_COMMIT_SHA
    unset CI_MERGE_REQUEST_SOURCE_BRANCH_SHA
}

# Turns the fixture into a merged results pipeline: CI_COMMIT_SHA becomes a
# merge of the source head into a target branch that has moved on, and the
# source head is only available as CI_MERGE_REQUEST_SOURCE_BRANCH_SHA.
# Exports MERGE.
merged_results_pipeline() {
    git checkout -q -b target "$BASE"
    echo target > other.txt && git add other.txt && git commit -qm target
    git merge -q --no-edit "$HEAD_SHA"
    MERGE=$(git rev-parse HEAD)
    CI_COMMIT_SHA="$MERGE"
    CI_MERGE_REQUEST_SOURCE_BRANCH_SHA="$HEAD_SHA"
    export CI_COMMIT_SHA CI_MERGE_REQUEST_SOURCE_BRANCH_SHA
}

# Writes a notes fixture. Each argument is "author:sha"; the notes are written
# newest first, the order the script asks GitLab for.
notes_fixture() {
    printf '[' > "$STUB_GLAB_REPLY"
    sep=""
    for entry in "$@"; do
        author=${entry%%:*}
        sha=${entry#*:}
        printf '%s{"author":{"username":"%s"},"body":"## Code review\\n\\n<!-- claude-review: %s -->"}' \
            "$sep" "$author" "$sha" >> "$STUB_GLAB_REPLY"
        sep=","
    done
    printf ']\n' >> "$STUB_GLAB_REPLY"
}

# POSIX sh functions share the caller's variables, so these use names the
# callers do not.
check() {
    check_label="$1"; check_expected="$2"; check_got="$3"
    if [ "$check_expected" = "$check_got" ]; then
        echo "ok   - $check_label"
    else
        echo "FAIL - $check_label: expected '$check_expected', got '$check_got'"
        failures=$((failures + 1))
    fi
}

check_contains() {
    check_label="$1"; check_needle="$2"; check_hay="$3"
    if printf '%s' "$check_hay" | grep -qF -- "$check_needle"; then
        echo "ok   - $check_label"
    else
        echo "FAIL - $check_label: '$check_needle' not found in: $check_hay"
        failures=$((failures + 1))
    fi
}

# No previous review: the range covers the whole merge request.
setup_repo
actual=$(sh "$SCRIPT" 7)
check "first review spans the merge request" "$BASE..$HEAD_SHA" "$actual"

# A previous review recorded MID: only the commits after it are reviewed.
setup_repo
notes_fixture "claude-bot:$MID"
actual=$(sh "$SCRIPT" 7)
check "incremental review starts at the marker" "$MID..$HEAD_SHA" "$actual"

# Notes arrive newest first, so the first marker in the list is the current one.
setup_repo
notes_fixture "claude-bot:$MID" "claude-bot:$BASE"
actual=$(sh "$SCRIPT" 7)
check "the newest marker wins" "$MID..$HEAD_SHA" "$actual"

# A marker pasted by somebody other than the bot must not steer the reviewer.
setup_repo
notes_fixture "mallory:$HEAD_SHA"
# Without the author filter the script would honour this marker and exit 3, so
# the exit code is captured rather than allowed to abort the suite.
set +e
actual=$(sh "$SCRIPT" 7 2>/dev/null)
status=$?
set -e
check "a marker from another author does not stop the review" "0" "$status"
check "a marker from another author is ignored" "$BASE..$HEAD_SHA" "$actual"

# Review Focus 3 - force-push: the marker is a real commit, but no longer an
# ancestor of HEAD.
setup_repo
notes_fixture "claude-bot:$ORPHAN"
actual=$(sh "$SCRIPT" 7)
check "a real but unreachable marker falls back to a full review" "$BASE..$HEAD_SHA" "$actual"

# A marker naming a commit this clone has never seen also falls back.
setup_repo
notes_fixture "claude-bot:0123456789abcdef0123456789abcdef01234567"
actual=$(sh "$SCRIPT" 7)
check "an unknown marker falls back to a full review" "$BASE..$HEAD_SHA" "$actual"

# Review Focus 5 - nothing new since the last review.
setup_repo
notes_fixture "claude-bot:$HEAD_SHA"
set +e
actual=$(sh "$SCRIPT" 7)
status=$?
set -e
check "no new commits exits 3" "3" "$status"
check "no new commits prints nothing" "" "$actual"

# Prose mentioning the key is not a marker.
setup_repo
printf '[{"author":{"username":"claude-bot"},"body":"the reviewer writes claude-review: somewhere"}]\n' > "$STUB_GLAB_REPLY"
actual=$(sh "$SCRIPT" 7)
check "prose is not a marker" "$BASE..$HEAD_SHA" "$actual"

# A failed notes read must be fatal. Treating it as "no marker" would silently
# re-review the whole merge request and repost every earlier finding.
setup_repo
STUB_GLAB_FAIL_MATCH="notes"
export STUB_GLAB_FAIL_MATCH
set +e
actual=$(sh "$SCRIPT" 7 2>/dev/null)
status=$?
set -e
check "an unreadable notes list exits 1" "1" "$status"
check "an unreadable notes list prints no range" "" "$actual"

# Outside GitLab CI the script must say so and exit 1, not die on an unset
# variable with the shell's own exit code.
setup_repo
set +e
message=$(env -u CI_PROJECT_ID sh "$SCRIPT" 7 2>&1 >/dev/null)
status=$?
set -e
check "a missing CI variable exits 1" "1" "$status"
check_contains "a missing CI variable names itself" "CI_PROJECT_ID" "$message"

# A merge request that is not open, or is a draft, has nothing to review. The
# check is deterministic, so it lives here rather than in an agent.
for state in closed merged locked; do
    setup_repo
    printf '{"state":"%s","draft":false}\n' "$state" > "$STUB_GLAB_REPLY_MR"
    set +e
    actual=$(sh "$SCRIPT" 7 2>/dev/null)
    status=$?
    set -e
    check "a $state merge request exits 3" "3" "$status"
    check "a $state merge request prints no range" "" "$actual"
done

setup_repo
printf '{"state":"opened","draft":true}\n' > "$STUB_GLAB_REPLY_MR"
set +e
message=$(sh "$SCRIPT" 7 2>&1 >/dev/null)
status=$?
set -e
check "a draft merge request exits 3" "3" "$status"
check_contains "a draft merge request says why it stops" "draft" "$message"

# GitLab before 14.0 reports drafts only as work_in_progress.
setup_repo
printf '{"state":"opened","work_in_progress":true}\n' > "$STUB_GLAB_REPLY_MR"
set +e
sh "$SCRIPT" 7 >/dev/null 2>&1
status=$?
set -e
check "a work_in_progress merge request exits 3" "3" "$status"

# A failed read of the merge request is a failure, not a reason to review.
setup_repo
STUB_GLAB_FAIL_MATCH="merge_requests/7 "
: > "$STUB_GLAB_REPLY_MR"
set +e
actual=$(sh "$SCRIPT" 7 2>/dev/null)
status=$?
set -e
check "an unreadable merge request exits 1" "1" "$status"

# Merged results pipeline: the review covers the source branch, not the
# temporary merge commit. Recording the merge commit would make every later
# marker a non-ancestor and turn each run into a full re-review.
setup_repo
merged_results_pipeline
notes_fixture "claude-bot:$MID"
actual=$(sh "$SCRIPT" 7)
check "a merged results pipeline reviews up to the source head" "$MID..$HEAD_SHA" "$actual"

setup_repo
merged_results_pipeline
actual=$(sh "$SCRIPT" 7)
check "a first review in a merged results pipeline spans the source branch" "$BASE..$HEAD_SHA" "$actual"

setup_repo
merged_results_pipeline
notes_fixture "claude-bot:$HEAD_SHA"
set +e
actual=$(sh "$SCRIPT" 7 2>/dev/null)
status=$?
set -e
check "a new merge commit over an unchanged source head exits 3" "3" "$status"

# An empty CI_MERGE_REQUEST_SOURCE_BRANCH_SHA is what a plain merge request
# pipeline carries; CI_COMMIT_SHA is then the head.
setup_repo
CI_MERGE_REQUEST_SOURCE_BRANCH_SHA=""
export CI_MERGE_REQUEST_SOURCE_BRANCH_SHA
actual=$(sh "$SCRIPT" 7)
check "an empty source branch SHA falls back to CI_COMMIT_SHA" "$BASE..$HEAD_SHA" "$actual"

# Every page of notes is read. A busy merge request can bury the marker under
# more than one page of newer notes, and missing it means a full re-review.
setup_repo
sh "$SCRIPT" 7 >/dev/null
check_contains "the notes are read with --paginate" "--paginate" "$(cat "$STUB_GLAB_CALLS")"

# Older glab versions print one JSON array per page, back to back.
setup_repo
printf '[{"author":{"username":"alice"},"body":"lgtm"}]\n[{"author":{"username":"claude-bot"},"body":"<!-- claude-review: %s -->"}]\n' \
    "$MID" > "$STUB_GLAB_REPLY"
actual=$(sh "$SCRIPT" 7)
check "a marker on the second page is found" "$MID..$HEAD_SHA" "$actual"

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed"
    exit 1
fi
echo "all review-range tests passed"
