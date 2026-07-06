#!/usr/bin/env bash
# Prompt helpers that work when scripts are launched through `curl | bash`.
# In that mode stdin is the installer pipe, so interactive reads must use the
# controlling terminal instead of fd 0.

tp_have_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

tp_prompt_err() {
  if declare -F err >/dev/null 2>&1; then
    err "$*"
  else
    printf 'ERROR: %s\n' "$*" >&2
  fi
}

tp_require_tty() {
  local context="${1:-this command needs an interactive terminal}"
  if tp_have_tty || [ -t 0 ]; then
    return 0
  fi
  tp_prompt_err "$context"
  tp_prompt_err "run it from an interactive shell, for example: sudo tokenpanel-setup"
  return 1
}

tp_read() {
  local __var="$1"
  local prompt="${2:-}"
  local secret="${3:-n}"
  local rc=0

  if tp_have_tty; then
    printf '%s' "$prompt" > /dev/tty
    if [ "$secret" = "secret" ]; then
      IFS= read -r -s "$__var" < /dev/tty || rc=$?
      printf '\n' > /dev/tty
    else
      IFS= read -r "$__var" < /dev/tty || rc=$?
    fi
  elif [ -t 0 ]; then
    if [ "$secret" = "secret" ]; then
      IFS= read -r -s -p "$prompt" "$__var" || rc=$?
      printf '\n' >&2
    else
      IFS= read -r -p "$prompt" "$__var" || rc=$?
    fi
  else
    tp_prompt_err "interactive input unavailable for prompt: $prompt"
    return 1
  fi

  return "$rc"
}

tp_read_required() {
  local __var="$1"
  local prompt="$2"
  tp_read "$__var" "$prompt" || {
    tp_prompt_err "input aborted"
    return 1
  }
}

tp_read_secret() {
  local __var="$1"
  local prompt="$2"
  tp_read "$__var" "$prompt" secret || {
    tp_prompt_err "input aborted"
    return 1
  }
}
