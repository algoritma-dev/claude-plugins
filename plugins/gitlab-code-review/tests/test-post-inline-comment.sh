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
    STUB_GLAB_STDIN="$WORK/body.json"
    STUB_GLAB_REPLY="$WORK/reply.json"
    STUB_GLAB_FAIL_MATCH=""
    export STUB_GLAB_CALLS STUB_GLAB_STDIN STUB_GLAB_REPLY STUB_GLAB_FAIL_MATCH
    : > "$STUB_GLAB_CALLS"
    : > "$STUB_GLAB_STDIN"
    printf '{"diff_refs":{"base_sha":"aaa","start_sha":"bbb","head_sha":"ccc"}}\n' > "$STUB_GLAB_REPLY"

    BODY_FILE="$WORK/comment.md"
    BODY_TEXT='Missing null check — see "Foo::bar", line 3.'
    printf '%s\n' "$BODY_TEXT" > "$BODY_FILE"

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

# The request body must be JSON with a nested position object. Bracketed field
# names are not expanded into a nested hash in a JSON body, so a flat
# "position[new_line]" key would reach GitLab as an ordinary unpositioned
# comment and the placement would be lost without any error.
setup
sh "$SCRIPT" 7 src/Core/Foo.php 12 "$BODY_FILE"
calls=$(cat "$STUB_GLAB_CALLS")
sent=$(cat "$STUB_GLAB_STDIN")
check_contains "reads the merge request" "projects/42/merge_requests/7" "$calls"
check_contains "posts to the discussions endpoint" "projects/42/merge_requests/7/discussions" "$calls"
check_contains "sends the body as a JSON document" "Content-Type: application/json" "$calls"
if printf '%s' "$calls" | grep -q -- "--jq"; then
    echo "FAIL - glab api has no --jq flag, but the script passes one"
    failures=$((failures + 1))
else
    echo "ok   - no --jq flag is passed to glab"
fi
check_equals "the body is valid JSON" "0" "$(printf '%s' "$sent" | jq -e . >/dev/null 2>&1; echo $?)"
check_equals "position is a nested object" "object" "$(printf '%s' "$sent" | jq -r '.position | type')"
check_equals "position_type is text" "text" "$(printf '%s' "$sent" | jq -r '.position.position_type')"
check_equals "base_sha comes from diff_refs" "aaa" "$(printf '%s' "$sent" | jq -r '.position.base_sha')"
check_equals "start_sha comes from diff_refs" "bbb" "$(printf '%s' "$sent" | jq -r '.position.start_sha')"
check_equals "head_sha comes from diff_refs" "ccc" "$(printf '%s' "$sent" | jq -r '.position.head_sha')"
check_equals "new_path is carried" "src/Core/Foo.php" "$(printf '%s' "$sent" | jq -r '.position.new_path')"
check_equals "new_line is carried" "12" "$(printf '%s' "$sent" | jq -r '.position.new_line')"
check_equals "the comment text survives quoting" "$BODY_TEXT" "$(printf '%s' "$sent" | jq -r '.body')"

# A body of "-" is read from stdin, so the comment can be passed as a here-doc
# and the command needs no file-writing permission.
setup
printf '%s\n' "$BODY_TEXT" | sh "$SCRIPT" 7 src/Core/Foo.php 12 -
check_equals "a body read from stdin is sent" "$BODY_TEXT" "$(jq -r '.body' "$STUB_GLAB_STDIN")"

# An empty body would post a blank discussion.
setup
set +e
printf '' | sh "$SCRIPT" 7 src/Core/Foo.php 12 - 2>/dev/null
status=$?
set -e
check_equals "an empty body exits 1" "1" "$status"

# Review Focus 4 - an unresolvable position must not lose the finding.
setup
STUB_GLAB_FAIL_MATCH="discussions"
export STUB_GLAB_FAIL_MATCH
set +e
sh "$SCRIPT" 7 src/Deleted.php 3 "$BODY_FILE" 2>/dev/null
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
sh "$SCRIPT" 7 src/Core/Foo.php 12 "$BODY_FILE" 2>/dev/null
status=$?
set -e
check_equals "a read-only token makes the script fail" "1" "$status"

# A merge request whose diff refs cannot be read is a hard failure: posting an
# unpositioned comment instead would hide the problem.
setup
printf '{"diff_refs":null}\n' > "$STUB_GLAB_REPLY"
set +e
sh "$SCRIPT" 7 src/Core/Foo.php 12 "$BODY_FILE" 2>/dev/null
status=$?
set -e
check_equals "missing diff refs exit 1" "1" "$status"

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed"
    exit 1
fi
echo "all post-inline-comment tests passed"
