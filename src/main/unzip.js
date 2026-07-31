'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const inflateRaw = promisify(zlib.inflateRaw);

/**
 * A minimal ZIP reader, enough to unpack a Chrome extension.
 *
 * Shelling out to `unzip` is not portable across the platforms this browser
 * targets, and pulling a dependency in for ~150 lines of well-specified
 * format parsing is not worth it. Only the two methods that matter are
 * supported: stored (0) and deflate (8).
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;

/** Locate the end-of-central-directory record, scanning back over any comment. */
function findEndOfCentralDirectory(buf) {
  const minOffset = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Reject paths that would escape the destination directory.
 * A crafted archive with `../../.bashrc` entries is the classic zip-slip.
 */
function isSafeEntryName(name) {
  if (!name || name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return !name.split(/[/\\]/).includes('..');
}

/** Parse the central directory into entry descriptors. */
function readEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) throw new Error('not a zip file (no end-of-central-directory record)');

  let entryCount = buf.readUInt16LE(eocd + 10);
  let centralOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in the
  // ZIP64 EOCD record pointed at by the locator just before the EOCD.
  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR) {
      const zip64Offset = Number(buf.readBigUInt64LE(locator + 8));
      entryCount = Number(buf.readBigUInt64LE(zip64Offset + 32));
      centralOffset = Number(buf.readBigUInt64LE(zip64Offset + 48));
    }
  }

  const entries = [];
  let pos = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) break;

    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      unixMode: (externalAttrs >>> 16) & 0xffff,
    });

    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Read one entry's bytes, following its local file header. */
async function readEntryData(buf, entry) {
  const local = entry.localOffset;
  if (local + 30 > buf.length) throw new Error(`corrupt entry: ${entry.name}`);
  const nameLength = buf.readUInt16LE(local + 26);
  const extraLength = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Extract a zip archive to a directory.
 * @param {Buffer} buffer archive contents
 * @param {string} destination directory to write into (created if needed)
 * @returns {Promise<string[]>} relative paths written
 */
async function extractZip(buffer, destination) {
  const entries = readEntries(buffer);
  const written = [];

  await fsp.mkdir(destination, { recursive: true });

  for (const entry of entries) {
    if (!isSafeEntryName(entry.name)) {
      throw new Error(`refusing unsafe archive path: ${entry.name}`);
    }
    const target = path.join(destination, entry.name);

    if (entry.name.endsWith('/')) {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    const data = await readEntryData(buffer, entry);
    await fsp.writeFile(target, data);
    written.push(entry.name);
  }

  return written;
}

/**
 * Strip a CRX (v2 or v3) header, returning the embedded zip.
 * Plain zips are passed through untouched.
 */
function stripCrxHeader(buffer) {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'Cr24') return buffer;

  const version = buffer.readUInt32LE(4);
  if (version === 2) {
    const publicKeyLength = buffer.readUInt32LE(8);
    const signatureLength = buffer.readUInt32LE(12);
    return buffer.subarray(16 + publicKeyLength + signatureLength);
  }
  if (version === 3) {
    const headerLength = buffer.readUInt32LE(8);
    return buffer.subarray(12 + headerLength);
  }
  throw new Error(`unsupported CRX version ${version}`);
}

/** Unpack a .crx or .zip file into a directory. */
async function extractArchiveFile(file, destination) {
  const buffer = await fsp.readFile(file);
  return extractZip(stripCrxHeader(buffer), destination);
}

/** True when the path exists and is a directory. */
function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

module.exports = { extractZip, extractArchiveFile, stripCrxHeader, isSafeEntryName, isDirectory };
