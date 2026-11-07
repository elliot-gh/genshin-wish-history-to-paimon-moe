import { MAX_FILE_SIZE, readWorkbook } from "./xlsx.js";
import { fetchMetadata } from "./metadata.js";
import { CATEGORIES, convertWishes, formatUtcOffset, utcOffsetMinutes } from "./converter.js";

const form = document.querySelector("#converter-form");
const workbook = document.querySelector("#workbook");
const timezoneControls = document.querySelector("#timezone-controls");
const timezoneSign = document.querySelector("#timezone-sign");
const timezoneHours = document.querySelector("#timezone-hours");
const timezoneMinutes = document.querySelector("#timezone-minutes");
const button = document.querySelector("#convert");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const result = document.querySelector("#result");
const download = document.querySelector("#download");
let downloadUrl;

const localOffset = -new Date().getTimezoneOffset();
timezoneSign.value = localOffset < 0 ? "-" : "+";
timezoneHours.value = String(Math.floor(Math.abs(localOffset) / 60));
timezoneMinutes.value = String(Math.abs(localOffset) % 60);

function clearResult() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
  download.removeAttribute("href");
  result.hidden = true;
  error.hidden = true;
  error.textContent = "";
  status.textContent = "";
}

form.addEventListener("input", clearResult);
form.addEventListener("change", clearResult);
window.addEventListener("pagehide", clearResult);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearResult();
  button.disabled = true;
  workbook.disabled = true;
  timezoneControls.disabled = true;
  form.setAttribute("aria-busy", "true");
  try {
    const file = workbook.files[0];
    if (!file || !file.name.toLowerCase().endsWith(".xlsx")) throw new Error("Choose an .xlsx workbook.");
    if (file.size > MAX_FILE_SIZE) throw new Error("Workbook exceeds the 25 MiB file limit.");
    const offsetMinutes = utcOffsetMinutes(timezoneSign.value, timezoneHours.valueAsNumber, timezoneMinutes.valueAsNumber);
    const zone = formatUtcOffset(offsetMinutes);
    status.textContent = "Reading your workbook locally...";
    const records = await readWorkbook(await file.arrayBuffer());
    status.textContent = "Fetching public Paimon item and banner metadata (no workbook data is sent)...";
    const metadata = await fetchMetadata();
    status.textContent = "Calculating wish history...";
    const data = convertWishes(records, metadata, offsetMinutes);
    const summary = CATEGORIES.map((category) => {
      const counter = data[`wish-counter-${category.id}`];
      const row = document.createElement("tr");
      for (const value of [category.label, counter.total, counter.legendary, counter.rare]) {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        row.append(cell);
      }
      return row;
    });
    document.querySelector("#summary").replaceChildren(...summary);
    const times = CATEGORIES.flatMap((category) => data[`wish-counter-${category.id}`].pulls.map((pull) => pull.time)).sort();
    document.querySelector("#result-info").textContent = `${records.length.toLocaleString()} wishes for UID ${data["wish-uid"]}. Output UTC offset: ${zone}.`;
    document.querySelector("#date-range").textContent = `History: ${times[0]} to ${times.at(-1)} (${zone}). Character Event Wish 1 and 2 share pity; their original codes are preserved.`;
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    download.href = downloadUrl;
    result.hidden = false;
    status.textContent = "Conversion complete. Download your JSON below.";
  } catch (cause) {
    console.error("Wish conversion failed:", cause);
    error.textContent = cause.message;
    error.hidden = false;
    status.textContent = "";
  } finally {
    button.disabled = false;
    workbook.disabled = false;
    timezoneControls.disabled = false;
    form.removeAttribute("aria-busy");
  }
});
