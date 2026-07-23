import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';
import {
  admitWorkingMemory,
  computeAdmissionReceiptId,
  type AdmissionReceipt,
} from '../memory-admission.js';
import type { MemoryObject } from '../memory-file.js';
import { SqliteStore } from '../store.js';

const AT = '2026-07-23T12:00:00.000Z';

function receipt(): AdmissionReceipt {
  const memory: MemoryObject = {
    id: 'mem_aaaaaaaaaaaa',
    type: 'decision',
    scope: 'user',
    confidence: 0.8,
    sensitivity: 'low',
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    sources: ['synthetic:receipt'],
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T00:00:00.000Z',
    salience: { reinforcementCount: 0 },
    body: 'Persist deterministic receipts.',
  };
  return admitWorkingMemory([{ memory, claim: memory.body }], { kind: 'brief', evaluatedAt: AT });
}

describe('admission receipt derived store', () => {
  it('validates the full receipt contract on put, read, id lookup, and list filters', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-receipt-validation-'));
    const dbPath = join(root, 'graph.db');
    const store = SqliteStore.open(dbPath);
    const original = receipt();
    const rehash = (changed: Omit<AdmissionReceipt, 'id'>): AdmissionReceipt => ({
      ...changed,
      id: computeAdmissionReceiptId(changed),
    });
    const { id: _id, ...body } = original;
    const malformed = [
      rehash({ ...body, kind: 'invalid' as never }),
      rehash({ ...body, evaluatedAt: 'not-iso' }),
      rehash({ ...body, included: ['bad-id'] }),
      rehash({ ...body, candidates: [{ ...body.candidates[0], decision: 'maybe' as never }] }),
      rehash({ ...body, candidates: [{ ...body.candidates[0], reasons: ['unknown' as never] }] }),
      rehash({ ...body, candidates: [{ ...body.candidates[0], tokenCost: -1 }] }),
      rehash({ ...body, budget: { ...body.budget, usedTokens: body.budget.tokenBudget + 1 } }),
      rehash({ ...body, policy: { ...body.policy, minEvidenceConfidence: Number.NaN } }),
      rehash({ ...body, covertSecret: 'must-not-persist' } as never),
      rehash({
        ...body,
        candidates: [
          {
            ...body.candidates[0],
            salience: {
              ...body.candidates[0].salience,
              components: {
                ...body.candidates[0].salience.components,
                confidence: undefined,
              } as never,
            },
          },
        ],
      }),
      rehash({
        ...body,
        candidates: [
          {
            ...body.candidates[0],
            salience: {
              ...body.candidates[0].salience,
              inputs: {
                ...body.candidates[0].salience.inputs,
                explicitCorrection: !body.candidates[0].salience.inputs.explicitCorrection,
              },
            },
          },
        ],
      }),
      rehash({
        ...body,
        candidates: [
          {
            ...body.candidates[0],
            salience: {
              ...body.candidates[0].salience,
              inputs: {
                ...body.candidates[0].salience.inputs,
                legacyFallback: body.candidates[0].salience.inputs.legacyFallback
                  ? {
                      ...body.candidates[0].salience.inputs.legacyFallback,
                      sourceAuthority: 'unknown',
                      authority: 1,
                    }
                  : undefined,
              },
            },
          },
        ],
      }),
    ];
    for (const invalid of malformed)
      assert.throws(() => store.putAdmissionReceipt(invalid), /invalid admission receipt/i);
    assert.throws(() => store.getAdmissionReceipt('rcpt_missing'), /receipt id/i);
    assert.throws(() => store.listAdmissionReceipts({ kind: 'invalid' as never }), /kind/i);
    store.putAdmissionReceipt(original);
    store.close();

    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE admission_receipts SET kind = ?, evaluated_at = ? WHERE id = ?')
      .run('recall', '2026-01-01T00:00:00.000Z', original.id);
    raw.close();
    const reopened = SqliteStore.open(dbPath);
    assert.throws(() => reopened.putAdmissionReceipt(original), /row.*disagrees/i);
    assert.throws(() => reopened.getAdmissionReceipt(original.id), /row.*disagrees/i);
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('migrates to schema 13 and provides idempotent put/get/list with corruption and payload bounds', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-receipts-'));
    const dbPath = join(root, 'graph.db');
    let store = SqliteStore.open(dbPath);
    const value = receipt();

    assert.equal(store.getMeta('schema_version'), '13');
    assert.equal(store.putAdmissionReceipt(value), true);
    assert.equal(store.putAdmissionReceipt(value), false);
    assert.deepEqual(store.getAdmissionReceipt(value.id), value);
    assert.deepEqual(store.listAdmissionReceipts(), [value]);
    store.close();

    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE admission_receipts SET payload = ? WHERE id = ?')
      .run('{"broken":true}', value.id);
    raw.close();
    store = SqliteStore.open(dbPath);
    assert.throws(() => store.getAdmissionReceipt(value.id), /corrupt admission receipt/i);
    store.close();

    const hugeBrief = 'x'.repeat(4_000_000);
    const oversized = {
      ...value,
      policy: { ...value.policy, tokenBudget: 1_000_000 },
      budget: { tokenBudget: 1_000_000, usedTokens: 1_000_000, remainingTokens: 0 },
      renderedBrief: hugeBrief,
    };
    const { id: _oldId, ...withoutId } = oversized;
    const bounded = { ...withoutId, id: computeAdmissionReceiptId(withoutId) } as AdmissionReceipt;
    store = SqliteStore.open(join(root, 'bounded.db'));
    assert.throws(() => store.putAdmissionReceipt(bounded), /payload.*bound/i);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects malformed and future schema versions before rewriting metadata', () => {
    for (const version of ['999', 'garbage', '12junk']) {
      const root = mkdtempSync(join(tmpdir(), 'nacre-receipt-schema-'));
      const dbPath = join(root, 'graph.db');
      SqliteStore.open(dbPath).close();
      const raw = new Database(dbPath);
      raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(version);
      raw.close();
      assert.throws(() => SqliteStore.open(dbPath), /schema version/i);
      const unchanged = new Database(dbPath, { readonly: true });
      assert.equal(
        (
          unchanged.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
            value: string;
          }
        ).value,
        version,
      );
      unchanged.close();
      rmSync(root, { recursive: true, force: true });
    }

    const root = mkdtempSync(join(tmpdir(), 'nacre-receipt-missing-meta-'));
    const dbPath = join(root, 'graph.db');
    const malformed = new Database(dbPath);
    malformed.exec('CREATE TABLE sentinel (value TEXT NOT NULL)');
    malformed.close();
    assert.throws(() => SqliteStore.open(dbPath), /schema.*metadata|schema version/i);
    const unchanged = new Database(dbPath, { readonly: true });
    const tables = unchanged
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map(({ name }) => name),
      ['sentinel'],
    );
    unchanged.close();
    rmSync(root, { recursive: true, force: true });

    const emptyRoot = mkdtempSync(join(tmpdir(), 'nacre-receipt-empty-existing-'));
    const emptyPath = join(emptyRoot, 'graph.db');
    const empty = new Database(emptyPath);
    empty.exec('VACUUM');
    empty.close();
    const emptyBefore = readFileSync(emptyPath);
    assert.throws(() => SqliteStore.open(emptyPath), /schema.*metadata|schema version/i);
    assert.deepEqual(readFileSync(emptyPath), emptyBefore);
    rmSync(emptyRoot, { recursive: true, force: true });
  });
});
