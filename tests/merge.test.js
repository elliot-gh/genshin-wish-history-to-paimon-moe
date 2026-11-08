import assert from "node:assert/strict";
import { test } from "node:test";
import { convertWishes, parsePaimonJson, wishAccountPrefix } from "../converter.js";
import { parseMetadata } from "../metadata.js";
import { metadataSources, wish } from "./fixtures.js";

const metadata = () => parseMetadata(...metadataSources);
const convert = (records, existing, offset = 0) => convertWishes(records, metadata(), offset, existing);
const standard = (number, name = "Sharpshooter''s Oath", time = "2024-01-01 08:00:00") =>
  wish(number, name, "Standard Wish", time);

test("reads Paimon JSON, including BOM, and rejects invalid backups explicitly", () => {
  const data = convert([standard(1)]);
  assert.deepEqual(parsePaimonJson("\uFEFF" + JSON.stringify(data)), data);
  for (const text of ["", "{", "null", "[]", "42", "{}", '{"unrelated":true}']) {
    assert.throws(() => parsePaimonJson(text), /JSON|Paimon/);
  }
  assert.throws(() => convert([standard(1)], []), /JSON object/);
});

test("merges older, overlapping and newer wishes, preserving backup and pull extras without mutation", () => {
  const old = standard(3, "Jean", "2023-12-31 08:00:00");
  const overlap = standard(2);
  const recent = standard(1, "Bennett", "2024-01-02 08:00:00");
  const existing = convert([old, overlap]);
  existing.characters = { jean: { level: 80 } };
  existing.inventory = { mora: 100 };
  existing.accounts = [{ label: "Main", value: "main" }];
  existing["wish-counter-setting"].manualInput = true;
  existing["wish-counter-standard"].custom = { preserved: true };
  existing["wish-counter-standard"].pulls[1].manualInput = true;
  existing["wish-counter-standard"].pulls[1].wishId = "1234567890123456789";
  const snapshot = structuredClone(existing);
  const result = convert([overlap, recent], existing);
  assert.deepEqual(existing, snapshot);
  for (const key of ["characters", "inventory", "accounts", "wish-counter-setting", "wish-counter-beginners"]) {
    assert.deepEqual(result[key], snapshot[key]);
  }
  const counter = result["wish-counter-standard"];
  assert.equal(counter.total, 3);
  assert.equal(counter.legendary, 2);
  assert.equal(counter.rare, 0);
  assert.deepEqual(counter.pulls.map((pull) => pull.id), ["jean", "sharpshooters_oath", "bennett"]);
  assert.deepEqual(counter.pulls.map((pull) => pull.pity), [1, 1, 3]);
  assert.equal(counter.pulls[1].manualInput, true);
  assert.equal(counter.pulls[1].wishId, "1234567890123456789");
  assert.deepEqual(counter.custom, { preserved: true });
  assert.deepEqual(convert([overlap, recent], result), result);
});

test("prepended wishes update subsequent pity and event guarantees/rates", () => {
  const newer = wish(1, "Kaedehara Kazuha", "Character Event Wish-2", "2024-01-02 08:00:00");
  const existing = convert([newer]);
  assert.equal(existing["wish-counter-character-event"].pulls[0].rate, 1);
  const records = [
    newer, wish(2), wish(3, "Jean", "Character Event Wish", "2023-12-31 08:00:00"),
  ];
  const result = convert(records, existing);
  assert.deepEqual(result, convert(records));
  const counter = result["wish-counter-character-event"];
  assert.deepEqual(counter.pulls.map((pull) => pull.rate), [0, undefined, 2]);
  assert.deepEqual(counter.pulls.map((pull) => pull.pity), [1, 1, 2]);
  assert.equal(counter.rateoff.legendary.lose, 1);
  assert.equal(counter.rateoff.legendary.win, 0);
  assert.equal(counter.guaranteed.legendary, false);
});

test("consumes overlap occurrences individually instead of collapsing repeated ten-pull items", () => {
  const existing = convert([standard(2), standard(1)]);
  existing["wish-counter-standard"].pulls[0].note = "first imported copy";
  const result = convert([standard(3), standard(2), standard(1)], existing);
  assert.equal(result["wish-counter-standard"].total, 3);
  assert.equal(result["wish-counter-standard"].pulls[0].note, "first imported copy");
  assert.deepEqual(convert([standard(1)], result), result);
  assert.deepEqual(convert([standard(3), standard(2), standard(1)], result), result);
  assert.equal(convert([standard(3), standard(2), standard(1)])["wish-counter-standard"].total, 3);
});

test("overlap anchors preserve chronological ten-pull order when inserting missing wishes", () => {
  const records = [standard(3, "Jean"), standard(2), standard(1, "Bennett")];
  const existing = convert([records[0], records[2]]);
  existing["wish-counter-standard"].pulls[0].note = "keep this";
  const result = convert(records, existing);
  assert.deepEqual(result["wish-counter-standard"].pulls.map((pull) => pull.id), ["jean", "sharpshooters_oath", "bennett"]);
  assert.deepEqual(result["wish-counter-standard"].pulls.map((pull) => pull.pity), [1, 1, 3]);
  assert.equal(result["wish-counter-standard"].pulls[0].note, "keep this");
});

test("matches absent or numeric banner codes but preserves distinct character-event codes", () => {
  const record = wish(1);
  const existing = convert([record]);
  delete existing["wish-counter-character-event"].pulls[0].code;
  const result = convert([record], existing);
  assert.deepEqual(result, existing);
  existing["wish-counter-character-event"].pulls[0].code = 301;
  assert.deepEqual(convert([record], existing), existing);
  const differentBanner = { ...record, banner: "Character Event Wish-2" };
  assert.equal(convert([differentBanner], existing)["wish-counter-character-event"].total, 2);
});

test("exact banner-code matches are used before code-less imported occurrences", () => {
  const records = [wish(2), wish(1)];
  const existing = convert(records);
  delete existing["wish-counter-character-event"].pulls[0].code;
  const incoming = [wish(2), wish(1, "Sharpshooter''s Oath", "Character Event Wish-2")];
  assert.deepEqual(convert(incoming, existing), existing);
});

test("same item/time on independent wish categories does not overlap", () => {
  const existing = convert([standard(1)]);
  const result = convert([wish(1)], existing);
  assert.equal(result["wish-counter-standard"].total, 1);
  assert.equal(result["wish-counter-character-event"].total, 1);
});

test("matches fixed-offset backup timestamps with minute offsets and date rollovers", () => {
  const records = [standard(2, "Jean", "2024-01-01 20:00:00"), standard(1, "Bennett", "2024-01-02 20:00:00")];
  for (const offset of [345, -210, 0]) {
    const existing = convert([records[0]], undefined, offset);
    assert.deepEqual(convert(records, existing, offset), convert(records, undefined, offset));
    assert.deepEqual(convert(records, convert(records, undefined, offset), offset), convert(records, undefined, offset));
  }
});

test("updates a matching secondary account without modifying main or other accounts", () => {
  const existing = convert([{ ...standard(1), uid: "899999999" }]);
  const secondary = convert([standard(2)]);
  for (const [key, value] of Object.entries(secondary)) existing[`alt-${key}`] = value;
  existing.accounts = [{ label: "Main", value: "main" }, { label: "Alt", value: "alt" }];
  existing["alt-wish-counter-chronicled"] = { custom: "untouched" };
  existing["another-wish-uid"] = "699999999";
  const snapshot = structuredClone(existing);
  const result = convert([standard(2), standard(1, "Bennett", "2024-01-02 08:00:00")], existing);
  assert.equal(wishAccountPrefix(result, "799999999"), "alt-");
  assert.equal(result["alt-wish-counter-standard"].total, 2);
  assert.deepEqual(result["alt-wish-counter-chronicled"], snapshot["alt-wish-counter-chronicled"]);
  for (const [key, value] of Object.entries(snapshot).filter(([key]) => !key.startsWith("alt-wish-counter-standard"))) {
    assert.deepEqual(result[key], value);
  }
  assert.deepEqual(existing, snapshot);
});

test("rejects mismatched, missing and ambiguous account identities rather than mixing wishes", () => {
  const existing = convert([standard(1)]);
  assert.throws(() => convert([{ ...standard(1), uid: "899999999" }], existing), /UID does not match/);
  const noUid = structuredClone(existing);
  delete noUid["wish-uid"];
  assert.throws(() => convert([standard(1)], noUid), /no UID/);
  existing["alt-wish-uid"] = existing["wish-uid"];
  assert.throws(() => convert([standard(1)], existing), /multiple accounts/);
  const empty = { accounts: [{ label: "Main", value: "main" }], "wish-uid": null };
  assert.equal(convert([standard(1)], empty)["wish-uid"], "799999999");
});

test("rejects malformed existing counters, timestamps and unsupported codes", () => {
  const original = convert([standard(1)]);
  for (const alter of [
    (data) => { data["wish-counter-standard"] = null; },
    (data) => { data["wish-counter-standard"].pulls = {}; },
    (data) => { data["wish-counter-standard"].total = 2; },
    (data) => { data["wish-counter-standard"].rare = -1; },
    (data) => { data["wish-counter-standard"].pulls[0] = null; },
    (data) => { data["wish-counter-standard"].pulls[0].time = "2024-02-30 08:00:00"; },
    (data) => { data["wish-counter-standard"].pulls[0].code = "301"; },
    (data) => { data["wish-counter-standard"].pulls[0].type = "unknown"; },
  ]) {
    const data = structuredClone(original);
    alter(data);
    assert.throws(() => convert([standard(1)], data), /invalid|Invalid/);
  }
});

test("preserves unaffected unknown items but fails if they prevent reliable merged statistics", () => {
  const existing = convert([standard(1)]);
  existing["wish-counter-standard"].pulls[0].id = "future_item";
  assert.deepEqual(convert([wish(1)], existing)["wish-counter-standard"], existing["wish-counter-standard"]);
  assert.throws(() => convert([standard(1)], existing), /missing existing wish item/);
});
