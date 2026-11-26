#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# != 1 || ! "$1" =~ ^[1-9][0-9]*$ ]]; then
    echo "Usage: npm run package:mac:local -- <positive iteration number>" >&2
    exit 2
fi
base=$(node -p 'require("./package.json").version')
if [[ ! "$base" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Use a three-part public version in package.json." >&2
    exit 2
fi
version="$base+local.$1"
output="${YANMO_MAC_LOCAL_OUTPUT:-dist-local/$version}"

npm run package:mac -- --publish never \
    "-c.extraMetadata.version=$version" \
    "-c.mac.bundleShortVersion=$base" \
    "-c.mac.bundleVersion=$base" \
    "-c.directories.output=$output"
