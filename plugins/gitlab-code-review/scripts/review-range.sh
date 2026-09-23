#!/bin/sh
# Resolves what the current review run should examine.
#
# Usage: review-range.sh <mr_iid> [<project>]
#
# <project> is a numeric project ID or a path such as group/app. Without it the
# script uses CI_PROJECT_ID, and outside CI the project of the clone it runs in.
#
# On success prints one JSON object on stdout:
#   {"project_id", "iid", "from", "to", "range", "title", "description", "web_url"}
# where "range" is "<from>..<to>". Exit 3 means there is nothing to review and
# the caller must post nothing: the merge request is not open, is a draft, or
# has no new commits since the last review. The reason goes to stderr. Exit 1
# means the range could not be resolved, and the caller must stop rather than
# guess.
#
# It runs in GitLab CI and on a developer's machine. Inside the CI job of the
# same merge request it takes base and head from the pipeline variables;
# anywhere else it takes them from the API and, when the clone lacks the
# merge request's commits, fetches refs/merge-requests/<iid>/head from the
# remote named by CLAUDE_REVIEW_REMOTE (default origin).
#
# The previous review's head SHA is read from a marker the reviewer writes into
# its own summary note: <!-- claude-review: <sha> -->. Only notes written by the
# authenticated account, or by an account listed in the comma-separated
# CLAUDE_REVIEW_TRUSTED_AUTHORS, count, so a marker quoted or pasted by
# somebody else cannot steer or silence the reviewer. A marker is authoritative
# only while it is still an ancestor of the current head; after a force-push it
# is not, and the run falls back to a full review from the merge base.
set -eu

fail() {
    echo "review-range: $1" >&2
    exit 1
}

iid="${1:-}"
project="${2:-${CI_PROJECT_ID:-}}"
case "$iid" in
    ''|*[!0-9]*) fail "usage: review-range.sh <mr_iid> [<project>]" ;;
esac

git rev-parse --git-dir >/dev/null 2>&1 \
    || fail "not inside a git repository; run the review from a clone of the project"

# glab api has no --jq flag; the filtering is jq's job.
if [ -z "$project" ]; then
    project=$(glab repo view --output json 2>/dev/null | jq -r '.id // empty') || true
    [ -n "$project" ] || fail "no project given and none found for this clone; pass the project ID or path"
fi
# A path goes into the URL with its slashes encoded.
project_ref=$(printf '%s' "$project" | sed 's|/|%2F|g')

mr=$(glab api "projects/$project_ref/merge_requests/$iid") \
    || fail "cannot read merge request $iid of project $project"
state=$(printf '%s' "$mr" | jq -r '.state // empty') \
    || fail "merge request $iid returned no readable state"
[ -n "$state" ] || fail "merge request $iid returned no state"
if [ "$state" != "opened" ]; then
    echo "review-range: merge request $iid is $state, nothing to review" >&2
    exit 3
fi
# GitLab before 14.0 reports a draft only as work_in_progress.
if [ "$(printf '%s' "$mr" | jq -r '.draft // .work_in_progress // false')" = "true" ]; then
    echo "review-range: merge request $iid is a draft, nothing to review" >&2
    exit 3
fi

project_id=$(printf '%s' "$mr" | jq -r '.project_id // empty')
[ -n "$project_id" ] || fail "merge request $iid returned no project_id"

if [ "${CI_PROJECT_ID:-}" = "$project_id" ] && [ "${CI_MERGE_REQUEST_IID:-}" = "$iid" ] \
    && [ -n "${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}" ] && [ -n "${CI_COMMIT_SHA:-}" ]; then
    base="$CI_MERGE_REQUEST_DIFF_BASE_SHA"
    # In a merged results pipeline CI_COMMIT_SHA is a temporary merge of the
    # source branch into the target, rebuilt on every run. The merge request's
    # own head is CI_MERGE_REQUEST_SOURCE_BRANCH_SHA, set only in that kind of
    # pipeline. Taking the merge commit would record a marker no later head
    # descends from, and every run would fall back to a full re-review.
    head="${CI_MERGE_REQUEST_SOURCE_BRANCH_SHA:-$CI_COMMIT_SHA}"
else
    base=$(printf '%s' "$mr" | jq -r '.diff_refs.base_sha // empty')
    head=$(printf '%s' "$mr" | jq -r '.diff_refs.head_sha // .sha // empty')
    [ -n "$base" ] && [ -n "$head" ] || fail "merge request $iid returned no diff_refs"
fi

# The base is an ancestor of the head, so one fetch brings both.
if ! git cat-file -e "$head^{commit}" 2>/dev/null || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
    remote="${CLAUDE_REVIEW_REMOTE:-origin}"
    echo "review-range: fetching merge request $iid from $remote" >&2
    git fetch --quiet "$remote" "refs/merge-requests/$iid/head" >&2 \
        || fail "cannot fetch refs/merge-requests/$iid/head from $remote; run the review from a clone of project $project"
    git cat-file -e "$head^{commit}" 2>/dev/null && git cat-file -e "$base^{commit}" 2>/dev/null \
        || fail "commits of merge request $iid are not in this clone; run the review from a clone of project $project"
fi

bot=$(glab api "user" | jq -r '.username') \
    || fail "cannot read the authenticated account; check the GitLab token"
[ -n "$bot" ] && [ "$bot" != "null" ] \
    || fail "the authenticated account has no username"
trusted="$bot,${CLAUDE_REVIEW_TRUSTED_AUTHORS:-}"

# Newest first, so the first marker found is the current one. Every page is
# read: system notes and inline comments count towards a page too, and a
# marker pushed off the first one would trigger a full re-review.
notes=$(glab api --paginate "projects/$project_id/merge_requests/$iid/notes?per_page=100&sort=desc") \
    || fail "cannot read the notes of merge request $iid"

# A failed read is never treated as "no marker": that would silently re-review
# the whole merge request and repost every finding already on it.
marker=$(printf '%s' "$notes" \
    | jq -r --arg trusted "$trusted" '
        ($trusted | split(",") | map(select(. != ""))) as $authors
        | if type == "array" then .[] else . end
        | select(.author.username as $u | $authors | index($u))
        | .body' \
    | grep -o 'claude-review: [0-9a-f]\{40\} -->' \
    | head -n 1 \
    | cut -d' ' -f2) || true

from="$base"
if [ -n "$marker" ]; then
    if ! git cat-file -e "$marker^{commit}" 2>/dev/null; then
        echo "review-range: marker $marker is unknown to this clone, reviewing from the merge base" >&2
    elif ! git merge-base --is-ancestor "$marker" "$head" 2>/dev/null; then
        echo "review-range: marker $marker is not an ancestor of $head (force-push), reviewing from the merge base" >&2
    elif [ "$marker" = "$head" ]; then
        echo "review-range: no new commits since $marker" >&2
        exit 3
    else
        from="$marker"
    fi
fi

printf '%s' "$mr" | jq -c \
    --arg from "$from" --arg to "$head" --arg iid "$iid" --arg project_id "$project_id" '{
        project_id: ($project_id | tonumber),
        iid: ($iid | tonumber),
        from: $from,
        to: $to,
        range: "\($from)..\($to)",
        title: (.title // ""),
        description: (.description // ""),
        web_url: (.web_url // "")
    }'
