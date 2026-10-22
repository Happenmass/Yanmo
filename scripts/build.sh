#!/bin/bash
set -euo pipefail
YANMO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$YANMO_ROOT"
exec npm run package:mac
