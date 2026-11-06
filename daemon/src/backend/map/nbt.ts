/**
 * A chunk-only NBT reader. The generic parser builds objects for light arrays,
 * heightmaps, entities and every other tag the map never looks at, which costs
 * about ten times more than the rest of a tile.
 */

const CORRUPT = "MC_MAP_CORRUPT";
const MAX_ELEMENTS = 1 << 22;
const MAX_BYTES = 8 * 1024 * 1024;

const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
} as const;

export interface ChunkSection {
  Y?: number;
  block_states?: { palette?: unknown[]; data?: ChunkLongs };
  Palette?: unknown[];
  BlockStates?: ChunkLongs;
  Blocks?: Buffer;
  Add?: Buffer;
  biomes?: { palette?: unknown[]; data?: ChunkLongs };
}

export interface ChunkNbt {
  DataVersion?: number;
  sections?: ChunkSection[];
  Level?: { DataVersion?: number; Sections?: ChunkSection[] };
}

type Reader = (cursor: Cursor, type: number) => unknown;

/**
 * A long array kept as its original bytes. Splitting it into 32-bit words costs
 * about a third of what building BigInts for every entry does, and the palette
 * reader can skip the split entirely for sections a surface scan never touches.
 */
export class ChunkLongs {
  constructor(readonly buffer: Buffer, readonly start: number, readonly count: number) {}

  get length() {
    return this.count;
  }

  /** Big-endian longs become `high`/`low` word pairs. */
  split(high: Uint32Array, low: Uint32Array) {
    for (let i = 0; i < this.count; i++) {
      high[i] = this.buffer.readUInt32BE(this.start + i * 8);
      low[i] = this.buffer.readUInt32BE(this.start + i * 8 + 4);
    }
    return this;
  }
}

class Cursor {
  offset = 0;

  constructor(private readonly buffer: Buffer) {}

  private need(bytes: number) {
    if (bytes < 0 || this.offset + bytes > this.buffer.length) throw new Error(CORRUPT);
  }

  tag() {
    this.need(1);
    return this.buffer.readUInt8(this.offset++);
  }

  byte() {
    this.need(1);
    return this.buffer.readInt8(this.offset++);
  }

  int() {
    this.need(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  text() {
    this.need(2);
    const length = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    this.need(length);
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  longs() {
    const length = this.int();
    if (length < 0 || length > MAX_ELEMENTS) throw new Error(CORRUPT);
    this.need(length * 8);
    const value = new ChunkLongs(this.buffer, this.offset, length);
    this.offset += length * 8;
    return value;
  }

  bytes() {
    const length = this.int();
    if (length < 0 || length > MAX_BYTES) throw new Error(CORRUPT);
    this.need(length);
    const values = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return values;
  }

  skip(type: number) {
    switch (type) {
      case TAG.BYTE: this.need(1); this.offset += 1; return;
      case TAG.SHORT: this.need(2); this.offset += 2; return;
      case TAG.INT: case TAG.FLOAT: this.need(4); this.offset += 4; return;
      case TAG.LONG: case TAG.DOUBLE: this.need(8); this.offset += 8; return;
      case TAG.BYTE_ARRAY: this.bytes(); return;
      case TAG.STRING: this.text(); return;
      case TAG.INT_ARRAY: {
        const length = this.int();
        if (length < 0 || length > MAX_ELEMENTS) throw new Error(CORRUPT);
        this.need(length * 4); this.offset += length * 4;
        return;
      }
      case TAG.LONG_ARRAY: this.longs(); return;
      case TAG.LIST: {
        const element = this.tag(), length = this.int();
        if (length < 0 || length > MAX_ELEMENTS) throw new Error(CORRUPT);
        for (let i = 0; i < length; i++) this.skip(element);
        return;
      }
      case TAG.COMPOUND: {
        for (;;) {
          const field = this.tag();
          if (field === TAG.END) return;
          this.text();
          this.skip(field);
        }
      }
      default: throw new Error(CORRUPT);
    }
  }
}

function readCompound(cursor: Cursor, readers: Record<string, Reader>) {
  const value: Record<string, unknown> = {};
  for (;;) {
    const type = cursor.tag();
    if (type === TAG.END) return value;
    const name = cursor.text();
    const reader = readers[name];
    if (reader) value[name] = reader(cursor, type);
    else cursor.skip(type);
  }
}

const int: Reader = (cursor, type) => type === TAG.INT ? cursor.int() : cursor.skip(type);
const longArray: Reader = (cursor, type) => type === TAG.LONG_ARRAY ? cursor.longs() : cursor.skip(type);
const byteArray: Reader = (cursor, type) => type === TAG.BYTE_ARRAY ? cursor.bytes() : cursor.skip(type);
const text: Reader = (cursor, type) => type === TAG.STRING ? cursor.text() : cursor.skip(type);

function listOf(read: Reader): Reader {
  return (cursor, type) => {
    if (type !== TAG.LIST) return cursor.skip(type);
    const element = cursor.tag(), length = cursor.int();
    if (length < 0 || length > MAX_ELEMENTS) throw new Error(CORRUPT);
    const items: unknown[] = [];
    for (let i = 0; i < length; i++) items.push(read(cursor, element));
    return items;
  };
}

function readProperties(cursor: Cursor) {
  const properties: Record<string, string> = {};
  for (;;) {
    const type = cursor.tag();
    if (type === TAG.END) return properties;
    const name = cursor.text();
    if (type === TAG.STRING) properties[name] = cursor.text();
    else if (type === TAG.BYTE) properties[name] = String(cursor.byte() !== 0);
    else if (type === TAG.INT) properties[name] = String(cursor.int());
    else cursor.skip(type);
  }
}

/** 26.x allows strings, `Name`, `id` and anonymous compounds in the same palette. */
const blockState: Reader = (cursor, type) => {
  if (type === TAG.STRING) return cursor.text();
  if (type !== TAG.COMPOUND) return cursor.skip(type);
  const value: Record<string, unknown> = {};
  for (;;) {
    const field = cursor.tag();
    if (field === TAG.END) return value;
    const name = cursor.text();
    if (field === TAG.STRING && (name === "Name" || name === "id" || name === "")) value[name] = cursor.text();
    else if (field === TAG.COMPOUND && (name === "Properties" || name === "properties")) value[name] = readProperties(cursor);
    else cursor.skip(field);
  }
};

const section: Reader = (cursor, type) => {
  if (type !== TAG.COMPOUND) return cursor.skip(type);
  return readCompound(cursor, {
    Y: (child, field) => field === TAG.BYTE ? child.byte() : child.skip(field),
    block_states: (child, field) => field === TAG.COMPOUND
      ? readCompound(child, { palette: listOf(blockState), data: longArray }) : child.skip(field),
    Palette: listOf(blockState),
    BlockStates: longArray,
    Blocks: byteArray,
    Add: byteArray,
    biomes: (child, field) => field === TAG.COMPOUND
      ? readCompound(child, { palette: listOf(text), data: longArray }) : child.skip(field)
  });
};

const sections = listOf(section);

/** Reads only what the surface and scene decoders use; everything else is skipped. */
export function readChunkNbt(buffer: Buffer): ChunkNbt {
  const cursor = new Cursor(buffer);
  if (cursor.tag() !== TAG.COMPOUND) throw new Error(CORRUPT);
  cursor.text();
  return readCompound(cursor, {
    DataVersion: int,
    sections,
    Level: (child, type) => type === TAG.COMPOUND ? readCompound(child, { DataVersion: int, Sections: sections }) : child.skip(type)
  }) as ChunkNbt;
}
