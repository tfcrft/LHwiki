import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createApp } = require('../cloudbase/functions/lhwiki-api/api-app.cjs');
const productionEntry = require('../cloudbase/functions/lhwiki-api/server.js');

function rejectingStore() {
  const reject = async () => { throw new Error('store must not be called'); };
  return {
    createDocument: reject,
    deleteDocument: reject,
    deleteDocuments: reject,
    getDocument: reject,
    queryDocuments: reject,
    setDocument: reject,
    updateDocuments: reject
  };
}

async function withServer(app, callback) {
  const server = http.createServer(app.handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('production entry can be imported without CloudBase credentials or opening a port', () => {
  assert.equal(typeof productionEntry.createProductionApp, 'function');
  assert.equal(typeof productionEntry.startServer, 'function');
});

test('createApp requires an injected store', () => {
  assert.throws(() => createApp(), /API store is required/);
});

test('injected maintenance configuration blocks private routes before store access', async () => {
  const app = createApp({
    store: rejectingStore(),
    sessionSecret: 'local-test-session-secret-at-least-32-characters',
    emergencyMaintenance: true,
    maintenanceReviewDate: '2099-12-31',
    publicSnapshot: { sections: [], articles: [], contributors: [], teacherAdditions: [] },
    logger: { error() {} }
  });
  await withServer(app, async origin => {
    const health = await fetch(`${origin}/api/health`).then(response => response.json());
    assert.deepEqual(health, {
      ok: true,
      database: 'suspended-by-application',
      maintenance: true,
      reviewDate: '2099-12-31',
      platform: 'cloudbase',
      region: 'ap-shanghai'
    });
    const blocked = await fetch(`${origin}/api/drafts/mine`);
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).maintenance, true);
  });
});

test('handler configuration is instance-local and validates the injected session secret', async () => {
  const app = createApp({
    store: rejectingStore(),
    emergencyMaintenance: false,
    sessionSecret: '',
    logger: { error() {} }
  });
  await withServer(app, async origin => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, '服务端尚未配置 SESSION_SECRET');
  });
});
