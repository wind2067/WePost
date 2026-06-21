const express = require('express');
const router = express.Router();
const db = require('../db');
const path = require('path');

// 获取所有文案组合
router.get('/', (req, res) => {
  const combos = db.prepare(`
    SELECT id, text, image_path, created_at FROM post_combos ORDER BY id
  `).all();
  // 解析 image_path JSON
  combos.forEach(c => {
    c.images = c.image_path ? JSON.parse(c.image_path) : [];
    delete c.image_path;
  });
  res.json(combos);
});

// 添加文案组合（文字 + 图片路径）
router.post('/', (req, res) => {
  const { text, images } = req.body;
  if (!text) return res.status(400).json({ error: '文案文字不能为空' });
  const imagePath = images && images.length > 0 ? JSON.stringify(images) : null;
  const result = db.prepare(`
    INSERT INTO post_combos (text, image_path) VALUES (?, ?)
  `).run(text, imagePath);
  res.json({ id: result.lastInsertRowid, text, images: images || [] });
});

// 更新文案组合
router.put('/:id', (req, res) => {
  const { text, images } = req.body;
  const imagePath = images && images.length > 0 ? JSON.stringify(images) : null;
  db.prepare(`UPDATE post_combos SET text = ?, image_path = ? WHERE id = ?`)
    .run(text, imagePath, req.params.id);
  res.json({ success: true });
});

// 删除文案组合
router.delete('/:id', (req, res) => {
  const db = require('../db');
  try {
    // 同时删除关联的图片文件
    const combo = db.prepare(`SELECT image_path FROM post_combos WHERE id = ?`).get(req.params.id);
    if (combo && combo.image_path) {
      const images = JSON.parse(combo.image_path);
      images.forEach(img => {
        const filePath = path.join(__dirname, '..', '..', 'data', 'uploads', img);
        try { require('fs').unlinkSync(filePath); } catch (e) { /* 忽略 */ }
      });
    }
    // 先解除 publish_logs 中的外键引用，再删除文案
    db.prepare(`UPDATE publish_logs SET combo_id = NULL WHERE combo_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM post_combos WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Posts] 删除文案失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 上传图片
router.post('/upload', (req, res) => {
  const upload = req.app.locals.upload.array('images', 9);
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const filenames = req.files.map(f => f.filename);
    res.json({ filenames });
  });
});

module.exports = router;
