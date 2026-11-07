import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { crc32, openZip } from "../xlsx.js";
import { makeZip } from "./fixtures.js";

test("CRC32 matches the standard check vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("reads stored and deflated ZIP entries with native decompression", async () => {
  for (const [compress, method] of [[undefined, 0], [deflateRawSync, 8]]) {
    const zip = openZip(makeZip([["xl/sharedStrings.xml", "<sst>Hello &amp; goodbye</sst>"]], compress, method));
    assert.equal(zip.has("xl/sharedStrings.xml"), true);
    assert.equal(await zip.text("xl/sharedStrings.xml"), "<sst>Hello &amp; goodbye</sst>");
    await assert.rejects(zip.text("missing.xml"), /missing/);
  }
});

test("rejects invalid, truncated, duplicate and corrupt archives", async () => {
  assert.throws(() => openZip(new ArrayBuffer(5)), /valid XLSX/);
  const bytes = makeZip([["x.xml", "test"]]);
  assert.throws(() => openZip(bytes.slice(0, -1)), /valid XLSX/);
  assert.throws(() => openZip(makeZip([["x.xml", "a"], ["x.xml", "b"]])), /Duplicate/);
  new Uint8Array(bytes)[35] ^= 1;
  await assert.rejects(openZip(bytes).text("x.xml"), /corrupt/);
});

test("rejects encrypted and unsupported compression entries", async () => {
  const encrypted = makeZip([["x.xml", "test"]]);
  const view = new DataView(encrypted);
  const directory = view.getUint32(encrypted.byteLength - 6, true);
  view.setUint16(6, 1, true);
  view.setUint16(directory + 8, 1, true);
  await assert.rejects(openZip(encrypted).text("x.xml"), /Encrypted/);
  await assert.rejects(openZip(makeZip([["x.xml", "test"]], (bytes) => bytes, 99)).text("x.xml"), /compression method 99/);
});

test("enforces expansion limits and detects forged entry sizes", async () => {
  const buffer = makeZip([["x.xml", "test"]]);
  const view = new DataView(buffer);
  const directory = view.getUint32(buffer.byteLength - 6, true);
  view.setUint32(directory + 24, 101 * 1024 * 1024, true);
  assert.throws(() => openZip(buffer), /100 MiB/);
  const deflated = makeZip([["x.xml", "test"]], deflateRawSync, 8);
  const deflateView = new DataView(deflated);
  deflateView.setUint32(deflateView.getUint32(deflated.byteLength - 6, true) + 24, 1, true);
  await assert.rejects(openZip(deflated).text("x.xml"), /declared decompressed size/);
});
