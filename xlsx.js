export const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_XML_SIZE = 64 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 100 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function openZip(buffer) {
  if (buffer.byteLength > MAX_FILE_SIZE) throw new Error("Workbook exceeds the 25 MiB file limit.");
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("Not a valid XLSX ZIP archive.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 ||
      view.getUint16(end + 8, true) !== count || count === 65535 ||
      directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new Error("Multi-volume and ZIP64 workbooks are not supported.");
  }
  if (count > 2000 || directoryOffset + directorySize > end) throw new Error("Invalid XLSX ZIP directory.");
  const entries = new Map();
  let offset = directoryOffset;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryOffset + directorySize || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid XLSX ZIP entry.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true);
    const entryEnd = offset + 46 + nameSize + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (entryEnd > directoryOffset + directorySize || localOffset + 30 > directoryOffset ||
        size === 0xffffffff || compressedSize === 0xffffffff) throw new Error("Invalid XLSX ZIP entry bounds.");
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameSize));
    if (entries.has(name)) throw new Error("Duplicate XLSX ZIP entry.");
    expanded += size;
    if (expanded > MAX_EXPANDED_SIZE) throw new Error("Workbook expands beyond the 100 MiB safety limit.");
    entries.set(name, { flags, method, crc, compressedSize, size, localOffset });
    offset = entryEnd;
  }
  if (offset !== directoryOffset + directorySize) throw new Error("Invalid XLSX ZIP directory length.");

  return {
    has: (name) => entries.has(name),
    async text(name) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Workbook is missing ${name}.`);
      if (entry.flags & 1) throw new Error("Encrypted workbooks are not supported.");
      if (entry.size > MAX_XML_SIZE) throw new Error("A workbook XML entry exceeds the 64 MiB safety limit.");
      const local = entry.localOffset;
      if (view.getUint32(local, true) !== 0x04034b50 ||
          view.getUint16(local + 6, true) !== entry.flags ||
          view.getUint16(local + 8, true) !== entry.method) throw new Error("Invalid XLSX local ZIP header.");
      const nameSize = view.getUint16(local + 26, true);
      const start = local + 30 + nameSize + view.getUint16(local + 28, true);
      if (start + entry.compressedSize > directoryOffset ||
          decoder.decode(bytes.subarray(local + 30, local + 30 + nameSize)) !== name) {
        throw new Error("Invalid XLSX compressed entry bounds.");
      }
      const compressed = bytes.subarray(start, start + entry.compressedSize);
      let content;
      if (entry.method === 0) {
        content = compressed;
      } else if (entry.method === 8) {
        let decompressor;
        try {
          decompressor = new DecompressionStream("deflate-raw");
        } catch (cause) {
          throw new Error("This browser cannot read XLSX files natively. Use a current Chrome, Edge, Firefox, or Safari.", { cause });
        }
        const reader = new Blob([compressed]).stream().pipeThrough(decompressor).getReader();
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > entry.size || length > MAX_XML_SIZE) {
              await reader.cancel();
              throw new Error("Workbook entry exceeds its declared decompressed size.");
            }
            chunks.push(value);
          }
        } catch (cause) {
          throw new Error(`Could not decompress ${name}: ${cause.message}`, { cause });
        } finally {
          reader.releaseLock();
        }
        content = new Uint8Array(length);
        let position = 0;
        for (const chunk of chunks) {
          content.set(chunk, position);
          position += chunk.length;
        }
      } else {
        throw new Error(`Unsupported XLSX ZIP compression method ${entry.method}.`);
      }
      if (content.length !== entry.size || crc32(content) !== entry.crc) throw new Error(`Workbook entry ${name} is corrupt.`);
      return decoder.decode(content);
    },
  };
}

function xml(text, name) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(`Unsupported XML declarations in ${name}.`);
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagNameNS("*", "parsererror").length) throw new Error(`Invalid XML in ${name}.`);
  return document;
}

const elements = (node, name) => Array.from(node.getElementsByTagNameNS("*", name));

function relationshipPath(target, base) {
  const parts = target.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("Workbook relationship escapes its archive.");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function relationships(document, base) {
  const result = new Map();
  for (const element of elements(document, "Relationship")) {
    if (element.getAttribute("TargetMode") === "External") continue;
    result.set(element.getAttribute("Id"), {
      path: relationshipPath(element.getAttribute("Target"), base),
      type: element.getAttribute("Type"),
    });
  }
  return result;
}

function cellValue(cell, strings) {
  const type = cell.getAttribute("t");
  if (type === "e" || elements(cell, "f").length) throw new Error(`Error or formula cell at ${cell.getAttribute("r")} is not supported.`);
  if (type === "inlineStr") return elements(cell, "t").map((text) => text.textContent).join("");
  const value = elements(cell, "v")[0]?.textContent ?? "";
  if (type === "s") {
    const index = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || index >= strings.length) {
      throw new Error(`Invalid shared string at ${cell.getAttribute("r")}.`);
    }
    return strings[index];
  }
  return value;
}

function excelTime(value, date1904) {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) throw new Error("Invalid Excel date.");
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
  return new Date(epoch + Math.round(serial * 86400) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export async function readWorkbook(buffer) {
  const zip = openZip(buffer);
  const rootRels = relationships(xml(await zip.text("_rels/.rels"), "package relationships"), "");
  const workbookPath = Array.from(rootRels.values()).find((rel) => rel.type.endsWith("/officeDocument"))?.path;
  if (!workbookPath) throw new Error("Workbook has no office document relationship.");
  const workbook = xml(await zip.text(workbookPath), workbookPath);
  const parts = workbookPath.split("/");
  const file = parts.pop();
  const relPath = [...parts, "_rels", `${file}.rels`].join("/");
  const rels = relationships(xml(await zip.text(relPath), relPath), workbookPath);
  const stringPath = Array.from(rels.values()).find((rel) => rel.type.endsWith("/sharedStrings"))?.path;
  const strings = stringPath
    ? elements(xml(await zip.text(stringPath), stringPath), "si").map((item) => elements(item, "t").map((text) => text.textContent).join(""))
    : [];
  const date1904 = ["1", "true"].includes(elements(workbook, "workbookPr")[0]?.getAttribute("date1904"));
  const headers = ["no.", "uid", "wish type", "wish award", "wish time"];
  const records = [];
  let matchedSheet = false;
  for (const sheet of elements(workbook, "sheet")) {
    const id = Array.from(sheet.attributes).find((attribute) => attribute.localName === "id")?.value;
    const relation = rels.get(id);
    if (!relation?.type.endsWith("/worksheet")) continue;
    const document = xml(await zip.text(relation.path), relation.path);
    let columns;
    for (const row of elements(document, "row")) {
      const cells = new Map();
      for (const cell of Array.from(row.children).filter((child) => child.localName === "c")) {
        const reference = cell.getAttribute("r");
        const column = reference?.match(/^[A-Z]+/)?.[0];
        if (!column || cells.has(column)) throw new Error("Missing or duplicate workbook cell reference.");
        cells.set(column, { value: cellValue(cell, strings).trim(), type: cell.getAttribute("t") });
      }
      if (!columns) {
        const found = headers.map((header) => Array.from(cells).find(([, cell]) => cell.value.toLowerCase() === header)?.[0]);
        if (found.every(Boolean)) {
          columns = found;
          matchedSheet = true;
        }
        continue;
      }
      if (Array.from(cells.values()).every((cell) => cell.value === "")) continue;
      const values = columns.map((column) => cells.get(column)?.value ?? "");
      const location = `${sheet.getAttribute("name")}, row ${row.getAttribute("r")}`;
      if (values.some((value) => value === "")) throw new Error(`Missing wish data at ${location}.`);
      const timeCell = cells.get(columns[4]);
      let time = values[4];
      if ((!timeCell.type || timeCell.type === "n") && /^\d+(\.\d+)?$/.test(time)) {
        time = excelTime(time, date1904);
      } else if (timeCell.type === "d") {
        time = time.replace(/T/, " ").replace(/Z$/, "");
      }
      records.push({ number: values[0], uid: values[1], banner: values[2], name: values[3], time, location });
    }
  }
  if (!matchedSheet) throw new Error("No wish log found. Expected No., UID, Wish type, Wish award, and Wish time columns.");
  if (!records.length) throw new Error("The workbook contains no wishes.");
  return records;
}
