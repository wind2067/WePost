const express = require('express');
const router = express.Router();
const db = require('../db');
const cookieManager = require('../services/cookieManager');

// 获取所有账号
router.get('/', (req, res) => {
  const accounts = db.prepare(`
    SELECT id, nickname, weibo_uid, weibo_name, cookie_status, last_check, created_at
    FROM accounts ORDER BY id
  `).all();
  res.json(accounts);
});

// 添加账号
router.post('/', (req, res) => {
  const { nickname } = req.body;
  if (!nickname) return res.status(400).json({ error: '昵称不能为空' });
  const result = db.prepare(`
    INSERT INTO accounts (nickname, cookie_status) VALUES (?, 'pending')
  `).run(nickname);
  res.json({ id: result.lastInsertRowid, nickname, cookie_status: 'pending' });
});

// 更新账号信息（昵称等）
router.put('/:id', (req, res) => {
  const { nickname } = req.body;
  db.prepare(`UPDATE accounts SET nickname = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
    .run(nickname, req.params.id);
  res.json({ success: true });
});

// 保存 Cookie（登录成功后调用）
router.post('/:id/cookie', (req, res) => {
  const { cookie, weibo_uid, weibo_name } = req.body;
  db.prepare(`
    UPDATE accounts
    SET cookie = ?, weibo_uid = ?, weibo_name = ?, cookie_status = 'active',
        last_check = datetime('now','localtime'), updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(JSON.stringify(cookie), weibo_uid || null, weibo_name || null, req.params.id);
  res.json({ success: true });
});

// 删除账号
router.delete('/:id', (req, res) => {
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// 检查 Cookie 状态
router.get('/:id/status', (req, res) => {
  const account = db.prepare(`SELECT cookie_status, last_check FROM accounts WHERE id = ?`)
    .get(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });
  res.json(account);
});

// 触发登录（打开浏览器让用户手动登录微博，保存 Cookie）
router.post('/:id/login', async (req, res) => {
  const account = db.prepare(`SELECT nickname FROM accounts WHERE id = ?`).get(req.params.id);
  if (!account) return res.status(404).json({ error: '账号不存在' });

  try {
    const result = await cookieManager.loginAndSaveCookie(req.params.id, account.nickname);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 批量检测 Cookie 状态
router.post('/check-all', async (req, res) => {
  const accounts = db.prepare(`SELECT id FROM accounts WHERE cookie_status != 'pending' OR cookie IS NOT NULL`).all();
  const results = [];
  for (const acc of accounts) {
    const status = await cookieManager.checkCookieStatus(acc.id);
    results.push({ id: acc.id, status });
  }
  res.json({ results });
});

module.exports = router;
