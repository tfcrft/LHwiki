'use strict';

const { PRIMARY_KEYS } = require('../../cloudbase/functions/lhwiki-api/pg-store.cjs');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createMemoryStore(initialData = {}) {
  const tables = new Map(Object.keys(PRIMARY_KEYS).map(table => [table, new Map()]));
  const failures = [];

  function tableFor(table) {
    const rows = tables.get(table);
    if (!rows) throw new Error(`Unknown memory table: ${table}`);
    return rows;
  }

  function keyFor(table, document) {
    const key = PRIMARY_KEYS[table];
    const value = document?.[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing primary key ${key} for ${table}`);
    }
    return String(value);
  }

  function consumeFailure(operation, table) {
    const index = failures.findIndex(item => item.operation === operation && (!item.table || item.table === table));
    if (index < 0) return;
    const [{ error }] = failures.splice(index, 1);
    throw error;
  }

  function matches(document, where = null) {
    return Object.entries(where || {}).every(([field, expected]) => {
      if (!expected || typeof expected !== 'object' || typeof expected.operator !== 'string') {
        return document[field] === expected;
      }
      const actual = document[field];
      switch (expected.operator) {
        case 'eq': return actual === expected.value;
        case 'neq': return actual !== expected.value;
        case 'gt': return actual > expected.value;
        case 'gte': return actual >= expected.value;
        case 'lt': return actual < expected.value;
        case 'lte': return actual <= expected.value;
        default: throw new Error(`Unsupported memory filter operator: ${expected.operator}`);
      }
    });
  }

  function assertUnique(table, document, replacingKey = null) {
    const rows = tableFor(table);
    const key = keyFor(table, document);
    if (key !== replacingKey && rows.has(key)) {
      const error = new Error(`Duplicate primary key for ${table}`);
      error.code = 'UNIQUE_VIOLATION';
      throw error;
    }
    if (table === 'drafts') {
      for (const [candidateKey, candidate] of rows) {
        if (candidateKey !== replacingKey
          && candidate.student_id === document.student_id
          && candidate.draft_key === document.draft_key) {
          const error = new Error('Duplicate draft key for student');
          error.code = 'UNIQUE_VIOLATION';
          throw error;
        }
      }
    }
  }

  for (const [table, documents] of Object.entries(initialData)) {
    for (const document of documents || []) {
      assertUnique(table, document);
      tableFor(table).set(keyFor(table, document), clone(document));
    }
  }

  async function getDocument(table, id) {
    consumeFailure('getDocument', table);
    return clone(tableFor(table).get(String(id)) || null);
  }

  async function queryDocuments(table, where = null, limit = 100) {
    consumeFailure('queryDocuments', table);
    return [...tableFor(table).values()].filter(document => matches(document, where)).slice(0, limit).map(clone);
  }

  async function createDocument(table, data) {
    consumeFailure('createDocument', table);
    assertUnique(table, data);
    tableFor(table).set(keyFor(table, data), clone(data));
    return clone(data);
  }

  async function setDocument(table, id, data) {
    consumeFailure('setDocument', table);
    const key = PRIMARY_KEYS[table];
    const document = { ...clone(data), [key]: id };
    const storageKey = String(id);
    assertUnique(table, document, storageKey);
    tableFor(table).set(storageKey, document);
  }

  async function updateDocuments(table, where, data) {
    consumeFailure('updateDocuments', table);
    const rows = tableFor(table);
    const updated = [];
    for (const [storageKey, existing] of [...rows]) {
      if (!matches(existing, where)) continue;
      const document = { ...existing, ...clone(data) };
      const nextKey = keyFor(table, document);
      assertUnique(table, document, storageKey);
      if (nextKey !== storageKey) rows.delete(storageKey);
      rows.set(nextKey, document);
      updated.push(clone(document));
    }
    return updated;
  }

  async function deleteDocument(table, id) {
    consumeFailure('deleteDocument', table);
    tableFor(table).delete(String(id));
  }

  async function deleteDocuments(table, where) {
    consumeFailure('deleteDocuments', table);
    const rows = tableFor(table);
    const deleted = [];
    for (const [key, document] of [...rows]) {
      if (!matches(document, where)) continue;
      rows.delete(key);
      deleted.push(clone(document));
    }
    return deleted;
  }

  function failNext(operation, table, error = new Error('Injected memory store failure')) {
    failures.push({ operation, table, error });
  }

  function inspect(table) {
    return [...tableFor(table).values()].map(clone);
  }

  return {
    createDocument,
    deleteDocument,
    deleteDocuments,
    getDocument,
    queryDocuments,
    setDocument,
    updateDocuments,
    failNext,
    inspect
  };
}

module.exports = { createMemoryStore };
