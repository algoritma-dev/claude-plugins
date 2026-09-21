#!/bin/sh
# Resolves the git revision range the current review run should examine.
#
# Prints "<from>..<to>" on stdout. Exit 3 means there is nothing new since the
# last review and the caller must post nothing. Exit 1 means the range could
# not be resolved.
#
# The previous review's head SHA is read from a marker the reviewer writes into
# its own summary note: <!-- claude-review: <sha> -->. A marker is authoritative
# only while it is still an ancestor of the current head; after a force-push it
# is not, and the run falls back to a full review from the merge base.
set -eu

iid="${1:-}"
if [ -z "$iid" ]; then
    echo "usage: review-range.sh <mr_iid>" >&2
    exit 1
fi

: "${CI_PROJECT_ID:?CI_PROJECT_ID is required}"
: "${CI_MERGE_REQUEST_DIFF_BASE_SHA:?CI_MERGE_REQUEST_DIFF_BASE_SHA is required}"
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"

base="$CI_MERGE_REQUEST_DIFF_BASE_SHA"
head="$CI_COMMIT_SHA"

notes=$(glab api "projects/$CI_PROJECT_ID/merge_requests/$iid/notes?per_page=100&sort=asc" \
    --jq '[.[].body]' 2>/dev/null || echo '[]')

# The trailing "-->" is part of the pattern so prose mentioning the key alone
# is never mistaken for a marker.
marker=$(printf '%s' "$notes" \
    | grep -o 'claude-review: [0-9a-f]\{40\} -->' \
    | tail -n 1 \
    | cut -d' ' -f2 || true)

if [ -z "$marker" ]; then
    echo "$base..$head"
    exit 0
fi

if ! git cat-file -e "$marker^{commit}" 2>/dev/null; then
    echo "review-range: marker $marker is unknown to this clone, reviewing from the merge base" >&2
    echo "$base..$head"
    exit 0
fi

if ! git merge-base --is-ancestor "$marker" "$head" 2>/dev/null; then
    echo "review-range: marker $marker is not an ancestor of $head (force-push), reviewing from the merge base" >&2
    echo "$base..$head"
    exit 0
fi

if [ "$marker" = "$head" ]; then
    echo "review-range: no new commits since $marker" >&2
    exit 3
fi

echo "$marker..$head"
