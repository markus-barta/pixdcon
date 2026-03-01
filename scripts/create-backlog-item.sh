#!/bin/bash

# Create backlog items for pidicon-light
#
# USAGE: ./scripts/create-backlog-item.sh [priority] [description]
# RUN FROM: Repository root
#
# EXAMPLES:
#   ./scripts/create-backlog-item.sh A10 implement-ulanzi-driver
#   ./scripts/create-backlog-item.sh P50 add-config-validation
#
# ARGUMENTS:
#   priority: LNN format (A00-Z99, default: P50)
#   description: kebab-case slug (default: timestamp)
#
# OUTPUT: +pm/backlog/LNN--hash--description.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/generate-hash.sh"

priority="${1:-P50}"
desc="${2:-$(date +"%Y-%m-%d-%H-%M-%S")}"

# Validate priority format
if ! [[ "$priority" =~ ^[A-Z][0-9]{2}$ ]]; then
  echo "Warning: Invalid priority '$priority' (expected LNN like P50), using P50"
  priority="P50"
fi

dir="+pm/backlog"
mkdir -p "$dir"

hash=$(generate_unique_hash ".")
filename="$dir/${priority}--${hash}--${desc}.md"

cat >"$filename" <<ITEM
# ${desc}

**Priority**: ${priority}
**Status**: Backlog
**Created**: $(date +%Y-%m-%d)

---

## Problem

[Brief description]

## Solution

[How to solve it]

## Implementation

- [ ] Task 1
- [ ] Task 2
- [ ] Documentation
- [ ] Test

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Notes

[Dependencies, risks, references]
ITEM

echo "Created: $filename"
