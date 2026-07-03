#!/usr/bin/env bash
# Build on host — git pull + docker build + tag.
# Used by the 6-phase update flow.

CURRENT_IMAGE_ID=""
NEW_IMAGE_TAG=""

fetch_and_build() {
  local target_version="${1:-}"

  # Save current image ID for potential rollback
  CURRENT_IMAGE_ID="$(docker compose -f "$APP_YML" images api --format '{{.ID}}' 2>/dev/null | head -1)"
  export CURRENT_IMAGE_ID

  # Fetch latest refs — abort on failure instead of swallowing git errors.
  # The old `|| true` let a broken fetch silently proceed to a build of stale
  # code, which is worse than failing the update. `local` is declared on its
  # own line so its (always-zero) exit status does not mask the command
  # substitution evaluated in the `if` conditions below.
  local git_err
  info "fetching latest code..."
  if ! git_err="$(git -C "$INSTALL_DIR" fetch --tags --prune origin 2>&1)"; then
    err "git fetch failed — aborting update (nothing changed):"
    printf '%s\n' "$git_err" >&2
    return 1
  fi

  if [ -n "$target_version" ]; then
    info "target: $target_version"
    if ! git_err="$(git -C "$INSTALL_DIR" checkout "$target_version" 2>&1)"; then
      err "git checkout '$target_version' failed — aborting update (nothing changed):"
      printf '%s\n' "$git_err" >&2
      return 1
    fi
  else
    info "pulling latest stable..."
    if ! git_err="$(git -C "$INSTALL_DIR" pull origin stable 2>&1)"; then
      info "stable branch not found, trying main..."
      if ! git_err="$(git -C "$INSTALL_DIR" pull origin main 2>&1)"; then
        err "git pull failed — aborting update (nothing changed):"
        printf '%s\n' "$git_err" >&2
        return 1
      fi
    fi
  fi

  local new_version_tag
  new_version_tag="$(git -C "$INSTALL_DIR" describe --tags --always 2>/dev/null || echo "dev-$(date +%s)")"
  info "building image: tokenpanel/app:${new_version_tag}..."

  docker build \
    -f "$INSTALL_DIR/docker/prod.Dockerfile" \
    -t "tokenpanel/app:${new_version_tag}" \
    -t "tokenpanel/app:current" \
    "$INSTALL_DIR" || { err "docker build failed"; return 1; }

  # Tag old image as :previous for rollback
  if [ -n "$CURRENT_IMAGE_ID" ]; then
    docker tag "$CURRENT_IMAGE_ID" tokenpanel/app:previous 2>/dev/null || true
    info "tagged old image as tokenpanel/app:previous"
  fi

  NEW_IMAGE_TAG="$new_version_tag"
  export NEW_IMAGE_TAG
  ok "image built: tokenpanel/app:${new_version_tag}"
}

cleanup_old_images() {
  info "pruning old images..."
  docker image prune -f 2>/dev/null || true
}