// Pocket Casts account data in protobuf (web ADR 0007). Hand-written, like the
// menubar's APIService.swift: only the fields the web player reads. Field
// numbers come from iOS api.pb.swift. Every field is optional on the wire, and
// fields this module does not read are skipped.

const WIRE_VARINT = 0, WIRE_FIXED64 = 1, WIRE_BYTES = 2, WIRE_FIXED32 = 5;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean { return this.offset >= this.bytes.length; }

  /** An unsigned varint below 2^31; anything larger is rejected, not truncated. */
  uint32(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) {
        if (value > 0x7fffffff) throw new Error("Varint out of range");
        return value;
      }
    }
    throw new Error("Varint out of range");
  }

  /** Reads and discards a varint of up to 10 bytes. */
  skipVarint(): void {
    for (let i = 0; i < 10; i++) if (!(this.byte() & 0x80)) return;
    throw new Error("Varint too long");
  }

  tag(): { field: number; wire: number } {
    const key = this.uint32();
    const field = key >>> 3;
    if (field === 0) throw new Error("Invalid field number");
    return { field, wire: key & 7 };
  }

  bytesField(): Uint8Array {
    const length = this.uint32();
    if (length > this.bytes.length - this.offset) throw new Error("Truncated field");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT: this.skipVarint(); return;
      case WIRE_FIXED64: this.advance(8); return;
      case WIRE_BYTES: this.bytesField(); return;
      case WIRE_FIXED32: this.advance(4); return;
      default: throw new Error("Unsupported wire type");
    }
  }

  private byte(): number {
    if (this.offset >= this.bytes.length) throw new Error("Truncated varint");
    return this.bytes[this.offset++]!;
  }

  private advance(count: number): void {
    if (count > this.bytes.length - this.offset) throw new Error("Truncated field");
    this.offset += count;
  }
}

function expectWire(actual: number, expected: number): void {
  if (actual !== expected) throw new Error("Unexpected wire type");
}

function writeVarint(out: number[], value: number): void {
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
}

function writeString(out: number[], field: number, value: string): void {
  if (!value) return;
  const bytes = new TextEncoder().encode(value);
  writeVarint(out, (field << 3) | WIRE_BYTES);
  writeVarint(out, bytes.length);
  out.push(...bytes);
}

/** google.protobuf.BoolValue: field 1 holds the bool; an empty message is false. */
function readBoolValue(bytes: Uint8Array): boolean {
  const reader = new Reader(bytes);
  let value = false;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WIRE_VARINT) value = reader.uint32() !== 0;
    else reader.skip(wire);
  }
  return value;
}

/** Api_UserPlaylistListRequest: v (1), m (2), exclude_deleted (3). iOS sends only m. */
export function encodePlaylistListRequest(request: { m: string }): Uint8Array {
  const out: number[] = [];
  writeString(out, 2, request.m);
  return new Uint8Array(out);
}

export interface ServerPlaylist {
  uuid: string;
  title: string;
  deleted: boolean;
}

/** Api_PlaylistSyncResponse: uuid (1), is_deleted (2, BoolValue), title (3). */
function decodePlaylist(bytes: Uint8Array): ServerPlaylist {
  const reader = new Reader(bytes);
  const playlist: ServerPlaylist = { uuid: "", title: "", deleted: false };
  while (!reader.done) {
    const { field, wire } = reader.tag();
    switch (field) {
      case 1: expectWire(wire, WIRE_BYTES); playlist.uuid = utf8.decode(reader.bytesField()); break;
      case 2: expectWire(wire, WIRE_BYTES); playlist.deleted = readBoolValue(reader.bytesField()); break;
      case 3: expectWire(wire, WIRE_BYTES); playlist.title = utf8.decode(reader.bytesField()); break;
      default: reader.skip(wire);
    }
  }
  if (!playlist.uuid) throw new Error("Playlist without a uuid");
  return playlist;
}

/** Api_UserPlaylistListResponse: playlists (1, repeated Api_PlaylistSyncResponse), in server order. */
export function decodePlaylistList(bytes: Uint8Array): ServerPlaylist[] {
  const reader = new Reader(bytes);
  const playlists: ServerPlaylist[] = [];
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) { expectWire(wire, WIRE_BYTES); playlists.push(decodePlaylist(reader.bytesField())); }
    else reader.skip(wire);
  }
  return playlists;
}
