#!/usr/bin/env bash
# Census of openclaw brand occurrences across git-tracked files.
# Counts every case/spacing variant (open[ _-]?claw, case-insensitive),
# subtracts the allowlist (docs/afora/REBRAND-ALLOWLIST.txt) and afora-compat
# marker lines, and prints bucketed counts plus the top files by hit count.
# The counting logic lives in rebrand.mjs --census so the census and the
# codemod can never disagree about what counts as a survivor.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec node scripts/afora/rebrand.mjs --census "$@"
