#!/bin/sh
# Posts one review finding to a merge request as an inline discussion.
#
# Usage: post-inline-comment.sh <mr_iid> <new_path> <new_line> <body_file>
#
# The request body is assembled as JSON with a nested "position" object and
# sent with --input. Passing bracketed field names (position[new_line]=12)
# would not work: glab puts them in the JSON body verbatim, GitLab does not
# expand bracket notation inside a JSON body, and the result is an ordinary
# unpositioned comment created with HTTP 201 — a lost placement with no error
# anywhere.
#
# GitLab rejects a position it cannot resolve (a deleted or renamed file, a
# line outside the diff) with HTTP 400. Losing the finding in that case is
# worse than losing its placement, so the script falls back to a plain merge
# request note. It exits non-zero only when the finding reached the merge
# request by neither route, which is what a token missing the `api` scope
# looks like.
set -eu

fail() {
    echo "post-inline-comment: $1" >&2
    exit 1
}

iid="${1:-}"
new_path="${2:-}"
new_line="${3:-}"
body_file="${4:-}"

if [ -z "$iid" ] || [ -z "$new_path" ] || [ -z "$new_line" ] || [ -z "$body_file" ]; then
    fail "usage: post-inline-comment.sh <mr_iid> <new_path> <new_line> <body_file>"
fi

case "$new_line" in
    ''|*[!0-9]*) fail "line must be a positive integer, got '$new_line'" ;;
esac

[ -r "$body_file" ] || fail "cannot read body file $body_file"
[ -n "${CI_PROJECT_ID:-}" ] || fail "CI_PROJECT_ID is not set; this command currently runs only inside GitLab CI"

body=$(cat "$body_file")

# glab api has no --jq flag; the filtering is jq's job.
refs=$(glab api "projects/$CI_PROJECT_ID/merge_requests/$iid") \
    || fail "cannot read merge request $iid"

base_sha=$(printf '%s' "$refs" | jq -r '.diff_refs.base_sha // empty')
start_sha=$(printf '%s' "$refs" | jq -r '.diff_refs.start_sha // empty')
head_sha=$(printf '%s' "$refs" | jq -r '.diff_refs.head_sha // empty')

if [ -z "$base_sha" ] || [ -z "$start_sha" ] || [ -z "$head_sha" ]; then
    fail "merge request $iid returned no diff_refs; refusing to post an unpositioned comment"
fi

payload=$(jq -n \
    --arg body "$body" \
    --arg base_sha "$base_sha" \
    --arg start_sha "$start_sha" \
    --arg head_sha "$head_sha" \
    --arg new_path "$new_path" \
    --argjson new_line "$new_line" \
    '{
        body: $body,
        position: {
            position_type: "text",
            base_sha: $base_sha,
            start_sha: $start_sha,
            head_sha: $head_sha,
            new_path: $new_path,
            new_line: $new_line
        }
    }')

if printf '%s' "$payload" | glab api --method POST \
    "projects/$CI_PROJECT_ID/merge_requests/$iid/discussions" \
    -H "Content-Type: application/json" \
    --input - >/dev/null 2>&1; then
    exit 0
fi

echo "post-inline-comment: inline position rejected for $new_path:$new_line, falling back to a plain note" >&2

if glab mr note "$iid" --message "\`$new_path:$new_line\` — $body" >/dev/null 2>&1; then
    exit 0
fi

fail "could not post the finding at all; check that the token carries the 'api' scope"
