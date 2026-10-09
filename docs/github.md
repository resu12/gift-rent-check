# Gift Rent Check repository

Use **Gift Rent Check** as the project title and **gift-rent-check** as the GitHub repository name. The existing `marketapp-rent` Python package and CLI name are retained so local commands continue to work.

## Contents and private files

The repository contains Python source, React source, Telegram backend modules, tests, dependency locks, API/decoder evidence, and setup scripts. CI runs tests and builds only; it has no deployment credentials and does not collect live market data.

Git excludes `.env`, private backend configuration and refresh-encryption keys, personal analytics captures, `.tgcloud` snapshots, uploaded attachments, local databases, portfolio CSVs, exports, logs, virtual environments, dependencies, and generated bundles. `.env.example`, the blank portfolio template, and `serverless/private-config.example.js` are safe configuration examples. Keep personal backups outside version control; an ignore rule does not protect a file that was already committed.

Public blockchain fixtures intentionally contain original contract/NFT addresses and BOCs for reproducible decoder checks. Their provenance is documented in `tests/fixtures/ton/README.md`. They are distinct from the private portfolio, raw discovery database, and credentials, which are excluded.

Do not attach `.env`, `.tgcloud`, raw databases, private exports, or credential-bearing logs to GitHub issues. A project license has not been selected; there is no open-source license grant for the application. The vendored TweetNaCl code retains its bundled third-party license and pinned source provenance.

## Fresh-clone checks

Use Python 3.12, Node.js 24, and pnpm 11.25.0. In PowerShell from the clone:

```powershell
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -c requirements-dev.lock -e '.[dev,dashboard]'
& .\.venv\Scripts\python.exe -m pytest
powershell -File scripts\build-dashboard.ps1
powershell -File scripts\build-serverless.ps1
```

These checks use mocked providers and temporary databases; no token or private configuration is required. The dashboard build creates the ignored assets that Python serves. For a Python wheel, run that build first, then:

```powershell
& .\.venv\Scripts\python.exe -m pip wheel --no-deps --no-build-isolation --wheel-dir dist .
```

Copy `.env.example` to `.env` and configure it only when ready for live use. The [main README](../README.md) covers discovery and collection; the [Telegram guide](telegram-serverless.md) covers separate server-side credentials and explicit deployment destinations.

GitHub Actions checks Python 3.12, Node 24 tests, and both frontend builds on pushes and pull requests. Dependencies use committed lockfiles; Actions are pinned by full commit hash. The workflow requests only read access to repository contents and never publishes the app.

## Release preparation

The current application version is **0.3.0**. [CHANGELOG.md](../CHANGELOG.md) contains the release notes and can supply the body of a GitHub release.

Keep `pyproject.toml`, `src/marketapp_rent/__init__.py`, `frontend/package.json`, and `serverless/package.json` on the same application version. Dependency and database schema versions are separate; a UI release does not change them. Add a dated changelog entry, run the fresh-clone checks above, and review the committed paths before pushing. Generated bundles and private operational data must remain ignored.

Preparing a release commit locally does not publish a GitHub release or deploy the app. After pushing an approved release commit and checking GitHub Actions, use its matching version, such as `v0.3.0`, for the release tag.

## First GitHub push

Preparation of a local repository does not create or upload a GitHub repository. Create an empty repository named `gift-rent-check` in the intended account; choose its visibility deliberately. Avoid initializing a second README or license there when pushing this existing history.

Review the included paths before publishing:

```powershell
git status --short
git ls-files
git log -1 --oneline
git remote -v
```

After creating the empty remote, use its exact URL (replace `YOUR_ACCOUNT`):

```powershell
git remote add origin https://github.com/YOUR_ACCOUNT/gift-rent-check.git
git push -u origin main
```

If `origin` is already configured, inspect it before changing it. These commands upload committed source to GitHub; they do not deploy Telegram or upload the ignored local data. Review the Actions result after the push; local passing checks do not substitute for the first hosted CI run.
