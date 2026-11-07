import assert from "node:assert/strict";
import { test } from "node:test";
import { convertWishes, formatUtcOffset, parseUtc, timeFormatter, utcOffsetMinutes } from "../converter.js";
import { fetchMetadata, METADATA_BASE, METADATA_FILES, normalizeName, parseMetadata } from "../metadata.js";
import { metadataSources, wish } from "./fixtures.js";

const metadata = () => parseMetadata(...metadataSources);

test("maps public item names to canonical IDs, types and rarity without executing source", () => {
  const data = parseMetadata(...metadataSources.map((source) => source + "\nthrow new Error('must not execute');"));
  assert.equal(data.items.get(normalizeName(" Sharpshooter''s  Oath ")).id, "sharpshooters_oath");
  assert.equal(data.items.get(normalizeName("Sharpshooter\u2019s Oath")).rarity, 3);
  assert.equal(data.banners.characters.length, 1);
  assert.deepEqual(data.banners.characters[0].featuredRare, ["bennett"]);
});

test("fails explicitly on changed, incomplete or ambiguous metadata", () => {
  assert.throws(() => parseMetadata("", metadataSources[1], metadataSources[2]), /Could not read/);
  assert.throws(() => parseMetadata(metadataSources[0], metadataSources[1], ""), /incomplete/);
  assert.throws(() => parseMetadata(metadataSources[0].replace("rarity: 4", "rarity: 7"), ...metadataSources.slice(1)), /rarity/);
  assert.throws(() => parseMetadata(metadataSources[0].replace("name: 'Jean'", "name: 'Bennett'"), ...metadataSources.slice(1)), /Ambiguous/);
});

test("accepts non-wish catalog entries but rejects them as workbook awards", () => {
  const source = metadataSources[1].replace("};", "  hunters_bow: {\n    name: 'Hunter Bow',\n    rarity: 2,\n  },\n};");
  const data = parseMetadata(metadataSources[0], source, metadataSources[2]);
  assert.equal(data.items.get("hunter bow").rarity, 2);
  assert.throws(() => convertWishes([wish(1, "Hunter Bow")], data, 0), /Non-wish item/);
});

test("preserves quoted hyphenated Paimon IDs in catalogs and featured lists", () => {
  const weaponSource = metadataSources[1].replace("skyward_blade:", "'skyward-blade':");
  const bannerSource = metadataSources[2].replace("'skyward_blade'", "'skyward-blade'");
  const data = parseMetadata(metadataSources[0], weaponSource, bannerSource);
  const counter = convertWishes([wish(1, "Skyward Blade", "Weapon Event Wish")], data, 0)["wish-counter-weapon-event"];
  assert.equal(counter.pulls[0].id, "skyward-blade");
  assert.equal(counter.pulls[0].rate, 1);
});

test("fetches only public metadata with no credentials or workbook payload", async () => {
  const urls = [];
  const result = await fetchMetadata(async (url, options) => {
    urls.push(url);
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.equal(options.body, undefined);
    return new Response(metadataSources[METADATA_FILES.indexOf(url.slice(METADATA_BASE.length))]);
  });
  assert.equal(result.items.size, 6);
  assert.deepEqual(urls, METADATA_FILES.map((file) => METADATA_BASE + file));
});

test("reports network and HTTP errors rather than returning empty metadata", async () => {
  await assert.rejects(fetchMetadata(async () => { throw new Error("offline"); }), /internet connection/);
  await assert.rejects(fetchMetadata(async () => new Response("", { status: 503 })), /HTTP 503/);
});

test("exports exact wish-only shape, shared character pity, original codes, rates and UID", () => {
  const result = convertWishes([
    wish(1, "Kaedehara Kazuha"), wish(2, "Bennett"), wish(3, "Favonius Sword"),
    wish(4, "Kaedehara Kazuha", "Character Event Wish-2"), wish(5, "Jean"), wish(6),
  ], metadata(), 0);
  assert.deepEqual(Object.keys(result).sort(), [
    "wish-counter-beginners", "wish-counter-character-event", "wish-counter-setting",
    "wish-counter-standard", "wish-counter-weapon-event", "wish-uid",
  ]);
  assert.equal(result["wish-uid"], "799999999");
  assert.deepEqual(result["wish-counter-setting"], { firstTime: false, manualInput: false });
  const counter = result["wish-counter-character-event"];
  assert.deepEqual(counter.pulls.map((pull) => pull.pity), [1, 2, 1, 4, 1, 3]);
  assert.deepEqual(counter.pulls.map((pull) => pull.rate), [undefined, 0, 2, 0, 2, 1]);
  assert.equal(counter.pulls[2].code, "400");
  assert.deepEqual(counter.pulls[0], { type: "weapon", code: "301", id: "sharpshooters_oath", time: "2024-01-01 08:00:00", pity: 1 });
  assert.equal(counter.total, 6);
  assert.equal(counter.legendary, 0);
  assert.equal(counter.rare, 1);
  assert.deepEqual(counter.guaranteed, { legendary: false, rare: false });
  assert.deepEqual(counter.rateoff, {
    legendary: { win: 1, lose: 1, maxStreak: 1, currentStreak: 1 },
    rare: { win: 0, lose: 1, maxStreak: 0, currentStreak: 0 },
  });
  assert.deepEqual(result["wish-counter-beginners"], { total: 0, legendary: 0, rare: 0, pulls: [] });
});

test("independent beginner, standard and weapon counters retain repeated wishes", () => {
  const result = convertWishes([
    wish(1, "Skyward Blade", "Weapon Event Wish"), wish(2, "Favonius Sword", "Standard Wish"),
    wish(3, "Bennett", "Novice Wish"), wish(4), wish(5),
  ], metadata(), 0);
  assert.equal(result["wish-counter-beginners"].pulls[0].code, "100");
  assert.equal(result["wish-counter-standard"].pulls[0].code, "200");
  assert.equal(result["wish-counter-weapon-event"].pulls[0].code, "302");
  assert.equal(result["wish-counter-character-event"].total, 2);
  assert.equal(result["wish-counter-weapon-event"].rateoff.legendary.win, 1);
  assert.equal(result["wish-counter-standard"].pulls[0].rate, undefined);
});

test("applies the same fixed offset in winter and summer, including midnight", () => {
  const format = timeFormatter(-480);
  assert.equal(format(parseUtc("2024-01-01 08:00:00")), "2024-01-01 00:00:00");
  assert.equal(format(parseUtc("2024-07-01 08:00:00")), "2024-07-01 00:00:00");
});

test("formats positive and negative minute offsets and date rollovers", () => {
  assert.equal(timeFormatter(345)(parseUtc("2024-01-01 20:00:00")), "2024-01-02 01:45:00");
  assert.equal(timeFormatter(-210)(parseUtc("2024-01-01 02:00:00")), "2023-12-31 22:30:00");
  assert.equal(timeFormatter(840)(parseUtc("2024-12-31 12:00:00")), "2025-01-01 02:00:00");
  assert.equal(timeFormatter(0)(parseUtc("2024-01-01 00:00:00")), "2024-01-01 00:00:00");
});

test("validates numeric offset components and formats UTC labels", () => {
  assert.equal(utcOffsetMinutes("+", 5, 45), 345);
  assert.equal(utcOffsetMinutes("-", 3, 30), -210);
  assert.equal(utcOffsetMinutes("-", 0, 45), -45);
  assert.equal(utcOffsetMinutes("-", 0, 0), 0);
  assert.equal(formatUtcOffset(345), "UTC+05:45");
  assert.equal(formatUtcOffset(-210), "UTC-03:30");
  assert.equal(formatUtcOffset(0), "UTC+00:00");
  assert.equal(utcOffsetMinutes("+", 23, 59), 1439);
  assert.equal(utcOffsetMinutes("-", 23, 59), -1439);
  for (const parts of [["", 0, 0], ["+", 24, 0], ["+", -1, 0], ["+", 1.5, 0], ["+", 0, 60], ["+", 0, -1], ["+", 0, 1.5], ["+", NaN, 0]]) {
    assert.throws(() => utcOffsetMinutes(...parts), /Invalid UTC offset/);
  }
  for (const offset of ["UTC", NaN, Infinity, undefined, 0.5, -1440, 1440]) {
    assert.throws(() => timeFormatter(offset), /Invalid UTC offset/);
    assert.throws(() => formatUtcOffset(offset), /Invalid UTC offset/);
  }
});

test("keeps UTC chronology across a daylight-saving transition with a fixed offset", () => {
  const result = convertWishes([
    wish(1, "Bennett", "Standard Wish", "2024-11-03 09:10:00"),
    wish(2, "Jean", "Standard Wish", "2024-11-03 08:50:00"),
  ], metadata(), -480);
  const pulls = result["wish-counter-standard"].pulls;
  assert.deepEqual(pulls.map((pull) => pull.id), ["jean", "bennett"]);
  assert.deepEqual(pulls.map((pull) => pull.time), ["2024-11-03 00:50:00", "2024-11-03 01:10:00"]);
  assert.equal(pulls[1].pity, 2);
});

test("matches server-local and simultaneous Asia banner boundaries independently of output timezone", () => {
  const data = metadata();
  data.banners.characters = [{
    start: "2024-01-01 18:00:00", end: "2024-01-02 18:00:00",
    featured: ["kaedehara_kazuha"], featuredRare: ["bennett"],
  }];
  const record = wish(1, "Bennett", "Character Event Wish", "2024-01-01 17:00:00");
  assert.equal(convertWishes([record], data, -480)["wish-counter-character-event"].pulls[0].rate, 1);
  assert.throws(() => convertWishes([{ ...record, time: "2024-01-02 17:00:00" }], data, 0), /No public banner/);
  data.banners.characters[0].timezoneDependent = true;
  assert.equal(convertWishes([{ ...record, time: "2024-01-01 10:00:00" }], data, 0)["wish-counter-character-event"].total, 1);
});

test("rejects empty input, mixed UIDs, duplicate sequences, invalid timestamps, unknown items and banners", () => {
  const data = metadata();
  assert.throws(() => convertWishes([], data, 0), /No wishes/);
  assert.throws(() => convertWishes([wish(1)], data, 1440), /UTC offset/);
  assert.throws(() => convertWishes([wish(1), { ...wish(2), uid: "899999999" }], data, 0), /multiple UIDs/);
  assert.throws(() => convertWishes([wish(1), wish(1)], data, 0), /duplicate wish/);
  assert.throws(() => convertWishes([wish(-1)], data, 0), /sequence/);
  assert.throws(() => parseUtc("2024-02-30 00:00:00"), /Invalid UTC/);
  assert.throws(() => parseUtc("2024-01-01 24:00:00"), /Invalid UTC/);
  assert.throws(() => convertWishes([wish(1, "Unknown Award")], data, 0), /missing these items/);
  assert.throws(() => convertWishes([wish(1, "Bennett", "Chronicled Wish")], data, 0), /Unsupported wish type/);
});

test("fails on missing and conflicting banner metadata without guessed rates", () => {
  const data = metadata();
  data.banners.characters = [];
  assert.throws(() => convertWishes([wish(1, "Bennett")], data, 0), /No public banner/);
  data.banners.characters = [metadata().banners.characters[0], { ...metadata().banners.characters[0], featuredRare: ["favonius_sword"] }];
  assert.throws(() => convertWishes([wish(1, "Bennett")], data, 0), /Conflicting/);
});
