#!/bin/sh
# Posts one review finding to a merge request as an inline discussion.
#
# Usage: post-inline-comment.sh <project_id> <mr_iid> <to_sha> <new_path> <new_line> <body_file>
#
# <project_id>, <mr_iid> and <to_sha> are the project_id, iid and to that
# review-range.sh printed; <new_line> is a line number in <to_sha>, the
# reviewed head. A <body_file> of "-" reads the comment from stdin, so the
# caller can pass it as a here-doc instead of writing a temporary file.
#
# The request body is assembled as JSON with a nested "position" object and
# sent with --input. Passing bracketed field names (position[new_line]=12)
# would not work: glab puts them in the JSON body verbatim, GitLab does not
# expand bracket notation inside a JSON body, and the result is an ordinary
# unpositioned comment created with HTTP 201 — a lost placement with no error
# anywhere.
#
# The position is anchored to the merge request diff version whose head is the
# reviewed commit, not to the newest version. A push during the review would
# otherwise shift every comment onto a line nobody reviewed. On an unchanged
# line GitLab also needs the line's number on the old side, and on a renamed
# file the old path; both are worked out from the version's diff.
#
# GitLab rejects a position it cannot resolve (a deleted file, a line outside
# the diff) with HTTP 400. Losing the finding in that case is worse than
# losing its placement, so the script falls back to a plain merge request
# note. It exits non-zero only when the finding reached the merge request by
# neither route, which is what a token missing the `api` scope looks like.
set -eu

fail() {
    echo "post-inline-comment: $1" >&2
    exit 1
}

project="${1:-}"
iid="${2:-}"
head="${3:-}"
new_path="${4:-}"
new_line="${5:-}"
body_file="${6:-}"

if [ -z "$project" ] || [ -z "$iid" ] || [ -z "$head" ] || [ -z "$new_path" ] || [ -z "$new_line" ] || [ -z "$body_file" ]; then
    fail "usage: post-inline-comment.sh <project_id> <mr_iid> <to_sha> <new_path> <new_line> <body_file>"
fi
printf '%s' "$head" | grep -Eq '^[0-9a-f]{40}$' || fail "to_sha must be a full 40-character SHA, got '$head'"
# A path goes into the URL with its slashes encoded.
project_ref=$(printf '%s' "$project" | sed 's|/|%2F|g')

# jq --argjson rejects a leading zero, and GitLab has no line 0.
case "$new_line" in
    ''|*[!0-9]*|0*) fail "line must be a positive integer, got '$new_line'" ;;
esac

if [ "$body_file" = "-" ]; then
    body=$(cat)
else
    [ -r "$body_file" ] || fail "cannot read body file $body_file"
    body=$(cat "$body_file")
fi
[ -n "$body" ] || fail "the comment body is empty"

# Posts the finding as a plain note, the route that needs no position.
post_note() {
    # A suggestion block can only be applied from a positioned discussion; in a
    # note it is an ordinary code block.
    note_body=$(printf '%s\n' "$body" | sed 's/^\([[:space:]]*\)```suggestion.*$/\1```/')
    note_payload=$(jq -n --arg body "\`$new_path:$new_line\` at $head — $note_body" '{body: $body}')
    if err=$(printf '%s' "$note_payload" | glab api --method POST \
        "projects/$project_ref/merge_requests/$iid/notes" \
        -H "Content-Type: application/json" \
        --input - 2>&1 >/dev/null); then
        exit 0
    fi
    fail "could not post the finding at all ($err); check that the token carries the 'api' scope"
}

# One review posts several comments against the same head, so the diff version
# is looked up once and kept for the rest of the run.
cache="${TMPDIR:-/tmp}/claude-review-$project_ref-$iid-$head"
refs=""
if [ -r "$cache" ]; then
    refs=$(grep -E '^[0-9a-f]{40} [0-9a-f]{40} [0-9a-f]{40}$' "$cache" || true)
fi
if [ -z "$refs" ]; then
    # glab api has no --jq flag; the filtering is jq's job. Older glab versions
    # print one array per page, hence the type test.
    versions=$(glab api --paginate "projects/$project_ref/merge_requests/$iid/versions") \
        || fail "cannot read the diff versions of merge request $iid"
    refs=$(printf '%s' "$versions" | jq -r --arg head "$head" '
        [if type == "array" then .[] else . end | select(.head_commit_sha == $head)][0]
        // empty
        | "\(.base_commit_sha) \(.start_commit_sha) \(.head_commit_sha)"')
    if [ -n "$refs" ]; then
        printf '%s\n' "$refs" > "$cache" 2>/dev/null || true
    fi
fi

if [ -z "$refs" ]; then
    echo "post-inline-comment: merge request $iid has no diff version for $head, falling back to a plain note" >&2
    post_note
fi

base_sha=${refs%% *}
start_sha=${refs#* }
start_sha=${start_sha%% *}
head_sha=${refs##* }

# The old side of a renamed file has the old path.
old_path=$(git diff -M --name-status "$base_sha" "$head_sha" 2>/dev/null \
    | awk -F '\t' -v p="$new_path" '$1 ~ /^R/ && $3 == p { print $2; exit }') || true
[ -n "$old_path" ] || old_path="$new_path"

# The line's number on the old side, or nothing when the line was added. Walks
# the zero-context hunks in order, adding up how far each one before the line
# shifted the numbering. If git cannot diff the two commits the result is
# empty too, and the position carries new_line alone.
old_line=$(git diff -M -U0 "$base_sha" "$head_sha" -- "$old_path" "$new_path" 2>/dev/null \
    | awk -v n="$new_line" '
        /^@@/ {
            split(substr($2, 2), o, ","); split(substr($3, 2), w, ",")
            oc = (o[2] == "") ? 1 : o[2] + 0
            ns = w[1] + 0; nc = (w[2] == "") ? 1 : w[2] + 0
            if (nc > 0 && n >= ns && n < ns + nc) { added = 1; exit }
            if ((nc > 0 && ns + nc - 1 < n) || (nc == 0 && ns < n)) { shift += nc - oc; next }
            exit
        }
        END { if (!added) print n - shift }') || true

payload=$(jq -n \
    --arg body "$body" \
    --arg base_sha "$base_sha" \
    --arg start_sha "$start_sha" \
    --arg head_sha "$head_sha" \
    --arg old_path "$old_path" \
    --arg new_path "$new_path" \
    --argjson new_line "$new_line" \
    --arg old_line "$old_line" \
    '{
        body: $body,
        position: ({
            position_type: "text",
            base_sha: $base_sha,
            start_sha: $start_sha,
            head_sha: $head_sha,
            old_path: $old_path,
            new_path: $new_path,
            new_line: $new_line
        } + (if $old_line == "" then {} else {old_line: ($old_line | tonumber)} end))
    }')

if err=$(printf '%s' "$payload" | glab api --method POST \
    "projects/$project_ref/merge_requests/$iid/discussions" \
    -H "Content-Type: application/json" \
    --input - 2>&1 >/dev/null); then
    exit 0
fi

echo "post-inline-comment: inline position rejected for $new_path:$new_line ($err), falling back to a plain note" >&2
post_note
