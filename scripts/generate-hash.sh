#!/bin/bash

# Shared function to generate unique 7-character hex hash
# Checks for collisions in specified directory (default: +pm/)
#
# USAGE (source this file):
#   source scripts/lib/generate-hash.sh
#   hash=$(generate_unique_hash [search_dir])

generate_unique_hash() {
	local search_dir="${1:-+pm}"

	# Create directory if it doesn't exist (for first-time use)
	mkdir -p "$search_dir"

	while true; do
		# Generate a 7-character hex hash using $RANDOM
		local full_hash
		full_hash=$(printf "%04x%04x" $RANDOM $RANDOM)
		local hash=${full_hash:0:7}

		# Check for collision by seeing if any file uses this hash
		# Search recursively to handle both +pm/backlog/ and hosts/*/docs/backlog/
		if ! find "$search_dir" -name "*--${hash}--*.md" 2>/dev/null | grep -q .; then
			echo "$hash"
			return 0
		fi
	done
}

# Allow direct execution for testing
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	generate_unique_hash "$@"
fi
