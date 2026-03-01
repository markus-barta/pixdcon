#!/bin/bash

# Generate unique 7-character hex hash
# Checks for collisions in specified directory
#
# USAGE (source this file):
#   source scripts/lib/generate-hash.sh
#   hash=$(generate_unique_hash [search_dir])

generate_unique_hash() {
  local search_dir="${1:-+pm}"
  mkdir -p "$search_dir"

  while true; do
    local hash=$(printf "%04x%04x" $RANDOM $RANDOM | cut -c1-7)
    
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
