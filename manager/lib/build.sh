#!/usr/bin/env bash
# Build on host — docker build + tags.
# Shared by setup, rebuild, and the 6-phase update flow.

CURRENT_IMAGE_ID=""
NEW_IMAGE_TAG=""

docker_tag_safe() {
  local raw="$1"
  local safe
  safe="$(printf '%s' "$raw" | tr -c 'A-Za-z0-9_.-' '-')"
  safe="${safe:0:120}"
  [ -n "$safe" ] || safe="dev-$(date +%s)"
  [[ "$safe" =~ ^[A-Za-z0-9_] ]] || safe="v${safe}"
  printf '%s\n' "$safe"
}

current_checkout_tag() {
  local raw
  raw="$(git -C "$INSTALL_DIR" describe --tags --always 2>/dev/null || echo "dev-$(date +%s)")"
  docker_tag_safe "$raw"
}

docker_build_prod() {
  if [ "$#" -lt 1 ]; then
    err "docker_build_prod: at least one image tag is required"
    return 1
  fi

  local -a args
  args=(--progress=plain -f "$INSTALL_DIR/docker/prod.Dockerfile")

  local tag
  for tag in "$@"; do
    args+=(-t "$tag")
  done
  args+=("$INSTALL_DIR")

  # Fail immediately on compile/config errors — do not blind-retry full builds.
  # Transient registry failures should be retried by the operator or CI with
  # classified network policy, not an unconditional second full docker build.
  docker build "${args[@]}"
}

build_current_checkout_image() {
  local new_version_tag
  new_version_tag="$(current_checkout_tag)"
  info "building image: tokenpanel/app:${new_version_tag}..."

  # `current` is the image Compose starts. Do not move it while an update is
  # still in its pre-migration phase: a failed pre migration must leave both
  # the running service and a later `tokenpanel start` on the old image.
  docker_build_prod "tokenpanel/app:${new_version_tag}" || {
    err "docker build failed"
    return 1
  }

  NEW_IMAGE_TAG="$new_version_tag"
  export NEW_IMAGE_TAG
  ok "image built: tokenpanel/app:${new_version_tag}"
}

promote_new_image_current() {
  if [ -z "${NEW_IMAGE_TAG:-}" ]; then
    err "cannot promote image: NEW_IMAGE_TAG is empty"
    return 1
  fi
  if ! docker image inspect "tokenpanel/app:${NEW_IMAGE_TAG}" >/dev/null 2>&1; then
    err "cannot promote image: tokenpanel/app:${NEW_IMAGE_TAG} is missing"
    return 1
  fi

  docker tag "tokenpanel/app:${NEW_IMAGE_TAG}" tokenpanel/app:current || {
    err "could not promote tokenpanel/app:${NEW_IMAGE_TAG} to current"
    return 1
  }
  ok "promoted tokenpanel/app:${NEW_IMAGE_TAG} to current"
}

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
    if ! git_err="$(git -C "$INSTALL_DIR" checkout --detach "$target_version" 2>&1)"; then
      err "git checkout '$target_version' failed — aborting update (nothing changed):"
      printf '%s\n' "$git_err" >&2
      return 1
    fi
  else
    # A prior version-targeted update intentionally leaves HEAD detached. A
    # regular `git pull` then fails, so always build the fetched stable ref.
    info "checking out latest main (stable channel)..."
    if ! git_err="$(git -C "$INSTALL_DIR" checkout --detach origin/main 2>&1)"; then
      err "git checkout origin/main failed — aborting update (nothing changed):"
      printf '%s\n' "$git_err" >&2
      return 1
    fi
  fi

  build_current_checkout_image || return 1

  # Tag old image as :previous for rollback
  if [ -n "$CURRENT_IMAGE_ID" ]; then
    docker tag "$CURRENT_IMAGE_ID" tokenpanel/app:previous 2>/dev/null || true
    info "tagged old image as tokenpanel/app:previous"
  fi
}

cleanup_old_images() {
  info "pruning old images..."
  docker image prune -f 2>/dev/null || true
}
