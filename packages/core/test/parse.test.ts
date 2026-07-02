import { describe, expect, it } from 'vitest';
import { isEmbeddable, isExcluded, tierForPath } from '../src/exclusion.js';
import { parseNote } from '../src/parse.js';
import { LinkResolver } from '../src/resolve.js';

const SAMPLE = `---
title: GPU Fabric RDMA
aliases: [RDMA, RoCE]
tags: [networking, ai-infra]
created: 2026-01-02
---

# Overview

RDMA lets NICs write directly into remote memory. See [[InfiniBand]] and
[[AI Infra/GPU Topologies|topologies]]. Also compare [external](https://example.com/rdma).

## Transport #deepdive

\`\`\`c
// [[NotALink]] inside code must be ignored
struct ibv_qp *qp;
\`\`\`

More text with a [[Congestion Control#ECN]] reference and inline #rdma tag.
`;

describe('parseNote', () => {
  const note = parseNote('AI Infra/GPU Fabric RDMA.md', SAMPLE);

  it('extracts frontmatter metadata', () => {
    expect(note.title).toBe('GPU Fabric RDMA');
    expect(note.aliases).toEqual(['RDMA', 'RoCE']);
    expect(note.tags).toContain('networking');
    expect(note.tags).toContain('deepdive');
    expect(note.tags).toContain('rdma');
    expect(note.createdAt).toBe('2026-01-02');
  });

  it('extracts headings with offsets pointing at original text', () => {
    expect(note.headings.map((h) => h.title)).toEqual(['Overview', 'Transport #deepdive']);
    const h0 = note.headings[0]!;
    expect(SAMPLE.slice(h0.position, h0.position + 10)).toBe('# Overview');
  });

  it('extracts wikilinks, aliases and fragments, skipping code blocks', () => {
    const targets = note.links.map((l) => l.rawTarget);
    expect(targets).toContain('InfiniBand');
    expect(targets).toContain('AI Infra/GPU Topologies');
    expect(targets).toContain('Congestion Control');
    expect(targets).not.toContain('NotALink');
    const aliased = note.links.find((l) => l.rawTarget === 'AI Infra/GPU Topologies')!;
    expect(aliased.anchorText).toBe('topologies');
    const url = note.links.find((l) => l.linkType === 'url')!;
    expect(url.rawTarget).toBe('https://example.com/rdma');
  });

  it('falls back to filename title without frontmatter', () => {
    const bare = parseNote('Notes/Quick Idea.md', 'just text');
    expect(bare.title).toBe('Quick Idea');
  });
});

describe('exclusion (ADR-009) and tiers (ADR-008)', () => {
  it('excludes private frontmatter and excluded folders', () => {
    expect(isExcluded('Journal/secret.md', { private: true }, { excludeFolders: [] })).toBe(true);
    expect(isExcluded('Private/x.md', {}, { excludeFolders: ['Private'] })).toBe(true);
    expect(isExcluded('Notes/x.md', {}, { excludeFolders: ['Private'] })).toBe(false);
    expect(isExcluded('.obsidian/config.md', {}, { excludeFolders: [] })).toBe(true);
    expect(isExcluded('image.png', {}, { excludeFolders: [] })).toBe(true);
  });

  it('assigns tiers by folder and keeps Wiki/ out of embeddings', () => {
    expect(tierForPath('Wiki/Concepts/RDMA.md')).toBe('compiled');
    expect(tierForPath('Inbox/2026-07-03-capture.md')).toBe('inbox');
    expect(tierForPath('Notes/x.md')).toBe('raw');
    expect(isEmbeddable('Wiki/Concepts/RDMA.md')).toBe(false);
    expect(isEmbeddable('Notes/x.md')).toBe(true);
  });
});

describe('LinkResolver', () => {
  const resolver = new LinkResolver([
    { id: 'p1', path: 'AI Infra/InfiniBand.md', title: 'InfiniBand', aliases: ['IB'] },
    { id: 'p2', path: 'Notes/Congestion Control.md', title: 'Congestion Control', aliases: [] },
    { id: 'p3', path: 'Deep/Nested/Congestion Control.md', title: 'CC copy', aliases: [] },
  ]);

  it('resolves by basename, path, and alias', () => {
    expect(resolver.resolve('InfiniBand')?.id).toBe('p1');
    expect(resolver.resolve('AI Infra/InfiniBand')?.id).toBe('p1');
    expect(resolver.resolve('IB')?.id).toBe('p1');
    expect(resolver.resolve('Congestion Control')?.id).toBe('p2'); // shortest path wins
    expect(resolver.resolve('Missing Note')).toBeUndefined();
  });
});

describe('markdown link destinations (Obsidian-style)', () => {
  it('parses percent-encoded, angle-bracketed, and bare destinations', () => {
    const note = parseNote(
      'Notes/Links.md',
      [
        '[encoded](Notes/My%20Note.md)',
        '[angled](<Notes/Other Note.md>)',
        '[bare](Notes/Plain.md)',
        '[web](https://example.com/a%20b)',
      ].join('\n\n'),
    );
    const md = note.links.filter((l) => l.linkType === 'markdown').map((l) => l.rawTarget);
    expect(md).toContain('Notes/My Note.md');
    expect(md).toContain('Notes/Other Note.md');
    expect(md).toContain('Notes/Plain.md');
    // URLs keep their encoding untouched
    const url = note.links.find((l) => l.linkType === 'url');
    expect(url?.rawTarget).toBe('https://example.com/a%20b');
  });
});
