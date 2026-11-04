'use strict';

/**
 * 只读校验备份：不改动备份，也不接触生产库。
 *   node scripts/verify-backup.js backups/pmo-2026-11-04T02-05-59.db
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/verify-backup.js <backup.db>');
  process.exit(1);
}
const full = path.resolve(file);
if (!fs.existsSync(full)) {
  console.error(`找不到备份：${full}`);
  process.exit(1);
}

const db = new DatabaseSync(full, { readOnly: true });
try {
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const counts = {
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
    weeklyReports: db.prepare('SELECT COUNT(*) AS n FROM weekly_reports').get().n,
    roomBookings: db.prepare('SELECT COUNT(*) AS n FROM room_bookings').get().n,
    supplyItems: db.prepare('SELECT COUNT(*) AS n FROM supply_items').get().n,
  };
  const manifestPath = full.replace(/\.db$/, '.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  console.log(JSON.stringify({ ok: integrity.integrity_check === 'ok', integrity: integrity.integrity_check, counts, manifest }, null, 2));
  if (integrity.integrity_check !== 'ok') process.exit(1);
} finally {
  db.close();
}
