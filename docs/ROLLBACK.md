# Recovering from a bad release

The last published release checked during this work was **v0.1.18**. The local
v0.1.19 changes keep the same app identifier (`com.topgear.garage`), WebView
storage configuration, database name (`topgear_offline_garage`), database version
(`5`), stores and backup format. The new cache and UI state live only in memory.

## Preferred recovery: publish the known-good code as a newer release

Tauri's default updater accepts only a version newer than the installed version.
For example, if v0.1.19 is faulty, rebuild the known-good v0.1.18 code as
**v0.1.20**, signed with the existing updater key. Customers receive the normal
update prompt; the app continues opening their current database.

1. Stop distributing the faulty release while preparing recovery. Keep the old
   signed installers and release assets available.
2. Use a separate, clean checkout of the known-good tag. Preserve ongoing work
   in the main checkout. Set its Tauri app version to a number higher than every
   published version and add customer-facing recovery notes.
3. Keep the identifier, database name/version, storage origin/profile, updater
   public key, endpoint and installer mode unchanged.
4. Test on an isolated copy with existing records, including records added using
   the faulty version. Verify all stores, relationships and financial totals.
5. Build, sign and publish through the existing release process. Confirm
   `latest.json` points to the recovery release and that the installed faulty
   version offers the update.

Merely pointing `latest.json` at v0.1.18 will not automatically downgrade clients
already running v0.1.19. Do not loosen the version comparator just for recovery.

## Manual recovery

Before changing a customer's installation, close the app and make an independent
copy of its entire `%LOCALAPPDATA%\com.topgear.garage\` folder. If the app opens,
also use its existing full JSON export. Verify the backup before proceeding.
Installing an older signed installer may be blocked by installer downgrade rules;
prefer the forward recovery release above. Never uninstall and remove app data
as a rollback step.

Database compatibility must be checked for the particular target release. The
v0.1.18/v0.1.19 code path uses database version 5; do not assume older releases
with lower database versions can open it.

Rolling back code does not undo records already changed by a bug. Restoring an
old backup also removes work entered after that backup, so data repair/recovery
must be assessed separately from the code rollback.

## Verification

`python tests/ui-improvements.py` uses a fresh Chromium profile, synthetic data
and a local test server. It opens v0.1.18, upgrades to the working tree and returns
to v0.1.18, comparing all six stores without reading any customer profile. It also
checks pagination, totals, unsaved forms, version display and invoice PDFs.

This browser test verifies frontend/database compatibility. It does not replace
a signed Windows installer/update test before publishing.

Reference: [Tauri updater version comparison](https://v2.tauri.app/plugin/updater/#allowing-downgrades).
