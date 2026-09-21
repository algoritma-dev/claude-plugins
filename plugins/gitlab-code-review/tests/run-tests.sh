#!/bin/sh
# Runs every test suite in this directory.
set -eu
SUITE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
status=0
for suite in "$SUITE_DIR"/test-*.sh; do
    echo "== $(basename "$suite")"
    sh "$suite" || status=1
done
exit "$status"
