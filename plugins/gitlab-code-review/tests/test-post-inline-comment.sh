#!/bin/sh
# Tests for scripts/post-inline-comment.sh.
set -eu

SUITE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(dirname "$SUITE_DIR")
SCRIPT="$PLUGIN_DIR/scripts/post-inline-comment.sh"

failures=0

setup() {
    WORK=$(mktemp -d)
    STUB_DIR=$(mktemp -d)
    cp "$SUITE_DIR/stub-glab" "$STUB_DIR/glab"
    PATH="$STUB_DIR:$PATH"
    export PATH

    STUB_GLAB_CALLS="$WORK/calls.log"
    STUB_GLAB_REPLY="$WORK/reply.json"
    STUB_GLAB_FAIL_MATCH=""
    export STUB_GLAB_CALLS STUB_GLAB_REPLY STUB_GLAB_FAIL_MATCH
    : > "$STUB_GLAB_CALLS"
    printf '{"base_sha":"aaa","start_sha":"bbb","head_sha":"ccc"}\n' > "$STUB_GLAB_REPLY"

    BODY_FILE="$WORK/body.md"
    printf 'Missing null check.\n' > "$BODY_FILE"

    CI_PROJECT_ID=42
    export CI_PROJECT_ID
}

# POSIX sh functions share the caller's variables, so these use names the
# callers do not.
check_contains() {
    check_label="$1"; check_needle="$2"; check_hay="$3"
    if printf '%s' "$check_hay" | grep -qF -- "$check_needle"; then
        echo "ok   - $check_label"
    else
        echo "FAIL - $check_label: '$check_needle' not found in:"
        printf '%s\n' "$check_hay" | sed 's/^/        /'
        failures=$((failures + 1))
    fi
}

check_equals() {
    check_label="$1"; check_expected="$2"; check_got="$3"
    if [ "$check_expected" = "$check_got" ]; then
        echo "ok   - $check_label"
    else
        echo "FAIL - $check_label: expected '$check_expected', got '$check_got'"
        failures=$((failures + 1))
    fi
}

# A successful inline discussion carries every position field GitLab requires.
setup
sh "$SCRIPT" 7 src/Core/Foo.php 12 "$BODY_FILE"
calls=$(cat "$STUB_GLAB_CALLS")
check_contains "reads the diff refs" "projects/42/merge_requests/7" "$calls"
check_contains "posts to the discussions endpoint" "projects/42/merge_requests/7/discussions" "$calls"
check_contains "sends position_type" "position[position_type]=text" "$calls"
check_contains "sends base_sha from diff_refs" "position[base_sha]=aaa" "$calls"
check_contains "sends start_sha from diff_refs" "position[start_sha]=bbb" "$calls"
check_contains "sends head_sha from diff_refs" "position[head_sha]=ccc" "$calls"
check_contains "sends new_path" "position[new_path]=src/Core/Foo.php" "$calls"
check_contains "sends new_line" "position[new_line]=12" "$calls"

# Review Focus 4 - an unresolvable position must not lose the finding.
setup
STUB_GLAB_FAIL_MATCH="discussions"
export STUB_GLAB_FAIL_MATCH
set +e
sh "$SCRIPT" 7 src/Deleted.php 3 "$BODY_FILE"
status=$?
set -e
check_equals "a rejected position still exits 0" "0" "$status"
check_contains "a rejected position falls back to a plain note" "mr note" "$(cat "$STUB_GLAB_CALLS")"

# Review Focus 2 - when every write fails the script must not report success.
setup
cat > "$STUB_DIR/glab" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_GLAB_CALLS"
case "$*" in
    *discussions*|*"mr note"*) echo "403 Forbidden" >&2; exit 1 ;;
esac
cat "$STUB_GLAB_REPLY"
STUB
chmod +x "$STUB_DIR/glab"
set +e
sh "$SCRIPT" 7 src/Core/Foo.php 12 "$BODY_FILE"
status=$?
set -e
check_equals "a read-only token makes the script fail" "1" "$status"

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed"
    exit 1
fi
echo "all post-inline-comment tests passed"
