#!/bin/sh
# Tests for scripts/post-summary-note.sh.
set -eu

SUITE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(dirname "$SUITE_DIR")
SCRIPT="$PLUGIN_DIR/scripts/post-summary-note.sh"

TEST_TMP=$(mktemp -d)
trap 'rm -rf "$TEST_TMP"' EXIT

failures=0
TO=b468eb8681a977ddcd5db4d256aadbaca25c10a3

setup() {
    WORK=$(mktemp -d "$TEST_TMP/XXXXXX")
    STUB_DIR=$(mktemp -d "$TEST_TMP/XXXXXX")
    cp "$SUITE_DIR/stub-glab" "$STUB_DIR/glab"
    PATH="$STUB_DIR:$PATH"
    export PATH
    STUB_GLAB_CALLS="$WORK/calls.log"
    STUB_GLAB_STDIN="$WORK/body.json"
    STUB_GLAB_FAIL_MATCH=""
    export STUB_GLAB_CALLS STUB_GLAB_STDIN STUB_GLAB_FAIL_MATCH
    unset STUB_GLAB_REPLY
    : > "$STUB_GLAB_CALLS"
    : > "$STUB_GLAB_STDIN"
}

check() {
    check_label="$1"; check_expected="$2"; check_got="$3"
    if [ "$check_expected" = "$check_got" ]; then
        echo "ok   - $check_label"
    else
        echo "FAIL - $check_label: expected:"
        printf '%s\n' "$check_expected" | sed 's/^/        /'
        echo "      got:"
        printf '%s\n' "$check_got" | sed 's/^/        /'
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

# The script writes the heading and the marker, so the marker is always in the
# format review-range.sh looks for, and always last.
setup
printf 'No issues found. Checked for bugs and CLAUDE.md compliance.\n' | sh "$SCRIPT" 42 7 "$TO" -
check_contains "posts to the notes endpoint" "--method POST projects/42/merge_requests/7/notes" "$(cat "$STUB_GLAB_CALLS")"
check "the note has heading, summary and marker" "## Code review

No issues found. Checked for bugs and CLAUDE.md compliance.

<!-- claude-review: $TO -->" "$(jq -r '.body' "$STUB_GLAB_STDIN")"

# A marker in the summary text would compete with the real one.
setup
printf '2 issue(s) commented inline.\n<!-- claude-review: 0123456789abcdef0123456789abcdef01234567 -->\n' \
    | sh "$SCRIPT" 42 7 "$TO" -
check "a marker in the summary is dropped" "## Code review

2 issue(s) commented inline.

<!-- claude-review: $TO -->" "$(jq -r '.body' "$STUB_GLAB_STDIN")"

setup
printf 'ok\n' | sh "$SCRIPT" team/app 7 "$TO" -
check_contains "a project path is encoded in the URL" "projects/team%2Fapp/merge_requests/7/notes" "$(cat "$STUB_GLAB_CALLS")"

for bad in "" b468eb8 HEAD; do
    setup
    set +e
    printf 'ok\n' | sh "$SCRIPT" 42 7 "$bad" - 2>/dev/null
    status=$?
    set -e
    check "to_sha '$bad' is rejected" "1" "$status"
done

setup
set +e
printf '' | sh "$SCRIPT" 42 7 "$TO" - 2>/dev/null
status=$?
set -e
check "an empty summary exits 1" "1" "$status"
check "an empty summary posts nothing" "" "$(cat "$STUB_GLAB_CALLS")"

setup
STUB_GLAB_FAIL_MATCH="notes"
export STUB_GLAB_FAIL_MATCH
set +e
printf 'ok\n' | sh "$SCRIPT" 42 7 "$TO" - 2>/dev/null
status=$?
set -e
check "a failed post exits 1" "1" "$status"

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed"
    exit 1
fi
echo "all post-summary-note tests passed"
