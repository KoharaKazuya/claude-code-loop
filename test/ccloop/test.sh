#!/bin/bash
set -e

# Import test library for `check` command
source dev-container-features-test-lib

# Install-time facts: the launcher is on PATH, the installed layout matches the
# bin/lib sibling contract the launcher relies on, and it is executable.
check "ccloop is on PATH" command -v ccloop
check "ccloop symlink points into /usr/local/share/ccloop" test -L /usr/local/bin/ccloop
check "ccloop launcher is executable" test -x /usr/local/share/ccloop/bin/ccloop
check "ccloop lib entrypoint is installed" test -f /usr/local/share/ccloop/lib/cli.ts
check "node is available on PATH" command -v node

# Runtime facts. `ccloop version` reads package.json from one level above lib/,
# so this also asserts that install.sh bundled it (otherwise it prints "unknown").
check "ccloop package.json is installed" test -f /usr/local/share/ccloop/package.json
check "ccloop version prints a semver string" bash -c 'ccloop version | grep -Eq "^[0-9]+\.[0-9]+\.[0-9]+"'

# doctor runs without a repository and reports every check. It exits non-zero
# here (no .agent/, claude CLI may be absent), so only the output is asserted.
check "ccloop doctor reports its checks" bash -c 'ccloop doctor 2>&1 | grep -q "CCLOOP_HOME"'

reportResults
