# OLKIL auto-update (Cursor-style)

Installed apps poll **https://updates.olkil.com** every ~15 minutes (and on focus).
When you publish a new build, users get an in-app update — no re-download from olkil.com.

**How it works:** Hostinger serves `latest.yml` (tiny). Installer binaries download from **GitHub Releases**.

## Ship an update

```bash
cd ide-electron

# 1) bump version
node scripts/bump-and-tag.js 1.3.7
# with push → triggers GitHub Actions on tag:
# node scripts/bump-and-tag.js 1.3.7 --push

# 2) build installer + latest.yml
yarn stage-ollama          # optional
yarn pack:publish

# 3) stage feeds + upload binaries to GitHub (needs GH_TOKEN)
set GH_TOKEN=ghp_xxx
node scripts/publish-update.js

# 4) zip + deploy Hostinger light feed (yml only)
node scripts/zip-updates-feed.js
# Deploy the zip to Hostinger domain: updates.olkil.com
```

## Important

- Git push of source code alone does **not** update users. You must **build + publish** (or push a `v*` tag for CI).
- Users on builds **before** the updater was added need **one** manual install of an updater-enabled build; after that updates are automatic.
- Live feed: https://updates.olkil.com/latest.yml

## Env

See `.env.example` (`OLKIL_UPDATE_URL`, `GH_TOKEN`, `OLKIL_GH_OWNER`, `OLKIL_GH_REPO`).
