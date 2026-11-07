import { readWorkbook } from "../xlsx.js";
import { convertWishes } from "../converter.js";
import { METADATA_BASE, METADATA_FILES, parseMetadata } from "../metadata.js";
import { makeZip, metadataSources, workbookFixture } from "./fixtures.js";

const results = [];
const tests = [
  ["inline strings, title row, empty trailing row and absolute worksheet relationship", async () => {
    const records = await readWorkbook(workbookFixture());
    if (records.length !== 1 || records[0].name !== "Sharpshooter''s Oath") throw new Error("Incorrect records");
    const data = convertWishes(records, parseMetadata(...metadataSources), 0);
    if (data["wish-counter-standard"].pulls[0].id !== "sharpshooters_oath") throw new Error("Incorrect output");
  }],
  ["shared strings and no hard-coded worksheet filename", async () => {
    const records = await readWorkbook(workbookFixture({ shared: true }));
    if (records.length !== 1 || records[0].time !== "2024-01-01 08:00:00") throw new Error("Incorrect shared strings");
  }],
  ["Excel 1900 numeric dates", async () => {
    const records = await readWorkbook(workbookFixture({ numeric: true, time: "45292.3333333333" }));
    if (records[0].time !== "2024-01-01 08:00:00") throw new Error(records[0].time);
  }],
  ["Excel 1904 numeric dates", async () => {
    const records = await readWorkbook(workbookFixture({ numeric: true, date1904: true, time: "0" }));
    if (records[0].time !== "1904-01-01 00:00:00") throw new Error(records[0].time);
  }],
  ["missing data is rejected", async () => {
    await mustReject(() => readWorkbook(workbookFixture({ missing: true })), /Missing wish data/);
  }],
  ["formula cells are rejected", async () => {
    await mustReject(() => readWorkbook(workbookFixture({ formula: true })), /formula cell/);
  }],
  ["invalid XML is rejected", async () => {
    await mustReject(() => readWorkbook(makeZip([["_rels/.rels", "<Relationships>"]])), /Invalid XML/);
  }],
  ["XML entities are rejected", async () => {
    await mustReject(() => readWorkbook(makeZip([["_rels/.rels", '<!DOCTYPE x [<!ENTITY x "bad">]><x/>']])), /declarations/);
  }],
  ["numeric UTC controls default locally, validate inputs, and export fixed minute offsets", async () => {
    const frame = document.createElement("iframe");
    const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    frame.src = "../index.html";
    document.body.append(frame);
    try {
      await loaded;
      const child = frame.contentWindow;
      const document = frame.contentDocument;
      const sign = document.querySelector("#timezone-sign");
      const hours = document.querySelector("#timezone-hours");
      const minutes = document.querySelector("#timezone-minutes");
      const localOffset = -new Date().getTimezoneOffset();
      if (sign.value !== (localOffset < 0 ? "-" : "+") ||
          hours.valueAsNumber !== Math.floor(Math.abs(localOffset) / 60) ||
          minutes.valueAsNumber !== Math.abs(localOffset) % 60) throw new Error("Incorrect local default");
      const originalFetch = child.fetch.bind(child);
      child.fetch = async (url, options) => {
        if (String(url).startsWith(METADATA_BASE)) {
          const index = METADATA_FILES.indexOf(String(url).slice(METADATA_BASE.length));
          if (index < 0) throw new Error("Unexpected metadata request");
          return new Response(metadataSources[index]);
        }
        return originalFetch(url, options);
      };
      const transfer = new DataTransfer();
      transfer.items.add(new File([workbookFixture()], "test.xlsx"));
      document.querySelector("#workbook").files = transfer.files;
      const form = document.querySelector("#converter-form");
      sign.value = "+";
      hours.value = "5";
      minutes.value = "60";
      if (form.checkValidity()) throw new Error("Invalid minutes accepted");
      minutes.value = "45";
      form.requestSubmit();
      if (!document.querySelector("#timezone-controls").disabled) throw new Error("Offset controls not disabled while converting");
      await waitForConversion(document);
      let data = await (await originalFetch(document.querySelector("#download").href)).json();
      if (data["wish-counter-standard"].pulls[0].time !== "2024-01-01 13:45:00" ||
          !document.querySelector("#result-info").textContent.includes("UTC+05:45")) throw new Error("Incorrect positive offset");
      sign.value = "-";
      hours.value = "3";
      minutes.value = "30";
      minutes.dispatchEvent(new Event("input", { bubbles: true }));
      if (document.querySelector("#download").hasAttribute("href")) throw new Error("Stale download remains");
      form.requestSubmit();
      await waitForConversion(document);
      data = await (await originalFetch(document.querySelector("#download").href)).json();
      if (data["wish-counter-standard"].pulls[0].time !== "2024-01-01 04:30:00" ||
          !document.querySelector("#result-info").textContent.includes("UTC-03:30")) throw new Error("Incorrect negative offset");
      if (document.querySelector("#timezone-controls").disabled) throw new Error("Offset controls not restored");
    } finally {
      frame.remove();
    }
  }],
];

async function waitForConversion(document) {
  const deadline = Date.now() + 5000;
  while (document.querySelector("#result").hidden) {
    if (!document.querySelector("#error").hidden) throw new Error(document.querySelector("#error").textContent);
    if (Date.now() > deadline) throw new Error("Conversion timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function mustReject(action, pattern) {
  try {
    await action();
  } catch (error) {
    if (pattern.test(error.message)) return;
    throw error;
  }
  throw new Error("Expected rejection");
}

for (const [name, run] of tests) {
  try {
    await run();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
    console.error(name, error);
  }
}
document.querySelector("#results").textContent = results.join("\n");
document.body.dataset.failures = String(results.filter((result) => result.startsWith("FAIL")).length);
