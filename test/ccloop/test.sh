#!/bin/bash
set -e

# Import test library for `check` command
source dev-container-features-test-lib

# ccloop has no runtime subcommand guaranteed to exist yet (e.g. `ccloop version`),
# so assertions here focus on install-time facts: the launcher is on PATH, the
# installed layout matches the bin/lib sibling contract the launcher relies on,
# and it is executable.
check "ccloop is on PATH" command -v ccloop
check "ccloop symlink points into /usr/local/share/ccloop" test -L /usr/local/bin/ccloop
check "ccloop launcher is executable" test -x /usr/local/share/ccloop/bin/ccloop
check "ccloop lib entrypoint is installed" test -f /usr/local/share/ccloop/lib/cli.ts
check "node is available on PATH" command -v node

reportResults
