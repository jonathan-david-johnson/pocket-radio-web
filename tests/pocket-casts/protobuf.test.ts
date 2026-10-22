import { describe, expect, it } from "vitest";
import { decodePlaylistList, encodePlaylistListRequest } from "../../functions/_lib/pocket-casts/protobuf";

// Wire bytes are written out by hand from the protobuf encoding rules, not
// produced by the module under test. Field numbers come from iOS api.pb.swift.
const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const varint = (n: number): number[] => { const out: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const bytesField = (field: number, body: number[]) => [...tag(field, 2), ...varint(body.length), ...body];
const stringField = (field: number, s: string) => bytesField(field, utf8(s));
const boolValue = (field: number, value: boolean) => bytesField(field, value ? [0x08, 0x01] : []);
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

const NEWS = "2f8e1c4a-6b1d-4c1e-9a77-3f0c2d1e4b5a";
const TECH = "7c3d9e10-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

describe("UserPlaylistListRequest", () => {
  it("encodes m as field 2, as the iOS RetrievePlaylistsTask sends it", () => {
    expect([...encodePlaylistListRequest({ m: "mobile" })]).toEqual([0x12, 0x06, ...utf8("mobile")]);
  });
});

describe("UserPlaylistListResponse", () => {
  it("reads uuid (1), title (3) and is_deleted (2, a BoolValue) from each playlist (1)", () => {
    // Field 1, wire type 2, length 0x30: one playlist written out byte by byte.
    const one = [0x0a, 0x30, 0x0a, 0x24, ...utf8(TECH), 0x12, 0x02, 0x08, 0x01, 0x1a, 0x04, ...utf8("Tech")];
    expect(one.length - 2).toBe(0x30);
    expect(decodePlaylistList(new Uint8Array(one))).toEqual([{ uuid: TECH, title: "Tech", deleted: true }]);
  });

  it("keeps server order and treats an absent or empty is_deleted as not deleted", () => {
    const body = bytes(
      bytesField(1, [...stringField(1, NEWS), ...stringField(3, "News")]),
      bytesField(1, [...stringField(1, TECH), ...boolValue(2, false), ...stringField(3, "Tech")]),
    );
    expect(decodePlaylistList(body)).toEqual([
      { uuid: NEWS, title: "News", deleted: false },
      { uuid: TECH, title: "Tech", deleted: false },
    ]);
  });

  it("skips fields it does not read, of every wire type, including multi-byte tags", () => {
    const playlist = [
      ...tag(13, 2), 0x02, 0x08, 0x07,                  // sort_position Int32Value
      ...stringField(1, NEWS),
      ...tag(30, 0), ...varint(300),                     // unknown varint
      ...tag(31, 1), 1, 2, 3, 4, 5, 6, 7, 8,             // unknown fixed64
      ...tag(32, 5), 1, 2, 3, 4,                         // unknown fixed32
      ...bytesField(25, stringField(1, "episode")),      // episodes[]: tag 0xca 0x01
      ...stringField(24, "episode-order"),
      ...stringField(3, "News ✓"),
    ];
    expect(tag(25, 2)).toEqual([0xca, 0x01]);
    expect(decodePlaylistList(bytes(tag(9, 0), [1], bytesField(1, playlist)))).toEqual([{ uuid: NEWS, title: "News ✓", deleted: false }]);
  });

  it("returns an empty list for an empty body", () => {
    expect(decodePlaylistList(new Uint8Array())).toEqual([]);
  });

  it.each([
    ["a truncated length", [0x0a, 0x05, 0x0a]],
    ["a truncated varint", [0x08, 0x80]],
    ["a varint longer than 10 bytes", [0x08, ...Array(10).fill(0x80), 0x01]],
    ["a group wire type", [0x0b]],
    ["field number 0", [0x02, 0x00]],
    ["invalid UTF-8 in a title", bytesField(1, [0x1a, 0x01, 0xff])],
    ["a playlist without a uuid", bytesField(1, stringField(3, "No id"))],
    ["a uuid of the wrong wire type", bytesField(1, [0x08, 0x01])],
  ])("rejects %s", (_name, body) => {
    expect(() => decodePlaylistList(new Uint8Array(body))).toThrow();
  });
});
