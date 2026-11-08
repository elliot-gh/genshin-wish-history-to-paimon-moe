# genshin-wish-history-to-paimon-moe

Convert an English HoYoverse wish-history `.xlsx` workbook to Paimon.moe JSON locally in your browser. Run `npm start` and open the printed local URL.

## Merge with existing Paimon.moe data

1. Export a fresh JSON backup from **Paimon.moe Settings -> Export**.
2. Select your workbook and choose the same UTC offset used by the backup's wish timestamps. Paimon JSON does not record that offset, so it cannot be detected automatically.
3. Choose **Merge with existing JSON** to show the required **Import existing Paimon.moe JSON** input. Select the backup, then convert and download the merged JSON. Both files are read locally, never uploaded (only public item/banner metadata is fetched).
4. Review **Merge changes** before importing into Paimon.moe: it shows existing, added, and overlapping wishes, before/after counts by banner, and whether pity/statistics were recalculated. Achievements, items/inventory, characters, and other backup data are shown as unchanged because this converter only updates wishes, not collection or inventory tracking. This summary appears only after a successful merge and is cleared when an input changes.

The workbook UID must match an account in the backup; matching secondary accounts are supported, and other accounts and unrelated backup fields are preserved. Backups with existing main-account wishes but no UID are rejected to prevent mixing accounts. Both inputs have a 25 MiB limit.

Overlap is inferred from category, item type/ID, timestamp, and banner code when present. Imported entries take precedence, and matching occurrences are consumed individually so repeated items in a ten-pull are not collapsed. Missing banner codes in older backups can match either character-event code. Unique wish IDs are not consistently available: distinct but otherwise identical wishes cannot always be distinguished. Imported order within a timestamp is retained; overlapping entries anchor new entries where possible.

Changed histories have pity, guarantees, and rate statistics recalculated using public metadata; these derived fields may change on imported pulls, but other pull/counter fields are preserved. Unchanged counters remain intact. Unsupported wish categories in the backup are preserved without modification; workbook conversion supports Beginners', Standard, Character Event (1 + 2), and Weapon Event wishes.

Choose **Brand new JSON** (the default) for the original wish-only export. The backup input is hidden and any previously selected backup is ignored in this mode. **Paimon.moe's Settings import replaces all local data**, so a workbook-only export will not preserve characters, inventory, settings, or other accounts. A merged export preserves only what was present in the selected backup.

Run unit tests with `npm test`; browser tests are available at `/tests/browser.html` while the local server is running.