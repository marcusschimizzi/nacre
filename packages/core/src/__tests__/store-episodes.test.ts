import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import type { Episode, MemoryNode } from '../types.js';

function makeEpisode(overrides: Partial<Episode> & { id: string; title: string }): Episode {
  return {
    timestamp: '2026-01-15',
    type: 'observation',
    content: 'Test content for ' + overrides.title,
    sequence: 0,
    participants: [],
    topics: [],
    importance: 0.5,
    accessCount: 0,
    lastAccessed: '2026-01-15',
    source: '/test.md',
    sourceType: 'markdown',
    ...overrides,
  };
}

function makeNode(id: string, label: string, type: MemoryNode['type'] = 'concept'): MemoryNode {
  return {
    id,
    label,
    type,
    aliases: [],
    firstSeen: '2026-01-01',
    lastReinforced: '2026-01-15',
    mentionCount: 1,
    reinforcementCount: 0,
    sourceFiles: [],
    excerpts: [],
  };
}

describe('SqliteStore — Episodes', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open();
  });

  after(() => {
    store.close();
  });

  describe('episode CRUD', () => {
    it('puts and gets an episode', () => {
      const ep = makeEpisode({ id: 'ep1', title: 'First Episode' });
      store.putEpisode(ep);
      const result = store.getEpisode('ep1');
      assert.ok(result);
      assert.equal(result.id, 'ep1');
      assert.equal(result.title, 'First Episode');
      assert.equal(result.type, 'observation');
      assert.equal(result.importance, 0.5);
    });

    it('returns undefined for missing episode', () => {
      assert.equal(store.getEpisode('nonexistent'), undefined);
    });

    it('deletes an episode', () => {
      store.putEpisode(makeEpisode({ id: 'ep-del', title: 'Delete Me' }));
      assert.ok(store.getEpisode('ep-del'));
      store.deleteEpisode('ep-del');
      assert.equal(store.getEpisode('ep-del'), undefined);
    });

    it('counts episodes', () => {
      const count = store.episodeCount();
      assert.ok(count >= 1);
    });

    it('upserts via putEpisode', () => {
      store.putEpisode(makeEpisode({ id: 'ep1', title: 'Updated Title' }));
      const result = store.getEpisode('ep1');
      assert.equal(result?.title, 'Updated Title');
    });
  });

  describe('episode filtering', () => {
    before(() => {
      store.putEpisode(makeEpisode({ id: 'ep-dec', title: 'A Decision', type: 'decision', timestamp: '2026-01-10' }));
      store.putEpisode(makeEpisode({ id: 'ep-evt', title: 'An Event', type: 'event', timestamp: '2026-01-20' }));
      store.putEpisode(makeEpisode({ id: 'ep-obs', title: 'An Observation', type: 'observation', timestamp: '2026-01-25', source: '/notes.md' }));
    });

    it('filters by type', () => {
      const decisions = store.listEpisodes({ type: 'decision' });
      assert.ok(decisions.length >= 1);
      assert.ok(decisions.every(e => e.type === 'decision'));
    });

    it('filters by since', () => {
      const recent = store.listEpisodes({ since: '2026-01-15' });
      assert.ok(recent.every(e => e.timestamp >= '2026-01-15'));
    });

    it('filters by until', () => {
      const early = store.listEpisodes({ until: '2026-01-15' });
      assert.ok(early.every(e => e.timestamp <= '2026-01-15'));
    });

    it('filters by source', () => {
      const fromNotes = store.listEpisodes({ source: '/notes.md' });
      assert.ok(fromNotes.length >= 1);
      assert.ok(fromNotes.every(e => e.source === '/notes.md'));
    });

    it('returns all with empty filter', () => {
      const all = store.listEpisodes();
      assert.ok(all.length >= 4);
    });

    it('orders by timestamp descending', () => {
      const all = store.listEpisodes();
      for (let i = 1; i < all.length; i++) {
        assert.ok(all[i - 1].timestamp >= all[i].timestamp);
      }
    });
  });

  describe('episode entity linking', () => {
    before(() => {
      store.putNode(makeNode('n-marcus', 'Marcus', 'person'));
      store.putNode(makeNode('n-nacre', 'Nacre', 'project'));
      store.putEpisode(makeEpisode({ id: 'ep-link', title: 'Linked Episode' }));
    });

    it('links and retrieves episode entities', () => {
      store.linkEpisodeEntity('ep-link', 'n-marcus', 'participant');
      store.linkEpisodeEntity('ep-link', 'n-nacre', 'topic');

      const links = store.getEpisodeEntities('ep-link');
      assert.equal(links.length, 2);

      const participant = links.find(l => l.role === 'participant');
      assert.ok(participant);
      assert.equal(participant.nodeId, 'n-marcus');

      const topic = links.find(l => l.role === 'topic');
      assert.ok(topic);
      assert.equal(topic.nodeId, 'n-nacre');
    });

    it('populates participants and topics on getEpisode', () => {
      const ep = store.getEpisode('ep-link');
      assert.ok(ep);
      assert.ok(ep.participants.includes('n-marcus'));
      assert.ok(ep.topics.includes('n-nacre'));
    });

    it('filters episodes by entity (hasEntity)', () => {
      const episodes = store.listEpisodes({ hasEntity: 'n-marcus' });
      assert.ok(episodes.length >= 1);
      assert.ok(episodes.some(e => e.id === 'ep-link'));
    });

    it('gets episodes for a node', () => {
      const episodes = store.getEntityEpisodes('n-marcus');
      assert.ok(episodes.length >= 1);
      assert.ok(episodes.some(e => e.id === 'ep-link'));
    });

    it('unlinks episode entity', () => {
      store.unlinkEpisodeEntity('ep-link', 'n-nacre', 'topic');
      const links = store.getEpisodeEntities('ep-link');
      assert.equal(links.filter(l => l.nodeId === 'n-nacre').length, 0);
    });

    it('cascades delete on episode removal', () => {
      store.putEpisode(makeEpisode({ id: 'ep-cascade', title: 'Cascade Test' }));
      store.linkEpisodeEntity('ep-cascade', 'n-marcus', 'participant');
      store.deleteEpisode('ep-cascade');
      const links = store.getEpisodeEntities('ep-cascade');
      assert.equal(links.length, 0);
    });
  });

  describe('touchEpisode', () => {
    it('increments access count and updates lastAccessed', () => {
      store.putEpisode(makeEpisode({ id: 'ep-touch', title: 'Touch Me', accessCount: 0 }));

      store.touchEpisode('ep-touch');
      const after1 = store.getEpisode('ep-touch');
      assert.equal(after1?.accessCount, 1);
      assert.ok(after1?.lastAccessed);

      store.touchEpisode('ep-touch');
      const after2 = store.getEpisode('ep-touch');
      assert.equal(after2?.accessCount, 2);
    });
  });

  describe('serialization roundtrip', () => {
    it('preserves all episode fields', () => {
      const ep = makeEpisode({
        id: 'ep-rt',
        title: 'Roundtrip Test',
        type: 'decision',
        timestamp: '2026-02-01T12:00:00Z',
        endTimestamp: '2026-02-01T13:00:00Z',
        summary: 'A test summary',
        content: 'Full content here with details.',
        sequence: 5,
        parentId: 'ep-parent',
        importance: 0.9,
        accessCount: 3,
        lastAccessed: '2026-02-01T14:00:00Z',
        source: '/deep/path/file.md',
        sourceType: 'markdown',
      });

      store.putEpisode(ep);
      const result = store.getEpisode('ep-rt')!;

      assert.equal(result.title, 'Roundtrip Test');
      assert.equal(result.type, 'decision');
      assert.equal(result.timestamp, '2026-02-01T12:00:00Z');
      assert.equal(result.endTimestamp, '2026-02-01T13:00:00Z');
      assert.equal(result.summary, 'A test summary');
      assert.equal(result.content, 'Full content here with details.');
      assert.equal(result.sequence, 5);
      assert.equal(result.parentId, 'ep-parent');
      assert.equal(result.importance, 0.9);
      assert.equal(result.accessCount, 3);
      assert.equal(result.lastAccessed, '2026-02-01T14:00:00Z');
      assert.equal(result.source, '/deep/path/file.md');
      assert.equal(result.sourceType, 'markdown');
    });
  });
});
