#!/usr/bin/env bash
# Release channel helpers. Sourced by build.sh and install.sh, so it depends on
# git (and docker for the deployed_* helpers) only, never on other manager libs.
#
# A release is a `vMAJOR.MINOR.PATCH[-PRERELEASE]` git tag. The stable channel
# (`tokenpanel update` with no version) is the highest `vX.Y.Z` tag without a
# prerelease suffix that is reachable from origin/main. The GitHub Release with
# notes is published from the same tag by .github/workflows/release.yml.
#
# Compatibility: managers released before this file existed resolve "latest"
# as origin/main and run that checkout's manager with no target. The update
# command therefore re-resolves the stable tag when it is bootstrapped without
# a target (see cmd_update), so the manager at the tip of main must keep
# accepting that call.

TP_STABLE_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
TP_RELEASE_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
TP_IMAGE_REVISION_LABEL="org.opencontainers.image.revision"
TP_IMAGE_VERSION_LABEL="org.opencontainers.image.version"

# Full commit SHA for a ref, or nothing (status 1) when it does not resolve.
tp_commit_of() {
  local dir="$1" ref="$2"
  [ -n "$ref" ] || return 1
  git -C "$dir" rev-parse --verify -q "${ref}^{commit}" 2>/dev/null
}

tp_is_shallow_checkout() {
  local dir="$1" shallow
  shallow="$(git -C "$dir" rev-parse --git-path shallow 2>/dev/null)" || return 1
  case "$shallow" in /*) ;; *) shallow="${dir}/${shallow}" ;; esac
  [ -f "$shallow" ]
}

# Fetch branches and release tags. Tags are force-updated and pruned so a
# re-pointed or deleted (yanked) release tag cannot wedge every later update
# with "would clobber existing tag". Installs made by the old installer are
# depth-1 clones; ancestry checks need full history, so convert them once
# (the repository is small).
tp_fetch_release_refs() {
  local dir="$1"
  local -a args=(fetch --tags --force --prune --prune-tags origin)
  if tp_is_shallow_checkout "$dir"; then
    args=(fetch --unshallow --tags --force --prune --prune-tags origin)
  fi
  git -C "$dir" "${args[@]}"
}

# Highest stable release tag reachable from $2 (default origin/main). Prints
# nothing when there is none, which callers treat as "no releases yet".
latest_stable_tag() {
  local dir="$1" base="${2:-origin/main}"
  local check_base=1
  tp_commit_of "$dir" "$base" >/dev/null || check_base=0

  local tag
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    if [ "$check_base" -eq 0 ] \
      || git -C "$dir" merge-base --is-ancestor "${tag}^{commit}" "$base" 2>/dev/null; then
      printf '%s\n' "$tag"
      return 0
    fi
  done < <(
    git -C "$dir" tag -l 'v*' 2>/dev/null \
      | grep -E "$TP_STABLE_TAG_RE" \
      | sed 's/^v//' \
      | sort -t. -k1,1nr -k2,2nr -k3,3nr \
      | sed 's/^/v/'
  )
  return 0
}

tp_is_release_tag() {
  [[ "${1:-}" =~ $TP_RELEASE_TAG_RE ]]
}

# Image the api service runs (falls back to tokenpanel/app:current, which
# Compose starts). After a failed update or rollback this is the old image,
# while the checkout may already point at the target, so the deployed version
# must come from here rather than from `git describe` of the checkout.
deployed_image_id() {
  local id=""
  if [ -n "${APP_YML:-}" ] && [ -f "${APP_YML}" ]; then
    id="$(docker compose -f "$APP_YML" images api --format '{{.ID}}' 2>/dev/null | head -1 || true)"
  fi
  if [ -z "$id" ]; then
    id="$(docker image inspect --format '{{.Id}}' tokenpanel/app:current 2>/dev/null || true)"
  fi
  printf '%s\n' "$id"
}

tp_image_label() {
  local image="$1" label="$2" value
  value="$(docker image inspect --format "{{ index .Config.Labels \"${label}\" }}" "$image" 2>/dev/null || true)"
  case "$value" in "<no value>") value="" ;; esac
  printf '%s\n' "$value"
}

# Full commit SHA the deployed image was built from; empty when unknown.
# Images built by this manager carry an OCI revision label. Older images only
# have the tag the build gave them: `git describe --tags --always` output such
# as `b831b42`, `v0.1.0` or `v0.1.0-3-gabc1234`.
deployed_revision() {
  local dir="$1" image rev tag candidate
  image="$(deployed_image_id)"
  [ -n "$image" ] || return 0

  rev="$(tp_image_label "$image" "$TP_IMAGE_REVISION_LABEL")"
  if [ -n "$rev" ]; then
    tp_commit_of "$dir" "$rev" || printf '%s\n' "$rev"
    return 0
  fi

  while IFS= read -r tag; do
    tag="${tag##*:}"
    case "$tag" in '' | current | previous | latest) continue ;; esac
    candidate="$tag"
    if [[ "$tag" =~ -g([0-9a-f]{7,40})$ ]]; then
      candidate="${BASH_REMATCH[1]}"
    fi
    if rev="$(tp_commit_of "$dir" "$candidate")"; then
      printf '%s\n' "$rev"
      return 0
    fi
  done < <(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$image" 2>/dev/null || true)
  return 0
}

# Human-readable version of a commit: `v0.2.0`, `v0.2.0-3-gabc1234`, or a
# short SHA before the first release. Prints `unknown` without a commit.
tp_describe_commit() {
  local dir="$1" rev="$2"
  if [ -z "$rev" ]; then
    printf 'unknown\n'
    return 0
  fi
  git -C "$dir" describe --tags --always "$rev" 2>/dev/null || printf '%s\n' "${rev:0:12}"
}

# How the target ref relates to the deployed commit:
#   same       target is the deployed commit
#   upgrade    deployed commit is an ancestor of the target
#   downgrade  target is an ancestor of the deployed commit
#   diverged   neither contains the other
#   unknown    deployed commit or target is not known locally
tp_update_relation() {
  local dir="$1" target_ref="$2" deployed="$3" target
  if [ -z "$deployed" ] || ! deployed="$(tp_commit_of "$dir" "$deployed")"; then
    printf 'unknown\n'
    return 0
  fi
  if ! target="$(tp_commit_of "$dir" "$target_ref")"; then
    printf 'unknown\n'
    return 0
  fi
  if [ "$target" = "$deployed" ]; then
    printf 'same\n'
  elif git -C "$dir" merge-base --is-ancestor "$deployed" "$target" 2>/dev/null; then
    printf 'upgrade\n'
  elif git -C "$dir" merge-base --is-ancestor "$target" "$deployed" 2>/dev/null; then
    printf 'downgrade\n'
  else
    printf 'diverged\n'
  fi
}

# Deployed commit when the checkout is on a different commit; prints nothing
# when they match or the deployed commit is unknown.
tp_checkout_drift() {
  local dir="$1" deployed head
  deployed="$(deployed_revision "$dir")"
  [ -n "$deployed" ] || return 0
  head="$(tp_commit_of "$dir" HEAD || true)"
  [ "$head" = "$deployed" ] || printf '%s\n' "$deployed"
}

# GitHub Release page for a tag when origin is a GitHub repository.
tp_release_notes_url() {
  local dir="$1" tag="$2" url path
  tp_is_release_tag "$tag" || return 0
  url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  case "$url" in
    https://github.com/*) path="${url#https://github.com/}" ;;
    git@github.com:*) path="${url#git@github.com:}" ;;
    ssh://git@github.com/*) path="${url#ssh://git@github.com/}" ;;
    *) return 0 ;;
  esac
  path="${path%.git}"
  path="${path%/}"
  printf 'https://github.com/%s/releases/tag/%s\n' "$path" "$tag"
}
