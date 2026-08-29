import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fromBackup } = require('../cloudbase/functions/lhwiki-api/public-snapshot.cjs');

const [backupArg, outputArg] = process.argv.slice(2);
if (!backupArg || backupArg.startsWith('-')) {
  throw new Error('用法：node scripts/build-public-snapshot.mjs <明确的备份 JSON 路径> [输出路径]');
}
const backupPath = resolve(backupArg);
const outputPath = resolve(outputArg || 'cloudbase/functions/lhwiki-api/public-snapshot.json');
const backup = JSON.parse((await readFile(backupPath, 'utf8')).replace(/^\uFEFF/, ''));
const snapshot = fromBackup(backup);
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`已生成公开快照：${outputPath}`);
console.log(`公开分区 ${snapshot.sections.length}，文章 ${snapshot.articles.length}，贡献者 ${snapshot.contributors.length}，教师补充 ${snapshot.teacherAdditions.length}`);
