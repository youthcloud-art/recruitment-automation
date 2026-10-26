const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { bossNameKey, sameBossNearDuplicate,
  chooseBossNearDuplicate } = require('../utils/bossResumeIdentity');
const { hiringJobTitle } = require('../utils/candidateDisplay');
const { idFromOfficialUrl, platformLocator } = require('../utils/platformLocator');

const BASE_SNAPSHOT = Symbol('sqlite-resume-read-snapshot');

function writeOnceDurable(file, value) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function migrationMarker(file) {
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.format !== 1 || !/^[a-f0-9]{64}$/.test(value.legacySha256 || '')) {
    throw new Error('SQLite 迁移标记损坏，请检查备份');
  }
  return value;
}

// The application uses synchronous model methods. Node 24's built-in SQLite
// binding lets a single candidate be committed without rewriting the whole
// legacy JSON library on every capture or evaluation.
function databaseClass() {
  try { return require('node:sqlite').DatabaseSync; }
  catch (_) { throw new Error('SQLite 简历库需要 Node.js 24 或更新版本'); }
}

function validLibrary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.resumes) || !Array.isArray(value.positions) ||
      !Array.isArray(value.categories)) {
    throw new Error('原简历 JSON 结构无效，已停止 SQLite 迁移');
  }
  const ids = new Set();
  for (const resume of value.resumes) {
    if (!resume || typeof resume !== 'object' || typeof resume.id !== 'string' ||
        !resume.id || ids.has(resume.id)) {
      throw new Error('原简历 JSON 包含空或重复 ID，已停止 SQLite 迁移');
    }
    ids.add(resume.id);
  }
  return value;
}

function resumeJobState(resume, positions) {
  if (resume.jobArchiveState === 'archived') return 'archived';
  const id = resume.capturePositionId || resume.positionId;
  if (id) {
    const position = positions.find(item => item.id === id);
    return position ? (position.archivedAt ? 'archived' : 'current') : 'historical';
  }
  const requirements = resume.captureJobRequirements;
  if (!requirements) return 'historical';
  const matches = positions.filter(position =>
    position.title === hiringJobTitle(resume) &&
    position.jobCriteria?.jobRequirements === requirements);
  return matches.length === 1 ? (matches[0].archivedAt ? 'archived' : 'current') : 'historical';
}

class SqliteResumeStore {
  constructor(jsonFile, sqliteFile = path.join(path.dirname(jsonFile), 'resumes.sqlite')) {
    this.jsonFile = path.resolve(jsonFile);
    this.sqliteFile = path.resolve(sqliteFile);
    this.markerFile = `${this.sqliteFile}.migration.json`;
    fs.mkdirSync(path.dirname(this.sqliteFile), { recursive: true });
    if (!fs.existsSync(this.sqliteFile)) {
      if (migrationMarker(this.markerFile)) {
        throw new Error('曾迁移的 SQLite 简历库已丢失；拒绝用旧 JSON 重新迁移，请从备份恢复');
      }
      this.migrateLegacy();
    }
    const DatabaseSync = databaseClass();
    this.db = new DatabaseSync(this.sqliteFile);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.createSchema();
    if (this.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
      this.db.close();
      throw new Error('SQLite 简历库完整性检查失败，请从备份恢复');
    }
    const legacySha256 = this.db.prepare(`SELECT value FROM library_metadata
      WHERE key = 'legacy_sha256'`).get()?.value;
    if (!/^[a-f0-9]{64}$/.test(legacySha256 || '')) {
      this.db.close();
      throw new Error('SQLite 简历库缺少迁移来源校验值');
    }
    const marker = migrationMarker(this.markerFile);
    if (marker && marker.legacySha256 !== legacySha256) {
      this.db.close();
      throw new Error('SQLite 简历库与迁移标记不匹配');
    }
    if (!marker) writeOnceDurable(this.markerFile, { format: 1, legacySha256 });
  }

  acquireMigrationLock(lockFile) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const descriptor = fs.openSync(lockFile, 'wx', 0o600);
        try {
          const owner = { format: 1, host: os.hostname(), pid: process.pid,
            startedAt: new Date().toISOString() };
          fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
          fs.fsyncSync(descriptor);
        } catch (error) {
          fs.closeSync(descriptor);
          throw error;
        }
        return descriptor;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')); }
        catch (_) { throw new Error('迁移锁文件无效，请人工检查后重试'); }
        const age = Date.now() - Date.parse(owner.startedAt);
        if (owner.format !== 1 || owner.host !== os.hostname() ||
            !Number.isInteger(owner.pid) || owner.pid <= 0 ||
            !Number.isFinite(age) || age < 60000) {
          throw new Error('简历库迁移正在进行或锁状态不明，请稍后重试');
        }
        try {
          process.kill(owner.pid, 0);
          throw new Error('简历库迁移仍由其它进程执行');
        } catch (checkError) {
          if (checkError.code !== 'ESRCH') throw checkError;
        }
        fs.renameSync(lockFile,
          `${lockFile}.stale.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
      }
    }
    throw new Error('未能取得简历库迁移锁');
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_resumes (
        id TEXT PRIMARY KEY,
        source TEXT,
        source_fingerprint TEXT,
        source_candidate_id TEXT,
        source_card_fingerprint TEXT,
        boss_name_key TEXT,
        source_url TEXT,
        candidate_name TEXT,
        position TEXT,
        hiring_job_title TEXT,
        match_score REAL,
        capture_position_id TEXT,
        job_state TEXT,
        workflow_status TEXT,
        created_at TEXT,
        payload TEXT NOT NULL
      );
      -- SQLite indexes the implicit rowid in ascending order. Scanning these
      -- ascending indexes backwards supports created_at DESC, rowid DESC
      -- without sorting the full candidate library for deep pages.
      CREATE INDEX IF NOT EXISTS candidate_source_created
        ON candidate_resumes(source, created_at ASC);
      CREATE INDEX IF NOT EXISTS candidate_created
        ON candidate_resumes(created_at ASC);
      CREATE INDEX IF NOT EXISTS candidate_fingerprint
        ON candidate_resumes(source, source_fingerprint);
      CREATE INDEX IF NOT EXISTS candidate_source_url_name
        ON candidate_resumes(source, source_url, candidate_name);
      CREATE INDEX IF NOT EXISTS candidate_status_created
        ON candidate_resumes(workflow_status, created_at DESC);
      CREATE INDEX IF NOT EXISTS candidate_position_created
        ON candidate_resumes(position, created_at DESC);
      CREATE TABLE IF NOT EXISTS library_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Databases created before the ascending index change retain their old
    // definitions under the same names. Replace only those two indexes in a
    // transaction so an interrupted startup cannot leave one missing.
    const oldCreatedIndexes = this.db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND name IN ('candidate_source_created', 'candidate_created')`).all()
      .filter(index => /\bcreated_at\s+DESC\b/i.test(index.sql || ''));
    if (oldCreatedIndexes.length) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const index of oldCreatedIndexes) {
          this.db.exec(`DROP INDEX ${index.name}`);
          this.db.exec(index.name === 'candidate_source_created'
            ? 'CREATE INDEX candidate_source_created ON candidate_resumes(source, created_at ASC)'
            : 'CREATE INDEX candidate_created ON candidate_resumes(created_at ASC)');
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    // Existing local databases predate the stable BOSS candidate ID column.
    const columns = this.db.prepare('PRAGMA table_info(candidate_resumes)').all();
    if (!columns.some(column => column.name === 'source_candidate_id')) {
      this.db.exec('ALTER TABLE candidate_resumes ADD COLUMN source_candidate_id TEXT');
    }
    if (!columns.some(column => column.name === 'source_card_fingerprint')) {
      this.db.exec('ALTER TABLE candidate_resumes ADD COLUMN source_card_fingerprint TEXT');
    }
    if (!columns.some(column => column.name === 'boss_name_key')) {
      this.db.exec('ALTER TABLE candidate_resumes ADD COLUMN boss_name_key TEXT');
    }
    if (!columns.some(column => column.name === 'hiring_job_title')) {
      this.db.exec('ALTER TABLE candidate_resumes ADD COLUMN hiring_job_title TEXT');
    }
    if (!columns.some(column => column.name === 'match_score')) {
      this.db.exec('ALTER TABLE candidate_resumes ADD COLUMN match_score REAL');
    }
    if (!columns.some(column => column.name === 'capture_position_id')) {
      this.db.exec('ALTER TABLE candidate_resumes ADD COLUMN capture_position_id TEXT');
    }
    if (!columns.some(column => column.name === 'job_state')) {
      this.db.exec('ALTER TABLE candidate_resumes ADD COLUMN job_state TEXT');
    }
    const candidateViewBackfilled = this.db.prepare(`SELECT value FROM library_metadata
      WHERE key = 'candidate_view_fields_backfilled'`).get();
    if (!candidateViewBackfilled) {
      const rows = this.db.prepare('SELECT id, payload FROM candidate_resumes').iterate();
      const update = this.db.prepare(`UPDATE candidate_resumes
        SET hiring_job_title = ?, match_score = ? WHERE id = ?`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const resume = JSON.parse(row.payload);
          update.run(hiringJobTitle(resume), Number.isFinite(resume.matchScore) ? resume.matchScore : null, row.id);
        }
        this.db.prepare(`INSERT INTO library_metadata (key, value) VALUES
          ('candidate_view_fields_backfilled', 'true')`).run();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_hiring_job
      ON candidate_resumes(hiring_job_title, source, created_at DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_match_score
      ON candidate_resumes(match_score, created_at DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_job_group
      ON candidate_resumes(job_state, hiring_job_title, source, created_at DESC)`);
    // Staging databases have no legacy hash until migration has loaded its
    // metadata. Backfill on the first real open so old candidates are assigned
    // from the retained position catalog exactly once.
    if (this.db.prepare(`SELECT value FROM library_metadata WHERE key = 'legacy_sha256'`).get() &&
        !this.db.prepare(`SELECT value FROM library_metadata
          WHERE key = 'candidate_job_state_backfilled'`).get()) {
      const positions = this.metadata('positions');
      const update = this.db.prepare(`UPDATE candidate_resumes
        SET capture_position_id = ?, job_state = ? WHERE id = ?`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db.prepare('SELECT id, payload FROM candidate_resumes').iterate()) {
          const resume = JSON.parse(row.payload);
          update.run(resume.capturePositionId || resume.positionId || null,
            resumeJobState(resume, positions), row.id);
        }
        this.db.prepare(`INSERT INTO library_metadata (key, value) VALUES
          ('candidate_job_state_backfilled', 'true')`).run();
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_boss_identity
      ON candidate_resumes(source, source_candidate_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_boss_card
      ON candidate_resumes(source, source_card_fingerprint)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_boss_name
      ON candidate_resumes(source, boss_name_key)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_evaluation_job
      ON candidate_resumes(json_extract(payload, '$.matchEvaluation.jobRequirements'))`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_capture_job
      ON candidate_resumes(json_extract(payload, '$.captureJobRequirements'))`);
    const backfilled = this.db.prepare(`SELECT value FROM library_metadata
      WHERE key = 'boss_candidate_id_backfilled'`).get();
    if (!backfilled) {
      const legacyBoss = this.db.prepare(`SELECT id, payload FROM candidate_resumes
        WHERE source = 'boss' AND source_candidate_id IS NULL`).all();
      const update = this.db.prepare(`UPDATE candidate_resumes SET source_candidate_id = ? WHERE id = ?`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of legacyBoss) {
          const candidateId = JSON.parse(row.payload).sourceCandidateId;
          if (candidateId) update.run(candidateId, row.id);
        }
        this.db.prepare(`INSERT INTO library_metadata (key, value) VALUES
          ('boss_candidate_id_backfilled', 'true')`).run();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    const locatorBackfilled = this.db.prepare(`SELECT value FROM library_metadata
      WHERE key = 'official_platform_ids_backfilled_v1'`).get();
    if (!locatorBackfilled) {
      const legacy = this.db.prepare(`SELECT id, source, payload FROM candidate_resumes
        WHERE source IN ('zlzp', 'qcwy') AND source_candidate_id IS NULL`).all();
      const update = this.db.prepare(`UPDATE candidate_resumes
        SET source_candidate_id = ?, payload = ? WHERE id = ?`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of legacy) {
          const resume = JSON.parse(row.payload);
          const officialId = idFromOfficialUrl(row.source, resume.sourceUrl);
          if (!officialId || resume.sourceCandidateId && resume.sourceCandidateId !== officialId) continue;
          resume.sourceCandidateId = officialId;
          update.run(officialId, JSON.stringify(resume), row.id);
        }
        this.db.prepare(`INSERT INTO library_metadata (key, value) VALUES
          ('official_platform_ids_backfilled_v1', 'true')`).run();
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    const cardBackfilled = this.db.prepare(`SELECT value FROM library_metadata
      WHERE key = 'boss_card_fingerprint_backfilled'`).get();
    if (!cardBackfilled) {
      const legacyBoss = this.db.prepare(`SELECT id, payload FROM candidate_resumes
        WHERE source = 'boss' AND source_card_fingerprint IS NULL`).all();
      const update = this.db.prepare(`UPDATE candidate_resumes
        SET source_card_fingerprint = ? WHERE id = ?`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of legacyBoss) {
          const fingerprint = JSON.parse(row.payload).sourceCardFingerprint;
          if (/^[a-f0-9]{64}$/.test(fingerprint || '')) update.run(fingerprint, row.id);
        }
        this.db.prepare(`INSERT INTO library_metadata (key, value) VALUES
          ('boss_card_fingerprint_backfilled', 'true')`).run();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    const nameBackfilled = this.db.prepare(`SELECT value FROM library_metadata
      WHERE key = 'boss_name_key_backfilled'`).get();
    if (!nameBackfilled) {
      const legacyBoss = this.db.prepare(`SELECT id, payload FROM candidate_resumes
        WHERE source = 'boss' AND boss_name_key IS NULL`).all();
      const update = this.db.prepare(`UPDATE candidate_resumes SET boss_name_key = ? WHERE id = ?`);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of legacyBoss) {
          const key = bossNameKey(JSON.parse(row.payload).name);
          if (key) update.run(key, row.id);
        }
        this.db.prepare(`INSERT INTO library_metadata (key, value) VALUES
          ('boss_name_key_backfilled', 'true')`).run();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  migrateLegacy() {
    const lockFile = `${this.sqliteFile}.migration.lock`;
    const lock = this.acquireMigrationLock(lockFile);
    const temporary = `${this.sqliteFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let staging;
    try {
      // Keep the original JSON untouched as a migration rollback snapshot.
      // A missing/corrupt JSON must never silently become an empty candidate DB.
      const bytes = fs.readFileSync(this.jsonFile);
      const library = validLibrary(JSON.parse(bytes.toString('utf8')));
      const legacySha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const DatabaseSync = databaseClass();
      staging = new DatabaseSync(temporary);
      const holder = { db: staging };
      SqliteResumeStore.prototype.createSchema.call(holder);
      staging.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      try {
        const insert = staging.prepare(`INSERT INTO candidate_resumes
          (id, source, source_fingerprint, source_candidate_id, source_card_fingerprint,
           boss_name_key, source_url,
           candidate_name, position, hiring_job_title, match_score,
           capture_position_id, job_state,
           workflow_status, created_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const resume of library.resumes) {
          const officialId = idFromOfficialUrl(resume.source, resume.sourceUrl);
          const normalized = officialId && !resume.sourceCandidateId
            ? { ...resume, sourceCandidateId: officialId } : resume;
          insert.run(...SqliteResumeStore.values(normalized));
        }
        const meta = staging.prepare('INSERT INTO library_metadata (key, value) VALUES (?, ?)');
        meta.run('positions', JSON.stringify(library.positions));
        meta.run('categories', JSON.stringify(library.categories));
        meta.run('legacy_sha256', legacySha256);
        meta.run('migrated_at', new Date().toISOString());
        staging.exec('COMMIT');
      } catch (error) {
        staging.exec('ROLLBACK');
        throw error;
      }
      const count = staging.prepare('SELECT COUNT(*) AS count FROM candidate_resumes').get().count;
      if (count !== library.resumes.length ||
          staging.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
        throw new Error('SQLite 简历库迁移校验失败');
      }
      staging.close();
      staging = null;
      // The final database appears only after a complete verified import.
      if (fs.existsSync(this.sqliteFile)) throw new Error('目标 SQLite 简历库已存在，停止覆盖');
      // Write the durable marker first. A crash before the final rename now
      // fails closed instead of silently remigrating a stale JSON snapshot.
      writeOnceDurable(this.markerFile, { format: 1, legacySha256 });
      fs.renameSync(temporary, this.sqliteFile);
    } finally {
      if (staging) staging.close();
      try { fs.unlinkSync(temporary); } catch (_) { /* moved or absent */ }
      fs.closeSync(lock);
      fs.unlinkSync(lockFile);
    }
  }

  static values(resume, jobState = 'historical') {
    return [resume.id, resume.source || null, resume.sourceFingerprint || null,
      resume.sourceCandidateId || null, resume.sourceCardFingerprint || null,
      resume.source === 'boss' ? bossNameKey(resume.name) || null : null,
      resume.sourceUrl || null, resume.name || null,
      resume.position || null, hiringJobTitle(resume),
      Number.isFinite(resume.matchScore) ? resume.matchScore : null,
      resume.capturePositionId || resume.positionId || null, jobState,
      resume.workflowStatus || 'new',
      resume.createdAt || null, JSON.stringify(resume)];
  }

  metadata(key) {
    const value = this.db.prepare('SELECT value FROM library_metadata WHERE key = ?').get(key)?.value;
    if (value === undefined) throw new Error(`SQLite 简历库缺少 ${key} 元数据`);
    return JSON.parse(value);
  }

  readDatabase() {
    this.db.exec('BEGIN');
    try {
      const rows = this.db.prepare(`SELECT id, payload FROM candidate_resumes
        ORDER BY created_at DESC, rowid DESC`).all();
      const positionsRaw = this.db.prepare(`SELECT value FROM library_metadata WHERE key = 'positions'`).get()?.value;
      const categoriesRaw = this.db.prepare(`SELECT value FROM library_metadata WHERE key = 'categories'`).get()?.value;
      if (positionsRaw === undefined || categoriesRaw === undefined) {
        throw new Error('SQLite 简历库元数据不完整');
      }
      const result = {
        resumes: rows.map(row => JSON.parse(row.payload)),
        positions: JSON.parse(positionsRaw),
        categories: JSON.parse(categoriesRaw)
      };
      Object.defineProperty(result, BASE_SNAPSHOT, {
        value: { resumes: new Map(rows.map(row => [row.id, row.payload])),
          positionsRaw, categoriesRaw }, enumerable: false
      });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getPositions() { return this.metadata('positions'); }

  // Position edits should touch only their metadata row. Reading a full
  // candidate snapshot for each edit makes the position UI scale with every
  // captured resume and can stall an active collection run.
  mutatePositions(change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const positions = this.metadata('positions');
      const { changed, result } = change(positions);
      if (changed) this.db.prepare(`UPDATE library_metadata SET value = ?
        WHERE key = 'positions'`).run(JSON.stringify(positions));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  archivePosition(positionId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const positions = this.metadata('positions');
      const index = positions.findIndex(item => item.id === positionId);
      if (index < 0 || positions[index].archivedAt) {
        this.db.exec('ROLLBACK');
        return { success: false, error: index < 0 ? '岗位不存在' : '岗位已归档' };
      }
      const position = { ...positions[index], archivedAt: new Date().toISOString(), status: '已归档' };
      positions[index] = position;
      this.db.prepare(`UPDATE library_metadata SET value = ? WHERE key = 'positions'`)
        .run(JSON.stringify(positions));
      this.db.prepare(`UPDATE candidate_resumes SET job_state = 'archived'
        WHERE capture_position_id = ? OR
          (capture_position_id IS NULL AND job_state = 'current' AND hiring_job_title = ?
           AND json_extract(payload, '$.captureJobRequirements') = ?)`)
        .run(positionId, position.title, position.jobCriteria?.jobRequirements || null);
      this.db.exec('COMMIT');
      return { success: true, position, message: '岗位已归档，相关简历已保留' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  restorePosition(positionId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const positions = this.metadata('positions');
      const index = positions.findIndex(item => item.id === positionId && item.archivedAt);
      if (index < 0) {
        this.db.exec('ROLLBACK');
        return { success: false, error: '未找到已归档岗位' };
      }
      const position = { ...positions[index], status: '招聘中' };
      delete position.archivedAt;
      positions[index] = position;
      this.db.prepare(`UPDATE library_metadata SET value = ? WHERE key = 'positions'`)
        .run(JSON.stringify(positions));
      this.db.prepare(`UPDATE candidate_resumes SET job_state = 'current'
        WHERE capture_position_id = ?`).run(positionId);
      if (positions.filter(item => item.title === position.title &&
          item.jobCriteria?.jobRequirements === position.jobCriteria?.jobRequirements).length === 1) {
        this.db.prepare(`UPDATE candidate_resumes SET job_state = 'current'
          WHERE capture_position_id IS NULL AND job_state = 'archived'
          AND hiring_job_title = ? AND json_extract(payload, '$.captureJobRequirements') = ?`)
          .run(position.title, position.jobCriteria?.jobRequirements || null);
      }
      this.db.exec('COMMIT');
      return { success: true, position, message: '岗位已恢复' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  hasResumeForPositionId(positionId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM candidate_resumes
      WHERE json_extract(payload, '$.positionId') = ? LIMIT 1`).get(positionId));
  }

  getResumes(position = null, source = null) {
    const filters = [];
    const params = [];
    if (position) { filters.push('position = ?'); params.push(position); }
    if (source) { filters.push('source = ?'); params.push(source); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return this.db.prepare(`SELECT payload FROM candidate_resumes ${where}
      ORDER BY created_at DESC, rowid DESC`).all(...params).map(row => JSON.parse(row.payload));
  }

  // Read one payload at a time for aggregate views. The legacy getResumes()
  // API must still return an array, but recommendation/analytics should not
  // materialize every historical candidate just to count the current job.
  forEachResume(visitor, { source = null, status = null, jobRequirements = null,
    jobGroup = null } = {}) {
    if (typeof visitor !== 'function') throw new TypeError('简历读取回调无效');
    const filters = [];
    const params = [];
    if (source) { filters.push('source = ?'); params.push(source); }
    if (status) { filters.push('workflow_status = ?'); params.push(status); }
    if (jobGroup === 'current') filters.push("job_state = 'current'");
    else if (jobGroup === 'historical') filters.push("job_state IN ('archived', 'historical')");
    if (jobRequirements !== null) {
      filters.push("(json_extract(payload, '$.matchEvaluation.jobRequirements') = ? OR json_extract(payload, '$.captureJobRequirements') = ?)");
      params.push(jobRequirements, jobRequirements);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    let count = 0;
    for (const row of this.db.prepare(`SELECT payload FROM candidate_resumes ${where}
      ORDER BY created_at DESC, rowid DESC`).iterate(...params)) {
      visitor(JSON.parse(row.payload));
      count++;
    }
    return count;
  }

  getResumesPage({ position = null, hiringJobTitle: jobTitle = null, jobGroup = null,
    source = null, sources = null, status = null,
    keyword = '', keywordFields = 'library', sortBy = 'createdAt', limit = 100, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 ||
        !Number.isInteger(offset) || offset < 0) throw new Error('分页参数无效');
    if (!['createdAt', 'name', 'experience', 'education', 'age', 'scoreAsc', 'scoreDesc'].includes(sortBy)) {
      throw new Error('排序方式无效');
    }
    if (!['library', 'pipeline'].includes(keywordFields)) throw new Error('搜索范围无效');
    const filters = [];
    const params = [];
    if (position) { filters.push('position = ?'); params.push(position); }
    if (jobTitle) { filters.push('hiring_job_title = ?'); params.push(jobTitle); }
    if (jobGroup === 'current') filters.push("job_state = 'current'");
    else if (jobGroup === 'historical') filters.push("job_state IN ('archived', 'historical')");
    if (source) { filters.push('source = ?'); params.push(source); }
    else if (sources?.length) {
      filters.push(`source IN (${sources.map(() => '?').join(',')})`);
      params.push(...sources);
    }
    if (status) { filters.push('workflow_status = ?'); params.push(status); }
    const term = String(keyword).trim().toLowerCase();
    if (term) {
      // Limit the JSON scan to the fields exposed by the library search. The
      // result and count stay in SQLite; only the selected page reaches React.
      const fields = [
        'candidate_name', 'position', 'hiring_job_title',
        'source_candidate_id', 'source_url',
        "json_extract(payload, '$.expectedPosition.position')",
        "json_extract(payload, '$.expectedPosition')",
        "json_extract(payload, '$.skills')",
        ...(keywordFields === 'library' ? [
          "json_extract(payload, '$.selfIntroduction')",
          "json_extract(payload, '$.workExperience')"
        ] : [])
      ];
      filters.push(`(${fields.map(field =>
        `instr(lower(CAST(COALESCE(${field}, '') AS TEXT)), ?) > 0`).join(' OR ')})`);
      params.push(...fields.map(() => term));
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const orderBy = {
      createdAt: 'created_at DESC, rowid DESC',
      name: 'candidate_name COLLATE NOCASE ASC, created_at DESC, rowid DESC',
      experience: "CAST(COALESCE(json_extract(payload, '$.workYears'), '0') AS INTEGER) DESC, created_at DESC, rowid DESC",
      education: `CASE CAST(json_extract(payload, '$.education') AS TEXT)
        WHEN '博士' THEN 5 WHEN '硕士' THEN 4 WHEN '本科' THEN 3
        WHEN '大专' THEN 2 WHEN '高中' THEN 1 ELSE 0 END DESC, created_at DESC, rowid DESC`,
      age: "CAST(COALESCE(json_extract(payload, '$.age'), '0') AS INTEGER) ASC, created_at DESC, rowid DESC",
      scoreAsc: '(match_score IS NULL) ASC, match_score ASC, created_at DESC, rowid DESC',
      scoreDesc: '(match_score IS NULL) ASC, match_score DESC, created_at DESC, rowid DESC'
    }[sortBy];
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM candidate_resumes ${where}`)
      .get(...params).total;
    const items = this.db.prepare(`SELECT payload, job_state FROM candidate_resumes ${where}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(row => ({ ...JSON.parse(row.payload),
        jobGroup: row.job_state === 'current' ? 'current' : 'historical' }));
    return { items, total, limit, offset };
  }

  getSourceStatusCounts(sources) {
    if (!Array.isArray(sources) || !sources.length) return [];
    return this.db.prepare(`SELECT source, workflow_status AS status, COUNT(*) AS total
      FROM candidate_resumes WHERE source IN (${sources.map(() => '?').join(',')})
      GROUP BY source, workflow_status`).all(...sources);
  }

  getHiringJobCounts(sources) {
    if (!Array.isArray(sources) || !sources.length) return [];
    return this.db.prepare(`SELECT hiring_job_title AS title, source,
        CASE WHEN job_state = 'current' THEN 'current' ELSE 'historical' END AS jobGroup,
        COUNT(*) AS total
      FROM candidate_resumes WHERE source IN (${sources.map(() => '?').join(',')})
      GROUP BY hiring_job_title, source, jobGroup`).all(...sources);
  }

  getResumeById(id) {
    const row = this.db.prepare('SELECT payload FROM candidate_resumes WHERE id = ?').get(id);
    return row ? JSON.parse(row.payload) : null;
  }

  // A card fingerprint is only a collection hint, never an insert dedup key.
  // Distinct people can share a teaser; the caller must additionally verify
  // that the full visible card is specific and unique in the current list.
  findBossCardMatch(fingerprint) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) return null;
    const rows = this.db.prepare(`SELECT payload FROM candidate_resumes
      WHERE source = 'boss' AND source_card_fingerprint = ? LIMIT 2`).all(fingerprint);
    if (rows.length !== 1) return null;
    const resume = JSON.parse(rows[0].payload);
    return resume.parseStatus === 'completed' && resume.sourceFingerprint &&
      String(resume.originalText || '').length >= 100 ? resume : null;
  }

  findDuplicate(incoming) {
    const source = incoming.source;
    if (!source) return null;
    if (incoming.sourceCandidateId) {
      const row = this.db.prepare(`SELECT payload FROM candidate_resumes
        WHERE source = ? AND source_candidate_id = ? LIMIT 1`)
        .get(source, incoming.sourceCandidateId);
      if (row) return JSON.parse(row.payload);
    }
    if (incoming.sourceFingerprint) {
      if (source === 'boss') {
        // A stable platform ID conflict wins even over byte-identical OCR.
        // Different profiles can share a template, so ambiguous fingerprints
        // cannot select a record for a new anonymous candidate.
        const rows = this.db.prepare(`SELECT payload FROM candidate_resumes
          WHERE source = 'boss' AND source_fingerprint = ? LIMIT 501`)
          .all(incoming.sourceFingerprint);
        if (rows.length > 500) return null;
        const compatible = rows.map(row => JSON.parse(row.payload)).filter(existing =>
          !(incoming.sourceCandidateId && existing.sourceCandidateId &&
            incoming.sourceCandidateId !== existing.sourceCandidateId));
        if (compatible.length === 1) return compatible[0];
        if (compatible.length > 1) return null;
      } else {
        const rows = this.db.prepare(`SELECT payload FROM candidate_resumes
          WHERE source = ? AND source_fingerprint = ? LIMIT 50`)
          .all(source, incoming.sourceFingerprint);
        const compatible = rows.map(row => JSON.parse(row.payload)).filter(existing =>
          !(incoming.sourceCandidateId && existing.sourceCandidateId &&
            incoming.sourceCandidateId !== existing.sourceCandidateId));
        if (compatible.length === 1) return compatible[0];
      }
    }
    if (source === 'boss') {
      const nameKey = bossNameKey(incoming.name);
      if (!nameKey) return null;
      // Name-indexed cohort only. If an extraordinarily common name exceeds
      // this bound, fail closed (keep a possible duplicate) rather than scan
      // unbounded resumes or merge different people on incomplete evidence.
      const rows = this.db.prepare(`SELECT payload FROM candidate_resumes
        WHERE source = 'boss' AND boss_name_key = ? LIMIT 501`).all(nameKey);
      if (rows.length > 500) return null;
      const matches = rows.map(row => JSON.parse(row.payload))
        .filter(existing => sameBossNearDuplicate(existing,incoming));
      return chooseBossNearDuplicate(matches);
    }
    if (source === 'qcwy') {
      // A stable 51Job detail URL is hashed into sourceRecordKey; generic
      // routes instead hash the resume text and must not be deduped by URL.
      const hasStableId = Boolean(incoming.sourceUrl && incoming.sourceRecordKey &&
        crypto.createHash('sha256').update(incoming.sourceUrl).digest('hex') ===
          incoming.sourceRecordKey);
      return this.findWuyouDuplicate(incoming, { hasStableId });
    }
    if (source !== 'zlzp' || !incoming.sourceUrl || !incoming.name) return null;
    const { isSameZhilianResume } = require('../utils/zhilianResumeIdentity');
    // The legacy predicate normalizes NFKC and whitespace in names. An exact
    // SQL name prefilter would miss e.g. 张三 vs 张 三; URL narrows the candidates
    // while the original identity predicate makes the final decision.
    for (const row of this.db.prepare(`SELECT payload FROM candidate_resumes
      WHERE source = 'zlzp' AND source_url = ?`)
      .all(incoming.sourceUrl)) {
      const existing = JSON.parse(row.payload);
      if (isSameZhilianResume(existing, incoming)) return existing;
    }
    return null;
  }

  findWuyouDuplicate(incoming, { hasStableId = false } = {}) {
    const incomingId = platformLocator(incoming).id;
    const compatible = row => {
      const item = JSON.parse(row.payload);
      const existingId = platformLocator(item).id;
      return !incomingId || !existingId || incomingId === existingId ? item : null;
    };
    if (incomingId) {
      const row = this.db.prepare(`SELECT payload FROM candidate_resumes
        WHERE source = 'qcwy' AND source_candidate_id = ? LIMIT 1`).get(incomingId);
      if (row) return JSON.parse(row.payload);
    }
    if (incoming.sourceFingerprint) {
      const rows = this.db.prepare(`SELECT payload FROM candidate_resumes
        WHERE source = 'qcwy' AND source_fingerprint = ? LIMIT 50`)
        .all(incoming.sourceFingerprint);
      const match = rows.map(compatible).find(Boolean);
      if (match) return match;
    }
    if (hasStableId && incoming.sourceUrl) {
      const row = this.db.prepare(`SELECT payload FROM candidate_resumes
        WHERE source = 'qcwy' AND source_url = ? LIMIT 1`)
        .get(incoming.sourceUrl);
      if (row) return compatible(row);
    }
    // Historical imported records may predate sourceFingerprint. Preserve
    // their content-based dedup without scanning every modern candidate.
    if (!incoming.originalText) return null;
    const normalized = incoming.originalText.replace(/\s+/g, ' ').trim().toLowerCase();
    for (const row of this.db.prepare(`SELECT payload FROM candidate_resumes
      WHERE source = 'qcwy' AND (source_fingerprint IS NULL OR source_fingerprint = '')`).all()) {
      const existing = compatible(row);
      if (!existing) continue;
      if (existing.originalText?.replace(/\s+/g, ' ').trim().toLowerCase() === normalized) {
        return existing;
      }
    }
    return null;
  }

  putResume(resume) {
    const existing = this.db.prepare('SELECT job_state FROM candidate_resumes WHERE id = ?').get(resume.id);
    const state = existing?.job_state || resumeJobState(resume, this.metadata('positions'));
    this.db.prepare(`INSERT INTO candidate_resumes
      (id, source, source_fingerprint, source_candidate_id, source_card_fingerprint,
       boss_name_key, source_url,
       candidate_name, position, hiring_job_title, match_score,
       capture_position_id, job_state,
       workflow_status, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source=excluded.source,
        source_fingerprint=excluded.source_fingerprint,
        source_candidate_id=excluded.source_candidate_id,
        source_card_fingerprint=excluded.source_card_fingerprint,
        boss_name_key=excluded.boss_name_key,
        source_url=excluded.source_url,
        candidate_name=excluded.candidate_name, position=excluded.position,
        hiring_job_title=excluded.hiring_job_title, match_score=excluded.match_score,
        capture_position_id=excluded.capture_position_id, job_state=excluded.job_state,
        workflow_status=excluded.workflow_status, created_at=excluded.created_at,
        payload=excluded.payload`).run(...SqliteResumeStore.values(resume, state));
  }

  insertIfNew(incoming, resume) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.findDuplicate(incoming);
      if (!existing) this.putResume(resume);
      this.db.exec('COMMIT');
      return existing ? { resume: existing, created: false } : { resume, created: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteResume(id) {
    return this.db.prepare('DELETE FROM candidate_resumes WHERE id = ?').run(id).changes > 0;
  }

  deleteHistoricalResumes(ids, expectedTitle) {
    const placeholders = ids.map(() => '?').join(',');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT id, source, hiring_job_title, job_state
        FROM candidate_resumes WHERE id IN (${placeholders})`).all(...ids);
      if (rows.length !== ids.length || rows.some(row =>
        !['boss', 'zlzp', 'qcwy'].includes(row.source) ||
        row.hiring_job_title !== expectedTitle || row.job_state === 'current')) {
        throw new Error('所选简历已变化，或不属于该历史岗位；请刷新后重选');
      }
      this.db.prepare(`DELETE FROM candidate_resumes WHERE id IN (${placeholders})`).run(...ids);
      this.db.exec('COMMIT');
      return { success: true, count: rows.length };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  clearAllResumes() {
    return this.db.prepare('DELETE FROM candidate_resumes').run().changes;
  }

  writeDatabase(data) {
    validLibrary(data);
    const baseline = data[BASE_SNAPSHOT];
    if (!baseline) throw new Error('SQLite 更新需先读取数据库快照');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = new Map(this.db.prepare('SELECT id, payload FROM candidate_resumes')
        .all().map(row => [row.id, row.payload]));
      const incoming = new Set();
      for (const resume of data.resumes) {
        incoming.add(resume.id);
        const payload = JSON.stringify(resume);
        const before = baseline.resumes.get(resume.id);
        if (before === payload) continue;
        if (current.get(resume.id) !== before) {
          throw new Error(`简历 ${resume.id} 已被其它操作修改，请刷新后重试`);
        }
        this.putResume(resume);
      }
      const remove = this.db.prepare('DELETE FROM candidate_resumes WHERE id = ?');
      for (const [id, before] of baseline.resumes) {
        if (incoming.has(id)) continue;
        if (current.get(id) !== before) {
          throw new Error(`简历 ${id} 已被其它操作修改，请刷新后重试`);
        }
        remove.run(id);
      }
      const meta = this.db.prepare(`INSERT INTO library_metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
      for (const [key, before, after] of [
        ['positions', baseline.positionsRaw, JSON.stringify(data.positions)],
        ['categories', baseline.categoriesRaw, JSON.stringify(data.categories)]
      ]) {
        if (before === after) continue;
        const currentValue = this.db.prepare('SELECT value FROM library_metadata WHERE key = ?')
          .get(key)?.value;
        if (currentValue !== before) {
          throw new Error(`${key} 已被其它操作修改，请刷新后重试`);
        }
        meta.run(key, after);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.db.close(); }
}

module.exports = { SqliteResumeStore, resumeJobState };
