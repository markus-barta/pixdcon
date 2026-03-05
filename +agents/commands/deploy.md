Deploy changed files to hsb1. Follow this procedure:

1. Check what changed: `git diff --name-only HEAD` and `git status`.
2. Categorize each changed file:
   - `scenes/*.js` → scene deploy (scp + touch)
   - `config.json` → config deploy (scp only)
   - `src/`, `lib/`, `package.json`, `Dockerfile` → image rebuild required (stop, tell user)
3. For **scene files**:
   ```bash
   scp scenes/<name>.js mba@hsb1:~/docker/mounts/pidicon-light/scenes/
   ssh mba@hsb1 "touch ~/docker/mounts/pidicon-light/config.json"
   ```
4. For **config.json**:
   ```bash
   scp config.json mba@hsb1:~/docker/mounts/pidicon-light/config.json
   ```
5. Verify: `ssh mba@hsb1 "docker logs pidicon-light --tail 20"` — look for reload confirmation.
6. Report what was deployed and any log warnings.

If `src/`, `lib/`, `Dockerfile`, or `package.json` changed: commit and push to `main` — GitHub Actions (`.github/workflows/build-and-push.yml`) builds and pushes to GHCR automatically. Then pull on hsb1:
```bash
ssh mba@hsb1 "cd ~/docker && docker compose pull pidicon-light && docker compose up -d pidicon-light"
```
Watch the build: `gh run watch`.
