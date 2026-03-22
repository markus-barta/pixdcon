Deploy changed files to hsb1. Follow this procedure:

1. Check what changed: `git diff --name-only HEAD` and `git status`.
2. Categorize each changed file:
   - `scenes/*.js` → scene deploy (scp to mount)
   - `config.json` → config deploy (scp to mount)
   - `src/`, `lib/`, `package.json`, `Dockerfile` → image rebuild required (stop, tell user)
3. For **scene files** (hot-reloads, no restart):
   ```bash
   scp scenes/ulanzi/<name>.js mba@hsb1:~/docker/mounts/pixdcon/scenes/ulanzi/
   scp scenes/pixoo/<name>.js mba@hsb1:~/docker/mounts/pixdcon/scenes/pixoo/
   ```
4. For **config.json** (hot-reloads, no restart):
   ```bash
   scp config.json mba@hsb1:~/docker/mounts/pixdcon/config.json
   ```
5. Verify: `ssh mba@hsb1 "docker logs pixdcon --tail 20"` — look for reload confirmation.
6. Report what was deployed and any log warnings.

If `src/`, `lib/`, `Dockerfile`, or `package.json` changed: commit and push to `main` — GitHub Actions builds and pushes to GHCR automatically. Then pull on hsb1:
```bash
ssh mba@hsb1 "cd ~/docker && docker compose pull pixdcon && docker compose up -d pixdcon"
```
Watch the build: `gh run watch`.

## Mount layout on hsb1

All user data at `~/docker/mounts/pixdcon/`:
- `config.json` → `/data/config.json` (rw)
- `scenes/` → `/data/scenes/` (rw) — ulanzi/ and pixoo/ subdirs
- `generated-scenes/` → `/data/generated-scenes/` (rw)

Scene paths in config are relative: `./scenes/ulanzi/clock.js` → `/data/scenes/ulanzi/clock.js`
