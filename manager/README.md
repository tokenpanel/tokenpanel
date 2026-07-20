# TokenPanel Manager

Deployment and update system for TokenPanel — modeled after Discourse's
`discourse_docker` launcher. Bash scripts that wrap `docker compose` with
safety rails: pre-flight checks, backups, health-check-gated swaps, and
auto-rollback.

## Directory layout

```
manager/
  bin/
    tokenpanel           # operator CLI
    tokenpanel-setup     # interactive installer wizard
  lib/
    config.sh            # path resolution + config loading
    config_render.sh     # operator YAML -> generated deployment artifacts
    output.sh            # colored output helpers
    preflight.sh         # disk / docker / mongo checks
    health.sh            # health-check polling
    backup.sh            # mongodump wrapper
    lock.sh              # cross-command flock (update/backup/restore/…)
    migrate.sh           # migration runner wrapper
    build.sh             # docker build on host (shared by setup/update/rebuild)
    rollback.sh          # container swap + rollback + config snapshot restore
  release/
    manifest.json        # generated config/release manifest
    manifest.env         # bash-safe manifest fragment
    defaults.env         # generated defaults
    allowed-env-keys.txt # generated allowlist
  templates/
    app.caddy.yml.tmpl   # compose template with Caddy
    app.direct.yml.tmpl  # compose template without Caddy
    env.tmpl             # legacy .env template
    Caddyfile.tmpl       # Caddy reverse proxy config
    tokenpanel.service   # systemd unit template
  VERSION                # manager version (semver)
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tokenpanel/tokenpanel/main/manager/install.sh | sudo bash
```

## Manual install

```bash
git clone https://github.com/tokenpanel/tokenpanel /opt/tokenpanel
cd /opt/tokenpanel/manager
sudo bin/tokenpanel-setup
```

## Commands

```bash
tokenpanel status       # container state, version, disk usage
tokenpanel start        # preflight + up + health + post migrations
tokenpanel stop         # stop all services
tokenpanel restart      # stop + start
tokenpanel update       # safe update: backup → build → config render → pre → swap → post
tokenpanel config       # operator config management (status|render|check|migrate)
tokenpanel backup       # write-quiet mongodump (stops api briefly for consistent snapshot)
tokenpanel restore <f>  # restore from backup
tokenpanel migrate      # run pending migrations (default phase: pre)
tokenpanel logs [-f]    # tail container logs
tokenpanel enter [svc]  # exec shell into container
tokenpanel doctor       # diagnostics
tokenpanel rebuild      # rebuild image + recreate + post migrations (keeps data)
tokenpanel destroy      # remove containers (keeps data)
tokenpanel reset        # WIPE everything (strong confirm)
tokenpanel version      # manager + app versions
```

## Configuration

The only file operators should edit is:

```bash
/etc/tokenpanel/tokenpanel.yml
```

Generated deployment artifacts are written to:

```bash
/etc/tokenpanel/generated/
```

Do not edit generated files. After changing `tokenpanel.yml`:

```bash
tokenpanel config render
tokenpanel restart
```

`tokenpanel update` renders configuration automatically from the target release.
Rollback restores the previous generated configuration snapshot from
`/etc/tokenpanel/snapshots/`.
