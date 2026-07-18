#!/usr/bin/env bash
# Backup restart of a legacy current image must use the frozen /health contract
# without probing target-only /ready.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BIN_DIR="$TMP_DIR/bin"
DOCKER_LOG="$TMP_DIR/docker.log"
mkdir -p "$BIN_DIR" "$TMP_DIR/backups"

cat >"$BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TEST_DOCKER_LOG"
case "$*" in
  *" ps --status running --services"*) printf 'api\n' ;;
  *" mongosh "*) printf '{"dataSize":0,"indexSize":0}\n' ;;
  *" mongodump "*) printf 'fake-archive' ;;
  *" mongorestore "*) exit 0 ;;
  *"/ready"*) exit 42 ;;
  *"/health"*) exit 0 ;;
esac
exit 0
EOF
chmod +x "$BIN_DIR/docker"

export PATH="$BIN_DIR:$PATH"
export TEST_DOCKER_LOG="$DOCKER_LOG"
export TOKENPANEL_SKIP_MANAGER_LOCK=1
APP_YML="$TMP_DIR/app.yml"
BACKUP_DIR="$TMP_DIR/backups"
MONGODB_DB="tokenpanel"
MONGO_USER_URI="user"
MONGO_PASS_URI="pass"
touch "$APP_YML" "$DOCKER_LOG"

# shellcheck source=../output.sh
source "$ROOT/manager/lib/output.sh"
# shellcheck source=../health.sh
source "$ROOT/manager/lib/health.sh"
# shellcheck source=../backup.sh
source "$ROOT/manager/lib/backup.sh"

backup_file="$(create_backup legacy-resume)"
[ -f "$backup_file" ] || { echo "FAIL: backup was not created" >&2; exit 1; }
grep -q '/health' "$DOCKER_LOG" || { echo "FAIL: /health was not probed" >&2; exit 1; }
if grep -q '/ready' "$DOCKER_LOG"; then
  echo "FAIL: backup resume probed target-only /ready" >&2
  exit 1
fi

echo "OK: backup resumes legacy API through frozen /health contract"
