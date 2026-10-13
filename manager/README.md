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
    release.sh           # release tags, deployed version, update direction
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

The installer is the only supported way to install TokenPanel, and
`tokenpanel update` the only supported way to update it. Do not clone the
repository, `git pull`, or run `docker compose` against it by hand: those skip
the release checkout, backups, pre/post migrations, health-gated swap, and
rollback that the manager performs.

## Commands

```bash
tokenpanel status       # container state, version, disk usage
tokenpanel start        # preflight + up + health + post migrations
tokenpanel stop         # stop all services
tokenpanel restart      # stop + start
tokenpanel update       # latest stable release: build → config render → pre → backup → post → swap
tokenpanel update vX.Y.Z  # a specific release or prerelease (downgrades refused)
tokenpanel config       # operator config management (status|render|check|migrate)
tokenpanel backup       # write-quiet mongodump (stops api briefly for consistent snapshot)
tokenpanel restore <f>  # restore from backup
tokenpanel migrate      # run pending migrations (default phase: pre)
tokenpanel logs [-f]    # tail container logs
tokenpanel enter [svc]  # exec shell into container
tokenpanel doctor       # diagnostics
tokenpanel rebuild      # rebuild the deployed version (refuses a different checkout; --force)
tokenpanel destroy      # remove containers (keeps data)
tokenpanel reset        # WIPE everything (strong confirm)
tokenpanel version      # manager + app versions
```

## Releases

Releases are `vX.Y.Z` git tags on `main`; each has a GitHub Release with
generated notes. `tokenpanel update` installs the highest stable tag, does
nothing when that release (or a newer build) is already deployed, and refuses
explicit downgrades. Before the first release it follows `origin/main`. The
installed version comes from the deployed image, so `tokenpanel version`
stays correct after a failed update or rollback. Older depth-1 install
checkouts are converted to full history on the first update.

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
