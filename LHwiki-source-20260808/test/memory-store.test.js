import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createMemoryStore } = require('./helpers/memory-store.cjs');

test('memory store implements CRUD, filtering and copy isolation', async () => {
  const store = createMemoryStore({
    sections: [{ slug: 'start', title: '开始', sort_order: 1 }],
    drafts: [{ id: 'draft-1', student_id: '209900001', draft_key: 'new:fixture001', revision: 1 }]
  });
  const section = await store.getDocument('sections', 'start');
  section.title = '被测试修改';
  assert.equal((await store.getDocument('sections', 'start')).title, '开始');

  await store.setDocument('sections', 'start', { title: '更新', sort_order: 2 });
  assert.equal((await store.getDocument('sections', 'start')).slug, 'start');
  await store.createDocument('sections', { slug: 'courses', title: '课程', sort_order: 3 });
  assert.deepEqual((await store.queryDocuments('sections', { sort_order: { operator: 'gte', value: 2 } })).map(row => row.slug), ['start', 'courses']);

  const updated = await store.updateDocuments('drafts', { id: 'draft-1', revision: 1 }, { revision: 2 });
  assert.equal(updated[0].revision, 2);
  assert.deepEqual(await store.updateDocuments('drafts', { id: 'draft-1', revision: 1 }, { revision: 3 }), []);
  assert.equal((await store.deleteDocuments('drafts', { student_id: '209900001' })).length, 1);
  assert.equal(await store.getDocument('drafts', 'draft-1'), null);
  await store.deleteDocument('sections', 'courses');
  assert.equal(await store.getDocument('sections', 'courses'), null);
});

test('memory store enforces primary keys and per-student draft keys', async () => {
  const store = createMemoryStore({ drafts: [{ id: 'draft-1', student_id: '209900001', draft_key: 'new:fixture001' }] });
  await assert.rejects(
    () => store.createDocument('drafts', { id: 'draft-1', student_id: '209900002', draft_key: 'new:fixture002' }),
    error => error.code === 'UNIQUE_VIOLATION'
  );
  await assert.rejects(
    () => store.createDocument('drafts', { id: 'draft-2', student_id: '209900001', draft_key: 'new:fixture001' }),
    error => error.code === 'UNIQUE_VIOLATION'
  );
  await store.createDocument('drafts', { id: 'draft-3', student_id: '209900002', draft_key: 'new:fixture001' });
  await assert.rejects(() => store.createDocument('sections', { title: '缺少主键' }), /Missing primary key/);
});

test('memory store injects a single targeted failure without poisoning later calls', async () => {
  const store = createMemoryStore({ sections: [{ slug: 'start', title: '开始' }] });
  const failure = Object.assign(new Error('database unavailable'), { name: 'CloudBasePgError', code: 'UPSTREAM_UNAVAILABLE', status: 503 });
  store.failNext('queryDocuments', 'sections', failure);
  await assert.rejects(() => store.queryDocuments('sections'), error => error === failure);
  assert.equal((await store.queryDocuments('sections')).length, 1);
});
