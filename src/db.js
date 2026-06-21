const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'wepost.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// 账号表
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname      TEXT NOT NULL,              -- 用户自定义昵称，方便识别
    weibo_uid     TEXT,                       -- 微博UID（登录后获取）
    weibo_name    TEXT,                       -- 微博昵称（登录后获取）
    cookie        TEXT,                       -- Cookie JSON 字符串
    cookie_status TEXT DEFAULT 'pending',     -- pending / active / expired
    last_check    TEXT,                       -- 上次检测时间 ISO
    created_at    TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

// 文案组合表（文字+图片绑定）
db.exec(`
  CREATE TABLE IF NOT EXISTS post_combos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,                 -- 文案文字
    image_path TEXT,                          -- 图片路径（JSON 数组，可多张）
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

// 发布任务表（一次发布任务的配置）
db.exec(`
  CREATE TABLE IF NOT EXISTS publish_tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    interval_sec    INTEGER DEFAULT 60,       -- 间隔秒数
    random_range_sec INTEGER DEFAULT 5,       -- 随机区间（±秒）
    visibility      TEXT DEFAULT 'public',    -- public / private
    order_mode      TEXT DEFAULT 'sequential',-- sequential / random
    status          TEXT DEFAULT 'pending',   -- pending / running / done / stopped
    total           INTEGER DEFAULT 0,        -- 总账号数
    success         INTEGER DEFAULT 0,        -- 成功数
    failed          INTEGER DEFAULT 0,        -- 失败数
    created_at      TEXT DEFAULT (datetime('now', 'localtime')),
    finished_at     TEXT
  )
`);

// 发布日志表（每个账号的发布记录）
db.exec(`
  CREATE TABLE IF NOT EXISTS publish_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER NOT NULL,
    account_id    INTEGER NOT NULL,
    combo_id      INTEGER,                    -- 实际使用的文案组合
    status        TEXT DEFAULT 'pending',     -- pending / success / failed
    message       TEXT,                       -- 成功提示或错误信息
    published_at  TEXT,
    FOREIGN KEY (task_id)    REFERENCES publish_tasks(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (combo_id)   REFERENCES post_combos(id)
  )
`);

module.exports = db;
