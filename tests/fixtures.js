import { crc32 } from "../xlsx.js";

const encoder = new TextEncoder();

export function makeZip(files, compress = (bytes) => bytes, method = 0) {
  const chunks = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = encoder.encode(name);
    const bytes = encoder.encode(text);
    const compressed = compress(bytes);
    const local = new Uint8Array(30 + nameBytes.length + compressed.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(8, method, true);
    header.setUint32(14, crc32(bytes), true);
    header.setUint32(18, compressed.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, method, true);
    entry.setUint32(16, crc32(bytes), true);
    entry.setUint32(20, compressed.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    chunks.push(local);
    directory.push(central);
    offset += local.length;
  }
  const directorySize = directory.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const header = new DataView(end.buffer);
  header.setUint32(0, 0x06054b50, true);
  header.setUint16(8, files.length, true);
  header.setUint16(10, files.length, true);
  header.setUint32(12, directorySize, true);
  header.setUint32(16, offset, true);
  const zip = new Uint8Array(offset + directorySize + end.length);
  let position = 0;
  for (const chunk of [...chunks, ...directory, end]) {
    zip.set(chunk, position);
    position += chunk.length;
  }
  return zip.buffer;
}

export const metadataSources = [
  `export const characters = {
  bennett: {
    id: 'bennett',
    name: 'Bennett',
    rarity: 4,
  },
  jean: {
    id: 'jean',
    name: 'Jean',
    rarity: 5,
  },
  kaedehara_kazuha: {
    id: 'kaedehara_kazuha',
    name: 'Kaedehara Kazuha',
    rarity: 5,
  },
};`,
  `export const weaponList = {
  sharpshooters_oath: {
    name: "Sharpshooter's Oath",
    rarity: 3,
  },
  favonius_sword: {
    name: 'Favonius Sword',
    rarity: 4,
  },
  skyward_blade: {
    name: 'Skyward Blade',
    rarity: 5,
  },
};`,
  `export const banners = {
  characters: [
    // {
    //   start: '2000-01-01 00:00:00',
    //   end: '2200-01-01 00:00:00',
    //   featured: ['jean'],
    //   featuredRare: ['bennett'],
    // },
    {
      start: '2000-01-01 00:00:00',
      end: '2200-01-01 00:00:00',
      featured: ['kaedehara_kazuha'],
      featuredRare: [
        'bennett',
      ],
      timezoneDependent: true,
    },
  ],
  weapons: [
    {
      start: '2000-01-01 00:00:00',
      end: '2200-01-01 00:00:00',
      featured: ['skyward_blade'],
      featuredRare: ['favonius_sword'],
    },
  ],
};`,
];

export function wish(number, name = "Sharpshooter''s Oath", banner = "Character Event Wish", time = "2024-01-01 08:00:00") {
  return { number: String(number), uid: "799999999", name, banner, time };
}

const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const escapeXml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export function workbookFixture({ shared = false, time = "2024-01-01 08:00:00", numeric = false, date1904 = false, missing = false, formula = false } = {}) {
  const strings = ["Wish log", "No.", "UID", "Wish type", "Wish award", "Wish time", "1", "799999999", "Standard Wish", "Sharpshooter''s Oath", time];
  const cell = (reference, index) => shared
    ? `<c r="${reference}" t="s"><v>${index}</v></c>`
    : `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(strings[index])}</t></is></c>`;
  const date = numeric ? `<c r="E3"><v>${time}</v></c>` : cell("E3", 10);
  const sheet = `<worksheet xmlns="${ns}"><sheetData>
    <row r="1">${cell("A1", 0)}</row>
    <row r="2">${["A", "B", "C", "D", "E"].map((column, index) => cell(`${column}2`, index + 1)).join("")}</row>
    <row r="3">${cell("A3", 6)}${cell("B3", 7)}${cell("C3", 8)}${missing ? "" : formula ? '<c r="D3"><f>1+1</f><v>2</v></c>' : cell("D3", 9)}${date}</row>
    <row r="4"><c r="A4"/></row>
    </sheetData></worksheet>`;
  return makeZip([
    ["_rels/.rels", `<Relationships xmlns="${relationNs}"><Relationship Id="book" Type="${officeNs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<workbook xmlns="${ns}" xmlns:r="${officeNs}"><workbookPr date1904="${Number(date1904)}"/><sheets><sheet name="Wish Log" sheetId="1" r:id="sheet"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships xmlns="${relationNs}"><Relationship Id="sheet" Type="${officeNs}/worksheet" Target="/xl/worksheets/log.xml"/>${shared ? `<Relationship Id="strings" Type="${officeNs}/sharedStrings" Target="sharedStrings.xml"/>` : ""}</Relationships>`],
    ["xl/worksheets/log.xml", sheet],
    ...(shared ? [["xl/sharedStrings.xml", `<sst xmlns="${ns}">${strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join("")}</sst>`]] : []),
  ]);
}
