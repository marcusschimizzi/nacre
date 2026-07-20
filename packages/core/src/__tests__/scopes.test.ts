import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScopeForWrite, resolveScopePolicy } from '../config.js';
import {
  DEFAULT_SCOPE_POLICIES,
  SESSION_SCOPE,
  isDurableScope,
  isKnownScope,
  resolveWriteScope,
  scopeClass,
  scopePolicy,
} from '../scopes.js';

describe('scope classification', () => {
  it('distinguishes durable scopes from session scratch', () => {
    for (const scope of ['user', 'agent', 'project/nacre', 'project/tide-pool']) {
      assert.ok(isDurableScope(scope), `${scope} is durable`);
      assert.ok(isKnownScope(scope));
    }
    assert.ok(!isDurableScope(SESSION_SCOPE), 'session is not durable');
    assert.ok(isKnownScope(SESSION_SCOPE), 'session is known');
    assert.ok(!isKnownScope('global'));
    assert.ok(!isKnownScope('project/'));
  });

  it('maps scopes to policy classes', () => {
    assert.equal(scopeClass('user'), 'user');
    assert.equal(scopeClass('agent'), 'agent');
    assert.equal(scopeClass('session'), 'session');
    assert.equal(scopeClass('project/nacre'), 'project');
    assert.equal(scopeClass('nonsense'), undefined);
  });
});

describe('scopePolicy', () => {
  it('applies built-in defaults per class', () => {
    assert.deepEqual(scopePolicy('user'), DEFAULT_SCOPE_POLICIES.user);
    assert.deepEqual(scopePolicy('project/nacre'), DEFAULT_SCOPE_POLICIES.project);
    assert.equal(scopePolicy('agent').hiveEligible, false);
    assert.equal(scopePolicy('session').spooled, false);
    assert.equal(scopePolicy('session').retentionDays, 7);
  });

  it('unknown scopes get the most conservative policy (store-only scratch)', () => {
    const policy = scopePolicy('whatever');
    assert.equal(policy.spooled, false);
    assert.equal(policy.hiveEligible, false);
  });

  it('class overrides apply to every scope in the class; exact overrides win', () => {
    const overrides = {
      project: { hiveEligible: false },
      'project/public-notes': { hiveEligible: true },
      agent: { syncEligible: true },
    };
    assert.equal(scopePolicy('project/nacre', overrides).hiveEligible, false);
    assert.equal(scopePolicy('project/public-notes', overrides).hiveEligible, true);
    assert.equal(scopePolicy('agent', overrides).syncEligible, true);
    // Untouched fields keep their defaults.
    assert.equal(scopePolicy('project/nacre', overrides).spooled, true);
  });
});

describe('resolveWriteScope', () => {
  it('explicit wins, config default second, agent last', () => {
    assert.equal(resolveWriteScope('project/nacre', 'user'), 'project/nacre');
    assert.equal(resolveWriteScope(undefined, 'user'), 'user');
    assert.equal(resolveWriteScope(undefined, undefined), 'agent');
  });

  it('explicit session is honored (scratch is a deliberate choice)', () => {
    assert.equal(resolveWriteScope('session', 'user'), 'session');
  });

  it('invalid explicit and non-durable config defaults fall through', () => {
    assert.equal(resolveWriteScope('global', 'user'), 'user');
    // A session DEFAULT would silently make everything scratch — refused.
    assert.equal(resolveWriteScope(undefined, 'session'), 'agent');
    assert.equal(resolveWriteScope(undefined, 'nonsense'), 'agent');
  });
});

describe('config-level scope resolution', () => {
  let root: string;
  after(() => rmSync(root, { recursive: true, force: true }));

  it('reads memory.defaultScope and scopes overrides from nacre.config.json', () => {
    root = mkdtempSync(join(tmpdir(), 'nacre-scopecfg-'));
    const graphPath = join(root, 'graph.db');
    writeFileSync(
      join(root, 'nacre.config.json'),
      JSON.stringify({
        memory: { defaultScope: 'project/nacre' },
        scopes: { agent: { hiveEligible: true }, session: { retentionDays: 1 } },
      }),
    );

    assert.equal(resolveScopeForWrite(graphPath), 'project/nacre');
    assert.equal(resolveScopeForWrite(graphPath, 'user'), 'user');
    assert.equal(resolveScopePolicy(graphPath, 'agent').hiveEligible, true);
    assert.equal(resolveScopePolicy(graphPath, 'session').retentionDays, 1);
    // Untouched scopes keep builtin policy.
    assert.equal(resolveScopePolicy(graphPath, 'user').hiveEligible, true);
  });

  it('falls back to agent without config', () => {
    assert.equal(resolveScopeForWrite(null), 'agent');
  });
});
