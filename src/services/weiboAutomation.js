const { createContextWithCookie } = require('./cookieManager');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 使用指定账号的 Cookie 发布一条微博
 */
async function postWeibo(account, combo, visibility = 'public') {
  if (!account.cookie) {
    return { success: false, message: 'Cookie 不存在，请先登录' };
  }

  const { browser, context } = await createContextWithCookie(account.cookie);
  const page = await context.newPage();

  try {
    // 打开微博首页（建立 cookie 上下文）
    await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000); // SPA 渲染等待

    console.log(`[WeiboAutomation] 页面 URL: ${page.url()}`);

    // API 方式仅用于：公开可见 + 无图片的纯文字帖子
    // 有可见性设置或有图片时直接走 UI（API 的可见性参数和图片上传接口不可靠）
    const useAPI = visibility === 'public' && (!combo.images || combo.images.length === 0);

    if (useAPI) {
      try {
        const apiResult = await postViaAPI(page, combo, visibility);
        if (apiResult.success) {
          console.log(`[WeiboAutomation] 账号 "${account.nickname}" API 发帖成功`);
          return apiResult;
        }
        console.log(`[WeiboAutomation] API 失败: ${apiResult.message}`);
      } catch (e) {
        console.log(`[WeiboAutomation] API 异常: ${e.message}`);
      }
    } else {
      console.log(`[WeiboAutomation] 可见性=${visibility} 或有图片，直接使用 UI 方式`);
    }

    // 回退到 UI 方式
    console.log(`[WeiboAutomation] 切换到 UI 方式发帖...`);
    return await postViaUI(page, account, combo, visibility);

  } catch (e) {
    console.error(`[WeiboAutomation] 账号 "${account.nickname}" 发布失败:`, e.message);
    return { success: false, message: `发布异常: ${e.message}` };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ========== API 方式 ==========
async function postViaAPI(page, combo, visibility) {
  // 从 cookie 获取 XSRF-TOKEN
  const cookies = await page.context().cookies();
  const xsrfCookie = cookies.find(c => c.name === 'XSRF-TOKEN');
  if (!xsrfCookie) {
    return { success: false, message: '未找到 XSRF-TOKEN cookie' };
  }
  const xsrfToken = decodeURIComponent(xsrfCookie.value);

  // 上传图片
  let picIds = [];
  if (combo.images && combo.images.length > 0) {
    picIds = await uploadImages(page, combo.images, xsrfToken);
  }

  // 发布微博
  const result = await page.evaluate(async ({ token, text, pics, priv }) => {
    try {
      const bodyData = new URLSearchParams();
      bodyData.append('content', text);
      bodyData.append('share_url', '');
      bodyData.append('picId', pics.join(','));
      bodyData.append('_exF', '');
      // 可见性参数映射
      if (priv === 'private') bodyData.append('privacy', '1');
      else if (priv === 'followers') bodyData.append('privacy', '2');
      else if (priv === 'friends') bodyData.append('privacy', '3');


      const resp = await fetch('/ajax/statuses/update', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-xsrf-token': token
        },
        body: bodyData.toString()
      });

      const data = await resp.json();
      return { ok: resp.ok, status: resp.status, data };
    } catch (e) {
      return { _error: e.message };
    }
  }, { token: xsrfToken, text: combo.text, pics: picIds, priv: visibility });

  console.log(`[WeiboAutomation] API 返回: ${JSON.stringify(result).substring(0, 400)}`);

  if (result.data && result.data.ok === 1) {
    return { success: true, message: '发布成功（API）' };
  }
  return { success: false, message: `API 返回: ${JSON.stringify(result).substring(0, 200)}` };
}

// 图片上传
async function uploadImages(page, imageNames, xsrfToken) {
  const picIds = [];

  for (const imgName of imageNames) {
    const imgPath = path.join(UPLOAD_DIR, imgName);
    if (!fs.existsSync(imgPath)) continue;

    const imgBuffer = fs.readFileSync(imgPath);
    const ext = path.extname(imgName).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    const imgBase64 = imgBuffer.toString('base64');

    const result = await page.evaluate(async ({ token, b64, m, name }) => {
      try {
        const fd = new FormData();
        fd.append('b64_data', b64);
        fd.append('name', name);

        const resp = await fetch('/ajax/upload/photo', {
          method: 'POST',
          credentials: 'include',
          headers: { 'x-xsrf-token': token },
          body: fd
        });
        const data = await resp.json();
        return data;
      } catch (e) {
        return { _error: e.message };
      }
    }, { token: xsrfToken, b64: imgBase64, m: mime, name: imgName });

    console.log(`[WeiboAutomation] 上图结果: ${JSON.stringify(result).substring(0, 300)}`);

    if (result && result.data && result.data.pic_id) picIds.push(result.data.pic_id);
    else if (result && result.pic_id) picIds.push(result.pic_id);
    else if (result && result.pid) picIds.push(result.pid);
  }
  return picIds;
}

// ========== UI 方式 ==========
async function postViaUI(page, account, combo, visibility) {
  const ssBase = path.join(UPLOAD_DIR, `debug_${account.id}_${Date.now()}`);

  // 截图初始状态
  await page.screenshot({ path: `${ssBase}_step0.png`, fullPage: false }).catch(() => {});

  // --- 步骤1：找到并点击发布框 ---
  const editorSelectors = [
    '[placeholder*="新鲜事"]',
    '[placeholder*="分享"]',
    '[class*="publish"] [contenteditable]',
    '[class*="Publish"] [contenteditable]',
    'div[role="textbox"]',
    '[contenteditable]',
    '.wbpro-textarea-wrap textarea',
    'textarea[class*="Form"]'
  ];

  let editor = null;
  for (let i = 0; i < editorSelectors.length; i++) {
    editor = await page.$(editorSelectors[i]).catch(() => null);
    if (editor) break;
    if (i > 2) await sleep(500);
  }

  if (!editor) {
    const clicked = await page.evaluate(() => {
      const allEls = [...document.querySelectorAll('*')];
      for (const el of allEls) {
        const t = el.textContent?.trim() || '';
        if ((t.includes('新鲜事') || t.includes('分享')) && el.children.length < 5) {
          el.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      await sleep(1500);
      for (const sel of editorSelectors) {
        editor = await page.$(sel).catch(() => null);
        if (editor) break;
      }
    }
  }

  if (!editor) {
    await page.screenshot({ path: `${ssBase}_nofield.png`, fullPage: false }).catch(() => {});
    return { success: false, message: '找不到发布框（已截图）', screenshot: `${ssBase}_nofield.png` };
  }

  console.log('[WeboAutomation] 找到发布框');

  // --- 步骤2：输入文字 ---
  await editor.click();
  await sleep(500);

  const tag = await editor.evaluate(el => el.tagName.toLowerCase());
  console.log(`[WeboAutomation] 编辑框标签: ${tag}`);

  if (tag === 'textarea') {
    await editor.fill(combo.text);
  } else {
    await page.keyboard.type(combo.text, { delay: 20 });
  }
  await sleep(500);

  // --- 步骤3：上传图片 ---
  if (combo.images && combo.images.length > 0) {
    const imgBtnClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('*')];
      for (const btn of btns) {
        const t = btn.textContent?.trim() || '';
        if (t === '图片' || t.includes('图片上传')) {
          btn.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (imgBtnClicked) {
      await sleep(500);
      const fileInput = await page.$('input[type="file"]').catch(() => null);
      if (fileInput) {
        const paths = combo.images.map(img => path.join(UPLOAD_DIR, img));
        await fileInput.setInputFiles(paths);
        await sleep(4000);
        console.log('[WeboAutomation] 图片已通过 UI 上传');
      }
    }
  }

  // --- 步骤4：设置可见性 ---
  const visLabels = {
    'public': '公开',
    'followers': '粉丝',
    'friends': '好友圈',
    'private': '仅自己可见',

  };

  if (visibility !== 'public') {
    const targetLabel = visLabels[visibility] || '公开';
    console.log(`[WeboAutomation] 设置可见性: ${targetLabel}`);

    await page.screenshot({ path: `${ssBase}_vis_before.png`, fullPage: false }).catch(() => {});

    let visOpened = false;

    // 找"发送"按钮坐标作为锚点
    const sendBox = await page.locator('text=发送').first().boundingBox().catch(() => null);
    
    if (sendBox) {
      const sendCx = sendBox.x + sendBox.width / 2;
      const sendCy = sendBox.y + sendBox.height / 2;
      console.log(`[WeboAutomation] 发送按钮中心: (${Math.round(sendCx)}, ${Math.round(sendCy)})`);

      // "公开"在"发送"左边约55px
      const publicX = sendCx - 55;
      const publicY = sendCy;

      await page.mouse.move(publicX, publicY);
      await sleep(300);
      
      await page.mouse.click(publicX, publicY);
      visOpened = true;
      console.log(`[WeboAutomation] 坐标点击"公开": (${Math.round(publicX)}, ${Math.round(publicY)})`);
    } else {
      console.log('[WeboAutomation] 找不到发送按钮，尝试备用方案');
      const found = await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')];
        for (const el of els) {
          const t = el.textContent?.trim() || '';
          if (t === '公开' && el.offsetHeight > 0 && el.offsetWidth > 0 && el.offsetHeight < 50) {
            const r = el.getBoundingClientRect();
            if (r.y > 200 && r.y < 500 && r.x > 600) {
              el.click();
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
            }
          }
        }
        return null;
      }).catch(() => null);
      if (found) {
        visOpened = true;
        console.log(`[WeboAutomation] evaluate 点击"公开": (${Math.round(found.x)}, ${Math.round(found.y)})`);
      }
    }

    if (visOpened) {
      await sleep(1200); // 等下拉菜单弹出
      
      await page.screenshot({ path: `${ssBase}_vis_dropdown.png`, fullPage: false }).catch(() => {});

      const dropdownAppeared = await page.evaluate(() => {
        const popups = document.querySelectorAll(
          '[class*="dropdown"], [class*="popup"], [class*="menu"], [class*="layer"], [class*="popover"], [class*="select"], [role="listbox"], [role="menu"]'
        );
        for (const p of popups) {
          if (p.offsetHeight > 0 && p.offsetWidth > 0) return true;
        }
        const allVisible = [...document.querySelectorAll('*')].filter(el => {
          const s = getComputedStyle(el);
          return (s.position === 'absolute' || s.position === 'fixed') 
            && el.offsetHeight > 50 
            && el.offsetHeight < 300
            && el.offsetWidth > 50
            && el.offsetWidth < 400
            && el.children.length >= 2;
        });
        return allVisible.length > 0;
      }).catch(() => false);

      console.log(`[WeboAutomation] 检测到弹出层: ${dropdownAppeared}`);

      if (dropdownAppeared) {
        // ========== 关键修复：精确选择下拉菜单中的选项（排除侧边栏同名元素）==========
        let visSelected = false;

        // "公开"按钮X坐标锚点——下拉菜单一定在这个附近，侧边栏在最左侧(X<400)
        const anchorX = sendBox ? (sendBox.x + sendBox.width / 2 - 55) : 850;
        
        // 第一步：枚举所有匹配目标文字的元素，按位置过滤找正确的那个
        const candidates = await page.evaluate((label) => {
          const matches = [];
          for (const el of [...document.querySelectorAll('*')]) {
            const t = el.textContent?.trim() || '';
            if (t !== label) continue;
            if (el.children.length > 2) continue; // 容器元素排除
            const r = el.getBoundingClientRect();
            if (r.height <= 0 || r.width <= 0) continue;
            if (r.height < 15 || r.height > 60 || r.width < 20 || r.width > 200) continue;
            matches.push({
              tag: el.tagName,
              cx: Math.round(r.x + r.width / 2),
              cy: Math.round(r.y + r.height / 2),
              w: Math.round(r.width),
              h: Math.round(r.height),
              cls: (el.className || '').toString().substring(0, 40)
            });
          }
          return matches;
        }, targetLabel).catch(() => []);

        console.log(`[WeboAutomation] "${targetLabel}" 候选数: ${candidates.length}, 列表: ${JSON.stringify(candidates)}`);

        // 过滤：只保留 X 靠近"公开"按钮的（排除左侧边栏）
        let bestCandidate = null;
        if (candidates.length > 0) {
          // 严格过滤：必须在公开按钮X附近 ±150px，且Y在按钮下方
          const strictFilter = candidates.filter(c =>
            c.cx > anchorX - 100 && c.cx < anchorX + 150 &&
            c.cy > (sendBox ? sendBox.y : 300)
          );
          
          if (strictFilter.length > 0) {
            strictFilter.sort((a, b) => a.cy - b.cy); // Y最小的最接近按钮
            bestCandidate = strictFilter[0];
            console.log(`[WeboAutomation] 严格过滤命中: ${JSON.stringify(bestCandidate)}`);
          } else {
            // 放宽：只要X>500就认为是右侧区域
            const looseFilter = candidates.filter(c => c.cx > 500);
            if (looseFilter.length > 0) {
              looseFilter.sort((a, b) => a.cy - b.cy);
              bestCandidate = looseFilter[0];
              console.log(`[WeboAutomation] 宽松过滤命中: ${JSON.stringify(bestCandidate)}`);
            }
          }
        }

        if (bestCandidate) {
          // 用 mouse click 精确点这个元素的坐标
          await page.mouse.click(bestCandidate.cx, bestCandidate.cy);
          visSelected = true;
          console.log(`[WeboAutomation] ✓ 精准点击 "${targetLabel}": (${bestCandidate.cx}, ${bestCandidate.cy}) tag=${bestCandidate.tag}`);
        }

        // 第二步兜底：Playwright locator 遍历所有匹配项，逐个检查位置
        if (!visSelected) {
          try {
            const allMatches = page.locator(`text="${targetLabel}"`);
            const count = await allMatches.count();
            console.log(`[WeboAutomation] locator遍历: 共${count}个"${targetLabel}"`);
            
            for (let i = 0; i < count; i++) {
              const box = await allMatches.nth(i).boundingBox().catch(() => null);
              if (!box) continue;
              const cx = box.x + box.width / 2;
              const cy = box.y + box.height / 2;
              console.log(`[WeboAutomation]   #${i}: (${Math.round(cx)}, ${Math.round(cy)})`);
              
              // 必须在"公开"按钮附近（排除侧边栏）
              if (cx > anchorX - 120 && cx < anchorX + 150 && cy > (sendBox ? sendBox.y : 300)) {
                await allMatches.nth(i).click({ force: true });
                visSelected = true;
                console.log(`[WeboAutomation] ✓ locator#${i}选中"${targetLabel}"`);
                break;
              }
            }
          } catch (e) {
            console.log(`[WeboAutomation] locator遍历异常: ${e.message}`);
          }
        }

        // 第三步最终兜底：evaluate 但严格限制X范围排除侧边栏
        if (!visSelected) {
          visSelected = await page.evaluate((label, minX, minY) => {
            const items = [...document.querySelectorAll('*')].filter(el => {
              const t = el.textContent?.trim() || '';
              if (t !== label || el.children.length > 3) return false;
              const r = el.getBoundingClientRect();
              if (r.height <= 0 || r.width <= 0) return false;
              // 关键：X必须足够靠右（排除侧边栏），Y在按钮下方
              if (r.x + r.width / 2 < minX || r.y < minY) return false;
              return true;
            });
            items.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
            if (items.length > 0) { items[0].click(); return true; }
            return false;
          }, targetLabel, anchorX - 100, sendBox ? sendBox.y : 300).catch(() => false);

          if (visSelected) {
            console.log(`[WeboAutomation] ✓ evaluate兜底选中: ${targetLabel}`);
          }
        }

        if (visSelected) {
          console.log(`[WeboAutomation] ✓ 可见性已设为: ${targetLabel}`);
          await sleep(800);
          await page.screenshot({ path: `${ssBase}_vis_after.png`, fullPage: false }).catch(() => {});


        } else {
          console.log(`[WeboAutomation] ✗ 未选中选项: ${targetLabel}`);
          await page.screenshot({ path: `${ssBase}_vis_fail.png`, fullPage: false }).catch(() => {});
        }
      } else {
        console.log('[WeboAutomation] ✗ 下拉未打开，重试...');
        await page.screenshot({ path: `${ssBase}_vis_nodropdown.png`, fullPage: false }).catch(() => {});
        if (sendBox) {
          const px = sendBox.x + sendBox.width / 2 - 55;
          const py = sendBox.y + sendBox.height / 2;
          await page.mouse.move(px, py, { steps: 5 });
          await sleep(500);
          await page.mouse.dblclick(px, py);
          await sleep(1500);
          await page.screenshot({ path: `${ssBase}_vis_retry.png`, fullPage: false }).catch(() => {});
          console.log('[WeboAutomation] 重试: hover+dblclick');
        }
      }
    } else {
      console.log('[WeboAutomation] ✗ 无法定位可见性按钮');
      await page.screenshot({ path: `${ssBase}_vis_nobtn.png`, fullPage: false }).catch(() => {});
    }
    await sleep(500);
  }

  // 截图输入完成状态
  await page.screenshot({ path: `${ssBase}_step4.png`, fullPage: false }).catch(() => {});

  // --- 步骤5：点击发送按钮 ---
  const sendBtnSelectors = [
    ':text("发送")',
    ':text("发博")',
    ':text("发布")'
  ];

  let sendBtn = null;
  for (const sel of sendBtnSelectors) {
    sendBtn = await page.$(sel).catch(() => null);
    if (sendBtn) break;
  }

  if (!sendBtn) {
    sendBtn = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a[class*="btn"], [class*="send"]')];
      for (const btn of btns) {
        const t = btn.textContent?.trim() || '';
        if (t.includes('发送') || t.includes('发博') || t.includes('发布') || t.includes('提交')) {
          return btn;
        }
      }
      return null;
    }).catch(() => null);
  }

  if (!sendBtn) {
    const btnTexts = await page.evaluate(() => {
      return [...document.querySelectorAll('button, a')]
        .filter(el => el.offsetHeight > 0 && el.offsetWidth > 0)
        .slice(-15)
        .map(el => ({
          tag: el.tagName,
          class: el.className?.substring?.(0, 60),
          text: el.textContent?.trim()?.substring(0, 20)
        }));
    }).catch(() => []);
    console.log(`[WeboAutomation] 页面按钮列表: ${JSON.stringify(btnTexts)}`);
    await page.screenshot({ path: `${ssBase}_nosend.png`, fullPage: false }).catch(() => {});
    return {
      success: false,
      message: '找不到发送按钮（已截图+日志）',
      screenshot: `${ssBase}_nosend.png`
    };
  }

  await sendBtn.click();
  console.log(`[WeboAutomation] 已点击发送按钮`);

  await sleep(4000);

  await page.screenshot({ path: `${ssBase}_done.png`, fullPage: false }).catch(() => {});
  return { success: true, message: '发布成功（UI）' };
}

module.exports = { postWeibo };
