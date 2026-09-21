#!/bin/sh
# Posts one review finding to a merge request as an inline discussion.
#
# Usage: post-inline-comment.sh <mr_iid> <new_path> <new_line> <body_file>
#
# GitLab rejects a position it cannot resolve (a deleted or renamed file, a
# line outside the diff) with HTTP 400. Losing the finding in that case is
# worse than losing its placement, so the script falls back to a plain merge
# request note. It exits non-zero only when the finding reached the merge
# request by neither route, which is what a token missing the `api` scope
# looks like.
set -eu

iid="${1:-}"
new_path="${2:-}"
new_line="${3:-}"
body_file="${4:-}"

if [ -z "$iid" ] || [ -z "$new_path" ] || [ -z "$new_line" ] || [ -z "$body_file" ]; then
    echo "usage: post-inline-comment.sh <mr_iid> <new_path> <new_line> <body_file>" >&2
    exit 1
fi

if [ ! -r "$body_file" ]; then
    echo "post-inline-comment: cannot read body file $body_file" >&2
    exit 1
fi

: "${CI_PROJECT_ID:?CI_PROJECT_ID is required}"

body=$(cat "$body_file")

refs=$(glab api "projects/$CI_PROJECT_ID/merge_requests/$iid" --jq '.diff_refs')
base_sha=$(printf '%s' "$refs" | jq -r '.base_sha')
start_sha=$(printf '%s' "$refs" | jq -r '.start_sha')
head_sha=$(printf '%s' "$refs" | jq -r '.head_sha')

if [ -z "$base_sha" ] || [ "$base_sha" = "null" ]; then
    echo "post-inline-comment: merge request $iid returned no diff_refs" >&2
    exit 1
fi

if glab api --method POST "projects/$CI_PROJECT_ID/merge_requests/$iid/discussions" \
    --field "body=$body" \
    --field "position[position_type]=text" \
    --field "position[base_sha]=$base_sha" \
    --field "position[start_sha]=$start_sha" \
    --field "position[head_sha]=$head_sha" \
    --field "position[new_path]=$new_path" \
    --field "position[new_line]=$new_line" >/dev/null 2>&1; then
    exit 0
fi

echo "post-inline-comment: inline position rejected for $new_path:$new_line, falling back to a plain note" >&2

if glab mr note "$iid" --message "\`$new_path:$new_line\` — $body" >/dev/null 2>&1; then
    exit 0
fi

echo "post-inline-comment: could not post the finding at all; check that the token carries the 'api' scope" >&2
exit 1
