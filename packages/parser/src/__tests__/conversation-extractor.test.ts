import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromConversation } from '../conversation-extractor.js';
import type { ConversationChunk, EntityMap } from '@nacre/core';

describe('extractFromConversation', () => {
  it('extracts tool names from conversation', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'I used TypeScript and React to build this',
          name: 'Marcus',
        },
        {
          role: 'assistant',
          content: 'Docker is great for containerization',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const toolLabels = result.nodes
      .filter((n) => n.type === 'tool')
      .map((n) => n.label);

    assert.ok(toolLabels.includes('TypeScript'));
    assert.ok(toolLabels.includes('React'));
    assert.ok(toolLabels.includes('Docker'));
  });

  it('extracts person names via NLP', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'Marcus and Sarah discussed the architecture',
          name: 'Marcus',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const people = result.nodes.filter((n) => n.type === 'person');

    assert.ok(people.length >= 1);
    const names = people.map((p) => p.label.toLowerCase());
    assert.ok(names.some((n) => n.includes('marcus') || n.includes('sarah')));
  });

  it('extracts bold text as concepts', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'We discussed **memory decay** and **entity resolution**',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const concepts = result.nodes.filter((n) => n.type === 'concept');
    const labels = concepts.map((c) => c.label.toLowerCase());

    assert.ok(labels.some((l) => l.includes('memory decay')));
    assert.ok(labels.some((l) => l.includes('entity resolution')));
  });

  it('extracts backtick code as tools and filters noisy paths', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content:
            'Use `npm` and `Vite` but ignore `/path/to/file` and `./src/index.ts`',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const tools = result.nodes.filter((n) => n.type === 'tool');
    const labels = tools.map((t) => t.label.toLowerCase());

    assert.ok(labels.some((l) => l === 'npm'));
    assert.ok(labels.some((l) => l === 'vite'));
    assert.ok(!labels.some((l) => l.includes('/path')));
    assert.ok(!labels.some((l) => l.includes('./src')));
  });

  it('extracts wikilinks as concepts', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'See [[Memory Architecture]] and [[Decay Math]] for details',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const concepts = result.nodes.filter((n) => n.type === 'concept');
    const labels = concepts.map((c) => c.label);

    assert.ok(labels.includes('Memory Architecture'));
    assert.ok(labels.includes('Decay Math'));
  });

  it('extracts GitHub URLs as projects', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content:
            'Check out https://github.com/vasturiano/3d-force-graph and https://github.com/facebook/react',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const projects = result.nodes.filter((n) => n.type === 'project');
    const labels = projects.map((p) => p.label);

    assert.ok(labels.includes('vasturiano/3d-force-graph'));
    assert.ok(labels.includes('facebook/react'));
  });

  it('extracts scoped packages as tools', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'Using @nacre/core and @nacre/parser in the project',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const tools = result.nodes.filter((n) => n.type === 'tool');
    const labels = tools.map((t) => t.label);

    assert.ok(labels.includes('@nacre/core'));
    assert.ok(labels.includes('@nacre/parser'));
  });

  it('tracks which participant mentioned each entity', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'I used TypeScript',
          name: 'Marcus',
        },
        {
          role: 'assistant',
          content: 'TypeScript is great for type safety',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const tsNode = result.nodes.find(
      (n) => n.label === 'TypeScript' && n.type === 'tool',
    );

    assert.ok(tsNode);
    assert.ok(tsNode.mentionedBy.includes('Marcus'));
    assert.ok(tsNode.mentionedBy.includes('assistant'));
  });

  it('skips system messages', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant using TypeScript',
        },
        {
          role: 'user',
          content: 'I need help with React',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const nodes = result.nodes;

    assert.ok(nodes.length > 0);
    const hasReact = nodes.some((n) => n.label === 'React');
    assert.ok(hasReact);
  });

  it('extracts tool message toolName as entity', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'tool',
          content: 'Command executed successfully',
          toolName: 'bash',
          toolCallId: 'call_123',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const tools = result.nodes.filter((n) => n.type === 'tool');
    const labels = tools.map((t) => t.label);

    assert.ok(labels.includes('bash'));
  });

  it('deduplicates entities by normalized label', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'TypeScript is great',
        },
        {
          role: 'assistant',
          content: 'typescript is indeed powerful',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const tsNodes = result.nodes.filter(
      (n) => n.label === 'TypeScript' && n.type === 'tool',
    );

    assert.equal(tsNodes.length, 1);
  });

  it('creates co-occurrence edges between entities', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'Using TypeScript with React and Vite',
        },
      ],
    };

    const result = extractFromConversation(chunk);

    assert.ok(result.edges.length > 0);
    assert.ok(result.edges.every((e) => e.type === 'co-occurrence'));

    const edgeLabels = result.edges.map((e) => `${e.source}-${e.target}`);
    assert.ok(
      edgeLabels.some(
        (l) =>
          (l === 'TypeScript-React' || l === 'React-TypeScript') &&
          result.edges.find((e) => e.source === 'TypeScript' || e.source === 'React'),
      ),
    );
  });

  it('uses entity map aliases for normalization', () => {
    const entityMap: EntityMap = {
      aliases: {
        typescript: 'TypeScript',
        react: 'React',
      },
      ignore: [],
    };

    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'Using typescript and react',
        },
      ],
    };

    const result = extractFromConversation(chunk, entityMap);
    const labels = result.nodes.map((n) => n.label);

    assert.ok(labels.includes('TypeScript'));
    assert.ok(labels.includes('React'));
  });

  it('ignores entities on the ignore list', () => {
    const entityMap: EntityMap = {
      aliases: {},
      ignore: ['typescript'],
    };

    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'TypeScript and React are great',
        },
      ],
    };

    const result = extractFromConversation(chunk, entityMap);
    const labels = result.nodes.map((n) => n.label.toLowerCase());

    assert.ok(!labels.some((l) => l === 'typescript'));
    assert.ok(labels.some((l) => l === 'react'));
  });

  it('extracts participant names from user messages', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'Hello from the assistant',
          name: 'Alice',
        },
        {
          role: 'user',
          content: 'And from me too',
          name: 'Bob',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const people = result.nodes.filter((n) => n.type === 'person');
    const labels = people.map((p) => p.label);

    assert.ok(labels.includes('Alice'));
    assert.ok(labels.includes('Bob'));
  });

  it('includes excerpts from messages containing entities', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'We discussed TypeScript extensively in this conversation',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const tsNode = result.nodes.find(
      (n) => n.label === 'TypeScript' && n.type === 'tool',
    );

    assert.ok(tsNode);
    assert.ok(tsNode.excerpts.length > 0);
    assert.ok(
      tsNode.excerpts[0].toLowerCase().includes('typescript'),
    );
  });

  it('handles multiple speakers mentioning same entity', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'Docker is useful',
          name: 'Marcus',
        },
        {
          role: 'assistant',
          content: 'Yes, Docker containers are powerful',
        },
        {
          role: 'user',
          content: 'Docker simplifies deployment',
          name: 'Sarah',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const dockerNode = result.nodes.find(
      (n) => n.label === 'Docker' && n.type === 'tool',
    );

    assert.ok(dockerNode);
    assert.equal(dockerNode.mentionedBy.length, 3);
    assert.ok(dockerNode.mentionedBy.includes('Marcus'));
    assert.ok(dockerNode.mentionedBy.includes('assistant'));
    assert.ok(dockerNode.mentionedBy.includes('Sarah'));
  });

  it('handles empty conversation', () => {
    const chunk: ConversationChunk = {
      messages: [],
    };

    const result = extractFromConversation(chunk);

    assert.equal(result.nodes.length, 0);
    assert.equal(result.edges.length, 0);
  });

  it('handles conversation with only system messages', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'system',
          content: 'System message only',
        },
      ],
    };

    const result = extractFromConversation(chunk);

    assert.equal(result.nodes.length, 0);
    assert.equal(result.edges.length, 0);
  });

  it('extracts organizations as projects via NLP', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'Google and Microsoft are major tech companies',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const projects = result.nodes.filter((n) => n.type === 'project');

    assert.ok(projects.length >= 1);
  });

  it('combines multiple extraction methods', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content:
            'Marcus discussed **memory decay** using TypeScript with [[Entity Resolution]] at https://github.com/nacre/nacre',
          name: 'Marcus',
        },
      ],
    };

    const result = extractFromConversation(chunk);

    const hasTools = result.nodes.some((n) => n.type === 'tool');
    const hasConcepts = result.nodes.some((n) => n.type === 'concept');
    const hasProjects = result.nodes.some((n) => n.type === 'project');
    const hasPeople = result.nodes.some((n) => n.type === 'person');

    assert.ok(hasTools);
    assert.ok(hasConcepts);
    assert.ok(hasProjects);
    assert.ok(hasPeople);
  });

  it('respects topic in co-occurrence edge context', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'TypeScript and React',
        },
      ],
      topic: 'Frontend Development',
    };

    const result = extractFromConversation(chunk);
    const edges = result.edges;

    assert.ok(edges.length > 0);
    assert.ok(
      edges.every((e) => e.context.includes('Frontend Development')),
    );
  });

  it('handles special characters in bold text', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'The **memory consolidation** process is important',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const concepts = result.nodes.filter((n) => n.type === 'concept');

    assert.ok(concepts.length > 0);
    assert.ok(concepts.some((c) => c.label.toLowerCase().includes('memory')));
  });

  it('filters out stop words from NLP extraction', () => {
    const chunk: ConversationChunk = {
      messages: [
        {
          role: 'user',
          content: 'The quick brown fox jumps over the lazy dog',
        },
      ],
    };

    const result = extractFromConversation(chunk);
    const labels = result.nodes.map((n) => n.label.toLowerCase());

    assert.ok(!labels.includes('the'));
    assert.ok(!labels.includes('is'));
    assert.ok(!labels.includes('a'));
  });
});
