const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('../db');

const cookieDir = path.join(__dirname, '..', '..', 'data', 'cookies');

// 简单的 sleep（不依赖 page 对象）
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 启动浏览器，让用户手动登录微博，登录成功后保存 Cookie
async function loginAndSaveCookie(accountId, nickname) {
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // 打开微博登录页
    await page.goto('https://passport.weibo.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log(`[CookieManager] 等待账号 "${nickname}" 登录微博...`);
    console.log('[CookieManager] 请在弹出的浏览器中手动登录，登录成功后将自动保存Cookie');
    console.log('[CookieManager] 请勿关闭浏览器窗口，登录后会自动保存');

    // 轮询检测登录状态
    const maxWaitMs = 300000; // 最长等待5分钟
    const checkIntervalMs = 2000; // 每2秒检测一次
    let elapsed = 0;
    let loggedIn = false;

    while (elapsed < maxWaitMs) {
      await sleep(checkIntervalMs);
      elapsed += checkIntervalMs;

      // 检测浏览器是否还活着
      if (!browser.isConnected()) {
        console.log('[CookieManager] 浏览器被关闭');
        return { success: false, error: '浏览器被关闭，请重新点击登录' };
      }

      try {
        // 检测 cookie 中是否有 SUB（微博登录态的关键 cookie）
        const cookies = await context.cookies();
        const subCookie = cookies.find(c => c.name === 'SUB' && c.value && c.value.length > 10);

        // 检测 URL 是否已从登录页跳走
        const currentUrl = page.url();
        const leftLoginPage = !currentUrl.includes('passport.weibo.com');

        if (subCookie && leftLoginPage) {
          loggedIn = true;
          console.log(`[CookieManager] 检测到登录成功 (SUB cookie found, URL: ${currentUrl})`);
          break;
        }

        // 每30秒打印一次等待状态
        if (elapsed % 30000 < checkIntervalMs) {
          console.log(`[CookieManager] 仍在等待登录... (${Math.floor(elapsed / 1000)}s)`);
        }
      } catch (e) {
        // 页面可能正在跳转，忽略临时错误
        console.log('[CookieManager] 轮询临时错误（页面跳转中）:', e.message);
      }
    }

    if (!loggedIn) {
      await browser.close().catch(() => {});
      return { success: false, error: '登录超时（5分钟内未检测到登录），请重试' };
    }

    // 登录成功后，获取用户信息
    let weiboName = nickname;
    let weiboUid = null;

    try {
      // 先从 SUB cookie 提取 uid
      const cookies0 = await context.cookies();
      const subCookie0 = cookies0.find(c => c.name === 'SUB');
      if (subCookie0) {
        const uidMatch = subCookie0.value.match(/uid=(\d+)/);
        if (uidMatch) weiboUid = uidMatch[1];
      }
      console.log(`[CookieManager] SUB cookie 提取 uid: ${weiboUid}`);

      // 跳转到微博主站
      await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(5000); // SPA 需要更多时间加载

      // 先从 $CONFIG 提取 uid（这个最可靠）
      try {
        const configInfo = await page.evaluate(() => {
          const result = {};
          if (typeof $CONFIG !== 'undefined') {
            result.nick = $CONFIG.nick || '';
            result.uid = $CONFIG.uid || '';
          }
          return result;
        }).catch(() => null);
        console.log(`[CookieManager] $CONFIG: ${JSON.stringify(configInfo)}`);
        if (configInfo && configInfo.uid && !weiboUid) {
          weiboUid = configInfo.uid;
        }
      } catch (e) {}

      // 用 uid 调 API 获取昵称
      if (weiboUid) {
        // 尝试多个 API 端点
        const apiEndpoints = [
          `https://weibo.com/ajax/profile/info?uid=${weiboUid}`,
          `https://weibo.com/ajax/profile/getuserinfo?uid=${weiboUid}`,
          `https://weibo.com/ajax/profile/info?nickname=${weiboUid}`
        ];

        for (const apiUrl of apiEndpoints) {
          try {
            const apiResult = await page.evaluate(async (url) => {
              try {
                const resp = await fetch(url, {
                  credentials: 'include',
                  headers: { 'Accept': 'application/json' }
                });
                const text = await resp.text();
                try { return JSON.parse(text); } catch (e) { return { _raw: text.substring(0, 300), _status: resp.status }; }
              } catch (e) {
                return { _error: e.message };
              }
            }, apiUrl).catch(() => null);

            console.log(`[CookieManager] API ${apiUrl}: ${JSON.stringify(apiResult).substring(0, 300)}`);

            // 解析多种可能的返回结构
            if (apiResult) {
              const user = apiResult.data?.user || apiResult.data || apiResult.user;
              if (user) {
                const name = user.screen_name || user.name || user.nick || user.nickname;
                if (name && name.length > 0 && name.length < 30) {
                  weiboName = name.trim();
                  console.log(`[CookieManager] 从 API 获取到昵称: ${weiboName}`);
                  break;
                }
              }
            }
          } catch (e) {}
        }
      }

      // 策略2：$CONFIG 的 nick 如果有值
      if (weiboName === nickname) {
        try {
          const configNick = await page.evaluate(() => {
            if (typeof $CONFIG !== 'undefined' && $CONFIG.nick) return $CONFIG.nick;
            return '';
          }).catch(() => '');
          if (configNick) {
            weiboName = configNick.trim();
            console.log(`[CookieManager] 从 $CONFIG.nick 获取到昵称: ${weiboName}`);
          }
        } catch (e) {}
      }

      console.log(`[CookieManager] 最终用户信息: 昵称=${weiboName}, UID=${weiboUid}`);
    } catch (e) {
      console.log('[CookieManager] 获取用户信息失败，使用默认值:', e.message);
    }

    // 保存 cookies 到数据库
    const allCookies = await context.cookies();
    db.prepare(`
      UPDATE accounts
      SET cookie = ?, weibo_uid = ?, weibo_name = ?, cookie_status = 'active',
          last_check = datetime('now','localtime'), updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(JSON.stringify(allCookies), weiboUid, weiboName, accountId);

    console.log(`[CookieManager] 账号 "${nickname}" Cookie 保存成功 (微博昵称: ${weiboName}, UID: ${weiboUid})`);
    await browser.close().catch(() => {});
    return { success: true, weibo_uid: weiboUid, weibo_name: weiboName };
  } catch (e) {
    console.log(`[CookieManager] 登录过程出错: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
    return { success: false, error: '登录过程出错: ' + e.message };
  }
}

// 加载 Cookie 创建浏览器上下文
async function createContextWithCookie(cookieJson) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });

  if (cookieJson) {
    const cookies = typeof cookieJson === 'string' ? JSON.parse(cookieJson) : cookieJson;
    await context.addCookies(cookies);
  }

  return { browser, context };
}

// 检测 Cookie 是否有效
async function checkCookieStatus(accountId) {
  const account = db.prepare(`SELECT cookie, nickname FROM accounts WHERE id = ?`).get(accountId);
  if (!account || !account.cookie) {
    db.prepare(`UPDATE accounts SET cookie_status = 'pending', last_check = datetime('now','localtime') WHERE id = ?`)
      .run(accountId);
    return 'pending';
  }

  const { browser, context } = await createContextWithCookie(account.cookie);
  const page = await context.newPage();

  try {
    await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // 检测是否已登录——通过 cookie 中的 SUB 判断
    const cookies = await context.cookies();
    const subCookie = cookies.find(c => c.name === 'SUB' && c.value && c.value.length > 10);
    let status = subCookie ? 'active' : 'expired';

    db.prepare(`
      UPDATE accounts SET cookie_status = ?, last_check = datetime('now','localtime') WHERE id = ?
    `).run(status, accountId);

    return status;
  } catch (e) {
    db.prepare(`UPDATE accounts SET cookie_status = 'expired', last_check = datetime('now','localtime') WHERE id = ?`)
      .run(accountId);
    return 'expired';
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { loginAndSaveCookie, createContextWithCookie, checkCookieStatus };
