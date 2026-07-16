import { inflateRawSync } from 'node:zlib';
import { ExtensionError } from './errors.js';
import { EXTENSION_LIMITS } from './limits.js';
import { checkPackageRelativePath } from './paths.js';

/**
 * Deterministic ZIP creation and bounded, hostile-input-safe ZIP extraction.
 *
 * Creation always uses the store method (no compression) with a fixed
 * timestamp and sorted entries, so packaging the same files twice produces
 * byte-identical archives. Extraction additionally accepts deflate entries so
 * archives produced by common tools still install, but every entry is guarded:
 * validated relative paths, symlink rejection, per-archive file-count and
 * total-size limits (zip-bomb protection), CRC verification, and no ZIP64.
 */
export const EXTENSION_ARCHIVE_SUFFIX = '.specbridge-extension.zip';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
/** 2026-01-01 00:00:00 in DOS date/time format (matches the plugin ZIP). */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const UTF8_FLAG = 0x0800;

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  return crcTable;
}

export function crc32(buffer: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function invalidArchive(detail: string): ExtensionError {
  return new ExtensionError(
    'SBE008',
    `archive is not a valid extension package: ${detail}.`,
    'Rebuild the archive with `specbridge extension package <dir>` and try again.',
  );
}

/**
 * Create a deterministic store-method ZIP from a file map. Entries are sorted
 * by name; timestamps are fixed; names must already be safe relative paths.
 */
export function createDeterministicZip(files: ReadonlyMap<string, Buffer>): Buffer {
  const names = [...files.keys()].sort();
  if (names.length === 0) {
    throw invalidArchive('archive would contain no files');
  }
  if (names.length > EXTENSION_LIMITS.maxArchiveFileCount) {
    throw invalidArchive(`archive would contain ${names.length} files (limit ${EXTENSION_LIMITS.maxArchiveFileCount})`);
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const name of names) {
    const problem = checkPackageRelativePath(name);
    if (problem !== undefined) {
      throw invalidArchive(`entry "${name}": ${problem}`);
    }
    const content = files.get(name) ?? Buffer.alloc(0);
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8); // store
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10); // store
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);

    offset += 30 + nameBytes.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...localParts, centralDirectory, eocd]);
  if (archive.length > EXTENSION_LIMITS.maxArchiveBytes) {
    throw invalidArchive(
      `archive of ${archive.length} bytes exceeds the ${EXTENSION_LIMITS.maxArchiveBytes} byte limit`,
    );
  }
  return archive;
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  readonly externalAttributes: number;
}

/**
 * Extract a ZIP archive into an in-memory file map with all package guards
 * applied. Throws `ExtensionError` (SBE008/SBE010/SBE011) on any violation.
 */
export function extractZipArchive(archive: Buffer): Map<string, Buffer> {
  if (archive.length > EXTENSION_LIMITS.maxArchiveBytes) {
    throw invalidArchive(
      `archive of ${archive.length} bytes exceeds the ${EXTENSION_LIMITS.maxArchiveBytes} byte limit`,
    );
  }
  if (archive.length < 22) {
    throw invalidArchive('archive is too small to be a ZIP file');
  }

  // Locate the end-of-central-directory record from the tail.
  const searchStart = Math.max(0, archive.length - 22 - 65_535);
  let eocdOffset = -1;
  for (let index = archive.length - 22; index >= searchStart; index -= 1) {
    if (archive.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw invalidArchive('missing end-of-central-directory record');
  }

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw invalidArchive('ZIP64 archives are not supported');
  }
  if (entryCount > EXTENSION_LIMITS.maxArchiveFileCount) {
    throw invalidArchive(
      `archive declares ${entryCount} entries (limit ${EXTENSION_LIMITS.maxArchiveFileCount})`,
    );
  }
  if (centralOffset + centralSize > archive.length) {
    throw invalidArchive('central directory extends past the end of the archive');
  }

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw invalidArchive('corrupt central directory');
    }
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw invalidArchive('ZIP64 entries are not supported');
    }
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset, externalAttributes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  for (const entry of entries) {
    // Unix symlinks are encoded in the upper 16 external-attribute bits.
    const unixMode = (entry.externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new ExtensionError(
        'SBE011',
        `archive entry "${entry.name}" is a symbolic link.`,
        'Extension packages must not contain symlinks; repackage without links.',
      );
    }
    if (entry.name.endsWith('/')) {
      // Directory entry: validate the name but store nothing.
      const dirProblem = checkPackageRelativePath(entry.name.replace(/\/+$/, ''));
      if (dirProblem !== undefined) {
        throw invalidArchive(`directory entry "${entry.name}": ${dirProblem}`);
      }
      continue;
    }
    const problem = checkPackageRelativePath(entry.name);
    if (problem !== undefined) {
      throw invalidArchive(`entry "${entry.name}": ${problem}`);
    }
    if (files.has(entry.name)) {
      throw invalidArchive(`duplicate entry "${entry.name}"`);
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > EXTENSION_LIMITS.maxExtractedTotalBytes) {
      throw invalidArchive(
        `declared extracted size exceeds the ${EXTENSION_LIMITS.maxExtractedTotalBytes} byte limit`,
      );
    }

    if (entry.localOffset + 30 > archive.length || archive.readUInt32LE(entry.localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw invalidArchive(`corrupt local header for "${entry.name}"`);
    }
    const flags = archive.readUInt16LE(entry.localOffset + 6);
    if ((flags & 0x0001) !== 0) {
      throw invalidArchive(`entry "${entry.name}" is encrypted`);
    }
    const localNameLength = archive.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = archive.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > archive.length) {
      throw invalidArchive(`entry "${entry.name}" extends past the end of the archive`);
    }
    const compressed = archive.subarray(dataStart, dataEnd);

    let content: Buffer;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw invalidArchive(`stored entry "${entry.name}" has inconsistent sizes`);
      }
      content = Buffer.from(compressed);
    } else if (entry.method === 8) {
      try {
        content = inflateRawSync(compressed, {
          maxOutputLength: Math.min(
            entry.uncompressedSize,
            EXTENSION_LIMITS.maxExtractedTotalBytes,
          ),
        });
      } catch {
        throw invalidArchive(`entry "${entry.name}" failed to decompress within the declared size`);
      }
      if (content.length !== entry.uncompressedSize) {
        throw invalidArchive(`entry "${entry.name}" decompressed to an undeclared size`);
      }
    } else {
      throw invalidArchive(`entry "${entry.name}" uses unsupported compression method ${entry.method}`);
    }

    if (crc32(content) !== entry.crc) {
      throw new ExtensionError(
        'SBE009',
        `archive entry "${entry.name}" failed CRC verification.`,
        'The archive is corrupt or was modified; re-download or rebuild it.',
      );
    }
    files.set(entry.name, content);
  }

  if (files.size === 0) {
    throw invalidArchive('archive contains no files');
  }
  return files;
}
