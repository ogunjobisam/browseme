'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { extractZip, stripCrxHeader, isSafeEntryName } = require('../src/main/unzip');

/**
 * Build a ZIP archive in memory so the tests do not depend on a fixture file
 * or on the platform having an `unzip` binary.
 */
function buildZip(files, { compress = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(contents, 'utf8');
    const data = compress ? zlib.deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'browseme-test-'));
}

test('extracts a deflated archive', async () => {
  const dir = await tempDir();
  const zip = buildZip({
    'manifest.json': '{"name":"Test","version":"1.0.0","manifest_version":3}',
    'background.js': 'console.log("hi");',
  });

  const written = await extractZip(zip, dir);
  assert.deepEqual(written.sort(), ['background.js', 'manifest.json']);

  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Test');

  await fs.rm(dir, { recursive: true, force: true });
});

test('extracts a stored (uncompressed) archive', async () => {
  const dir = await tempDir();
  const zip = buildZip({ 'a.txt': 'plain bytes' }, { compress: false });

  await extractZip(zip, dir);
  assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'plain bytes');

  await fs.rm(dir, { recursive: true, force: true });
});

test('creates nested directories for nested entries', async () => {
  const dir = await tempDir();
  const zip = buildZip({ 'icons/16/icon.txt': 'icon' });

  await extractZip(zip, dir);
  assert.equal(await fs.readFile(path.join(dir, 'icons', '16', 'icon.txt'), 'utf8'), 'icon');

  await fs.rm(dir, { recursive: true, force: true });
});

test('refuses archive paths that escape the destination', async () => {
  const dir = await tempDir();
  const zip = buildZip({ '../escaped.txt': 'nope' });

  await assert.rejects(() => extractZip(zip, dir), /unsafe archive path/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('isSafeEntryName rejects traversal and absolute paths', () => {
  assert.equal(isSafeEntryName('manifest.json'), true);
  assert.equal(isSafeEntryName('icons/16.png'), true);
  assert.equal(isSafeEntryName('../etc/passwd'), false);
  assert.equal(isSafeEntryName('a/../../b'), false);
  assert.equal(isSafeEntryName('/etc/passwd'), false);
  assert.equal(isSafeEntryName('C:\\Windows\\system32'), false);
});

test('strips a CRX3 header to reveal the zip', () => {
  const zip = buildZip({ 'manifest.json': '{}' });
  const header = Buffer.from('fake protobuf header');

  const crx = Buffer.concat([
    Buffer.from('Cr24', 'ascii'),
    uint32(3),
    uint32(header.length),
    header,
    zip,
  ]);

  assert.deepEqual(stripCrxHeader(crx), zip);
});

test('strips a CRX2 header to reveal the zip', () => {
  const zip = buildZip({ 'manifest.json': '{}' });
  const key = Buffer.alloc(24, 1);
  const signature = Buffer.alloc(16, 2);

  const crx = Buffer.concat([
    Buffer.from('Cr24', 'ascii'),
    uint32(2),
    uint32(key.length),
    uint32(signature.length),
    key,
    signature,
    zip,
  ]);

  assert.deepEqual(stripCrxHeader(crx), zip);
});

test('a plain zip passes through the CRX stripper untouched', () => {
  const zip = buildZip({ 'manifest.json': '{}' });
  assert.deepEqual(stripCrxHeader(zip), zip);
});

function uint32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}
