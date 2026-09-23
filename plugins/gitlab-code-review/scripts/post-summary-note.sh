#!/bin/sh
# Posts the review's summary note, which records the reviewed head.
#
# Usage: post-summary-note.sh <project_id> <mr_iid> <to_sha> <summary_file>
#
# <project_id>, <mr_iid> and <to_sha> are the project_id, iid and to that
# review-range.sh printed. A <summary_file> of "-" reads the summary from
# stdin. The script adds the "## Code review" heading and ends the note with
# the <!-- claude-review: <to_sha> --> marker the next run's review-range.sh
# reads, so the marker's format never depends on the caller. Any marker in the
# summary itself is dropped: it would compete with the real one.
set -eu

fail() {
    echo "post-summary-note: $1" >&2
    exit 1
}

project="${1:-}"
iid="${2:-}"
to="${3:-}"
summary_file="${4:-}"

if [ -z "$project" ] || [ -z "$iid" ] || [ -z "$summary_file" ]; then
    fail "usage: post-summary-note.sh <project_id> <mr_iid> <to_sha> <summary_file>"
fi
printf '%s' "$to" | grep -Eq '^[0-9a-f]{40}$' || fail "to_sha must be a full 40-character SHA, got '$to'"
project_ref=$(printf '%s' "$project" | sed 's|/|%2F|g')

if [ "$summary_file" = "-" ]; then
    summary=$(cat)
else
    [ -r "$summary_file" ] || fail "cannot read summary file $summary_file"
    summary=$(cat "$summary_file")
fi
summary=$(printf '%s\n' "$summary" | grep -v 'claude-review:' || true)
[ -n "$summary" ] || fail "the summary is empty"

payload=$(jq -n --arg summary "$summary" --arg to "$to" \
    '{body: "## Code review\n\n\($summary)\n\n<!-- claude-review: \($to) -->"}')

if err=$(printf '%s' "$payload" | glab api --method POST \
    "projects/$project_ref/merge_requests/$iid/notes" \
    -H "Content-Type: application/json" \
    --input - 2>&1 >/dev/null); then
    exit 0
fi
fail "could not post the summary note ($err); check that the token carries the 'api' scope"
