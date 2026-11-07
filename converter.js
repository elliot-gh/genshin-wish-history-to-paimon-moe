import { normalizeName } from "./metadata.js";

export const CATEGORIES = [
  { id: "beginners", label: "Beginners' Wish" },
  { id: "standard", label: "Standard Wish" },
  { id: "character-event", label: "Character Event Wish (1 + 2)" },
  { id: "weapon-event", label: "Weapon Event Wish" },
];
const bannerTypes = new Map([
  ["Novice Wish", { category: "beginners", code: "100" }],
  ["Beginners' Wish", { category: "beginners", code: "100" }],
  ["Standard Wish", { category: "standard", code: "200" }],
  ["Character Event Wish", { category: "character-event", code: "301" }],
  ["Character Event Wish-2", { category: "character-event", code: "400" }],
  ["Weapon Event Wish", { category: "weapon-event", code: "302" }],
]);
const HOUR = 3600000;

export function parseUtc(time) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) throw new Error(`Invalid UTC timestamp: ${time}.`);
  const timestamp = Date.parse(time.replace(" ", "T") + "Z");
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19).replace("T", " ") !== time) {
    throw new Error(`Invalid UTC timestamp: ${time}.`);
  }
  return timestamp;
}

export function utcOffsetMinutes(sign, hours, minutes) {
  if (!["+", "-"].includes(sign) || !Number.isInteger(hours) || hours < 0 || hours > 23 ||
      !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    throw new Error("Invalid UTC offset. Choose + or -, whole hours from 0 to 23, and whole minutes from 0 to 59.");
  }
  const total = hours * 60 + minutes;
  return sign === "-" && total !== 0 ? -total : total;
}

function validateUtcOffset(offsetMinutes) {
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 1439) {
    throw new Error("Invalid UTC offset. Use whole minutes between -23:59 and +23:59.");
  }
}

export function formatUtcOffset(offsetMinutes) {
  validateUtcOffset(offsetMinutes);
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `UTC${offsetMinutes < 0 ? "-" : "+"}${hours}:${minutes}`;
}

export function timeFormatter(offsetMinutes) {
  validateUtcOffset(offsetMinutes);
  return (timestamp) => new Date(timestamp + offsetMinutes * 60000).toISOString().slice(0, 19).replace("T", " ");
}

function serverOffset(uid) {
  const prefix = uid.length === 10 ? uid.slice(0, 2) : uid[0];
  const offsets = { 1: 8, 2: 8, 5: 8, 6: -5, 7: 1, 8: 8, 9: 8, 18: 8 };
  if (!(prefix in offsets)) throw new Error("Cannot identify this UID's server for banner metadata.");
  return offsets[prefix];
}

function emptyCounter(event) {
  const counter = { total: 0, legendary: 0, rare: 0, pulls: [] };
  if (event) {
    counter.guaranteed = { legendary: false, rare: false };
    const emptyRate = () => ({ win: 0, lose: 0, maxStreak: 0, currentStreak: 0 });
    counter.rateoff = { legendary: emptyRate(), rare: emptyRate() };
  }
  return counter;
}

function updateRate(counter, level, featured) {
  const guaranteed = counter.guaranteed[level];
  const tally = counter.rateoff[level];
  if (!featured) {
    tally.lose++;
    tally.currentStreak = 0;
  } else if (!guaranteed) {
    tally.win++;
    tally.currentStreak++;
    tally.maxStreak = Math.max(tally.maxStreak, tally.currentStreak);
  }
  counter.guaranteed[level] = !featured;
  return Number(guaranteed) + Number(featured);
}

export function convertWishes(records, metadata, offsetMinutes) {
  if (!records.length) throw new Error("No wishes to convert.");
  const formatTime = timeFormatter(offsetMinutes);
  const uid = String(records[0].uid);
  if (!/^[1-9]\d{8,9}$/.test(uid)) throw new Error("Workbook UID must contain 9 or 10 digits.");
  const numbers = new Set();
  const unknown = new Set();
  const prepared = records.map((record) => {
    const location = record.location ?? `wish ${record.number}`;
    if (String(record.uid) !== uid) throw new Error(`Workbook contains multiple UIDs (${location}). Convert one account at a time.`);
    const number = Number(record.number);
    if (!/^\d+$/.test(String(record.number)) || !Number.isSafeInteger(number) || number < 1 || numbers.has(number)) {
      throw new Error(`Invalid or duplicate wish sequence number at ${location}.`);
    }
    numbers.add(number);
    const banner = bannerTypes.get(record.banner);
    if (!banner) throw new Error(`Unsupported wish type "${record.banner}" at ${location}.`);
    const item = metadata.items.get(normalizeName(record.name));
    if (!item) unknown.add(record.name);
    if (item && ![3, 4, 5].includes(item.rarity)) throw new Error(`Non-wish item "${record.name}" at ${location}.`);
    return { ...record, number, timestamp: parseUtc(record.time), banner, item };
  });
  if (unknown.size) throw new Error(`Paimon metadata is missing these items; no export was generated:\n${Array.from(unknown).join(", ")}.\nRetry after Paimon's public metadata is updated.`);
  // HoYo numbers rows newest-first, including the order within a ten-pull.
  prepared.sort((left, right) => left.timestamp - right.timestamp || right.number - left.number);
  const offset = serverOffset(uid);
  const schedules = {};
  for (const [category, type] of [["character-event", "characters"], ["weapon-event", "weapons"]]) {
    schedules[category] = metadata.banners[type].map((banner) => ({
      ...banner,
      start: parseUtc(banner.start) - (banner.timezoneDependent ? 8 : offset) * HOUR,
      end: parseUtc(banner.end) - (banner.timezoneDependentEnd ? 8 : offset) * HOUR,
    }));
    if (schedules[category].some((banner) => banner.end <= banner.start)) throw new Error("Paimon metadata contains an invalid banner interval.");
  }
  const output = {};
  for (const category of CATEGORIES) {
    output[`wish-counter-${category.id}`] = emptyCounter(category.id.endsWith("-event"));
  }
  for (const record of prepared) {
    const counter = output[`wish-counter-${record.banner.category}`];
    counter.total++;
    counter.legendary++;
    counter.rare++;
    const pull = {
      type: record.item.type,
      code: record.banner.code,
      id: record.item.id,
      time: formatTime(record.timestamp),
      pity: 1,
    };
    if (record.item.rarity === 5 || record.item.rarity === 4) {
      const level = record.item.rarity === 5 ? "legendary" : "rare";
      pull.pity = counter[level];
      counter[level] = 0;
      // Paimon keeps the 4-star counter running when a 5-star is pulled.
      if (counter.guaranteed) {
        const active = schedules[record.banner.category].filter((banner) => record.timestamp >= banner.start && record.timestamp < banner.end);
        if (!active.length) throw new Error(`No public banner metadata covers ${record.banner.category} at ${record.time} UTC. No export was generated.`);
        const fields = level === "legendary" ? "featured" : "featuredRare";
        const signatures = new Set(active.map((banner) => [...banner[fields]].sort().join(",")));
        if (signatures.size > 1) throw new Error(`Conflicting public banner metadata at ${record.time} UTC.`);
        pull.rate = updateRate(counter, level, active[0][fields].includes(record.item.id));
      }
    }
    counter.pulls.push(pull);
  }
  output["wish-counter-setting"] = { firstTime: false, manualInput: false };
  output["wish-uid"] = uid;
  return output;
}
