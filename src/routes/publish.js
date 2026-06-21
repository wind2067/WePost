const express = require('express');
const router = express.Router();
const db = require('../db');
const scheduler = require('../services/scheduler');

// 预览：返回本次发布的分配方案（不实际执行）
router.post('/preview', (req, res) => {
  const { account_ids, interval_sec, random_range_sec, visibility, order_mode } = req.body;

  // 获取选中的账号
  const placeholders = account_ids.map(() => '?').join(',');
  const accounts = db.prepare(`
    SELECT id, nickname, weibo_name, cookie_status FROM accounts WHERE id IN (${placeholders})
  `).all(...account_ids);

  // 获取所有文案组合
  const combos = db.prepare(`SELECT id, text, image_path FROM post_combos ORDER BY id`).all();
  if (combos.length === 0) return res.status(400).json({ error: '没有可用的文案组合' });

  // 生成分配方案
  let order = accounts.map((acc, idx) => ({ ...acc }));
  if (order_mode === 'random') {
    order = order.sort(() => Math.random() - 0.5);
  }

  const plan = order.map((acc, idx) => {
    const combo = combos[Math.floor(Math.random() * combos.length)];
    const images = combo.image_path ? JSON.parse(combo.image_path) : [];
    return {
      account_id: acc.id,
      nickname: acc.nickname,
      weibo_name: acc.weibo_name,
      cookie_status: acc.cookie_status,
      combo_id: combo.id,
      text: combo.text,
      images,
      estimated_wait: idx === 0 ? 0 : interval_sec + (Math.random() * 2 - 1) * random_range_sec
    };
  });

  res.json({
    visibility,
    interval_sec,
    random_range_sec,
    order_mode,
    total: plan.length,
    plan
  });
});

// 执行发布
router.post('/start', (req, res) => {
  const { account_ids, interval_sec, random_range_sec, visibility, order_mode, plan } = req.body;

  // 创建任务记录
  const taskResult = db.prepare(`
    INSERT INTO publish_tasks (interval_sec, random_range_sec, visibility, order_mode, status, total)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(interval_sec, random_range_sec, visibility, order_mode, account_ids.length);

  const taskId = taskResult.lastInsertRowid;

  // 异步启动调度（传入预览方案，避免二次随机）
  scheduler.start(taskId, account_ids, {
    interval_sec,
    random_range_sec,
    visibility,
    order_mode,
    plan: plan || null
  });

  res.json({ task_id: taskId, message: '发布任务已启动' });
});

// 获取任务状态 + 实时日志
router.get('/task/:taskId', (req, res) => {
  const task = db.prepare(`SELECT * FROM publish_tasks WHERE id = ?`).get(req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const logs = db.prepare(`
    SELECT pl.*, a.nickname, a.weibo_name
    FROM publish_logs pl
    JOIN accounts a ON pl.account_id = a.id
    WHERE pl.task_id = ?
    ORDER BY pl.id
  `).all(req.params.taskId);

  res.json({ task, logs });
});

// 获取最新任务
router.get('/latest', (req, res) => {
  const task = db.prepare(`SELECT * FROM publish_tasks ORDER BY id DESC LIMIT 1`).get();
  if (!task) return res.json({ task: null, logs: [] });

  const logs = db.prepare(`
    SELECT pl.*, a.nickname, a.weibo_name
    FROM publish_logs pl
    JOIN accounts a ON pl.account_id = a.id
    WHERE pl.task_id = ?
    ORDER BY pl.id
  `).all(task.id);

  res.json({ task, logs });
});

module.exports = router;
