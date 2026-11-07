export const METADATA_BASE = "https://raw.githubusercontent.com/MadeBaruna/paimon-moe/main/src/data/";
export const METADATA_FILES = ["characters.js", "weaponList.js", "banners.js"];

export function normalizeName(name) {
  return name.normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/'{2,}/g, "'").trim().replace(/\s+/g, " ").toLowerCase();
}

function stringLiteral(literal) {
  if (literal.startsWith('"')) return JSON.parse(literal);
  return literal.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|['"\\nrt])/g, (_, escape) => {
    if (escape.startsWith("u") || escape.startsWith("x")) return String.fromCharCode(parseInt(escape.slice(1), 16));
    return { n: "\n", r: "\r", t: "\t" }[escape] ?? escape;
  });
}

function stringField(body, field, indentation) {
  const match = body.match(new RegExp(`^ {${indentation}}${field}: ('(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*"),?\\s*$`, "m"));
  if (!match) throw new Error(`Paimon metadata format changed: missing ${field}.`);
  return stringLiteral(match[1]);
}

function listField(body, field) {
  const match = body.match(new RegExp(`^ {6}${field}: \\[([\\s\\S]*?)\\],?`, "m"));
  if (!match) throw new Error(`Paimon metadata format changed: missing ${field}.`);
  const tokens = Array.from(match[1].matchAll(/'([a-z0-9_-]+)'|"([a-z0-9_-]+)"/g));
  if (!tokens.length || match[1].replace(/'([a-z0-9_-]+)'|"([a-z0-9_-]+)"|[\s,]/g, "") !== "") {
    throw new Error(`Invalid Paimon ${field} metadata.`);
  }
  return tokens.map((token) => token[1] ?? token[2]);
}

export function parseMetadata(characterSource, weaponSource, bannerSource) {
  const items = new Map();
  for (const [source, type] of [[characterSource, "character"], [weaponSource, "weapon"]]) {
    let count = 0;
    // Extract data literals only; never evaluate downloaded JavaScript.
    for (const match of source.matchAll(/^ {2}(?:([a-z0-9_]+)|'([a-z0-9_-]+)'|"([a-z0-9_-]+)"): \{([\s\S]*?)^ {2}\},?/gm)) {
      const id = match[1] ?? match[2] ?? match[3];
      const rarity = Number(match[4].match(/^ {4}rarity: ([1-5]),?\s*$/m)?.[1]);
      if (![1, 2, 3, 4, 5].includes(rarity)) throw new Error(`Invalid rarity in Paimon metadata for ${id}.`);
      const name = stringField(match[4], "name", 4);
      const normalized = normalizeName(name);
      if (items.has(normalized)) throw new Error(`Ambiguous Paimon item name: ${name}.`);
      items.set(normalized, { id, name, type, rarity });
      count++;
    }
    if (!count) throw new Error(`Could not read Paimon ${type} metadata. Its source format may have changed.`);
  }
  const banners = {};
  for (const section of bannerSource.matchAll(/^ {2}(characters|weapons): \[([\s\S]*?)^ {2}\],?/gm)) {
    const entries = [];
    for (const match of section[2].matchAll(/^ {4}\{([\s\S]*?)^ {4}\},?/gm)) {
      entries.push({
        start: stringField(match[1], "start", 6),
        end: stringField(match[1], "end", 6),
        featured: listField(match[1], "featured"),
        featuredRare: listField(match[1], "featuredRare"),
        timezoneDependent: /^ {6}timezoneDependent: true,?\s*$/m.test(match[1]),
        timezoneDependentEnd: /^ {6}timezoneDependentEnd: true,?\s*$/m.test(match[1]),
      });
    }
    if (!entries.length) throw new Error(`Could not read Paimon ${section[1]} banners.`);
    banners[section[1]] = entries;
  }
  if (!banners.characters || !banners.weapons) throw new Error("Paimon banner metadata is incomplete.");
  return { items, banners };
}

export async function fetchMetadata(fetcher = fetch) {
  const sources = await Promise.all(METADATA_FILES.map(async (file) => {
    let response;
    try {
      response = await fetcher(`${METADATA_BASE}${file}`, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(30000),
      });
    } catch (cause) {
      throw new Error(`Could not fetch public Paimon metadata (${file}). Check your internet connection and retry.`, { cause });
    }
    if (!response.ok) throw new Error(`Paimon metadata request failed (${file}, HTTP ${response.status}). Please retry later.`);
    const text = await response.text();
    if (text.length > 3 * 1024 * 1024) throw new Error(`Paimon metadata ${file} exceeds the safety limit.`);
    return text;
  }));
  return parseMetadata(...sources);
}
