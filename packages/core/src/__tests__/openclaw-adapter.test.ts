import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConversationFile } from '../adapters.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openclaw');

describe('OpenClaw v3 adapter', () => {
  it('parses nested messages and preserves evidence identity and classifications', () => {
    const source = join(fixtures, 'direct-session.jsonl');
    const input = parseConversationFile(readFileSync(source, 'utf8'), 'openclaw', { source });

    assert.equal(input.metadata?.sessionId, 'sess-synthetic-direct');
    assert.equal(input.metadata?.agentId, 'main');
    assert.equal(input.messages.length, 5);
    assert.deepEqual(
      input.messages.map(({ id, parentId, origin, extractionEligible }) => ({
        id,
        parentId,
        origin,
        extractionEligible,
      })),
      [
        { id: 'msg-user-1', parentId: undefined, origin: 'direct', extractionEligible: true },
        {
          id: 'msg-assistant-1',
          parentId: 'msg-user-1',
          origin: 'direct',
          extractionEligible: true,
        },
        {
          id: 'msg-assistant-1:tool:call-1',
          parentId: 'msg-assistant-1',
          origin: 'tool_call',
          extractionEligible: false,
        },
        {
          id: 'msg-tool-1',
          parentId: 'msg-assistant-1',
          origin: 'tool_result',
          extractionEligible: false,
        },
        {
          id: 'msg-history-1',
          parentId: 'msg-tool-1',
          origin: 'quoted_context',
          extractionEligible: false,
        },
      ],
    );
    assert.match(input.messages[1].content, /Project Pearl/);
    assert.equal(input.messages[3].toolCallId, 'call-1');
    assert.ok(input.messages.every((message) => message.sourceRef?.includes('#')));
    assert.ok(input.messages.every((message) => /^[a-f0-9]{64}$/.test(message.contentHash ?? '')));
  });

  it('makes only direct dialogue extraction-eligible, including excluding cron', () => {
    const source = join(fixtures, 'routed-and-cron.jsonl');
    const input = parseConversationFile(readFileSync(source, 'utf8'), 'openclaw', { source });
    assert.ok(input.messages.some((message) => message.origin === 'cron'));
    assert.ok(
      input.messages.every(
        (message) => message.extractionEligible === (message.origin === 'direct'),
      ),
    );
  });

  it('preserves recoverable malformed and unknown material with line warnings and validated time bounds', () => {
    const input = parseConversationFile(
      [
        JSON.stringify({ type: 'session', id: 'sess-malformed', agentId: 'main' }),
        'null',
        '{broken',
        JSON.stringify({
          type: 'message',
          id: 'late',
          timestamp: '2026-02-02T10:00:00-05:00',
          message: { role: 'user', content: [{ type: 'text', text: 'late direct' }, null] },
        }),
        JSON.stringify({
          type: 'message',
          id: 'invalid-time',
          timestamp: 'not-a-date',
          message: {
            role: 'user',
            content: [
              { type: 'mystery', payload: { retained: true } },
              { type: 'toolCall', id: 42, name: 'broken-tool', arguments: { retained: true } },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'early',
          timestamp: '2026-02-02T09:00:00Z',
          message: { role: 'assistant', content: 'early direct' },
        }),
        JSON.stringify({ type: 'future-record', payload: { retained: true } }),
        JSON.stringify({ type: 'message', id: 'missing-message-object' }),
      ].join('\n'),
      'openclaw',
      { source: 'synthetic.jsonl' },
    );

    assert.equal(input.messages.length, 3);
    const invalidTime = input.messages.find((message) => message.id === 'invalid-time');
    assert.ok(invalidTime);
    assert.match(invalidTime.content, /mystery/);
    assert.deepEqual(invalidTime.rawContentBlocks, [
      { type: 'mystery', payload: { retained: true } },
      { type: 'toolCall', id: 42, name: 'broken-tool', arguments: { retained: true } },
    ]);
    assert.ok(input.warnings?.some((warning) => /synthetic\.jsonl:2/.test(warning)));
    assert.ok(input.warnings?.some((warning) => /synthetic\.jsonl:3/.test(warning)));
    assert.ok(input.warnings?.some((warning) => /synthetic\.jsonl:4/.test(warning)));
    assert.ok(input.warnings?.some((warning) => /synthetic\.jsonl:5/.test(warning)));
    assert.ok(input.warnings?.some((warning) => /synthetic\.jsonl:7/.test(warning)));
    assert.ok(input.warnings?.some((warning) => /synthetic\.jsonl:8/.test(warning)));
    assert.ok(
      input.warnings?.every((warning) => !/only in raw source|source warning/.test(warning)),
    );
    assert.deepEqual(
      input.rawEvidence?.map(({ line, raw }) => ({ line, raw })),
      [
        { line: 2, raw: 'null' },
        { line: 3, raw: '{broken' },
        {
          line: 4,
          raw: JSON.stringify({
            type: 'message',
            id: 'late',
            timestamp: '2026-02-02T10:00:00-05:00',
            message: { role: 'user', content: [{ type: 'text', text: 'late direct' }, null] },
          }),
        },
        {
          line: 5,
          raw: JSON.stringify({
            type: 'message',
            id: 'invalid-time',
            timestamp: 'not-a-date',
            message: {
              role: 'user',
              content: [
                { type: 'mystery', payload: { retained: true } },
                { type: 'toolCall', id: 42, name: 'broken-tool', arguments: { retained: true } },
              ],
            },
          }),
        },
        {
          line: 7,
          raw: JSON.stringify({ type: 'future-record', payload: { retained: true } }),
        },
        {
          line: 8,
          raw: JSON.stringify({ type: 'message', id: 'missing-message-object' }),
        },
      ],
    );
    assert.equal(input.metadata?.eventStart, '2026-02-02T09:00:00.000Z');
    assert.equal(input.metadata?.eventEnd, '2026-02-02T15:00:00.000Z');
    assert.deepEqual(
      input.messages.map((message) => message.id),
      ['early', 'late', 'invalid-time'],
    );
    assert.deepEqual(
      input.messages.map((message) => message.sourcePosition),
      [
        { line: 6, ordinal: 0 },
        { line: 4, ordinal: 0 },
        { line: 5, ordinal: 0 },
      ],
    );
  });

  it('retains malformed raw JSONL lines byte-for-byte while keeping pathful human warnings', () => {
    const raw = '   {broken json   ';
    const input = parseConversationFile(
      `${JSON.stringify({ type: 'session', id: 'raw-bytes' })}\n${raw}\n`,
      'openclaw',
      { source: '/synthetic/archive/raw-bytes.jsonl' },
    );

    assert.equal(input.rawEvidence?.[0]?.raw, raw);
    assert.match(input.warnings?.[0] ?? '', /\/synthetic\/archive\/raw-bytes\.jsonl:2/);
  });

  it('stable-sorts equal event instants by original source position, including generated tool calls', () => {
    const input = parseConversationFile(
      [
        JSON.stringify({ type: 'session', id: 'stable-sort' }),
        JSON.stringify({
          type: 'message',
          id: 'second',
          timestamp: '2026-01-01T01:00:00+01:00',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'second' },
              { type: 'toolCall', id: 'tc', name: 'read' },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'third',
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: 'third' },
        }),
      ].join('\n'),
      'openclaw',
    );
    assert.deepEqual(
      input.messages.map((message) => message.id),
      ['second', 'second:tool:tc', 'third'],
    );
    assert.deepEqual(
      input.messages.map((message) => message.sourcePosition),
      [
        { line: 2, ordinal: 0 },
        { line: 2, ordinal: 1 },
        { line: 3, ordinal: 0 },
      ],
    );
  });
});
