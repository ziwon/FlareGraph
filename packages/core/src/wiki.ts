/** Wiki Compiler prompt/rendering (planning §6.6). The LLM call itself lives in
 *  the worker; these helpers are pure so they can be unit-tested. */

export interface WikiSource {
  path: string;
  title: string;
  body: string;
}

export interface WikiCompileResult {
  summary: string;
  keyFacts: string[];
  relatedConcepts: string[];
  claims: { text: string; sourcePath: string; heading?: string; confidence: number }[];
  openQuestions: string[];
}

export function buildWikiPrompt(
  topic: string,
  sources: WikiSource[],
  activeRules: string[],
): string {
  const rules = activeRules.length
    ? `\nCompiler rules distilled from past errors (follow strictly):\n${activeRules.map((r) => `- ${r}`).join('\n')}\n`
    : '';
  const src = sources
    .map((s) => `<note path="${s.path}" title="${s.title}">\n${s.body}\n</note>`)
    .join('\n\n');
  return `You are a wiki compiler for a personal knowledge base. Compile a wiki page about "${topic}" strictly from the source notes below. Never invent facts that are not in the sources. Every claim must cite a source note path (and heading when possible).
${rules}
Respond with JSON only, matching this shape:
{
  "summary": "2-4 sentence overview",
  "keyFacts": ["fact ..."],
  "relatedConcepts": ["concept name ..."],
  "claims": [{"text": "...", "sourcePath": "Notes/x.md", "heading": "optional", "confidence": 0.0}],
  "openQuestions": ["..."]
}

Source notes:
${src}`;
}

export function renderWikiPage(
  topic: string,
  result: WikiCompileResult,
  sources: WikiSource[],
  generatedAt: string,
): string {
  const fm = [
    '---',
    `title: ${JSON.stringify(topic)}`,
    'tier: compiled',
    `generated_at: ${generatedAt}`,
    'generator: flaregraph-wiki-compiler',
    '---',
  ].join('\n');
  const claims = result.claims
    .map(
      (c) =>
        `- ${c.text} _(source: [[${c.sourcePath.replace(/\.md$/i, '')}${c.heading ? `#${c.heading}` : ''}]], confidence ${c.confidence.toFixed(2)})_`,
    )
    .join('\n');
  return `${fm}

# ${topic}

## Summary

${result.summary}

## Key facts

${result.keyFacts.map((f) => `- ${f}`).join('\n')}

## Related concepts

${result.relatedConcepts.map((c) => `- [[${c}]]`).join('\n')}

## Claims

${claims}

## Sources

${sources.map((s) => `- [[${s.path.replace(/\.md$/i, '')}]]`).join('\n')}

## Open questions

${result.openQuestions.map((q) => `- ${q}`).join('\n')}
`;
}

export function wikiPagePath(topic: string, category = 'Concepts'): string {
  const safe = topic
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `Wiki/${category}/${safe}.md`;
}
