export function parseInterval(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new Error("Invalid ICY interval");
  const interval = Number(value);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 1024 * 1024) {
    throw new Error("Invalid ICY interval");
  }
  return interval;
}

export class IcyParser {
  private audioRemaining: number;
  private metadataRemaining = 0;
  private metadataOffset = 0;
  private readonly metadata = new Uint8Array(255 * 16);

  constructor(private readonly interval: number | null, private readonly title: (value: string) => void) {
    if (interval !== null) parseInterval(String(interval));
    this.audioRemaining = interval ?? 0;
  }

  // Retains at most 4080 metadata bytes; callers bound the input chunk size.
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.interval === null) return chunk.length ? [chunk] : [];
    const output: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.metadataRemaining > 0) {
        const count = Math.min(this.metadataRemaining, chunk.length - offset);
        this.metadata.set(chunk.subarray(offset, offset + count), this.metadataOffset);
        this.metadataOffset += count;
        this.metadataRemaining -= count;
        offset += count;
        if (this.metadataRemaining === 0) {
          const text = new TextDecoder().decode(this.metadata.subarray(0, this.metadataOffset)).replace(/\0+$/, "");
          const match = /(?:^|;)\s*StreamTitle='([^\0]*?)';/i.exec(text);
          if (match) this.title(match[1] ?? "");
          this.audioRemaining = this.interval;
        }
      } else if (this.audioRemaining === 0) {
        this.metadataRemaining = (chunk[offset++] ?? 0) * 16;
        this.metadataOffset = 0;
        if (this.metadataRemaining === 0) this.audioRemaining = this.interval;
      } else {
        const count = Math.min(this.audioRemaining, chunk.length - offset);
        output.push(chunk.subarray(offset, offset + count));
        this.audioRemaining -= count;
        offset += count;
      }
    }
    return output;
  }
}
