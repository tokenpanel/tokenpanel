#!/usr/bin/env bash
# Colored output helpers — sourced by all manager scripts.

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Log helpers write to stderr by convention: stdout is reserved for data.
# For example, create_backup echoes the archive path on stdout so callers
# can capture it via command substitution ("$(create_backup ...)") without
# picking up progress noise; all step/info/ok/warn lines go to stderr.
ok()   { echo -e "${GREEN}✓${NC} $*" >&2; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
warn() { echo -e "${YELLOW}⚠${NC} $*" >&2; }
info() { echo -e "${BLUE}→${NC} $*" >&2; }
step() { echo -e "${BOLD}[$1]${NC} $2" >&2; }
die()  { err "$*"; exit 1; }
