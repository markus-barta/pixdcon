#!/bin/bash

# Generic script to create backlog items in any directory
#
# USAGE: ./scripts/create-backlog-item.sh [priority] [description] [--dir target-dir] [--host hostname]
# RUN FROM: Repository root
#
# EXAMPLES:
#   # Infrastructure backlog (default)
#   ./scripts/create-backlog-item.sh P50 fix-nix-flake
#
#   # Host-specific backlog with explicit directory
#   ./scripts/create-backlog-item.sh P30 audit-docker --dir hosts/hsb0/docs/backlog
# RUN FROM: Repository root
#
# EXAMPLES:
#   ./scripts/create-backlog-item.sh A10 implement-feature
#   ./scripts/create-backlog-item.sh P50 refactor-auth
#
# ARGUMENTS:
#   priority: LNN format (A00-Z99, default: P50)
#   description: kebab-case slug (default: timestamp YYYY-MM-DD)
#
# OUTPUT: +pm/backlog/LNN--hash--description.md

set -euo pipefail

# Get script directory for sourcing lib
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source hash generation library
# shellcheck source=scripts/lib/generate-hash.sh
source "$SCRIPT_DIR/lib/generate-hash.sh"

# Defaults
priority=""
desc=""
dir=""
host=""

# Parse arguments
positional_args=()
while [[ $# -gt 0 ]]; do
	case $1 in
	--dir)
		dir="$2"
		shift 2
		;;
	--host)
		host="$2"
		shift 2
		;;
	-*)
		echo "Unknown option: $1"
		exit 1
		;;
	*)
		positional_args+=("$1")
		shift
		;;
	esac
done

# Restore positional parameters
set -- "${positional_args[@]}"

# Parse positional arguments
if [[ $# -ge 1 ]]; then
	priority="$1"
fi

if [[ $# -ge 2 ]]; then
	desc="$2"
fi

# Validate and default priority
if [[ -z "$priority" ]] || ! [[ "$priority" =~ ^[A-Z][0-9]{2}$ ]]; then
	if [[ -n "$priority" ]]; then
		echo "Warning: Invalid priority format '$priority' (expected LNN like P50), using P50"
	fi
	priority="P50"
fi

# Generate default description if empty
if [[ -z "$desc" ]]; then
	desc=$(date +"%Y-%m-%d-%H-%M-%S")
fi

# Determine target directory
if [[ -z "$dir" ]]; then
	if [[ -n "$host" ]]; then
		# Infer directory from host
		dir="hosts/$host/docs/backlog"
	else
		# Default to infrastructure backlog
		dir="+pm/backlog"
	fi
fi

# Ensure target directory exists
mkdir -p "$dir"

# Generate unique hash (search entire repo to avoid collisions)
hash=$(generate_unique_hash ".")

# Build filename
filename="$dir/${priority}--${hash}--${desc}.md"

# Create template
cat >"$filename" <<EOF
# ${desc}

**Priority**: ${priority}
**Status**: Backlog
**Created**: $(date +%Y-%m-%d)

---

## Problem

[Brief description of what needs to be fixed or built]

## Solution

[How we're going to solve it]

## Implementation

- [ ] Task 1
- [ ] Task 2
- [ ] Documentation update
- [ ] Test

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Tests pass

## Notes

[Optional: Dependencies, risks, references, related items]
EOF

echo "Created: $filename"
