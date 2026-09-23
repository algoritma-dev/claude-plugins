#!/bin/sh
# Tests for scripts/post-inline-comment.sh.
set -eu

SUITE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(dirname "$SUITE_DIR")
SCRIPT="$PLUGIN_DIR/scripts/post-inline-comment.sh"

TEST_TMP=$(mktemp -d)
trap 'rm -rf "$TEST_TMP"' EXIT

failures=0

# Builds a merge request with two diff versions. BASE is the merge base; HEAD_SHA
# is the reviewed head, which inserts two lines after line 3 of src/Core/Foo.php
# and renames src/Old.php to src/New.php; NEWER is a commit pushed after the
# review started. The versions fixture lists NEWER first, as GitLab does.
setup() {
    WORK=$(mktemp -d "$TEST_TMP/XXXXXX")
    cd "$WORK"
    git init -q .
    git config user.email ci@algoritma.it
    git config user.name CI
    mkdir -p src/Core
    for i in 1 2 3 4 5 6 7 8 9 10; do echo "line $i"; done > src/Core/Foo.php
    printf 'a\nb\nc\n' > src/Old.php
    git add -A && git commit -qm base
    BASE=$(git rev-parse HEAD)

    { sed -n 1,3p src/Core/Foo.php; echo "new a"; echo "new b"; sed -n '4,$p' src/Core/Foo.php; } > src/Core/Foo.tmp
    mv src/Core/Foo.tmp src/Core/Foo.php
    git mv src/Old.php src/New.php
    git commit -qam reviewed
    HEAD_SHA=$(git rev-parse HEAD)

    echo "line 11" >> src/Core/Foo.php
    git commit -qam newer
    NEWER=$(git rev-parse HEAD)
    git checkout -q "$HEAD_SHA"

    STUB_DIR=$(mktemp -d "$TEST_TMP/XXXXXX")
    cp "$SUITE_DIR/stub-glab" "$STUB_DIR/glab"
    PATH="$STUB_DIR:$PATH"
    export PATH

    STUB_GLAB_CALLS="$WORK/calls.log"
    STUB_GLAB_STDIN="$WORK/body.json"
    STUB_GLAB_REPLY="$WORK/versions.json"
    STUB_GLAB_FAIL_MATCH=""
    export STUB_GLAB_CALLS STUB_GLAB_STDIN STUB_GLAB_REPLY STUB_GLAB_FAIL_MATCH
    : > "$STUB_GLAB_CALLS"
    : > "$STUB_GLAB_STDIN"
    printf '[{"id":2,"head_commit_sha":"%s","base_commit_sha":"%s","start_commit_sha":"%s"},{"id":1,"head_commit_sha":"%s","base_commit_sha":"%s","start_commit_sha":"%s"}]\n' \
        "$NEWER" "$BASE" "$BASE" "$HEAD_SHA" "$BASE" "$BASE" > "$STUB_GLAB_REPLY"

    BODY_FILE="$WORK/comment.md"
    BODY_TEXT='Missing null check — see "Foo::bar", line 3.'
    printf '%s\n' "$BODY_TEXT" > "$BODY_FILE"

    # The diff version cache lives in TMPDIR; each test gets its own. The
    # script must not depend on pipeline variables, so none are set.
    TMPDIR="$WORK"
    export TMPDIR
    unset CI_PROJECT_ID CI_COMMIT_SHA CI_MERGE_REQUEST_SOURCE_BRANCH_SHA
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

sent() {
    jq -r "$1" "$STUB_GLAB_STDIN"
}

# The request body must be JSON with a nested position object. Bracketed field
# names are not expanded into a nested hash in a JSON body, so a flat
# "position[new_line]" key would reach GitLab as an ordinary unpositioned
# comment and the placement would be lost without any error.
setup
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 4 "$BODY_FILE"
calls=$(cat "$STUB_GLAB_CALLS")
check_contains "reads the diff versions" "projects/42/merge_requests/7/versions" "$calls"
check_contains "posts to the discussions endpoint" "projects/42/merge_requests/7/discussions" "$calls"
check_contains "sends the body as a JSON document" "Content-Type: application/json" "$calls"
if printf '%s' "$calls" | grep -q -- "--jq"; then
    echo "FAIL - glab api has no --jq flag, but the script passes one"
    failures=$((failures + 1))
else
    echo "ok   - no --jq flag is passed to glab"
fi
check_equals "the body is valid JSON" "0" "$(jq -e . "$STUB_GLAB_STDIN" >/dev/null 2>&1; echo $?)"
check_equals "position is a nested object" "object" "$(sent '.position | type')"
check_equals "position_type is text" "text" "$(sent '.position.position_type')"
check_equals "new_path is carried" "src/Core/Foo.php" "$(sent '.position.new_path')"
check_equals "new_line is carried" "4" "$(sent '.position.new_line')"
check_equals "the comment text survives quoting" "$BODY_TEXT" "$(sent '.body')"

# The position anchors to the diff version of the reviewed head, not to the
# newest one: the line numbers were read from the reviewed head, and a push
# during the review would otherwise shift every comment onto the wrong line.
check_equals "head_sha is the reviewed head" "$HEAD_SHA" "$(sent '.position.head_sha')"
check_equals "base_sha comes from that version" "$BASE" "$(sent '.position.base_sha')"
check_equals "start_sha comes from that version" "$BASE" "$(sent '.position.start_sha')"

# An added line carries new_line only.
check_equals "an added line has no old_line" "null" "$(sent '.position.old_line')"
check_equals "an unrenamed file keeps its path as old_path" "src/Core/Foo.php" "$(sent '.position.old_path')"

# An unchanged line needs old_line too, or GitLab rejects the position. Line 8
# of the reviewed head was line 6 before the two inserted lines.
setup
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 8 "$BODY_FILE"
check_equals "an unchanged line carries its old line number" "6" "$(sent '.position.old_line')"
check_equals "an unchanged line keeps its new line number" "8" "$(sent '.position.new_line')"

# Lines above the change keep their number.
setup
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 2 "$BODY_FILE"
check_equals "a line above the change has the same old line" "2" "$(sent '.position.old_line')"

# A renamed file is addressed by its old path on the old side.
setup
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/New.php 2 "$BODY_FILE"
check_equals "a renamed file carries its old path" "src/Old.php" "$(sent '.position.old_path')"
check_equals "a renamed file carries its old line" "2" "$(sent '.position.old_line')"

# A project path works as well as a numeric ID.
setup
sh "$SCRIPT" team/app 7 "$HEAD_SHA" src/Core/Foo.php 4 "$BODY_FILE"
check_contains "a project path is encoded in the URL" "projects/team%2Fapp/merge_requests/7/discussions" "$(cat "$STUB_GLAB_CALLS")"

# The reviewed head must be a full SHA: it selects the diff version.
for bad in "" b468eb8 HEAD; do
    setup
    set +e
    sh "$SCRIPT" 42 7 "$bad" src/Core/Foo.php 4 "$BODY_FILE" 2>/dev/null
    status=$?
    set -e
    check_equals "to_sha '$bad' is rejected" "1" "$status"
done

# The diff version is read once per review, not once per comment.
setup
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 4 "$BODY_FILE"
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 8 "$BODY_FILE"
check_equals "the versions are read once for two comments" "1" "$(grep -c '/versions' "$STUB_GLAB_CALLS")"

# A body of "-" is read from stdin, so the comment can be passed as a here-doc
# and the command needs no file-writing permission.
setup
printf '%s\n' "$BODY_TEXT" | sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 4 -
check_equals "a body read from stdin is sent" "$BODY_TEXT" "$(sent '.body')"

# An empty body would post a blank discussion.
setup
set +e
printf '' | sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 4 - 2>/dev/null
status=$?
set -e
check_equals "an empty body exits 1" "1" "$status"

for line in 0 012 -3 abc; do
    setup
    set +e
    sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php "$line" "$BODY_FILE" 2>/dev/null
    status=$?
    set -e
    check_equals "line '$line' is rejected" "1" "$status"
done

# Review Focus 4 - an unresolvable position must not lose the finding.
setup
STUB_GLAB_FAIL_MATCH="discussions"
export STUB_GLAB_FAIL_MATCH
set +e
message=$(sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Deleted.php 3 "$BODY_FILE" 2>&1)
status=$?
set -e
check_equals "a rejected position still exits 0" "0" "$status"
check_contains "a rejected position falls back to a plain note" "merge_requests/7/notes" "$(cat "$STUB_GLAB_CALLS")"
check_contains "the fallback says what GitLab answered" "simulated failure" "$message"

# A suggestion block cannot be applied from a plain note, so the fallback turns
# it into an ordinary code block.
setup
STUB_GLAB_FAIL_MATCH="discussions"
export STUB_GLAB_FAIL_MATCH
printf 'Use the parameter.\n\n```suggestion:-0+0\nreturn count($xs);\n```\n' > "$BODY_FILE"
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 4 "$BODY_FILE" 2>/dev/null
note=$(sent '.body')
if printf '%s' "$note" | grep -q 'suggestion'; then
    echo "FAIL - the fallback note still carries a suggestion block"
    failures=$((failures + 1))
else
    echo "ok   - the fallback note carries no suggestion block"
fi
check_contains "the fallback note keeps the suggested code" 'return count($xs);' "$note"

# No diff version for the reviewed head yet: the finding still reaches the merge
# request, as a note naming the commit its line number refers to.
setup
printf '[{"id":2,"head_commit_sha":"%s","base_commit_sha":"%s","start_commit_sha":"%s"}]\n' \
    "$NEWER" "$BASE" "$BASE" > "$STUB_GLAB_REPLY"
set +e
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 4 "$BODY_FILE" 2>/dev/null
status=$?
set -e
check_equals "a head with no diff version still exits 0" "0" "$status"
check_contains "a head with no diff version falls back to a plain note" "merge_requests/7/notes" "$(cat "$STUB_GLAB_CALLS")"
check_contains "the note names the reviewed commit" "$HEAD_SHA" "$(sent '.body')"

# Review Focus 2 - when every write fails the script must not report success.
setup
cat > "$STUB_DIR/glab" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_GLAB_CALLS"
case "$*" in
    *discussions*|*/notes*) cat > /dev/null; echo "403 Forbidden" >&2; exit 1 ;;
esac
cat "$STUB_GLAB_REPLY"
STUB
chmod +x "$STUB_DIR/glab"
set +e
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 4 "$BODY_FILE" 2>/dev/null
status=$?
set -e
check_equals "a read-only token makes the script fail" "1" "$status"

# The versions of a merge request that cannot be read are a hard failure.
setup
STUB_GLAB_FAIL_MATCH="versions"
export STUB_GLAB_FAIL_MATCH
set +e
sh "$SCRIPT" 42 7 "$HEAD_SHA" src/Core/Foo.php 4 "$BODY_FILE" 2>/dev/null
status=$?
set -e
check_equals "unreadable diff versions exit 1" "1" "$status"

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed"
    exit 1
fi
echo "all post-inline-comment tests passed"
