Deploy changed files to hsb1. Full procedure and rationale: `docs/DEPLOY.md`. Follow this:

0. Reach hsb1 as `mba@hsb1`, or `mba@192.168.1.101` when `hsb1` does not resolve on the Mac.
   Run `date` first; record what you deploy on the PIXD ticket.
1. Check what changed: `git diff --name-only <last deployed commit>..HEAD` and `git status`.
2. Categorize each changed file:
   - `scenes/*.js` → scene deploy (scp to mount, hot-reloads)
   - `config.json` → config deploy (**pull-before-push**, hot-reloads)
   - `src/`, `lib/`, `package.json`, `Dockerfile`, `version.json` → a release (new pinned image, step 6)
3. **Backup first** (outside the mount), for any deploy. hsb1's login shell is fish, so run bash explicitly:
   ```bash
   ssh mba@hsb1 'bash -s' <<'EOS'
   B=~/backups/pixdcon/$(date +%Y%m%d-%H%M%S); mkdir -p "$B"
   cp -a ~/docker/mounts/pixdcon/scenes "$B/scenes"; cp -a ~/docker/mounts/pixdcon/config.json "$B/"; echo "$B"
   EOS
   ```
   Before copying scenes, check the live files still match the last deployed commit (`md5sum` vs `git show <commit>:<file> | md5`); drift → stop and ask.
4. **Scene files** (hot-reload, no restart):
   ```bash
   scp scenes/pixoo/<name>.js mba@hsb1:~/docker/mounts/pixdcon/scenes/pixoo/
   scp scenes/ulanzi/<name>.js mba@hsb1:~/docker/mounts/pixdcon/scenes/ulanzi/
   ```
5. **config.json** — never copy the repo's `config.json` (a gitignored dev sample). The live file has UI-saved settings:
   ```bash
   scp mba@hsb1:~/docker/mounts/pixdcon/config.json /tmp/config.live.json   # pull
   $EDITOR /tmp/config.live.json                                             # edit
   scp /tmp/config.live.json mba@hsb1:~/docker/mounts/pixdcon/config.json    # push
   ```
6. **Image deploy = a release** (hsb1 runs a pinned `<version>@sha256` image; pulling `latest` changes nothing):
   reserve a new `version.json` coordinate in the PR → merge → tag `v<version>` → release workflow →
   digest via `docker buildx imagetools inspect` → **OPS** opens the nixcfg pin PR → **Markus's go** →
   hsb1 switch (also recreates `hsb1-home`) → copy changed scenes. Full steps: `docs/DEPLOY.md` § 3.
   - **Never** `sudo systemctl restart compose-hsb1.service` on your own; the switch is OPS's, with Markus's go.
   - The old `cd ~/docker && docker compose …` no longer works (no compose file there since OPS-116).
7. Verify (never `docker inspect` — it prints the resolved environment):
   - `curl -s http://192.168.1.101:8080/api/status | jq '{version, version_scheme, mqttConnected, deviceHealth}'`
   - `ssh mba@hsb1 "docker logs pixdcon --since 2m 2>&1 | grep -E ' WARN | ERROR |Loaded scene|Running'"`
   - live frame: `node scripts/preview-to-png.js --host 192.168.1.101:8080 --device pixoo-159 --out /tmp/frame.png --scale 8`
8. Report what was deployed, the backup path, the rollback point and any log warnings.

## Mount layout on hsb1

All user data at `~/docker/mounts/pixdcon/`:
- `config.json` → `/data/config.json` (rw, single-file bind mount)
- `scenes/` → `/data/scenes/` (rw) — ulanzi/ and pixoo/ subdirs
- `generated-scenes/` → `/data/generated-scenes/` (rw) — Clone & Detach writes `<type>/<key>.js`

Scene paths in config are relative: `./scenes/ulanzi/clock.js` → `/data/scenes/ulanzi/clock.js`
