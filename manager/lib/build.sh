#!/usr/bin/env bash
# Build on host — docker build + tags.
# Shared by setup, rebuild, and the 6-phase update flow.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release.sh"

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

  # Record the source commit in the image. The update gate and `status` read
  # it to know what is deployed, even after a failed update or a rollback left
  # the checkout on another commit.
  local revision version
  revision="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$revision" ]; then
    version="$(tp_describe_commit "$INSTALL_DIR" "$revision")"
    args+=(--label "${TP_IMAGE_REVISION_LABEL}=${revision}")
    args+=(--label "${TP_IMAGE_VERSION_LABEL}=${version}")
  fi
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

# `rebuild` and `tokenpanel-setup` build the checkout as it is. Refuse when that
# would change the deployed version: versions change only through
# `tokenpanel update`, which adds backup, ordered migrations, and rollback.
require_checkout_matches_deployed() {
  local cmd="$1" force="${2:-0}" deployed head
  deployed="$(tp_checkout_drift "$INSTALL_DIR")"
  [ -n "$deployed" ] || return 0
  head="$(tp_commit_of "$INSTALL_DIR" HEAD || true)"

  local have want
  have="$(tp_describe_commit "$INSTALL_DIR" "$head")"
  want="$(tp_describe_commit "$INSTALL_DIR" "$deployed")"
  if [ "$force" = "1" ]; then
    warn "--force: building checkout $have although $want is deployed"
    return 0
  fi
  err "$cmd would deploy checkout $have, but $want is deployed"
  err "change versions with: tokenpanel update [version]"
  err "to build the checkout anyway: $cmd --force"
  return 1
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

fetch_update_refs() {
  # Abort on fetch failure instead of building stale code. `local` is declared
  # on its own line so its (always-zero) exit status does not mask the command
  # substitution evaluated in the `if` condition.
  local git_err
  info "fetching releases..."
  if tp_is_shallow_checkout "$INSTALL_DIR"; then
    info "converting shallow install checkout to full history (one-time)..."
  fi
  if ! git_err="$(tp_fetch_release_refs "$INSTALL_DIR" 2>&1)"; then
    err "git fetch failed — aborting update (nothing changed):"
    printf '%s\n' "$git_err" >&2
    return 1
  fi
}

checkout_update_ref() {
  local ref="$1" git_err
  if ! git_err="$(git -C "$INSTALL_DIR" checkout --detach "$ref" 2>&1)"; then
    err "git checkout '$ref' failed — aborting update (nothing changed):"
    printf '%s\n' "$git_err" >&2
    return 1
  fi
}

# Resolve the update ref: the requested version, else the latest stable
# release tag, else origin/main while no release exists yet. HEAD is always
# detached so a later update never depends on a local branch.
checkout_update_target() {
  local target_version="${1:-}"
  fetch_update_refs || return 1

  local ref="$target_version"
  if [ -z "$ref" ]; then
    ref="$(latest_stable_tag "$INSTALL_DIR")"
    if [ -z "$ref" ]; then
      info "no stable release yet — checking out origin/main"
      ref="origin/main"
    fi
  fi
  info "target: $ref"
  checkout_update_ref "$ref"
}

build_update_image() {
  CURRENT_IMAGE_ID="$(docker compose -f "$APP_YML" images api --format '{{.ID}}' 2>/dev/null | head -1)"
  if [ -z "$CURRENT_IMAGE_ID" ]; then
    CURRENT_IMAGE_ID="$(docker image inspect --format '{{.Id}}' tokenpanel/app:current 2>/dev/null || true)"
  fi
  export CURRENT_IMAGE_ID

  build_current_checkout_image || return 1

  # Tag old image as :previous for rollback
  if [ -n "$CURRENT_IMAGE_ID" ]; then
    docker tag "$CURRENT_IMAGE_ID" tokenpanel/app:previous 2>/dev/null || true
    info "tagged old image as tokenpanel/app:previous"
  fi
}

# Kept as a compatibility wrapper for callers outside the main CLI. The update
# command itself checks out the target and re-runs its manager before backup,
# then calls build_update_image from that refreshed process.
fetch_and_build() {
  checkout_update_target "${1:-}" || return 1
  build_update_image
}

cleanup_old_images() {
  info "pruning old images..."
  docker image prune -f 2>/dev/null || true
}
