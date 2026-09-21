#!/bin/sh
# Tests for scripts/review-range.sh.
set -eu

SUITE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(dirname "$SUITE_DIR")
SCRIPT="$PLUGIN_DIR/scripts/review-range.sh"

failures=0

# Builds a repository with three commits and exports BASE, MID and HEAD_SHA.
setup_repo() {
    WORK=$(mktemp -d)
    cd "$WORK"
    git init -q .
    git config user.email ci@algoritma.it
    git config user.name CI
    echo one > file.txt && git add file.txt && git commit -qm one
    BASE=$(git rev-parse HEAD)
    echo two >> file.txt && git commit -qam two
    MID=$(git rev-parse HEAD)
    echo three >> file.txt && git commit -qam three
    HEAD_SHA=$(git rev-parse HEAD)

    STUB_DIR=$(mktemp -d)
    cp "$SUITE_DIR/stub-glab" "$STUB_DIR/glab"
    PATH="$STUB_DIR:$PATH"
    export PATH

    STUB_GLAB_REPLY="$WORK/reply.json"
    export STUB_GLAB_REPLY
    : > "$STUB_GLAB_REPLY"

    CI_PROJECT_ID=42
    CI_MERGE_REQUEST_DIFF_BASE_SHA="$BASE"
    CI_COMMIT_SHA="$HEAD_SHA"
    export CI_PROJECT_ID CI_MERGE_REQUEST_DIFF_BASE_SHA CI_COMMIT_SHA
}

# POSIX sh functions share the caller's variables, so this uses names the
# callers do not: clobbering their "actual" would make the next check compare
# the wrong value.
check() {
    check_label="$1"; check_expected="$2"; check_got="$3"
    if [ "$check_expected" = "$check_got" ]; then
        echo "ok   - $check_label"
    else
        echo "FAIL - $check_label: expected '$check_expected', got '$check_got'"
        failures=$((failures + 1))
    fi
}

# No previous review: the range covers the whole merge request.
setup_repo
printf '[]\n' > "$STUB_GLAB_REPLY"
actual=$(sh "$SCRIPT" 7)
check "first review spans the merge request" "$BASE..$HEAD_SHA" "$actual"

# A previous review recorded MID: only the commits after it are reviewed.
setup_repo
printf '["## Code review\\n\\nno issues\\n<!-- claude-review: %s -->"]\n' "$MID" > "$STUB_GLAB_REPLY"
actual=$(sh "$SCRIPT" 7)
check "incremental review starts at the marker" "$MID..$HEAD_SHA" "$actual"

# Two markers: the most recent one wins.
setup_repo
printf '["<!-- claude-review: %s -->","<!-- claude-review: %s -->"]\n' "$BASE" "$MID" > "$STUB_GLAB_REPLY"
actual=$(sh "$SCRIPT" 7)
check "the latest marker wins" "$MID..$HEAD_SHA" "$actual"

# Review Focus 3 - force-push: the marker is not an ancestor of HEAD any more.
setup_repo
printf '["<!-- claude-review: 0123456789abcdef0123456789abcdef01234567 -->"]\n' > "$STUB_GLAB_REPLY"
actual=$(sh "$SCRIPT" 7)
check "unreachable marker falls back to a full review" "$BASE..$HEAD_SHA" "$actual"

# Review Focus 5 - nothing new since the last review.
setup_repo
printf '["<!-- claude-review: %s -->"]\n' "$HEAD_SHA" > "$STUB_GLAB_REPLY"
set +e
actual=$(sh "$SCRIPT" 7)
status=$?
set -e
check "no new commits exits 3" "3" "$status"
check "no new commits prints nothing" "" "$actual"

# A note mentioning the marker syntax in prose must not be mistaken for a marker.
setup_repo
printf '["the reviewer writes claude-review: somewhere in its note"]\n' > "$STUB_GLAB_REPLY"
actual=$(sh "$SCRIPT" 7)
check "prose is not a marker" "$BASE..$HEAD_SHA" "$actual"

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed"
    exit 1
fi
echo "all review-range tests passed"
