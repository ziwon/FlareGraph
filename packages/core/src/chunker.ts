import { shortHash } from './hash.js';
import { slugify } from './slug.js';
import type { Chunk } from './types.js';

const TARGET_TOKENS = 800; // within the 500–1000 range from planning §6.2
const MIN_TOKENS = 200; // merge tiny trailing sections forward
const OVERLAP_TOKENS = 80;

/** Rough token estimate good enough for chunk sizing (CJK-aware). */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x1100 && c <= 0x11ff) || // Hangul Jamo
      (c >= 0x3040 && c <= 0x30ff) || // Kana
      (c >= 0x4e00 && c <= 0x9fff) || // CJK ideographs
      (c >= 0xac00 && c <= 0xd7af) // Hangul syllables
    )
      cjk++;
  }
  const nonCjkChars = text.length - cjk;
  return Math.ceil(nonCjkChars / 4) + cjk;
}

interface Segment {
  text: string;
  start: number;
  end: number;
  headingSlug?: string;
  isCode: boolean;
}

/** Split body into heading-scoped paragraph/code segments, preserving offsets. */
function segment(body: string, bodyOffset: number): Segment[] {
  const segments: Segment[] = [];
  const lines = body.split('\n');
  let currentHeading: string | undefined;
  let buf: string[] = [];
  let bufStart = 0;
  let pos = 0;
  let inFence: string | null = null;

  const flush = (end: number, isCode = false) => {
    const text = buf.join('\n');
    if (text.trim().length > 0) {
      segments.push({
        text,
        start: bodyOffset + bufStart,
        end: bodyOffset + end,
        headingSlug: currentHeading,
        isCode,
      });
    }
    buf = [];
  };

  for (const line of lines) {
    const lineStart = pos;
    const fence = /^(```|~~~)/.exec(line.trimStart());
    if (inFence) {
      buf.push(line);
      if (fence && line.trimStart().startsWith(inFence)) {
        flush(lineStart + line.length, true);
        inFence = null;
        bufStart = lineStart + line.length + 1;
      }
    } else if (fence) {
      flush(lineStart); // close pending paragraph
      inFence = fence[1] ?? '```';
      bufStart = lineStart;
      buf.push(line);
    } else {
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h?.[2]) {
        flush(lineStart);
        currentHeading = slugify(h[2]);
        bufStart = lineStart + line.length + 1;
      } else if (line.trim() === '') {
        flush(lineStart);
        bufStart = lineStart + line.length + 1;
      } else {
        if (buf.length === 0) bufStart = lineStart;
        buf.push(line);
      }
    }
    pos += line.length + 1;
  }
  flush(pos - 1, inFence != null);
  return segments;
}

/**
 * Heading-aware chunking (planning §6.2): paragraph boundaries kept, code blocks
 * kept whole, chunk id = chunk:{page_id}:{hash} computed by the caller from `hash`.
 */
export async function chunkNote(body: string, bodyOffset = 0): Promise<Chunk[]> {
  const segs = segment(body, bodyOffset);
  const chunks: Chunk[] = [];
  let group: Segment[] = [];
  let groupTokens = 0;

  const emit = async () => {
    if (group.length === 0) return;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const text = group.map((s) => s.text).join('\n\n');
    chunks.push({
      index: chunks.length,
      text,
      hash: await shortHash(text, 16),
      headingSlug: first.headingSlug,
      tokenCount: estimateTokens(text),
      startOffset: first.start,
      endOffset: last.end,
    });
    // paragraph-level overlap: carry the last segment into the next chunk
    const carry = last.isCode ? [] : [last];
    group = carry;
    groupTokens = carry.reduce((n, s) => n + estimateTokens(s.text), 0);
    if (groupTokens > OVERLAP_TOKENS * 2) {
      group = [];
      groupTokens = 0;
    }
  };

  for (const seg of segs) {
    const tokens = estimateTokens(seg.text);
    const headingChanged =
      group.length > 0 && seg.headingSlug !== group[group.length - 1]!.headingSlug;
    if (
      group.length > 0 &&
      (groupTokens + tokens > TARGET_TOKENS || (headingChanged && groupTokens >= MIN_TOKENS))
    ) {
      await emit();
      // after a heading change, drop overlap from the previous section
      if (headingChanged) {
        group = [];
        groupTokens = 0;
      }
    }
    group.push(seg);
    groupTokens += tokens;
  }
  // emit remainder unless it is purely the overlap carry-over
  if (group.length > 0) {
    const lastEnd = chunks[chunks.length - 1]?.endOffset ?? -1;
    if (group[group.length - 1]!.end > lastEnd) await emit();
  }
  return chunks;
}
