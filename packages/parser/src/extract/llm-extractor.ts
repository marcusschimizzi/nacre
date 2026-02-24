import type { RawEntity, LLMProvider } from '@nacre/core';
import type { Section } from '../parse.js';

/**
 * Create an Anthropic-based LLM provider for entity extraction.
 *
 * @param apiKey - Anthropic API key (defaults to ANTHROPIC_API_KEY env var)
 * @param model - Model to use (defaults to claude-3-5-haiku-latest)
 */
export function createAnthropicProvider(
  apiKey?: string,
  model: string = 'claude-3-5-haiku-latest',
): LLMProvider {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is required for Anthropic LLM provider');
  }

  return {
    name: `anthropic/${model}`,
    async complete(prompt: string): Promise<string> {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic API error: ${res.status} ${text}`);
      }

      const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
      const textContent = data.content.find((c) => c.type === 'text');
      if (!textContent) {
        throw new Error('Anthropic response missing text content');
      }
      return textContent.text;
    },
  };
}

const EXTRACTION_PROMPT = `Extract all distinct entities from this note. An entity is:
- A person, agent, or named individual
- A project, app, or product
- A tool, technology, or framework
- A concept, idea, or topic worth remembering
- A place, company, or organization
- An event or date worth tracking

For each entity, provide:
- text: the exact term as it appears
- type: one of person|project|tool|concept|place|tag|event|decision|lesson
- confidence: 0.0-1.0 (how confident you are this is a meaningful entity)
- context: optional brief reason why this is an entity

Be generous — prefer over-extraction over under-extraction. The system will reinforce or fade entities over time based on usage.

Return ONLY a valid JSON array, no markdown formatting, no explanation.

Example output:
[{"text":"Conch","type":"project","confidence":0.95},{"text":"Lobstar","type":"person","confidence":0.9}]

Note content:
`;

interface LLMExtractedEntity {
  text: string;
  type: string;
  confidence: number;
  context?: string;
}

const VALID_TYPES = new Set([
  'person',
  'project',
  'tool',
  'concept',
  'place',
  'tag',
  'event',
  'decision',
  'lesson',
]);

function buildPrompt(sections: Section[]): string {
  const content = sections
    .map((s) => {
      const heading = s.heading ? `## ${s.heading}\n` : '';
      return heading + s.content;
    })
    .join('\n\n');
  return EXTRACTION_PROMPT + content;
}

function parseEntityResponse(
  response: string,
  filePath: string,
  section: Section,
): RawEntity[] {
  let entities: LLMExtractedEntity[];

  try {
    // Strip any markdown code blocks if present
    const cleaned = response
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    entities = JSON.parse(cleaned);
  } catch {
    console.warn(`[llm-extractor] Failed to parse LLM response as JSON: ${response.slice(0, 100)}...`);
    return [];
  }

  if (!Array.isArray(entities)) {
    console.warn(`[llm-extractor] LLM response is not an array`);
    return [];
  }

  const valid: RawEntity[] = [];

  for (const e of entities) {
    if (!e.text || typeof e.text !== 'string') continue;
    if (!e.type || !VALID_TYPES.has(e.type)) continue;
    if (typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1) {
      e.confidence = 0.8; // Default confidence if invalid
    }

    valid.push({
      text: e.text.trim(),
      type: e.type as RawEntity['type'],
      confidence: e.confidence,
      source: 'llm',
      position: {
        file: filePath,
        section: section.headingPath,
        line: section.startLine,
      },
    });
  }

  return valid;
}

/**
 * Extract entities from note sections using an LLM provider.
 *
 * @param sections - Parsed markdown sections
 * @param filePath - Source file path for position tracking
 * @param provider - LLM provider interface
 * @returns Array of extracted raw entities
 */
export async function extractWithLLM(
  sections: Section[],
  filePath: string,
  provider: LLMProvider,
): Promise<RawEntity[]> {
  const prompt = buildPrompt(sections);

  let response: string;
  try {
    response = await provider.complete(prompt);
  } catch (err) {
    console.warn(`[llm-extractor] LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Use first section for position (LLM returns combined entities)
  // In practice, most notes have one primary section
  const primarySection = sections[0] ?? {
    headingPath: '',
    startLine: 1,
    heading: '',
    content: '',
  };

  return parseEntityResponse(response, filePath, primarySection);
}
