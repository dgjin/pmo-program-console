'use strict';

/**
 * 在线每日备份：VACUUM INTO 生成一致性数据库快照，同时备份 AI 本地密钥和校验清单。
 *
 *   node scripts/backup.js
 *   PMO_DB=/var/lib/pmo/pmo.db PMO_BACKUP_DIR=/backup/pmo node scripts/backup.js
 *
 * 默认保留 30 天：PMO_BACKUP_KEEP_DAYS=30
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const source = process.env.PMO_DB || path.join(root, 'data', 'pmo.db');
const outDir = process.env.PMO_BACKUP_DIR || path.join(root, 'backups');
const keepDays = Math.max(1, Number(process.env.PMO_BACKUP_KEEP_DAYS) || 30);

if (!fs.existsSync(source)) {
  console.error(`找不到数据库：${source}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.chmodSync(outDir, 0o700);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const base = `pmo-${stamp}`;
const dest = path.join(outDir, `${base}.db`);
const keySource = path.join(path.dirname(source), '.ai-key');
const keyDest = path.join(outDir, `${base}.ai-key`);
const manifestPath = path.join(outDir, `${base}.json`);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const db = new DatabaseSync(source);
try {
  const escaped = dest.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}

let keyCopied = false;
if (fs.existsSync(keySource)) {
  fs.copyFileSync(keySource, keyDest);
  fs.chmodSync(keyDest, 0o600);
  keyCopied = true;
}

const manifest = {
  createdAt: new Date().toISOString(),
  source,
  database: path.basename(dest),
  databaseBytes: fs.statSync(dest).size,
  databaseSha256: sha256(dest),
  aiKey: keyCopied ? path.basename(keyDest) : null,
  aiKeySha256: keyCopied ? sha256(keyDest) : null,
  keepDays,
  node: process.version,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(dest, 0o600);
fs.chmodSync(manifestPath, 0o600);

const cutoff = Date.now() - keepDays * 86400000;
const keep = new Set([path.basename(dest), path.basename(manifestPath), keyCopied ? path.basename(keyDest) : '']);
let removed = 0;
for (const file of fs.readdirSync(outDir)) {
  if (!/^pmo-.*\.(db|ai-key|json)$/.test(file)) continue;
  if (keep.has(file)) continue;
  const full = path.join(outDir, file);
  if (fs.statSync(full).mtimeMs < cutoff) {
    fs.unlinkSync(full);
    removed += 1;
  }
}

console.log(`备份完成：${dest}（${(manifest.databaseBytes / 1024).toFixed(0)} KB）`);
console.log(`校验：${manifest.databaseSha256}`);
console.log(`AI 密钥：${keyCopied ? '已备份' : '未找到，跳过'}；保留 ${keepDays} 天，清理 ${removed} 个旧文件`);
