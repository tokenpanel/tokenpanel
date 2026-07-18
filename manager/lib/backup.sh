#!/usr/bin/env bash
# Backup system: mongodump with dynamic space check + smart retention.
#
# Consistency model
# -----------------
# Live mongodump without write quiesce is NOT a single logical snapshot:
# collections are copied at different wall-clock times while the API may still
# mutate related billing/usage/balance state.
#
# We cannot use `mongodump --oplog` + `mongorestore --oplogReplay` here:
#   - --oplog requires a full-instance dump (no single-db / --db limit)
#   - --oplogReplay forbids --nsFrom/--nsTo/--nsInclude (breaks restore-into-temp)
# So we stop the API (the sole app writer) for the dump window, then restart it.
# That yields a write-quiet, cross-collection-consistent archive while keeping
# the existing single-DB dump + temp-DB swap restore path.

source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/output.sh"
source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/prompt.sh"
source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/lock.sh"

# URI-encoded Mongo credentials (MONGO_USER_URI / MONGO_PASS_URI) are derived
# in config.sh (_ensure_uri_creds), which is always sourced before this file.

# 1 if create_backup stopped the api and must restart it; 0 otherwise.
BACKUP_API_WAS_RUNNING=0

_api_is_running() {
  docker compose -f "$APP_YML" ps --status running --services 2>/dev/null \
    | grep -qx 'api'
}

# Stop api if it is up so mongodump sees one write-quiet moment.
# Sets BACKUP_API_WAS_RUNNING so _resume_writers only restarts what we stopped.
_quiesce_writers() {
  BACKUP_API_WAS_RUNNING=0
  if _api_is_running; then
    step "backup" "stopping api for consistent snapshot..."
    if ! docker compose -f "$APP_YML" stop api; then
      err "failed to stop api — refusing live dump (would not be consistent)"
      return 1
    fi
    BACKUP_API_WAS_RUNNING=1
    ok "api stopped (writes quiesced)"
  else
    info "api not running — dump already write-quiet"
  fi
}

# Restart api only if this backup run stopped it. Safe to call multiple times.
# Returns 0 when nothing to do or api is up and (when wait_for_health is
# available) ready; 1 if start or readiness fails. Callers must not treat a
# failed resume as overall success even when the dump itself succeeded.
_resume_writers() {
  if [ "${BACKUP_API_WAS_RUNNING:-0}" -ne 1 ]; then
    return 0
  fi
  BACKUP_API_WAS_RUNNING=0
  step "backup" "restarting api..."
  if ! docker compose -f "$APP_YML" start api >/dev/null 2>&1; then
    err "failed to restart api — start it manually: tokenpanel start"
    return 1
  fi
  # health.sh is sourced by bin/tokenpanel before backup.sh; unit tests that
  # only source backup.sh skip readiness (start success is enough).
  if declare -F wait_for_health >/dev/null 2>&1; then
    if ! wait_for_health api 60 "/ready" 1; then
      err "api started but not ready — check: tokenpanel logs api"
      return 1
    fi
  else
    ok "api restarted"
  fi
  return 0
}

create_backup() {
  local label="${1:-manual}"

  # Serialize with update/restore/migrate/etc. Re-entrant if caller already holds.
  acquire_manager_lock "backup" || return 1

  # Unique path even within the same UTC second: include pid, and if the path
  # still exists (PID reuse / clock skew), append a monotonic counter.
  # Label stays as the final "_${label}.gz" segment so globs like
  # *_pre-restore.gz / *_pre-update.gz keep working.
  local timestamp pid backup_file n
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  pid="$$"
  n=0
  backup_file="${BACKUP_DIR}/${timestamp}-${pid}_${label}.gz"
  while [ -e "$backup_file" ]; do
    n=$((n + 1))
    backup_file="${BACKUP_DIR}/${timestamp}-${pid}-${n}_${label}.gz"
    if [ "$n" -ge 1000 ]; then
      err "could not allocate unique backup filename under $BACKUP_DIR"
      return 1
    fi
  done

  mkdir -p "$BACKUP_DIR"

  step "backup" "checking database size..."

  local db_stats data_size_mb index_size_mb total_db_mb estimated_backup_mb
  db_stats="$(docker compose -f "$APP_YML" exec -T mongo mongosh --quiet \
    "mongodb://${MONGO_USER_URI}:${MONGO_PASS_URI}@localhost:27017/${MONGODB_DB}?authSource=admin&directConnection=true" \
    --eval 'JSON.stringify(db.stats())' 2>/dev/null)" || {
    err "failed to get db stats — is mongo running?"
    return 1
  }

  if command -v jq >/dev/null 2>&1; then
    data_size_mb="$(echo "$db_stats" | jq -r '.dataSize // 0' | awk '{printf "%.0f", $1/1048576}')"
    index_size_mb="$(echo "$db_stats" | jq -r '.indexSize // 0' | awk '{printf "%.0f", $1/1048576}')"
  else
    data_size_mb="$(echo "$db_stats" | grep -o '"dataSize":[0-9]*' | head -1 | cut -d: -f2 | awk '{printf "%.0f", $1/1048576}')"
    index_size_mb="$(echo "$db_stats" | grep -o '"indexSize":[0-9]*' | head -1 | cut -d: -f2 | awk '{printf "%.0f", $1/1048576}')"
  fi
  data_size_mb="${data_size_mb:-0}"
  index_size_mb="${index_size_mb:-0}"
  total_db_mb=$((data_size_mb + index_size_mb))

  info "database: ${data_size_mb}MB data + ${index_size_mb}MB indexes = ${total_db_mb}MB total"

  # Conservative headroom: assume dump can approach full data+index size
  # (compression is not guaranteed for already-compressed / binary-heavy data).
  # Require 1× dump + 1× verify copy + 2GB free-space floor for live Mongo.
  local estimated_backup_mb free_floor_mb free_mb required_mb
  if [ "$total_db_mb" -gt 0 ]; then
    estimated_backup_mb="$total_db_mb"
  else
    estimated_backup_mb=64
  fi
  free_floor_mb=2048
  info "conservative backup budget: ~${estimated_backup_mb}MB (uncompressed upper bound)"

  free_mb="$(df -m "$BACKUP_DIR" 2>/dev/null | tail -1 | awk '{print $4}')"
  required_mb=$((estimated_backup_mb * 2 + free_floor_mb))

  if [ "${free_mb:-0}" -lt "$required_mb" ]; then
    err "insufficient disk space: ${free_mb}MB free, need ~${required_mb}MB"
    err "(dump upper bound ~${estimated_backup_mb}MB x2 + ${free_floor_mb}MB floor)"
    return 1
  fi
  ok "disk: ${free_mb}MB free, need ~${required_mb}MB — ok"

  # Safety net for signals / unexpected abort while API is stopped.
  # EXIT runs on shell exit only — failure paths below also resume explicitly
  # because `return` from this function does not fire EXIT.
  trap '_resume_writers' EXIT

  if ! _quiesce_writers; then
    trap - EXIT
    return 1
  fi

  step "backup" "dumping database (write-quiet)..."
  if ! docker compose -f "$APP_YML" exec -T mongo mongodump \
    --uri="mongodb://${MONGO_USER_URI}:${MONGO_PASS_URI}@localhost:27017/${MONGODB_DB}?authSource=admin&directConnection=true" \
    --archive --gzip --quiet > "$backup_file"; then
    err "mongodump failed"
    rm -f "$backup_file"
    trap - EXIT
    _resume_writers
    return 1
  fi

  local actual_size_mb
  actual_size_mb="$(($(stat -c %s "$backup_file" 2>/dev/null || stat -f %z "$backup_file") / 1048576))"
  ok "backup created: $(basename "$backup_file") (${actual_size_mb}MB)"

  step "backup" "verifying integrity..."
  if docker compose -f "$APP_YML" exec -T mongo mongorestore \
    --uri="mongodb://${MONGO_USER_URI}:${MONGO_PASS_URI}@localhost:27017/admin?authSource=admin&directConnection=true" \
    --archive=/dev/stdin --gzip --dryRun --quiet < "$backup_file" 2>/dev/null; then
    ok "backup verified"
  else
    err "backup verification failed — archive may be corrupt"
    rm -f "$backup_file"
    trap - EXIT
    _resume_writers
    return 1
  fi

  # Resume API before retention (retention is local FS only) so write traffic
  # returns ASAP. Clear EXIT trap only after an explicit resume attempt.
  # Dump + verify already succeeded; still fail the command if api does not
  # come back so operators never see "backup ok" with a dead API.
  trap - EXIT
  local resume_rc=0
  _resume_writers || resume_rc=$?

  apply_retention

  echo "$backup_file"
  if [ "$resume_rc" -ne 0 ]; then
    err "backup archive is valid but api did not resume cleanly"
    return 1
  fi
}

apply_retention() {
  local keep_n
  keep_n="$(compute_retention_count)"
  info "retention: keeping last ${keep_n} backups"

  local count=0
  while IFS= read -r file; do
    # Never prune a backup that is currently protected (e.g. the archive a
    # restore is about to read). Without this, a pre-restore backup's
    # retention pass could delete the very file restore uses next.
    if [ -n "${BACKUP_PROTECT:-}" ] && [ "$file" = "$BACKUP_PROTECT" ]; then
      continue
    fi
    count=$((count + 1))
    if [ "$count" -gt "$keep_n" ]; then
      warn "pruning old backup: $(basename "$file")"
      rm -f "$file"
    fi
  done < <(ls -t "$BACKUP_DIR"/*.gz 2>/dev/null || true)
}

compute_retention_count() {
  local max_keep=5
  local free_mb
  free_mb="$(df -m "$BACKUP_DIR" 2>/dev/null | tail -1 | awk '{print $4}')"

  local total_size num_backups avg_size_mb fits
  total_size="$(du -cm "$BACKUP_DIR"/*.gz 2>/dev/null | tail -1 | cut -f1)"
  num_backups="$(ls "$BACKUP_DIR"/*.gz 2>/dev/null | wc -l)"

  if [ "${num_backups:-0}" -gt 0 ] && [ -n "${total_size:-}" ]; then
    avg_size_mb=$((total_size / num_backups))
    if [ "$avg_size_mb" -gt 0 ]; then
      fits=$((free_mb * 50 / 100 / avg_size_mb))
      [ "$fits" -lt "$max_keep" ] && max_keep="$fits"
    fi
  fi

  [ "$max_keep" -lt 1 ] && max_keep=1
  echo "$max_keep"
}

# Drop a temp restore database if it exists (idempotent; never fails caller).
_drop_temp_db() {
  local tmp_db="$1"
  local admin_uri="$2"
  docker compose -f "$APP_YML" exec -T mongo mongosh "$admin_uri" \
    --quiet --eval "db.getSiblingDB('${tmp_db}').dropDatabase()" >/dev/null 2>&1 || true
}

# Restore EXIT-trap state. Globals (not locals) so the trap body can read them
# after unexpected termination (signal / set -e abort of the whole script).
#
# _RESTORE_SWAP_UNSAFE=1 once the destructive drop+rename swap has started and
# until it finishes cleanly. While set, the EXIT trap must NOT restart the API
# — the live DB may be empty or only partially renamed.
# Explicit rc==2 failure clears the trap and leaves API stopped; this flag
# covers the path where the process dies before that code runs.
_RESTORE_SWAP_UNSAFE=0
_RESTORE_PRE_BACKUP=""

# EXIT trap for restore_backup: restart API only when live DB is still safe.
_restore_api_exit_trap() {
  if [ "${_RESTORE_SWAP_UNSAFE:-0}" -eq 1 ]; then
    echo "⚠ restore aborted during destructive swap — API left STOPPED" >&2
    echo "  live database may be PARTIALLY restored — do NOT start api until recovery is confirmed" >&2
    if [ -n "${_RESTORE_PRE_BACKUP:-}" ]; then
      echo "  recover: tokenpanel restore \"${_RESTORE_PRE_BACKUP}\"" >&2
    fi
    return 0
  fi
  docker compose -f "$APP_YML" start api >/dev/null 2>&1 \
    && echo "⚠ api restarted after aborted restore" \
    || true
}

# Restore archive into a temp DB, verify it, then swap it into place of the
# live DB via per-collection renameCollection. The LIVE database is never
# touched until the temp DB is fully populated and verified. On any failure
# before the swap the live DB is left intact and the temp DB is cleaned up.
# If the swap itself fails partway, the temp DB is preserved for recovery.
#
# Exit codes: 0 = success (live DB replaced); 1 = failed before swap (live DB
# untouched, temp DB cleaned up); 2 = swap failed partway (live DB may be
# PARTIALLY restored, temp DB preserved for recovery).
_restore_into_temp() {
  local backup_file="$1"
  local tmp_db="$2"
  local real_db="$3"
  local admin_uri="$4"

  # Clean any leftover temp DB from a prior aborted restore.
  step "restore" "preparing temp database (${tmp_db})..."
  _drop_temp_db "$tmp_db" "$admin_uri"

  # Restore archive into the temp DB, renaming real.* namespaces -> tmp.*.
  step "restore" "restoring archive into temp database (live DB untouched)..."
  if ! docker compose -f "$APP_YML" exec -T mongo mongorestore \
      --uri="$admin_uri" \
      --archive=/dev/stdin --gzip --quiet \
      --nsFrom="${real_db}.*" --nsTo="${tmp_db}.*" \
      < "$backup_file" 2>/dev/null; then
    err "restore into temp database failed — live DB untouched"
    _drop_temp_db "$tmp_db" "$admin_uri"
    return 1
  fi

  # Verify the temp DB actually received collections.
  local coll_count
  coll_count="$(docker compose -f "$APP_YML" exec -T mongo mongosh "$admin_uri" \
    --quiet --eval "db.getSiblingDB('${tmp_db}').getCollectionNames().length" 2>/dev/null || true)"
  coll_count="${coll_count//[^0-9]/}"
  coll_count="${coll_count:-0}"
  if [ "$coll_count" -lt 1 ]; then
    err "temp database is empty after restore — archive incompatible or empty (live DB untouched)"
    _drop_temp_db "$tmp_db" "$admin_uri"
    return 1
  fi
  ok "temp database verified: ${coll_count} collections"

  # Swap: drop live DB, rename each temp collection into the live DB.
  # On partial failure the temp DB is PRESERVED (not dropped) so the operator
  # can retry the swap or recover from the pre-restore backup.
  #
  # Mark unsafe BEFORE drop/rename so an EXIT trap (SIGINT/SIGTERM/etc.) never
  # restarts the API while live DB may be mid-swap. Cleared only on full
  # success; left set on failure so unexpected termination also keeps API down.
  step "restore" "swapping temp database -> live (drop + rename)..."
  _RESTORE_SWAP_UNSAFE=1
  if ! docker compose -f "$APP_YML" exec -T mongo mongosh "$admin_uri" --quiet --eval '
    var tmp = "'"$tmp_db"'", real = "'"$real_db"'";
    var dropRes = db.getSiblingDB(real).dropDatabase();
    if (!dropRes.ok) { print("DROP_FAIL " + JSON.stringify(dropRes)); quit(2); }
    var colls = db.getSiblingDB(tmp).getCollectionNames();
    var moved = 0, fail = 0;
    for (var i = 0; i < colls.length; i++) {
      var c = colls[i];
      var r = db.adminCommand({ renameCollection: tmp + "." + c, to: real + "." + c });
      if (r.ok) { moved++; } else { print("RENAME_FAIL " + c + ": " + JSON.stringify(r)); fail++; }
    }
    if (fail === 0) {
      db.getSiblingDB(tmp).dropDatabase();
      print("SWAP_OK " + moved);
    } else {
      print("SWAP_PARTIAL moved=" + moved + " failed=" + fail + " tmpdb=" + tmp);
      quit(1);
    }
  ' 2>/dev/null; then
    err "swap failed — live database may be partially restored"
    err "do NOT resume normal traffic until you recover"
    # leave _RESTORE_SWAP_UNSAFE=1
    return 2
  fi
  _RESTORE_SWAP_UNSAFE=0
  ok "swap complete: ${coll_count} collections restored to ${real_db}"
  return 0
}

restore_backup() {
  local backup_file="$1"
  [ -n "$backup_file" ] || { err "usage: tokenpanel restore <backup-file>"; return 1; }
  [ -f "$backup_file" ] || { err "backup not found: $backup_file"; return 1; }
  # Resolve to an absolute path: stable regardless of the operator's CWD, and
  # matchable against the absolute paths apply_retention enumerates with ls -t.
  backup_file="$(cd "$(dirname "$backup_file")" && pwd)/$(basename "$backup_file")"

  # Hold manager lock for the entire restore (incl. confirm + pre-restore dump +
  # swap). Re-entrant create_backup inside will not self-deadlock.
  acquire_manager_lock "restore" || return 1

  local admin_uri="mongodb://${MONGO_USER_URI}:${MONGO_PASS_URI}@localhost:27017/admin?authSource=admin&directConnection=true"
  local real_db="$MONGODB_DB"
  local tmp_db="${real_db}__restore_tmp"

  echo
  warn "RESTORE will OVERWRITE the current database."
  warn "All data created after this backup will be LOST."
  local size
  size="$(($(stat -c %s "$backup_file" 2>/dev/null || stat -f %z "$backup_file") / 1048576))"
  warn "Backup: $backup_file (${size}MB)"
  echo
  tp_read_required confirm "Type the current domain name to confirm restore: " || return 1
  [ "$confirm" = "$DOMAIN" ] || { err "confirmation failed — domain mismatch"; return 1; }

  # 1. Verify archive integrity BEFORE touching the live DB.
  step "restore" "verifying archive integrity..."
  if ! docker compose -f "$APP_YML" exec -T mongo mongorestore \
      --uri="$admin_uri" \
      --archive=/dev/stdin --gzip --dryRun --quiet < "$backup_file" 2>/dev/null; then
    err "archive verification failed — refusing to restore (DB untouched)"
    return 1
  fi
  ok "archive verified"

  # 2. Mandatory pre-restore backup of the current live state.
  #    Protect the restore target from retention pruning: create_backup runs
  #    apply_retention, which could otherwise delete the very archive we are
  #    about to restore if it is old and lives in the same backup directory.
  #    Capture create_backup stdout (path) — do not re-discover via glob.
  step "restore" "creating pre-restore backup of current database..."
  BACKUP_PROTECT="$backup_file"
  local pre_restore_file
  if ! pre_restore_file="$(create_backup "pre-restore")"; then
    err "pre-restore backup failed — aborting (DB untouched)"
    return 1
  fi
  if [ -z "$pre_restore_file" ] || [ ! -f "$pre_restore_file" ]; then
    err "pre-restore backup file not found after creation — aborting (DB untouched)"
    return 1
  fi
  ok "pre-restore backup: $(basename "$pre_restore_file")"

  # 3. Stop the API for the swap window. EXIT trap restarts the API on
  #    unexpected abort ONLY while live DB is still safe (before swap, or after
  #    a clean full swap). Once drop/rename starts, _RESTORE_SWAP_UNSAFE=1 and
  #    the trap leaves the API STOPPED — same policy as explicit rc==2.
  _RESTORE_SWAP_UNSAFE=0
  _RESTORE_PRE_BACKUP="$pre_restore_file"
  trap '_restore_api_exit_trap' EXIT

  step "restore" "stopping api..."
  docker compose -f "$APP_YML" stop api

  # 4. Restore into a temp DB, verify, then swap into place. The live DB is
  #    not modified until the temp DB is proven good.
  local rc=0
  _restore_into_temp "$backup_file" "$tmp_db" "$real_db" "$admin_uri" || rc=$?

  # 5. Clear the EXIT trap. On success / safe failure we restart the API below;
  #    on a partial-swap failure (rc == 2) we deliberately leave the API
  #    STOPPED so no traffic hits a partially-restored database.
  trap - EXIT
  _RESTORE_PRE_BACKUP=""

  # _restore_into_temp exit codes: 0 = success; 1 = failed before swap (live
  # DB untouched); 2 = swap failed partway (live DB may be PARTIALLY restored).
  if [ "$rc" -eq 2 ]; then
    err "restore failed — live database may be PARTIALLY restored"
    err "the API has been left STOPPED — do NOT start it until recovery is confirmed"
    err "recover immediately: tokenpanel restore \"$pre_restore_file\""
    err "(the swap dropped the old DB and moved some collections into place;"
    err " do NOT resume normal traffic until recovery is confirmed)"
    return 1
  fi

  # rc == 0 (success) or rc == 1 (failed before swap, live DB untouched): the
  # live database is intact, so it is safe to resume serving traffic.
  step "restore" "restarting api..."
  if ! docker compose -f "$APP_YML" start api; then
    err "failed to restart api — start it manually: tokenpanel start"
    return 1
  fi
  if declare -F wait_for_health >/dev/null 2>&1; then
    if ! wait_for_health api 60 "/ready" 1; then
      err "api started but not ready after restore — check: tokenpanel logs api"
      return 1
    fi
  fi

  if [ "$rc" -eq 1 ]; then
    err "restore failed — live database was NOT modified (data intact)"
    err "pre-restore backup retained for safety: $(basename "$pre_restore_file")"
    err "to undo / recover: tokenpanel restore \"$pre_restore_file\""
    return 1
  fi

  # rc == 0: restore replaced the live DB with the backup's data. If the
  # running image is newer than the backup (e.g. operator restored a
  # pre-update backup onto newer code per the Phase-6 failure-recovery docs
  # in `tokenpanel update`), the restored schema may lag the code — run
  # post/ migrations to catch up. Idempotent via `_migrations` (already-applied
  # ids are skipped). This mirrors cmd_start / cmd_rebuild / cmd_setup, which
  # all run post after the api is healthy.
  if ! declare -F run_migrations >/dev/null 2>&1; then
    source "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/migrate.sh"
  fi
  step "restore" "applying pending post-restore migrations..."
  if ! run_migrations "post"; then
    err "post-migration failed after restore"
    err "the restore itself SUCCEEDED and the api is running, but some"
    err "destructive migrations did not apply — schema may lag the code."
    err "retry manually: tokenpanel migrate post"
    return 1
  fi

  ok "restore complete: $backup_file"
  info "pre-restore backup retained: $(basename "$pre_restore_file")"
}
