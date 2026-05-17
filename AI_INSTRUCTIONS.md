# AI Assistant Instructions for TopGear

> This file is for AI assistants working on this codebase (Claude, ChatGPT, Cursor, etc.). Read it end-to-end before making changes.

---

## What this is

**TopGear** is a Hebrew (RTL) desktop app for managing a single Israeli car garage. It runs as a Tauri (v2) wrapper around a static HTML/JS/CSS frontend that stores all data locally in IndexedDB. There is no backend, no auth, no server, no analytics. The garage owner installs a Windows `.exe`, runs it offline, and his data lives in `%LOCALAPPDATA%\com.topgear.garage\`.

The current customer is a single garage owner in Israel. The app is being sold as a one-time install for ~₪3,000 with an auto-updater that ships updates from GitHub Releases.

Repo: https://github.com/morad-z/TopGear (public)
Owner GitHub user: `morad-z`

---

## Tech stack & file layout

```
TopGear/
├── index.html             # Single-page UI, Hebrew RTL, 5 views in sections
├── app.js                 # ~1900 lines of vanilla JS (no bundler, no TypeScript)
├── styles.css             # CSS with custom properties (--accent, --line, etc.)
├── assets/topgear.png     # Logo (any aspect ratio; CI squares it to 1024x1024)
├── CHANGELOG.md           # Customer-facing release notes in Hebrew (consumed by CI)
├── README.md              # Customer-facing install / overview
├── DEVELOPING.md          # Maintainer dev guide
├── AI_INSTRUCTIONS.md     # ← this file
├── src-tauri/
│   ├── tauri.conf.json    # App metadata, bundle config, updater endpoint + pubkey
│   ├── Cargo.toml         # Rust deps (tauri 2, tauri-plugin-updater 2)
│   ├── build.rs           # tauri_build::build()
│   ├── src/
│   │   ├── main.rs        # Entry: calls topgear_lib::run()
│   │   └── lib.rs         # 2 commands: check_for_updates, install_update
│   └── capabilities/default.json   # core:default + updater:default
└── .github/workflows/release.yml   # Build Windows .exe on every v* tag push
```

**No bundler, no Node modules, no TypeScript.** The frontend is plain JS loaded directly by the HTML. This is intentional — keep it simple. Do NOT add Webpack, Vite, or any build step for the frontend.

**No tests yet.** The codebase has no test suite. If adding one, prefer Vitest + Playwright. Don't break this when adding features — verification is done by reading code + the preview server (see below).

---

## Data model (IndexedDB)

**Database name**: `topgear_offline_garage`
**Current version**: `3` (defined in `app.js:DB_VERSION`)

| Store | Key | Indexes | Fields |
|---|---|---|---|
| `jobs` | auto-id | `jobDate`, `vehiclePlate` | jobDate, vehiclePlate, vehicleModel, vehicleYear, engineDisplacement, ownerName, laborPrice, deliveryDate, parts[], **taxEnabled**, **taxRate**, **deliveredAt** (ISO string or absent), createdAt, updatedAt |
| `inventory` | auto-id | `sku` (unique), `name` | sku, name, category, quantity, garageCost, customerPrice, createdAt, updatedAt |
| `categories` | string id | — | id (`custom_<rand>`), label, custom: true, createdAt |
| `appointments` | auto-id | `appointmentDate`, `phoneNumber` | appointmentDate, appointmentTime, customerName, phoneNumber, vehiclePlate, vehicleModel, reason, notes |

**Each `parts[]` entry in a job is a snapshot** — it copies `garageCostSnapshot` and `customerPriceSnapshot` at the time the job was saved, so changing inventory prices later doesn't retroactively change historical jobs. **Never change this** — it's an accounting requirement.

**Schema migrations** happen in `onupgradeneeded` (in `openDatabase()`). When bumping `DB_VERSION`, add a new `if (!db.objectStoreNames.contains(...))` block. Existing customer data must be preserved — this means **never delete or rename a store**, only add.

---

## ⚠️ Critical invariants — DO NOT CHANGE

1. **`identifier: "com.topgear.garage"`** in `src-tauri/tauri.conf.json`. WebView2 keys IndexedDB storage by this identifier. Changing it = every existing customer loses all their data on the next update. There is no migration path. Treat this as immutable.

2. **DB name `topgear_offline_garage`**. Same reason — renaming = data loss.

3. **The updater public key** in `tauri.conf.json` → `plugins.updater.pubkey`. The matching private key is in the GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` and on the owner's machine at `~/.tauri/topgear-updater.key`. If you regenerate the pubkey, **every customer must manually reinstall** because the auto-updater verifies signatures against the embedded pubkey. Never rotate without a really good reason.

4. **Updater endpoint** must stay `https://github.com/morad-z/TopGear/releases/latest/download/latest.json`. CI publishes `latest.json` to whatever release tag is pushed; this URL auto-redirects to the latest published release.

5. **`bundle.targets: ["nsis"]`** — we ship NSIS `.exe` only, not MSI. Don't add MSI back without a reason; it confuses customers.

6. **Frontend stays in `dist/` at build time, NOT the project root.** The workflow stages `index.html`, `app.js`, `styles.css`, `assets/` into `dist/` before `tauri build` runs. `tauri.conf.json → build.frontendDist = "../dist"`. If you point it at `"../"`, the build fails because Tauri refuses to bundle `src-tauri/` into the frontend payload.

7. **Logo must be square at build time.** The workflow uses ImageMagick to pad `assets/topgear.png` to 1024×1024 transparent → `assets/topgear-square.png` before calling `tauri icon`. The source PNG can be any aspect; the workflow handles it.

---

## How features are organized in `app.js`

The file is monolithic and roughly grouped:

| Lines (approx) | Concern |
|---|---|
| 1–60 | Top-level constants, state object, DOMContentLoaded boot |
| 60–110 | `lookupVehicleByPlate` — data.gov.il integration |
| 110–155 | `autofillVehicleFields` — wires plate lookup to forms |
| 155–180 | `checkForUpdates` — Tauri auto-update dialog |
| 180–320 | `cacheElements` + `bindEvents` (single source of DOM refs and listeners) |
| 320–400 | `openDatabase` + IDB helpers |
| 400–500 | `renderAll` + view-switching + category helpers |
| 500–800 | `renderJobs`, `renderInventory`, `renderDeliveries`, `renderAppointments`, `renderAnalytics` |
| 800–1100 | Part picker (`renderPartPicker`, `addPartToDraft`, etc.) |
| 1100–1400 | Modal openers + form submit handlers (jobs, parts, appointments) |
| 1400–1700 | Save/transaction logic + `getJobTotals` + `getPartsTotals` |
| 1700–1900 | Export/import (CSV + JSON), `replaceAllData`, file utils |

**Pattern: cache once, bind once.** Every DOM element is cached in `cacheElements()` into the `els` object at boot. Every event listener is bound in `bindEvents()`. Don't add ad-hoc `document.querySelector` calls in feature code; cache it.

**Pattern: IDB transactions are awaited via helpers** — `idbRequest()` wraps a single request, `transactionDone()` waits for the whole transaction. Don't `.then()` directly on requests; use the helpers.

**Pattern: every render function takes no args and reads from `state`**. State is mutated by handlers, then `renderX()` is called. There's no virtual DOM or framework — it's manual but works for the app's size.

---

## VAT / tax model

- Inventory prices are **net (pre-tax)**.
- Each job has `taxEnabled: boolean` and `taxRate: number` (default 18 for new jobs, false/0 for jobs created before v0.1.2).
- `getPartsTotals` returns `{ partsCost, partsPrice, subtotal, taxAmount, total, profit }`. `total` is what the customer pays; `profit` is always pre-tax.
- **Profit is NEVER tax-inclusive** — VAT is collected for the government, not kept by the business. Don't change this; it's an accounting requirement.
- Analytics band on the jobs page uses `subtotal` for revenue (pre-tax), so `revenue − cost = profit` invariant holds.

---

## External API: data.gov.il vehicle lookup

The plate autofill (v0.1.3) does a two-step CKAN query:

1. `053cea08-09bc-40ec-8f7a-156f0677aff3` (vehicles) — `{ mispar_rechev: <digits> }` → returns `tozeret_cd`, `degem_cd`, `shnat_yitzur`, `kinuy_mishari`, color, fuel
2. `142afde2-6228-49f9-8a29-9b6c3a0cbe40` (models) — `{ tozeret_cd, degem_cd, shnat_yitzur }` → returns `nefah_manoa` (cc), `tozar` (clean brand without country)

`Access-Control-Allow-Origin: *` is set, so this works in both Tauri webview and `npx serve`. No API key needed. Public, free, rate-limited generously.

---

## Build & release

**Triggered by**: pushing a tag matching `v*`.

```bash
# Bump version in src-tauri/tauri.conf.json
# Add an entry to CHANGELOG.md (customer-friendly Hebrew)
git add -A && git commit -m "feat: ..."
git tag v0.1.X
git push origin main v0.1.X
```

**What CI does** (`.github/workflows/release.yml`):
1. Install Rust stable + Node 20
2. Pad logo to square 1024×1024 with ImageMagick
3. Run `tauri icon` to generate `src-tauri/icons/*`
4. Stage `index.html`, `app.js`, `styles.css`, `assets/` into `dist/`
5. Extract the section for the current tag from `CHANGELOG.md` (regex match against `^## v0.1.X`)
6. Run `tauri build` — produces a signed NSIS `.exe` + `.sig` + `latest.json` under `src-tauri/target/release/bundle/`
7. Create a **draft GitHub release** with the extracted notes as the body
8. Owner manually publishes (or you run `gh release edit vX.Y.Z --draft=false`)

**Build time**: ~5–8 min with cached Rust deps; ~15–25 min cold.

**Required GitHub Secret**: `TAURI_SIGNING_PRIVATE_KEY` — the contents of the minisign private key. Already configured.

**Auto-publish trick**: `gh release edit vX.Y.Z --repo morad-z/TopGear --draft=false` after the build finishes.

---

## Update dialog flow

When a customer launches the app:
1. `DOMContentLoaded` fires → `setTimeout(checkForUpdates, 3000)` 3 seconds in.
2. `checkForUpdates` (in `app.js`) calls Rust command `check_for_updates` via `window.__TAURI__.core.invoke`.
3. Rust command uses `tauri-plugin-updater` to fetch `latest.json`, verify signature, compare versions.
4. If newer version exists, returns `{ available: true, version, current_version, body }`.
5. JS shows a `confirm()` with `מה חדש בגרסה זו: <body>`.
6. On accept: Rust `install_update` downloads new `.exe`, verifies sig, replaces the binary, calls `app.restart()`.

**Important timing fact**: the dialog runs **the OLD version's code**. So any change to the dialog itself only takes effect one release later. Don't promise "this update will look nicer" if you're just changing the dialog code — that change manifests in the *next* update prompt.

**Customer only sees the latest version's notes**, not skipped versions. If a customer is on v0.1.0 and skips to v0.1.5, they see v0.1.5's CHANGELOG section only. There's an open option to fetch GitHub Releases API and show all skipped versions; user has currently declined this complexity.

---

## Things that have broken before (and the fix)

1. **Non-square logo** → workflow pads via ImageMagick. Don't remove this step.
2. **Tauri v2 NSIS config**: the key is `languages`, NOT `installerLanguages`. Tauri v2 schema renamed it.
3. **`frontendDist: "../"`** fails because Tauri refuses to bundle `src-tauri/`. Always use the staging step + `"../dist"`.
4. **`withGlobalTauri: true`** is required for the static frontend to access `window.__TAURI__.core.invoke`. Don't remove it.
5. **Updater plugin permissions**: `capabilities/default.json` must include `"updater:default"`. Without it, the JS invoke returns "command not allowed".
6. **JSON import preserved fields**: `replaceAllData` has a hardcoded field whitelist per store. When you add a field to a store, you MUST also add it to the whitelist or it gets silently dropped on import. Currently complete for jobs (incl. tax fields), inventory, categories, appointments.

---

## Customer-facing UX conventions

- **Hebrew, RTL everywhere**. `<html dir="rtl">`. CSS uses logical properties where it matters.
- **Currency**: ILS, formatted via `Intl.NumberFormat("he-IL")`.
- **Dates**: ISO `YYYY-MM-DD` in storage; displayed via `Intl.DateTimeFormat("he-IL")` as `DD.MM.YYYY`.
- **Plate numbers**: accept any format on input (dashes/spaces fine); strip non-digits for API calls.
- **Phone numbers**: stored as user entered. Rendered as `tel:` links in tables.
- **Modals**: open via `openModal(id)`, close via `closeModal(id)`. Escape key closes all.
- **Toasts**: `showToast("message")` — auto-hides after ~2.8s. Used for success/error feedback.
- **Categories**: built-in list in `PART_CATEGORIES` (Hebrew labels) + dynamic custom ones from `categories` store. Don't hardcode lookups against built-ins; use `getAllPartCategories()`.

---

## Pricing context (for AI agents helping with product decisions)

The customer pays ~₪3,000 one-time + optional ₪600/yr support. Don't recommend SaaS-style infra (cloud DB, multi-tenant backend) — it would change the entire business model and isn't wanted. The single-shop, local-only model is intentional.

If the customer ever wants multi-shop or multi-user, that's a major architectural conversation requiring a backend, auth, sync — not a small change.

---

## Things to NOT do

- Don't add a bundler (Webpack/Vite/Rollup) for the frontend. Keep it static.
- Don't add TypeScript without explicit instruction. It would require a build step.
- Don't introduce a frontend framework (React/Vue/etc). The vanilla approach is intentional.
- Don't add telemetry, analytics, error reporting that phones home. Local-only is a feature.
- Don't change `identifier`, DB name, or store names. Customer data depends on these.
- Don't commit secrets. The `.gitignore` already excludes `.tauri/`, `.env`, etc.
- Don't ship MSI installers (customers find two installers confusing).
- Don't auto-restart the app without confirmation. Always go through `install_update` which prompts.
- Don't add features the user didn't ask for. The user is the product owner; ask before expanding scope.

---

## Conventions when adding a new feature

1. **Read `app.js` end-to-end first** (it's only ~1900 lines). Understand the boot flow, state, and the render pattern before adding code.
2. **Add new IDB stores via DB version bump** in `openDatabase()`. Bump `DB_VERSION`. Add migration if reshaping existing data.
3. **Cache new DOM refs in `cacheElements()`**. Bind events in `bindEvents()`.
4. **Add a new view section in `index.html`** with class `view`, id `<name>View`. Add the view to `els.views` and the nav button.
5. **Add a `render<Feature>()` function**. Call it from `renderAll()`. It should be idempotent and read from `state`.
6. **Add a section to `CHANGELOG.md`** under the next version. Use customer-friendly Hebrew.
7. **Bump version in `tauri.conf.json`**, commit, tag, push.
8. **Always update `replaceAllData`** if you add fields to existing stores. Otherwise JSON import silently drops them.
9. **Update `AI_INSTRUCTIONS.md` (this file)** if you change anything in the "critical invariants" or "things to avoid" sections.

---

## How to verify changes without a Tauri build

There's a static dev server already configured: `.claude/launch.json` defines `Node serve` on port 3000. The user typically has it running. Just edit files; browser auto-reloads on refresh. Most logic works in plain browser mode EXCEPT:
- Auto-update dialog (no `window.__TAURI__` in browser)
- Auto-install (same reason)

To test the actual updater, you need to build the `.exe` via CI (push a tag) and run it.

---

## Quick context for "where is X?"

- "How is VAT computed?" → `getPartsTotals` in `app.js`.
- "Where is the plate autofill?" → `lookupVehicleByPlate` + `autofillVehicleFields` in `app.js`.
- "Where is the updater config?" → `tauri.conf.json → plugins.updater`.
- "Where is the CI?" → `.github/workflows/release.yml`.
- "Where are the icons generated?" → workflow step "Generate Tauri icons from logo".
- "Where is the customer's data on disk?" → `%LOCALAPPDATA%\com.topgear.garage\EBWebView\` (IndexedDB inside WebView2 profile).
- "Where do I add a new view?" → `index.html` (section), `app.js` (cacheElements, bindEvents, renderX, switchView titles).
- "How do I add a new field to a job?" → `saveJobFromForm` (collect), `openJobModal` (populate when editing), `replaceAllData` (preserve on import), CHANGELOG.

---

## Project history (so an AI doesn't repeat closed conversations)

The user has explicitly DECLINED:
- Whitelabel per-customer builds (path C in the multi-customer discussion). They prefer one binary for everyone.
- A first-run setup wizard (path B). Not yet — pending first paying customer.
- WhatsApp/SMS click-to-send buttons. Not yet.
- "Show multi-version skipped notes" in the update dialog. Latest-only is fine for now.
- Periodic re-check for updates / manual "Check for updates" button. The 3-second-after-launch check is enough.
- Manual MSI installer alongside NSIS. NSIS `.exe` only.

The user HAS confirmed wanting:
- Auto-updater that preserves data ✅ (implemented v0.1.0)
- Hebrew, RTL, offline-first ✅
- VAT support with per-job override (default 18%) ✅ (v0.1.2)
- Appointments diary ✅ (v0.1.1)
- Inventory totals ✅ (v0.1.1)
- Plate autofill from gov.il ✅ (v0.1.3)
- Release notes in update dialog ✅ (v0.1.4)
- Customer-facing CHANGELOG ✅ (v0.1.4)
- Mark job as delivered (removes from יומן עבודה default view + מסירות צפויות) ✅ (v0.1.5)

Before suggesting a new feature, check if it's on the declined list. If so, ask the user first.
