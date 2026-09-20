# Desktop sidebar synchronization

Core's `state_5.sqlite` and the desktop sidebar are separate stores. Current
desktop builds keep `local_thread_catalog` in `sqlite/codex.db` or
`sqlite/codex-dev.db`. A correct `thread/list` response alone does not prove that
the sidebar is correct. Older cached entries can survive an incremental scan
even after the corresponding Core thread is archived.

After applying history and project metadata to a stopped Home, the synchronizer:

1. Backs up the desktop database with SQLite's backup API (including WAL data).
2. Removes only known archived/deleted local catalog entries and reconciles
   existing local entries' project IDs and titles against Core.
3. Invalidates the local watermark, initial-build flag and saved scan checkpoint
   so the desktop performs a full scan on its next launch. This also discovers
   imported active threads older than the previous watermark.
4. Leaves remote/cloud catalogs, automations and chat history untouched. An
   unchanged subsequent sync is a no-op for the catalog.

Backups are under `<Home>/backups_state/desktop-catalog/`; the synchronization
fingerprint is under `<Home>/cache/`. Neither belongs in Git. Unsupported schemas
or unknown/running runtimes are reported as skipped, not silently treated as
offline. This integration currently detects Windows runtimes.

Project metadata now observes project order, names and per-thread assignments.
Changes are compared with each Home's previous observation, rather than unioning
stale memberships forever. On first adoption, the first configured Home with
the relevant metadata is preferred. If two Homes changed the same field before
synchronization, configuration order breaks the tie. A thread removed from a
project has an explicit projectless assignment.

Windows runtime detection recognizes configured backends and Home-local runtime
mirrors. Integrators should track the desktop parent across backend restarts:
a short-lived launcher/shim exiting is not proof that the desktop has exited.
Pre-launch synchronization (`start`) waits for an existing synchronization
instead of returning success while that other synchronization is still running.

Verification must include a manual desktop switch: compare Projects, confirm
archived threads are absent from Recents and present in the archive view, then
restart once more to check persistence. Database and automated test results do
not substitute for that final UI check.
