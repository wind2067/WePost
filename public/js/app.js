/* ===== 博群WePost - 前端逻辑 ===== */

const API = {
  accounts: '/api/accounts',
  posts: '/api/posts',
  publish: '/api/publish'
};

// 当前选中的图片文件名（添加文案时临时存储）
let selectedImages = [];
// 当前编辑中的文案ID（null=新增模式，数字=编辑模式）
let editingPostId = null;
// 已加载的文案列表缓存（供编辑按钮按 id 查找）
let loadedPosts = [];
// 预览方案缓存
let previewPlan = null;
// 日志轮询定时器
let logPollTimer = null;

// ===== Tab 切换 =====
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');

    // 切到发布配置时刷新账号列表
    if (tab.dataset.tab === 'publish') loadPublishAccounts();
    // 切到日志时加载最新任务
    if (tab.dataset.tab === 'logs') loadLatestTask();
  });
});

// ==================== 账号管理 ====================

async function loadAccounts() {
  const res = await fetch(API.accounts);
  const accounts = await res.json();
  const list = document.getElementById('accountList');
  document.getElementById('accountCount').textContent = `${accounts.length} 个账号`;

  if (accounts.length === 0) {
    list.innerHTML = '<div class="empty-state">还没有添加账号，在上方添加吧</div>';
    return;
  }

  list.innerHTML = accounts.map(acc => `
    <div class="account-item">
      <div class="account-info">
        <div class="account-avatar">${acc.nickname.charAt(0)}</div>
        <div>
          <div class="account-name">${escapeHtml(acc.nickname)}</div>
          <div class="account-weibo">${acc.weibo_name ? '微博: ' + escapeHtml(acc.weibo_name) : '未登录'}</div>
        </div>
        <span class="cookie-badge ${acc.cookie_status}">${statusText(acc.cookie_status)}</span>
      </div>
      <div class="account-actions">
        <button class="btn btn-outline btn-sm" onclick="loginAccount(${acc.id})">登录</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAccount(${acc.id})">删除</button>
      </div>
    </div>
  `).join('');
}

function statusText(status) {
  return { active: '已登录', expired: '已过期', pending: '待登录' }[status] || status;
}

async function addAccount() {
  const name = document.getElementById('newAccountName').value.trim();
  if (!name) { alert('请输入账号名'); return; }
  try {
    const res = await fetch(API.accounts, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: name })
    });
    if (!res.ok) throw new Error('服务器返回错误: ' + res.status);
    document.getElementById('newAccountName').value = '';
    loadAccounts();
  } catch (err) {
    alert('添加失败: ' + err.message);
    console.error('添加账号失败:', err);
  }
}

async function deleteAccount(id) {
  if (!confirm('确定删除这个账号吗？')) return;
  try {
    const res = await fetch(`${API.accounts}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('服务器返回错误: ' + res.status);
    loadAccounts();
  } catch (err) {
    alert('删除失败: ' + err.message);
    console.error('删除账号失败:', err);
  }
}

async function loginAccount(id) {
  document.getElementById('globalStatus').textContent = '正在打开浏览器...';
  const res = await fetch(`${API.accounts}/${id}/login`, { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    alert('登录成功！Cookie已保存');
    document.getElementById('globalStatus').textContent = '就绪';
  } else {
    alert('登录失败: ' + (data.error || '未知错误'));
    document.getElementById('globalStatus').textContent = '就绪';
  }
  loadAccounts();
}

async function checkAllCookies() {
  document.getElementById('globalStatus').textContent = '正在检测Cookie状态...';
  const res = await fetch(`${API.accounts}/check-all`, { method: 'POST' });
  const data = await res.json();
  document.getElementById('globalStatus').textContent = '就绪';
  loadAccounts();
}

// ==================== 文案编辑 ====================

async function loadPosts() {
  const res = await fetch(API.posts);
  const posts = await res.json();
  loadedPosts = posts;
  const list = document.getElementById('postList');

  if (posts.length === 0) {
    list.innerHTML = '<div class="empty-state">还没有添加文案</div>';
    return;
  }

  list.innerHTML = posts.map(post => `
    <div class="combo-item">
      <div class="combo-text">${escapeHtml(post.text)}</div>
      ${post.images && post.images.length > 0 ? `
        <div class="combo-images">
          ${post.images.map(img => `<img src="/uploads/${img}" alt="">`).join('')}
        </div>
      ` : ''}
      <div class="combo-actions">
        <button class="btn btn-outline btn-sm" onclick="editPost(${post.id})">修改</button>
        <button class="btn btn-danger btn-sm" onclick="deletePost(${post.id})">删除</button>
      </div>
    </div>
  `).join('');
}

function handleImageSelect(event) {
  const files = Array.from(event.target.files);
  if (files.length === 0) return;

  const formData = new FormData();
  files.forEach(f => formData.append('images', f));

  fetch(`${API.posts}/upload`, { method: 'POST', body: formData })
    .then(res => res.json())
    .then(data => {
      if (data.filenames) {
        selectedImages.push(...data.filenames);
        renderUploadPreview();
      }
    })
    .catch(err => alert('图片上传失败: ' + err.message));

  event.target.value = '';
}

function renderUploadPreview() {
  const preview = document.getElementById('uploadPreview');
  preview.innerHTML = selectedImages.map((img, i) => `
    <div style="position:relative;">
      <img src="/uploads/${img}" alt="">
      <button onclick="removeImage(${i})" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:var(--danger);color:#fff;border:none;cursor:pointer;font-size:12px;">x</button>
    </div>
  `).join('');
}

function removeImage(index) {
  selectedImages.splice(index, 1);
  renderUploadPreview();
}

function editPost(id) {
  const post = loadedPosts.find(p => p.id === id);
  if (!post) { alert('文案数据不存在，请刷新页面重试'); return; }

  const textArea = document.getElementById('newPostText');
  // 如果编辑区已有内容且不是当前编辑项，提醒用户
  const currentText = textArea.value.trim();
  const currentImgs = selectedImages.length > 0;
  if ((currentText || currentImgs) && editingPostId !== id) {
    if (!confirm('编辑区已有内容，确定要覆盖吗？')) return;
  }

  // 加载到编辑区
  textArea.value = post.text;
  selectedImages = (post.images || []).slice();
  renderUploadPreview();
  editingPostId = id;

  // 切换按钮状态
  document.getElementById('submitBtn').textContent = '保存修改';
  document.getElementById('cancelEditBtn').style.display = 'inline-block';

  // 滚动到编辑区
  textArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  textArea.focus();
}

function cancelEdit() {
  editingPostId = null;
  document.getElementById('newPostText').value = '';
  selectedImages = [];
  renderUploadPreview();
  document.getElementById('submitBtn').textContent = '添加文案';
  document.getElementById('cancelEditBtn').style.display = 'none';
}

async function addPostCombo() {
  const text = document.getElementById('newPostText').value.trim();
  if (!text) { alert('请输入文案文字'); return; }

  try {
    if (editingPostId !== null) {
      // 编辑模式：PUT 更新
      const res = await fetch(`${API.posts}/${editingPostId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, images: selectedImages })
      });
      if (!res.ok) throw new Error('服务器返回错误: ' + res.status);
      cancelEdit();
      loadPosts();
    } else {
      // 新增模式：POST
      const res = await fetch(API.posts, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, images: selectedImages })
      });
      if (!res.ok) throw new Error('服务器返回错误: ' + res.status);
      document.getElementById('newPostText').value = '';
      selectedImages = [];
      renderUploadPreview();
      loadPosts();
    }
  } catch (err) {
    alert(editingPostId !== null ? '修改失败: ' + err.message : '添加失败: ' + err.message);
    console.error('保存文案失败:', err);
  }
}

async function deletePost(id) {
  if (!confirm('确定删除这条文案吗？')) return;
  try {
    const res = await fetch(`${API.posts}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('服务器返回错误: ' + res.status);
    // 如果正在编辑这条文案，取消编辑模式
    if (editingPostId === id) cancelEdit();
    loadPosts();
  } catch (err) {
    alert('删除失败: ' + err.message);
    console.error('删除文案失败:', err);
  }
}

// ==================== 发布配置 ====================

async function loadPublishAccounts() {
  const res = await fetch(API.accounts);
  const accounts = await res.json();
  const list = document.getElementById('publishAccountList');

  if (accounts.length === 0) {
    list.innerHTML = '<div class="empty-state">请先在「账号管理」中添加并登录账号</div>';
    return;
  }

  list.innerHTML = accounts.map(acc => `
    <label class="account-check">
      <input type="checkbox" value="${acc.id}" ${acc.cookie_status === 'active' ? 'checked' : ''}>
      <span class="check-name">${escapeHtml(acc.nickname)}${acc.weibo_name ? ' (' + escapeHtml(acc.weibo_name) + ')' : ''}</span>
      <span class="check-status cookie-badge ${acc.cookie_status}">${statusText(acc.cookie_status)}</span>
    </label>
  `).join('');
}

function selectAllAccounts(check) {
  document.querySelectorAll('#publishAccountList input[type="checkbox"]').forEach(cb => {
    cb.checked = check;
  });
}

function getSelectedAccountIds() {
  return Array.from(document.querySelectorAll('#publishAccountList input[type="checkbox"]:checked'))
    .map(cb => parseInt(cb.value));
}

function getPublishConfig() {
  return {
    account_ids: getSelectedAccountIds(),
    interval_sec: parseInt(document.getElementById('intervalSec').value) || 5,
    random_range_sec: parseFloat(document.getElementById('randomRangeSec').value) || 0.5,
    visibility: document.querySelector('input[name="visibility"]:checked').value,
    order_mode: document.querySelector('input[name="orderMode"]:checked').value
  };
}

async function previewPublish() {
  const config = getPublishConfig();
  if (config.account_ids.length === 0) {
    alert('请至少选择一个账号');
    return;
  }

  const res = await fetch(`${API.publish}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  const data = await res.json();

  if (data.error) {
    alert(data.error);
    return;
  }

  previewPlan = data;
  renderPreview(data);
  document.getElementById('previewModal').classList.add('show');
}

async function rerollPreview() {
  const config = getPublishConfig();
  const res = await fetch(`${API.publish}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  const data = await res.json();

  if (data.error) {
    alert(data.error);
    return;
  }

  previewPlan = data;
  renderPreview(data);
}

function renderPreview(data) {
  const content = document.getElementById('previewContent');
  const visMap = { 'public': '公开', 'followers': '粉丝', 'friends': '好友圈', 'private': '仅自己可见' };
  const visText = visMap[data.visibility] || data.visibility;
  const orderText = data.order_mode === 'random' ? '随机顺序' : '按列表顺序';

  content.innerHTML = `
    <div style="margin-bottom:16px; font-size:14px; color:var(--text-light);">
      可见性: <strong>${visText}</strong> |
      间隔: <strong>${data.interval_sec}±${data.random_range_sec}秒</strong> |
      顺序: <strong>${orderText}</strong> |
      共 <strong>${data.total}</strong> 个账号
    </div>
    <div class="preview-list">
      ${data.plan.map((item, i) => `
        <div class="preview-item">
          <div class="preview-num">${i + 1}</div>
          <div class="preview-content">
            <div class="preview-account">${escapeHtml(item.nickname)}${item.weibo_name ? ' (' + escapeHtml(item.weibo_name) + ')' : ''}</div>
            <div class="preview-text">${escapeHtml(item.text)}</div>
            ${item.images && item.images.length > 0 ? `
              <div class="preview-imgs">
                ${item.images.map(img => `<img src="/uploads/${img}" alt="">`).join('')}
              </div>
            ` : ''}
            <div style="font-size:12px; color:var(--text-light); margin-top:4px;">
              预计等待: ${i === 0 ? '0秒（首发）' : Math.round(item.estimated_wait) + '秒'}
              ${item.cookie_status !== 'active' ? ' | <span style="color:var(--warning);">Cookie状态异常</span>' : ''}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function confirmPublish() {
  if (!previewPlan) return;
  closeModal('previewModal');

  const config = getPublishConfig();
  // 把预览方案一起传过去，避免发布时重新随机
  const payload = { ...config, plan: previewPlan.plan };
  const res = await fetch(`${API.publish}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (data.task_id) {
    // 自动切换到日志页并开始轮询（不用 alert 阻塞）
    document.querySelector('[data-tab="logs"]').click();
    startLogPolling(data.task_id);
  }
}

function startPublish() {
  const config = getPublishConfig();
  if (config.account_ids.length === 0) {
    alert('请至少选择一个账号');
    return;
  }
  previewPublish();
}

// ==================== 发布日志 ====================

function startLogPolling(taskId) {
  if (logPollTimer) clearInterval(logPollTimer);
  loadTaskLog(taskId);
  logPollTimer = setInterval(() => loadTaskLog(taskId), 3000);
}

async function loadTaskLog(taskId) {
  const res = await fetch(`${API.publish}/task/${taskId}?t=${Date.now()}`);
  const data = await res.json();
  if (data.error) return;

  renderLogs(data.task, data.logs);

  // 任务完成后停止轮询
  if (data.task.status === 'done') {
    clearInterval(logPollTimer);
    logPollTimer = null;
    document.getElementById('globalStatus').textContent = '就绪';
  }
}

async function loadLatestTask() {
  const res = await fetch(`${API.publish}/latest?t=${Date.now()}`);
  const data = await res.json();
  if (!data.task) {
    document.getElementById('reportCard').style.display = 'none';
    document.getElementById('logContainer').innerHTML = '<div class="empty-state">暂无发布记录</div>';
    return;
  }
  renderLogs(data.task, data.logs);

  // 如果任务还在运行，开始轮询
  if (data.task.status === 'running') {
    startLogPolling(data.task.id);
  }
}

function renderLogs(task, logs) {
  // 报告卡片
  const reportCard = document.getElementById('reportCard');
  if (task.status === 'done') {
    reportCard.style.display = 'block';
    document.getElementById('reportTotal').textContent = task.total;
    document.getElementById('reportSuccess').textContent = task.success;
    document.getElementById('reportFailed').textContent = task.failed;
    document.getElementById('reportTime').textContent = task.finished_at || '';
  } else {
    reportCard.style.display = 'none';
  }

  // 日志列表
  const container = document.getElementById('logContainer');
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无日志</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    const icon = log.status === 'success' ? '✓' : log.status === 'failed' ? '✗' : '·';
    const name = log.nickname + (log.weibo_name ? ` (${log.weibo_name})` : '');
    return `
      <div class="log-item">
        <div class="log-icon ${log.status}">${icon}</div>
        <div class="log-account">${escapeHtml(name)}</div>
        <div class="log-message">${escapeHtml(log.message || '')}</div>
        <div class="log-time">${log.published_at || ''}</div>
      </div>
    `;
  }).join('');

  // 全局状态
  if (task.status === 'running') {
    document.getElementById('globalStatus').textContent = `发布中: ${task.success + task.failed}/${task.total}`;
  }
}

// ==================== 工具函数 ====================

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== 初始化 =====
loadAccounts();
loadPosts();
