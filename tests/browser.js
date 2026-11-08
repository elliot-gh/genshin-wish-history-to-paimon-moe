import { MAX_FILE_SIZE, readWorkbook } from "../xlsx.js";
import { convertWishes } from "../converter.js";
import { METADATA_BASE, METADATA_FILES, parseMetadata } from "../metadata.js";
import { makeZip, metadataSources, wish, workbookFixture } from "./fixtures.js";

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
  ["JSON mode toggles import visibility and validation, merges locally, and restores controls", async () => {
    const frame = document.createElement("iframe");
    const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    frame.src = "../index.html";
    document.body.append(frame);
    try {
      await loaded;
      const child = frame.contentWindow;
      const document = frame.contentDocument;
      const originalFetch = child.fetch.bind(child);
      const requests = [];
      child.fetch = async (url, options) => {
        requests.push(String(url));
        if (!String(url).startsWith(METADATA_BASE) || options.body !== undefined) throw new Error("Unexpected data upload");
        return new Response(metadataSources[METADATA_FILES.indexOf(String(url).slice(METADATA_BASE.length))]);
      };
      const setFile = (selector, contents, name) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([contents], name));
        const input = document.querySelector(selector);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setFile("#workbook", workbookFixture(), "test.xlsx");
      document.querySelector("#timezone-sign").value = "+";
      document.querySelector("#timezone-hours").value = "0";
      document.querySelector("#timezone-minutes").value = "0";
      const form = document.querySelector("#converter-form");
      const newMode = document.querySelector("#export-new");
      const mergeMode = document.querySelector("#export-merge");
      const modeControls = document.querySelector("#export-mode-controls");
      const importControls = document.querySelector("#existing-json-controls");
      const importInput = document.querySelector("#existing-json");
      const diff = document.querySelector("#merge-diff");
      const assertMergeDiff = (before, after, added, overlaps) => {
        const expected = `${before} existing + ${added} added = ${after} merged wishes. ${overlaps} overlapping wishes kept from the backup, not added again.`;
        if (diff.hidden || document.querySelector("#merge-diff-info").textContent !== expected) {
          throw new Error("Incorrect merge diff totals");
        }
        const changes = new Map([...document.querySelectorAll("#merge-changes tr")].map((row) =>
          [row.children[0].textContent, row.children[1].textContent]));
        for (const label of ["Achievements", "Items / inventory", "Characters", "Other backup data / accounts"]) {
          if (changes.get(label) !== "0 changes (preserved)") throw new Error(`Incorrect ${label} diff`);
        }
        if (changes.get("Standard Wish") !== `${before} -> ${after} wishes (+${added} added)` ||
            changes.get("Character Event Wish (1 + 2)") !== "0 -> 0 wishes (+0 added)" ||
            changes.get("Wish pity / statistics") !== (added ? "Recalculated for banners with added wishes" : "Unchanged (no new wishes)")) {
          throw new Error("Incorrect banner or statistics diff");
        }
      };
      if (!newMode.checked || mergeMode.checked || !importControls.hidden || !importInput.disabled ||
          importInput.required || !form.checkValidity() || !diff.hidden) throw new Error("Incorrect default new-JSON mode");
      mergeMode.click();
      if (importControls.hidden || importInput.disabled || !importInput.required || form.checkValidity()) {
        throw new Error("Merge mode does not show and require the import");
      }
      form.dispatchEvent(new child.Event("submit", { bubbles: true, cancelable: true }));
      await waitForError(document, /backup to merge/);
      const backup = convertWishes([wish(2, "Jean", "Standard Wish", "2023-12-31 08:00:00")], parseMetadata(...metadataSources), 0);
      backup.inventory = { mora: 100 };
      backup.achievements = { completed: [1, 2] };
      backup.characters = { jean: { level: 80 } };
      backup["wish-counter-setting"].manualInput = true;
      setFile("#existing-json", JSON.stringify(backup), "backup.json");
      form.requestSubmit();
      if (!importInput.disabled || !modeControls.disabled) throw new Error("JSON mode controls not disabled during conversion");
      await waitForConversion(document);
      let data = await (await originalFetch(document.querySelector("#download").href)).json();
      if (data["wish-counter-standard"].total !== 2 || data.inventory.mora !== 100 ||
          !data["wish-counter-setting"].manualInput ||
          !document.querySelector("#result-info").textContent.includes("1 new wishes added; 0 overlapping") ||
          !document.querySelector("#date-range").textContent.includes("2023-12-31")) throw new Error("Incorrect merged result");
      assertMergeDiff(1, 2, 1, 0);
      if (JSON.stringify(data.achievements) !== JSON.stringify(backup.achievements) ||
          JSON.stringify(data.characters) !== JSON.stringify(backup.characters)) throw new Error("Preserved-data diff does not match export");
      if (importInput.disabled || modeControls.disabled || document.querySelector("#workbook").disabled ||
          form.hasAttribute("aria-busy")) throw new Error("Controls not restored");
      setFile("#existing-json", JSON.stringify(data), "merged.json");
      if (document.querySelector("#download").hasAttribute("href") || !diff.hidden ||
          document.querySelector("#merge-changes").children.length || document.querySelector("#merge-diff-info").textContent) {
        throw new Error("Stale download or diff after changing backup");
      }
      form.requestSubmit();
      await waitForConversion(document);
      const repeated = await (await originalFetch(document.querySelector("#download").href)).json();
      if (JSON.stringify(repeated) !== JSON.stringify(data) ||
          !document.querySelector("#result-info").textContent.includes("0 new wishes added; 1 overlapping")) throw new Error("Overlap was not retained");
      assertMergeDiff(2, 2, 0, 1);
      const secondaryBackup = { ...backup, "wish-uid": "899999999" };
      for (const [key, value] of Object.entries(data).filter(([key]) => key.startsWith("wish-"))) {
        secondaryBackup[`alt-${key}`] = value;
      }
      setFile("#existing-json", JSON.stringify(secondaryBackup), "accounts.json");
      form.requestSubmit();
      await waitForConversion(document);
      const accounts = await (await originalFetch(document.querySelector("#download").href)).json();
      if (accounts["wish-uid"] !== "899999999" || accounts["wish-counter-standard"].total !== 1 ||
          accounts["alt-wish-counter-standard"].total !== 2 ||
          !document.querySelector("#result-info").textContent.includes("2 wishes for UID 799999999") ||
          document.querySelectorAll("#summary tr")[1].children[1].textContent !== "2") throw new Error("Secondary account summary is incorrect");
      assertMergeDiff(2, 2, 0, 1);
      setFile("#existing-json", "{", "invalid.json");
      form.requestSubmit();
      await waitForError(document, /valid JSON backup/);
      if (document.querySelector("#download").hasAttribute("href")) throw new Error("Download remains after failure");
      const mismatch = { ...backup, "wish-uid": "899999999" };
      setFile("#existing-json", JSON.stringify(mismatch), "mismatch.json");
      form.requestSubmit();
      await waitForError(document, /UID does not match/);
      setFile("#existing-json", JSON.stringify(backup), "backup.txt");
      form.requestSubmit();
      await waitForError(document, /Choose a .json/);
      setFile("#existing-json", JSON.stringify(backup).padEnd(MAX_FILE_SIZE, " "), "limit.json");
      form.requestSubmit();
      await waitForConversion(document);
      const atLimit = await (await originalFetch(document.querySelector("#download").href)).json();
      if (atLimit["wish-counter-standard"].total !== 2) throw new Error("JSON at the 25 MiB limit was not merged");
      assertMergeDiff(1, 2, 1, 0);
      setFile("#existing-json", new Uint8Array(MAX_FILE_SIZE + 1), "large.json");
      form.requestSubmit();
      await waitForError(document, /25 MiB file limit/);
      newMode.click();
      if (!importControls.hidden || !importInput.disabled || importInput.required || !form.checkValidity()) {
        throw new Error("New mode did not hide and disable the selected backup");
      }
      form.requestSubmit();
      await waitForConversion(document);
      data = await (await originalFetch(document.querySelector("#download").href)).json();
      if (data["wish-counter-standard"].total !== 1 || Object.hasOwn(data, "inventory") || !diff.hidden ||
          document.querySelector("#merge-changes").children.length) throw new Error("Workbook-only export or hidden diff changed");
      if (!importInput.disabled || modeControls.disabled) throw new Error("New mode controls not restored");
      setFile("#existing-json", JSON.stringify(backup), "backup.json");
      mergeMode.click();
      if (document.querySelector("#download").hasAttribute("href") || importControls.hidden ||
          importInput.disabled || !importInput.required || !form.checkValidity()) throw new Error("Switching back to merge failed");
      form.requestSubmit();
      await waitForConversion(document);
      data = await (await originalFetch(document.querySelector("#download").href)).json();
      if (data["wish-counter-standard"].total !== 2 || data.inventory.mora !== 100) throw new Error("Merge after switching modes failed");
      assertMergeDiff(1, 2, 1, 0);
      if (requests.some((url) => !url.startsWith(METADATA_BASE))) throw new Error("Private data sent");
    } finally {
      frame.remove();
    }
  }],
];

async function waitForError(document, pattern) {
  const deadline = Date.now() + 5000;
  while (document.querySelector("#error").hidden) {
    if (Date.now() > deadline) throw new Error("Expected conversion error timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!pattern.test(document.querySelector("#error").textContent)) throw new Error(document.querySelector("#error").textContent);
  if (!document.querySelector("#merge-diff").hidden || document.querySelector("#merge-changes").children.length) {
    throw new Error("Stale merge diff after error");
  }
  if (document.querySelector("#existing-json").disabled || document.querySelector("#export-mode-controls").disabled ||
      document.querySelector("#timezone-controls").disabled ||
      document.querySelector("#converter-form").hasAttribute("aria-busy")) throw new Error("Controls not restored after error");
}

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
