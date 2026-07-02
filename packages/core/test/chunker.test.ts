import { describe, expect, it } from 'vitest';
import { chunkNote, estimateTokens } from '../src/chunker.js';
import { indexNote } from '../src/indexNote.js';

describe('chunkNote', () => {
  it('keeps code blocks intact and respects heading boundaries', async () => {
    const body = [
      '# Section A',
      '',
      'Paragraph one about RDMA. '.repeat(40),
      '',
      '```python',
      'def f():',
      '    return 1',
      '```',
      '',
      '# Section B',
      '',
      'Second section content. '.repeat(40),
    ].join('\n');
    const chunks = await chunkNote(body);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const code = chunks.find((c) => c.text.includes('def f():'))!;
    expect(code.text).toContain('```python');
    expect(code.text).toContain('```');
    for (const c of chunks) {
      const open = (c.text.match(/```/g) ?? []).length;
      expect(open % 2).toBe(0); // never split a fence
    }
  });

  it('produces offsets that map back into the original file', async () => {
    const content = `---\ntitle: T\n---\n\n# H\n\nHello world paragraph.\n`;
    const idx = await indexNote('Notes/T.md', content, { excludeFolders: [] });
    expect(idx).not.toBeNull();
    const c = idx!.chunks[0]!;
    expect(content.slice(c.startOffset, c.endOffset)).toContain('Hello world paragraph.');
  });

  it('content change flips the chunk id (insert + GC, not upsert)', async () => {
    const a = await chunkNote('same intro\n\nabout X');
    const b = await chunkNote('same intro\n\nabout Y');
    expect(a[0]!.hash).not.toBe(b[0]!.hash);
  });

  it('estimates CJK-heavy text with ~1 token per character', () => {
    expect(estimateTokens('한국어텍스트')).toBe(6);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});
