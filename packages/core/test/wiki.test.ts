import { describe, expect, it } from 'vitest';
import { parseWikiCategory, wikiPagePath } from '../src/wiki.js';

describe('wiki path helpers', () => {
  it('accepts only supported wiki categories', () => {
    expect(parseWikiCategory(undefined)).toBe('Concepts');
    expect(parseWikiCategory('Systems')).toBe('Systems');
    expect(parseWikiCategory('../Inbox')).toBeUndefined();
    expect(parseWikiCategory('')).toBe('Concepts');
  });

  it('keeps generated wiki pages under the selected category', () => {
    expect(wikiPagePath('RDMA: zero-copy?', 'Concepts')).toBe('Wiki/Concepts/RDMA zero-copy.md');
  });
});
