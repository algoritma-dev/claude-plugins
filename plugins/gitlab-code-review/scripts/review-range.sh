#!/bin/sh
# Resolves the git revision range the current review run should examine.
#
# Prints "<from>..<to>" on stdout. Exit 3 means there is nothing new since the
# last review and the caller must post nothing. Exit 1 means the range could
# not be resolved, and the caller must stop rather than guess.
#
# The previous review's head SHA is read from a marker the reviewer writes into
# its own summary note: <!-- claude-review: <sha> -->. Only notes written by the
# authenticated account count, so a marker quoted or pasted by somebody else
# cannot steer or silence the reviewer. A marker is authoritative only while it
# is still an ancestor of the current head; after a force-push it is not, and
# the run falls back to a full review from the merge base.
set -eu

fail() {
    echo "review-range: $1" >&2
    exit 1
}

iid="${1:-}"
[ -n "$iid" ] || fail "usage: review-range.sh <mr_iid>"

# These come from GitLab CI. Checked explicitly rather than with ${VAR:?},
# which exits 2 in dash and would contradict this script's documented codes.
[ -n "${CI_PROJECT_ID:-}" ] || fail "CI_PROJECT_ID is not set; this command currently runs only inside GitLab CI"
[ -n "${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}" ] || fail "CI_MERGE_REQUEST_DIFF_BASE_SHA is not set; this command currently runs only inside GitLab CI"
[ -n "${CI_COMMIT_SHA:-}" ] || fail "CI_COMMIT_SHA is not set; this command currently runs only inside GitLab CI"

base="$CI_MERGE_REQUEST_DIFF_BASE_SHA"
# In a merged results pipeline CI_COMMIT_SHA is a temporary merge of the source
# branch into the target, rebuilt on every run. The merge request's own head is
# CI_MERGE_REQUEST_SOURCE_BRANCH_SHA, set only in that kind of pipeline. Taking
# the merge commit would record a marker no later head descends from, and
# every run would fall back to a full re-review.
head="${CI_MERGE_REQUEST_SOURCE_BRANCH_SHA:-$CI_COMMIT_SHA}"

# glab api has no --jq flag; the filtering is jq's job.
bot=$(glab api "user" | jq -r '.username') \
    || fail "cannot read the authenticated account; check GITLAB_TOKEN"
[ -n "$bot" ] && [ "$bot" != "null" ] \
    || fail "the authenticated account has no username"

# Newest first, so the first marker found is the current one. Every page is
# read: system notes and inline comments count towards a page too, and a
# marker pushed off the first one would trigger a full re-review.
notes=$(glab api --paginate "projects/$CI_PROJECT_ID/merge_requests/$iid/notes?per_page=100&sort=desc") \
    || fail "cannot read the notes of merge request $iid"

# A failed read is never treated as "no marker": that would silently re-review
# the whole merge request and repost every finding already on it.
marker=$(printf '%s' "$notes" \
    | jq -r --arg bot "$bot" 'if type == "array" then .[] else . end | select(.author.username == $bot) | .body' \
    | grep -o 'claude-review: [0-9a-f]\{40\} -->' \
    | head -n 1 \
    | cut -d' ' -f2) || true

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
