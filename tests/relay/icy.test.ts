import { describe, expect, it } from "vitest";
import { IcyParser, parseInterval } from "../../functions/_lib/relay/icy";

const bytes = (s: string) => new TextEncoder().encode(s);
const fixture = () => {
  const metadata = bytes("StreamTitle='Artist - Track';");
  const block = new Uint8Array(32);
  block.set(metadata);
  return new Uint8Array([...bytes("abcd"), 2, ...block, ...bytes("efgh"), 0, ...bytes("ijkl")]);
};

describe("incremental ICY", () => {
  it("preserves audio bytes and emits one title at every possible split, including zero blocks", () => {
    const input = fixture();
    for (let split = 0; split <= input.length; split++) {
      const titles: string[] = [];
      const parser = new IcyParser(4, title => titles.push(title));
      const output = [...parser.push(input.slice(0, split)), ...parser.push(input.slice(split))];
      expect(output.flatMap(chunk => [...chunk])).toEqual([...bytes("abcdefghijkl")]);
      expect(titles).toEqual(["Artist - Track"]);
    }
    const titles: string[] = [];
    const parser = new IcyParser(4, title => titles.push(title));
    expect([...fixture()].flatMap(byte => parser.push(new Uint8Array([byte])).flatMap(chunk => [...chunk])))
      .toEqual([...bytes("abcdefghijkl")]);
    expect(titles).toEqual(["Artist - Track"]);
  });

  it("preserves non-text audio bytes around zero metadata blocks", () => {
    const input = new Uint8Array([0, 128, 255, 1, 0, 2, 0, 254, 127, 0]);
    const parser = new IcyParser(4, () => { throw new Error("No title expected"); });
    const audio = [...input].flatMap(byte => parser.push(new Uint8Array([byte])).flatMap(chunk => [...chunk]));
    expect(audio).toEqual([0, 128, 255, 1, 2, 0, 254, 127]);
  });

  it("passes streams without metadata and rejects malformed or excessive intervals", () => {
    expect(parseInterval(null)).toBeNull();
    expect(new IcyParser(null, () => {}).push(bytes("abc"))).toEqual([bytes("abc")]);
    for (const value of ["0", "-1", "1.5", "NaN", "1e3", "", "9999999999"]) {
      expect(() => parseInterval(value)).toThrow();
    }
  });
});
