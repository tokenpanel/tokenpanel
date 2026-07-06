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
    config.sh            # path resolution + env loading
    output.sh            # colored output helpers
    preflight.sh         # disk / docker / mongo checks
    health.sh            # health-check polling
    backup.sh            # mongodump wrapper (tokenpanel-wuv)
    migrate.sh           # migration runner wrapper
    build.sh             # docker build on host (shared by setup/update/rebuild)
    rollback.sh          # container swap + rollback (tokenpanel-db3)
  templates/
    app.yml.tmpl         # compose template (envsubst)
    env.tmpl             # .env template
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
tokenpanel start        # preflight + up + health check
tokenpanel stop         # stop all services
tokenpanel restart      # stop + start
tokenpanel update       # 6-phase safe update (tokenpanel-db3)
tokenpanel backup       # mongodump with space check (tokenpanel-wuv)
tokenpanel restore <f>  # restore from backup
tokenpanel migrate      # run pending migrations
tokenpanel logs [-f]    # tail container logs
tokenpanel enter [svc]  # exec shell into container
tokenpanel doctor       # diagnostics
tokenpanel rebuild      # rebuild current checkout + force-recreate (keeps data)
tokenpanel destroy      # remove containers (keeps data)
tokenpanel reset        # WIPE everything (strong confirm)
tokenpanel version      # manager + app versions
```
