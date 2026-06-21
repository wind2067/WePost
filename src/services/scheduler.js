const db = require('../db');
const { postWeibo } = require('./weiboAutomation');

let running = false;

async function start(taskId, accountIds, config) {
  if (running) {
    console.log('[Scheduler] 已有发布任务正在运行');
    return;
  }
  running = true;

  try {

  const { interval_sec, random_range_sec, visibility, order_mode, plan } = config;

  // 获取账号列表
  const placeholders = accountIds.map(() => '?').join(',');
  let accounts = db.prepare(`
    SELECT * FROM accounts WHERE id IN (${placeholders})
  `).all(...accountIds);

  // 获取文案组合
  const combos = db.prepare(`SELECT id, text, image_path FROM post_combos ORDER BY id`).all();
  if (combos.length === 0) {
    db.prepare(`UPDATE publish_tasks SET status = 'done', finished_at = datetime('now','localtime') WHERE id = ?`).run(taskId);
    running = false;
    return;
  }

  // 解析图片路径
  combos.forEach(c => {
    c.images = c.image_path ? JSON.parse(c.image_path) : [];
    delete c.image_path;
  });

  // ===== 如果有预览方案，直接用；否则按原逻辑随机/顺序分配 =====
  let logIds;

  if (plan && Array.isArray(plan) && plan.length > 0) {
    console.log('[Scheduler] 使用预览方案，不重新随机');
    
    // 根据 plan 中的 account_id 和 combo_id 构建发布队列
    logIds = plan.map(item => {
      const account = accounts.find(a => a.id === item.account_id);
      const combo = combos.find(c => c.id === item.combo_id);
      if (!account || !combo) {
        console.log(`[Scheduler] 警告: plan 项找不到对应数据 account_id=${item.account_id} combo_id=${item.combo_id}`);
        return null;
      }
      const result = db.prepare(`
        INSERT INTO publish_logs (task_id, account_id, combo_id, status)
        VALUES (?, ?, ?, 'pending')
      `).run(taskId, account.id, combo.id);
      return { logId: result.lastInsertRowid, account, combo };
    }).filter(x => x !== null);

  } else {
    // 没有预览方案，走原逻辑（顺序或随机）
    console.log('[Scheduler] 无预览方案，现场分配');

    // 发布顺序
    if (order_mode === 'random') {
      accounts = accounts.sort(() => Math.random() - 0.5);
    }

    // 创建日志记录（初始为 pending）
    logIds = accounts.map(acc => {
      const combo = combos[Math.floor(Math.random() * combos.length)];
      const result = db.prepare(`
        INSERT INTO publish_logs (task_id, account_id, combo_id, status)
        VALUES (?, ?, ?, 'pending')
      `).run(taskId, acc.id, combo.id);
      return { logId: result.lastInsertRowid, account: acc, combo };
    });
  }

  // 逐个发布
  let successCount = 0;
  let failedCount = 0;

  for (let i = 0; i < logIds.length; i++) {
    if (!running) break;

    const { logId, account, combo } = logIds[i];

    // 计算等待时间（第一个账号不等待）
    if (i > 0) {
      const waitMs = (interval_sec + (Math.random() * 2 - 1) * random_range_sec) * 1000;
      const waitSec = Math.max(1, Math.round(waitMs / 1000));
      console.log(`[Scheduler] 等待 ${waitSec} 秒后发布下一个账号...`);
      await sleep(waitMs);
    }

    if (!running) break;

    // 更新日志为进行中
    db.prepare(`UPDATE publish_logs SET message = '正在发布...' WHERE id = ?`).run(logId);

    // 执行发布
    const result = await postWeibo(account, combo, visibility);

    // 更新日志
    db.prepare(`
      UPDATE publish_logs
      SET status = ?, message = ?, published_at = datetime('now','localtime')
      WHERE id = ?
    `).run(result.success ? 'success' : 'failed', result.message, logId);

    if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }

    // 更新任务进度
    db.prepare(`
      UPDATE publish_tasks SET success = ?, failed = ? WHERE id = ?
    `).run(successCount, failedCount, taskId);

    console.log(`[Scheduler] [${i + 1}/${accounts.length}] ${account.nickname}: ${result.success ? '✓' : '✗'} ${result.message}`);
  }

  // 标记任务完成
  db.prepare(`
    UPDATE publish_tasks SET status = 'done', finished_at = datetime('now','localtime') WHERE id = ?
  `).run(taskId);

  running = false;
  console.log(`[Scheduler] 任务完成: 成功 ${successCount}, 失败 ${failedCount}`);

  } catch (err) {
    console.error('[Scheduler] 任务异常:', err.message);
    db.prepare(`UPDATE publish_tasks SET status = 'done', finished_at = datetime('now','localtime') WHERE id = ?`).run(taskId);
    running = false;
  }
}

function stop() {
  running = false;
  console.log('[Scheduler] 收到停止信号');
}

function isRunning() {
  return running;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { start, stop, isRunning };
