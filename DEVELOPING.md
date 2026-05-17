# Developing TopGear

Internal docs for building, releasing, and maintaining the app. Customers don't need this — see [README.md](README.md).

## Architecture at a glance

- **Frontend**: plain `index.html` + `app.js` + `styles.css`, no bundler. Hebrew RTL UI.
- **Storage**: IndexedDB (`topgear_offline_garage`, v2). Stores: `jobs`, `inventory`, `categories`.
- **Desktop wrapper**: Tauri v2. The `src-tauri/` folder holds Rust code (`lib.rs`, `main.rs`), `tauri.conf.json`, and `capabilities/`.
- **Auto-updater**: `tauri-plugin-updater` + a tiny `checkForUpdates()` in [app.js](app.js) that calls Rust commands via `window.__TAURI__.core.invoke`.
- **CI**: [.github/workflows/release.yml](.github/workflows/release.yml). Builds Windows NSIS installer on every `v*` tag.

## Local development

### Quick frontend dev (no installer)

```powershell
npx serve .
# Open http://localhost:3000
```

Data persists in the browser's IndexedDB. The auto-update prompt won't appear (`window.__TAURI__` is undefined).

### Full Tauri dev (with native window)

Requirements:

- [Rust](https://www.rust-lang.org/tools/install) stable
- [Node.js](https://nodejs.org/) 20+
- WebView2 (preinstalled on Windows 11)

```powershell
# One-time: generate Tauri icons from the logo
npx --yes @tauri-apps/cli@latest icon assets/topgear.png

# Stage the static frontend (only needed for `tauri build`, not `tauri dev`)
New-Item -ItemType Directory -Force -Path dist | Out-Null
Copy-Item index.html, app.js, styles.css -Destination dist
Copy-Item -Recurse -Force assets -Destination dist/assets

# Build a local installer
npx --yes @tauri-apps/cli@latest build
```

The installer lands in `src-tauri/target/release/bundle/nsis/`.

## Releasing a new version

CI ([.github/workflows/release.yml](.github/workflows/release.yml)) handles everything when you push a `v*` tag.

```powershell
# 1. Bump version in src-tauri/tauri.conf.json (e.g. "version": "0.1.1")
git add src-tauri/tauri.conf.json
git commit -m "chore: release v0.1.1"

# 2. Tag and push
git tag v0.1.1
git push origin main v0.1.1
```

GitHub Actions will:

1. Generate square icons from `assets/topgear.png`.
2. Stage the frontend into `dist/`.
3. Run `cargo build --release` for `windows-x86_64`.
4. Bundle into a signed NSIS `.exe`.
5. Generate `latest.json` and `.exe.sig` (signed with the GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`).
6. Create a **draft Release** named `TopGear vX.Y.Z` with the three assets attached.

Then publish:

```powershell
gh release edit vX.Y.Z --repo morad-z/TopGear --draft=false
```

A few seconds later, every customer running the previous version sees the upgrade dialog on their next app launch.

## Auto-updater signing

The updater is built on the [Tauri Updater Plugin](https://v2.tauri.app/plugin/updater/). Each build is signed with a minisign-style key pair; the app verifies the signature on download.

### Key files

| File | Where it lives | Status |
|---|---|---|
| Public key | embedded in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | committed (public is fine) |
| Private key | `~/.tauri/topgear-updater.key` (on the maintainer's machine) | **never commit** |
| Private key (for CI) | GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` | already added |

If you ever need to regenerate the keys:

```powershell
npx --yes @tauri-apps/cli@latest signer generate -w $HOME\.tauri\topgear-updater.key -p "" --ci -f
```

Then:

1. Copy the `.pub` contents into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
2. Update the GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` with the new private key.
3. Bump the app version and release.

**Warning**: rotating the key invalidates auto-update for everyone on the old version. They'd need a manual reinstall.

## Data persistence across upgrades

Customer data lives in `%LOCALAPPDATA%\com.topgear.garage\EBWebView\` (the WebView2 IndexedDB store). It's preserved because:

1. The NSIS installer runs in `installMode: currentUser` and only replaces the binary.
2. The app identifier (`com.topgear.garage` in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)) **must never change** — WebView2 keys storage by identifier. Changing it orphans every existing customer's data.
3. The IndexedDB schema version in [app.js](app.js) (`DB_VERSION`) handles migrations via `onupgradeneeded`. Bump it carefully and write migration code when you change the schema.

To verify a release didn't break persistence, install the previous version, add data, then install the new one over it — data should survive.

## Config schema notes (gotchas)

- `bundle.windows.nsis.languages` (not `installerLanguages`).
- `frontendDist` must point to a folder that does NOT contain `src-tauri/`; that's why CI stages everything into `dist/`.
- The source logo must be square. CI pads it to 1024×1024 via ImageMagick before running `tauri icon`.
- `withGlobalTauri: true` is required for the static-HTML frontend to access `window.__TAURI__.core.invoke`.

## File map

```
TopGear/
├── index.html, app.js, styles.css   ← frontend
├── assets/topgear.png               ← logo (any aspect ratio; CI squares it)
├── src-tauri/
│   ├── tauri.conf.json              ← app metadata, bundle config, updater
│   ├── Cargo.toml
│   ├── build.rs
│   ├── src/
│   │   ├── main.rs                  ← entry
│   │   └── lib.rs                   ← commands: check_for_updates, install_update
│   └── capabilities/default.json    ← permissions (core:default, updater:default)
├── .github/workflows/release.yml    ← CI: build + sign + draft release on v* tags
├── README.md                        ← customer-facing
└── DEVELOPING.md                    ← this file
```
