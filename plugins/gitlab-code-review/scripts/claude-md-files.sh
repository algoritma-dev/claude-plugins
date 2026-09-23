#!/bin/sh
# Lists the CLAUDE.md files that govern the files changed in a revision range.
#
# Usage: claude-md-files.sh <from>..<to>
#
# Prints one repository-relative path per line: every CLAUDE.md that sits in
# the directory of a changed file or in one of its parents, up to the root.
# The files are looked up in <to>, not in the working tree: in a merged
# results pipeline the checkout is a merge with the target branch, and a
# guideline file that exists only there does not govern this change.
# Changes under vendor/ and node_modules/ are third-party code and are skipped.
set -eu

fail() {
    echo "claude-md-files: $1" >&2
    exit 1
}

range="${1:-}"
case "$range" in
    ?*..?*) ;;
    *) fail "usage: claude-md-files.sh <from>..<to>" ;;
esac
to=${range#*..}

git rev-parse --verify -q "$to^{commit}" >/dev/null || fail "unknown revision $to"
changed=$(git diff --name-only "$range") || fail "cannot diff $range"

# Every ancestor directory of every changed file, "." being the root.
printf '%s\n' "$changed" \
    | grep -Ev '^(vendor/|node_modules/)|/node_modules/' \
    | awk -F/ 'NF { print "."; p = ""; for (i = 1; i < NF; i++) { p = (i == 1) ? $1 : p "/" $i; print p } }' \
    | sort -u \
    | while IFS= read -r dir; do
        if [ "$dir" = "." ]; then path=CLAUDE.md; else path="$dir/CLAUDE.md"; fi
        if git cat-file -e "$to:$path" 2>/dev/null; then
            echo "$path"
        fi
    done
