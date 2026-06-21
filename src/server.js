const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 确保运行时目录存在
const dataDir = path.join(__dirname, '..', 'data');
const uploadDir = path.join(dataDir, 'uploads');
const cookieDir = path.join(dataDir, 'cookies');
[dataDir, uploadDir, cookieDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const PORT = 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 静态文件（禁缓存，确保每次加载最新代码）
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
}));
app.use('/uploads', express.static(uploadDir));

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 单图 10MB
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持图片文件'));
  }
});
app.locals.upload = upload;

// 路由挂载
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/publish', require('./routes/publish'));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: '博群WePost' });
});

// 启动
app.listen(PORT, () => {
  console.log(`\n  博群WePost 服务已启动`);
  console.log(`  访问地址: http://localhost:${PORT}\n`);
});
