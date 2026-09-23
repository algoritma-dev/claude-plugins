#!/bin/sh
# Tests for scripts/claude-md-files.sh.
set -eu

SUITE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(dirname "$SUITE_DIR")
SCRIPT="$PLUGIN_DIR/scripts/claude-md-files.sh"

failures=0

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

# Writes a file and its parent directories.
put() {
    mkdir -p "$(dirname "$1")"
    echo "$2" > "$1"
}

# A repository whose first commit carries guideline files at several depths.
# The second commit, the reviewed range, touches src/Core, lib and vendor, and
# adds a guideline file of its own under api/. Exports FROM and TO.
setup_repo() {
    WORK=$(mktemp -d)
    cd "$WORK"
    git init -q .
    git config user.email ci@algoritma.it
    git config user.name CI
    put CLAUDE.md root
    put src/CLAUDE.md src
    put src/Core/Foo.php one
    put src/Other/CLAUDE.md untouched-sibling
    put lib/util.php one
    put docs/CLAUDE.md untouched
    put vendor/acme/CLAUDE.md third-party
    put vendor/acme/lib.php one
    git add -A && git commit -qm one
    FROM=$(git rev-parse HEAD)

    put src/Core/Foo.php two
    put lib/util.php two
    put vendor/acme/lib.php two
    put api/CLAUDE.md added-in-range
    put api/Controller.php new
    git add -A && git commit -qm two
    TO=$(git rev-parse HEAD)
}

setup_repo
actual=$(sh "$SCRIPT" "$FROM..$TO")
check "lists the guideline files that govern the changed files" "CLAUDE.md
api/CLAUDE.md
src/CLAUDE.md" "$actual"

# The files are read from <to>, not from the working tree, which in a merged
# results pipeline is a merge with the target branch.
setup_repo
put lib/CLAUDE.md only-in-working-tree
actual=$(sh "$SCRIPT" "$FROM..$TO")
check "a guideline file missing from <to> is not listed" "CLAUDE.md
api/CLAUDE.md
src/CLAUDE.md" "$actual"

# Without a root guideline file only the nested ones are listed.
setup_repo
git rm -q CLAUDE.md && git commit -qm drop-root
actual=$(sh "$SCRIPT" "$FROM..$(git rev-parse HEAD)")
check "no root guideline file" "api/CLAUDE.md
src/CLAUDE.md" "$actual"

# A range with no changes lists nothing and still succeeds.
setup_repo
actual=$(sh "$SCRIPT" "$TO..$TO")
check "an empty range lists nothing" "" "$actual"

setup_repo
set +e
sh "$SCRIPT" "$TO" >/dev/null 2>&1
status=$?
set -e
check "an argument that is not a range exits 1" "1" "$status"

setup_repo
set +e
sh "$SCRIPT" "$FROM..0123456789abcdef0123456789abcdef01234567" >/dev/null 2>&1
status=$?
set -e
check "an unknown revision exits 1" "1" "$status"

if [ "$failures" -gt 0 ]; then
    echo "$failures test(s) failed"
    exit 1
fi
echo "all claude-md-files tests passed"
