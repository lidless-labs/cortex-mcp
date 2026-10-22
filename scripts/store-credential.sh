#!/bin/bash
# The caller supplies credential bytes on stdin, never as command arguments.
set -euo pipefail
umask 077
credential_file=$1
credential_dir=$(dirname -- "$credential_file")
mkdir -p -- "$credential_dir"
chmod 700 -- "$credential_dir"
# Refuse to follow an existing symlink and create a new owner-only file.
set -o noclobber
cat > "$credential_file"
chmod 600 -- "$credential_file"
