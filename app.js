import { MAX_FILE_SIZE, readWorkbook } from "./xlsx.js";
import { fetchMetadata } from "./metadata.js";
import { CATEGORIES, convertWishes, formatUtcOffset, parsePaimonJson, utcOffsetMinutes, wishAccountPrefix } from "./converter.js";

const form = document.querySelector("#converter-form");
const workbook = document.querySelector("#workbook");
const exportModeControls = document.querySelector("#export-mode-controls");
const mergeMode = document.querySelector("#export-merge");
const existingJsonControls = document.querySelector("#existing-json-controls");
const existingJson = document.querySelector("#existing-json");
const timezoneControls = document.querySelector("#timezone-controls");
const timezoneSign = document.querySelector("#timezone-sign");
const timezoneHours = document.querySelector("#timezone-hours");
const timezoneMinutes = document.querySelector("#timezone-minutes");
const button = document.querySelector("#convert");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const result = document.querySelector("#result");
const mergeDiff = document.querySelector("#merge-diff");
const mergeDiffInfo = document.querySelector("#merge-diff-info");
const mergeChanges = document.querySelector("#merge-changes");
const download = document.querySelector("#download");
let downloadUrl;

const localOffset = -new Date().getTimezoneOffset();
timezoneSign.value = localOffset < 0 ? "-" : "+";
timezoneHours.value = String(Math.floor(Math.abs(localOffset) / 60));
timezoneMinutes.value = String(Math.abs(localOffset) % 60);

function updateExportMode() {
  existingJsonControls.hidden = !mergeMode.checked;
  existingJson.disabled = !mergeMode.checked;
  existingJson.required = mergeMode.checked;
}

updateExportMode();
exportModeControls.addEventListener("change", updateExportMode);

function clearResult() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
  download.removeAttribute("href");
  result.hidden = true;
  mergeDiff.hidden = true;
  mergeDiffInfo.textContent = "";
  mergeChanges.replaceChildren();
  error.hidden = true;
  error.textContent = "";
  status.textContent = "";
}

function tableRow(values) {
  const row = document.createElement("tr");
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    row.append(cell);
  }
  return row;
}

form.addEventListener("input", clearResult);
form.addEventListener("change", clearResult);
window.addEventListener("pagehide", clearResult);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearResult();
  button.disabled = true;
  workbook.disabled = true;
  exportModeControls.disabled = true;
  existingJson.disabled = true;
  timezoneControls.disabled = true;
  form.setAttribute("aria-busy", "true");
  try {
    const file = workbook.files[0];
    if (!file || !file.name.toLowerCase().endsWith(".xlsx")) throw new Error("Choose an .xlsx workbook.");
    if (file.size > MAX_FILE_SIZE) throw new Error("Workbook exceeds the 25 MiB file limit.");
    const backup = mergeMode.checked ? existingJson.files[0] : undefined;
    if (mergeMode.checked && !backup) throw new Error("Choose a .json Paimon.moe backup to merge.");
    let existingData;
    if (backup) {
      if (!backup.name.toLowerCase().endsWith(".json")) throw new Error("Choose a .json Paimon.moe backup.");
      if (backup.size > MAX_FILE_SIZE) throw new Error("Existing JSON exceeds the 25 MiB file limit.");
      status.textContent = "Reading your existing Paimon.moe JSON locally...";
      existingData = parsePaimonJson(await backup.text());
    }
    const offsetMinutes = utcOffsetMinutes(timezoneSign.value, timezoneHours.valueAsNumber, timezoneMinutes.valueAsNumber);
    const zone = formatUtcOffset(offsetMinutes);
    status.textContent = "Reading your workbook locally...";
    const records = await readWorkbook(await file.arrayBuffer());
    status.textContent = "Fetching public Paimon item and banner metadata (no workbook data is sent)...";
    const metadata = await fetchMetadata();
    status.textContent = "Calculating wish history...";
    const data = convertWishes(records, metadata, offsetMinutes, existingData);
    const prefix = wishAccountPrefix(data, String(records[0].uid));
    const total = CATEGORIES.reduce((sum, category) => sum + data[`${prefix}wish-counter-${category.id}`].total, 0);
    const previousTotal = existingData ? CATEGORIES.reduce((sum, category) =>
      sum + (existingData[`${prefix}wish-counter-${category.id}`]?.total ?? 0), 0) : 0;
    const added = total - previousTotal;
    const summary = CATEGORIES.map((category) => {
      const counter = data[`${prefix}wish-counter-${category.id}`];
      return tableRow([category.label, counter.total, counter.legendary, counter.rare]);
    });
    document.querySelector("#summary").replaceChildren(...summary);
    if (existingData) {
      mergeDiffInfo.textContent = `${previousTotal.toLocaleString()} existing + ${added.toLocaleString()} added = ${total.toLocaleString()} merged wishes. ${(records.length - added).toLocaleString()} overlapping wishes kept from the backup, not added again.`;
      const changes = ["Achievements", "Items / inventory", "Characters", "Other backup data / accounts"].map((label) =>
        [label, "0 changes (preserved)"]);
      for (const category of CATEGORIES) {
        const key = `${prefix}wish-counter-${category.id}`;
        const before = existingData[key]?.total ?? 0;
        const after = data[key].total;
        changes.push([category.label, `${before.toLocaleString()} -> ${after.toLocaleString()} wishes (+${(after - before).toLocaleString()} added)`]);
      }
      changes.push(["Wish pity / statistics", added ? "Recalculated for banners with added wishes" : "Unchanged (no new wishes)"]);
      mergeChanges.replaceChildren(...changes.map(tableRow));
      mergeDiff.hidden = false;
    }
    const times = CATEGORIES.flatMap((category) => data[`${prefix}wish-counter-${category.id}`].pulls.map((pull) => pull.time)).sort();
    const mergeInfo = existingData ? ` ${added.toLocaleString()} new wishes added; ${(records.length - added).toLocaleString()} overlapping wishes kept from the existing JSON. Other backup data preserved.` : "";
    document.querySelector("#result-info").textContent = `${total.toLocaleString()} wishes for UID ${data[`${prefix}wish-uid`]}. Output UTC offset: ${zone}.${mergeInfo}`;
    document.querySelector("#date-range").textContent = `History: ${times[0]} to ${times.at(-1)} (${zone}). Character Event Wish 1 and 2 share pity; their original codes are preserved.`;
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    download.href = downloadUrl;
    result.hidden = false;
    status.textContent = `${existingData ? "Merge" : "Conversion"} complete. Download your JSON below.`;
  } catch (cause) {
    console.error("Wish conversion failed:", cause);
    error.textContent = cause.message;
    error.hidden = false;
    status.textContent = "";
  } finally {
    button.disabled = false;
    workbook.disabled = false;
    exportModeControls.disabled = false;
    updateExportMode();
    timezoneControls.disabled = false;
    form.removeAttribute("aria-busy");
  }
});
