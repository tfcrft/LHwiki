'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { parseDocument } = require('./content.cjs');

const SNAPSHOT_SCHEMA_VERSION = 1;
const TOP_LEVEL_KEYS = ['schemaVersion', 'generatedAt', 'sections', 'articles', 'contributors', 'teacherAdditions'];
const SECTION_KEYS = ['slug', 'title', 'description', 'icon', 'sort_order'];
const ARTICLE_KEYS = ['slug', 'section_slug', 'title', 'summary', 'content_type', 'subject', 'author_label', 'published_at', 'updated_at', 'body'];
const CONTRIBUTOR_KEYS = ['displayName', 'since'];
const TEACHER_ADDITION_KEYS = ['id', 'name', 'subject', 'motto', 'profile', 'sourceUrl', 'sourceLabel', 'publishedAt'];

function fail(message) {
  throw new Error(`Public snapshot invalid: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains an unapproved field`);
  }
}

function text(value, label, max = 500) {
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be short text`);
  return value;
}

function optionalText(value, label, max = 500) {
  if (value !== null && value !== undefined) text(value, label, max);
  return value ?? null;
}

function publicArticle(article, label) {
  exactKeys(article, ARTICLE_KEYS, label);
  const body = parseDocument(article.body);
  if (!body) fail(`${label}.body is not a valid document`);
  return {
    slug: text(article.slug, `${label}.slug`, 120),
    section_slug: text(article.section_slug, `${label}.section_slug`, 60),
    title: text(article.title, `${label}.title`, 100),
    summary: text(article.summary, `${label}.summary`, 240),
    content_type: text(article.content_type, `${label}.content_type`, 40),
    subject: text(article.subject, `${label}.subject`, 80),
    author_label: text(article.author_label, `${label}.author_label`, 40),
    published_at: text(article.published_at, `${label}.published_at`, 80),
    updated_at: text(article.updated_at, `${label}.updated_at`, 80),
    body
  };
}

function validatePublicSnapshot(snapshot) {
  exactKeys(snapshot, TOP_LEVEL_KEYS, 'snapshot');
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail('unsupported schemaVersion');
  optionalText(snapshot.generatedAt, 'snapshot.generatedAt', 80);
  const limits = { sections: 100, articles: 2000, contributors: 2000, teacherAdditions: 500 };
  for (const [name, value] of Object.entries({ sections: snapshot.sections, articles: snapshot.articles, contributors: snapshot.contributors, teacherAdditions: snapshot.teacherAdditions })) {
    if (!Array.isArray(value)) fail(`snapshot.${name} must be an array`);
    if (value.length > limits[name]) fail(`snapshot.${name} exceeds the public limit`);
  }
  const sections = snapshot.sections.map((section, index) => {
    const label = `sections[${index}]`;
    exactKeys(section, SECTION_KEYS, label);
    return {
      slug: text(section.slug, `${label}.slug`, 60),
      title: text(section.title, `${label}.title`, 100),
      description: text(section.description, `${label}.description`, 240),
      icon: text(section.icon, `${label}.icon`, 8),
      sort_order: Number.isSafeInteger(section.sort_order) ? section.sort_order : fail(`${label}.sort_order must be an integer`)
    };
  });
  const sectionSlugs = new Set(sections.map(section => section.slug));
  if (sectionSlugs.size !== sections.length) fail('duplicate section slug');
  const articles = snapshot.articles.map((article, index) => publicArticle(article, `articles[${index}]`));
  const articleSlugs = new Set(articles.map(article => article.slug));
  if (articleSlugs.size !== articles.length) fail('duplicate article slug');
  if (articles.some(article => !sectionSlugs.has(article.section_slug))) fail('article references an unknown section');
  const contributors = snapshot.contributors.map((contributor, index) => {
    const label = `contributors[${index}]`;
    exactKeys(contributor, CONTRIBUTOR_KEYS, label);
    return { displayName: text(contributor.displayName, `${label}.displayName`, 40), since: text(contributor.since, `${label}.since`, 80) };
  });
  const teacherAdditions = snapshot.teacherAdditions.map((teacher, index) => {
    const label = `teacherAdditions[${index}]`;
    exactKeys(teacher, TEACHER_ADDITION_KEYS, label);
    if (teacher.id === null || teacher.id === undefined) fail(`${label}.id is required`);
    return {
      id: text(String(teacher.id), `${label}.id`, 140),
      name: text(teacher.name, `${label}.name`, 80),
      subject: text(teacher.subject, `${label}.subject`, 80),
      motto: optionalText(teacher.motto, `${label}.motto`, 240),
      profile: text(teacher.profile ?? '', `${label}.profile`, 1),
      sourceUrl: text(teacher.sourceUrl ?? '', `${label}.sourceUrl`, 1),
      sourceLabel: text(teacher.sourceLabel ?? '', `${label}.sourceLabel`, 40),
      publishedAt: text(teacher.publishedAt, `${label}.publishedAt`, 80)
    };
  });
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, generatedAt: snapshot.generatedAt ?? null, sections, articles, contributors, teacherAdditions };
}

function parseBodyJson(value, label) {
  let body;
  try { body = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail(`${label}.body_json is not JSON`); }
  return parseDocument(body) || fail(`${label}.body_json is not a valid document`);
}

function fromSeed(seed) {
  return validatePublicSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: null,
    sections: (seed.sections || []).map(section => ({ ...section })),
    articles: (seed.articles || []).map(article => ({
      slug: article.slug,
      section_slug: article.section_slug,
      title: article.title,
      summary: article.summary,
      content_type: article.content_type,
      subject: article.subject,
      author_label: article.author_label,
      published_at: article.published_at,
      updated_at: article.updated_at,
      body: parseBodyJson(article.body_json, `article ${article.slug}`)
    })),
    contributors: [],
    teacherAdditions: []
  });
}

function fromBackup(backup) {
  if (!backup || backup.formatVersion !== 1 || !backup.data) fail('backup format is unsupported');
  const rows = name => Array.isArray(backup.data[name]) ? backup.data[name] : fail(`backup.data.${name} must be an array`);
  return validatePublicSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: backup.exportedAt || new Date().toISOString(),
    sections: rows('sections').map(section => ({
      slug: section.slug, title: section.title, description: section.description, icon: section.icon, sort_order: section.sort_order
    })),
    articles: rows('articles').map(article => ({
      slug: article.slug,
      section_slug: article.section_slug,
      title: article.title,
      summary: article.summary,
      content_type: article.content_type,
      subject: article.subject,
      author_label: article.author_label,
      published_at: article.published_at,
      updated_at: article.updated_at,
      body: parseBodyJson(article.body_json, `article ${article.slug}`)
    })),
    contributors: rows('contributors').filter(row => row.approved_at).map(row => ({ displayName: row.display_name, since: row.approved_at })),
    teacherAdditions: rows('teacher_additions').filter(row => row.approved_at).map(row => ({
      id: String(row.id), name: row.name, subject: row.subject, motto: row.motto ?? null,
      profile: '', sourceUrl: '', sourceLabel: '经校内补充审核', publishedAt: row.approved_at
    }))
  });
}

function loadPublicSnapshot({ snapshotPath, seedPath }) {
  const path = existsSync(snapshotPath) ? snapshotPath : seedPath;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return existsSync(snapshotPath) ? validatePublicSnapshot(raw) : fromSeed(raw);
}

module.exports = { SNAPSHOT_SCHEMA_VERSION, fromBackup, fromSeed, loadPublicSnapshot, validatePublicSnapshot };
