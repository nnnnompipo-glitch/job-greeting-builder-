/* Local credentials stay in extension trusted contexts, never in the BOSS page. */
const SERVER = 'http://127.0.0.1:43127';
const BOSS_HOST = 'www.zhipin.com';
const trustedStorage = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

function isBossUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === `https://${BOSS_HOST}` &&
      (/^\/job_detail\/[\w-]+\.html$/.test(url.pathname) || /^\/web\/geek\/(?:job|job-recommend)\/?$/.test(url.pathname));
  } catch { return false; }
}

async function settings() {
  await trustedStorage;
  const stored = await chrome.storage.local.get({ token: '', enabled: false });
  return { token: stored.token, enabled: Boolean(stored.enabled && stored.token) };
}

async function foreground(sender) {
  if (!sender.tab || !isBossUrl(sender.url) || sender.frameId !== 0) return false;
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!tab.active || !isBossUrl(tab.url)) return false;
  const window = await chrome.windows.get(tab.windowId);
  return window.focused;
}

function popupSender(sender) {
  return !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
}

function modelSettingsSender(sender) {
  return sender.url === chrome.runtime.getURL('settings.html') && (sender.frameId === undefined || sender.frameId === 0);
}

function cleanModelSettings(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('模型设置不正确。');
  const result = {};
  for (const key of ['provider','baseUrl','model','apiKey','responseFormat']) {
    if (typeof model[key] === 'string') result[key] = model[key];
  }
  if (typeof model.clearApiKey === 'boolean') result.clearApiKey = model.clearApiKey;
  if (typeof model.timeoutMs === 'number') result.timeoutMs = model.timeoutMs;
  return result;
}

function publicSettings(data) {
  const model = {};
  for (const key of ['provider','baseUrl','model','responseFormat','timeoutMs','hasApiKey']) {
    if (data?.model?.[key] !== undefined) model[key] = data.model[key];
  }
  return { model, profile: typeof data?.profile === 'string' ? data.profile : '', profileReady: Boolean(data?.profileReady) };
}

async function request(path, config, method = 'GET', body, timeoutMs = 12000) {
  if (!config.token) throw Object.assign(new Error('请先在扩展设置中填写配对码。'), { code: 'unpaired' });
  try {
    const response = await fetch(SERVER + path, {
      method,
      headers: { 'X-Boss-Helper-Token': config.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store', credentials: 'omit', redirect: 'error'
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || `本地服务返回 ${response.status}`), { code: String(response.status) });
    return data;
  } catch (error) {
    if (error.code) throw error;
    throw new Error('连接不到本地服务，请先运行“启动助手”。');
  }
}

function cleanJob(job) {
  if (!job || !isBossUrl(job.url) || typeof job.title !== 'string' || typeof job.description !== 'string') {
    throw new Error('当前页面不是可识别的岗位详情。');
  }
  const result = {};
  for (const [key, max] of Object.entries({ url: 2000, title: 160, company: 160, description: 18000, salary: 100, requirements: 1000 })) {
    if (typeof job[key] === 'string') result[key] = job[key].trim().slice(0, max);
  }
  if (!result.title || result.description.length < 30) throw new Error('岗位详情还没有加载完整。');
  return result;
}

async function handle(message, sender) {
  if (!message || typeof message.action !== 'string') throw new Error('无效请求。');
  if (popupSender(sender)) {
    if (message.action === 'getSettings') {
      const config = await settings();
      return { enabled: config.enabled, paired: Boolean(config.token), token: config.token };
    }
    if (message.action === 'saveSettings') {
      const token = String(message.token || '').trim();
      if (token && !/^[A-Za-z0-9_-]{24,128}$/.test(token)) throw new Error('配对码格式不正确，请从 private/pairing.txt 复制完整配对码。');
      await trustedStorage;
      await chrome.storage.local.set({ token, enabled: Boolean(message.enabled && token) });
      return { paired: Boolean(token), enabled: Boolean(message.enabled && token) };
    }
    if (message.action === 'testConnection') return request('/api/health', await settings());
    if (message.action === 'openSettings') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
      return { opened: true };
    }
    throw new Error('不支持的设置操作。');
  }
  if (modelSettingsSender(sender)) {
    const config = await settings();
    if (message.action === 'getModelSettings') return publicSettings(await request('/api/settings',config));
    if (message.action === 'saveModelSettings') {
      const body = { model: cleanModelSettings(message.model) };
      if (message.profile !== undefined) {
        if (typeof message.profile !== 'string' || message.profile.length > 60000) throw new Error('个人资料格式不正确或过长。');
        body.profile = message.profile;
      }
      const result = publicSettings(await request('/api/settings',config,'PUT',body));
      await notifySettings().catch(() => {});
      return result;
    }
    if (message.action === 'testModelSettings') {
      const model = cleanModelSettings(message.model);
      const timeoutMs = Math.min(185000,Math.max(15000,(model.timeoutMs || 120000)+5000));
      const result = await request('/api/model/test',config,'POST',{model},timeoutMs);
      return { ok: Boolean(result.ok), message: typeof result.message === 'string' ? result.message : '模型连接测试完成。' };
    }
    throw new Error('不支持的模型设置操作。');
  }
  if (!sender.tab || !isBossUrl(sender.url) || sender.frameId !== 0) throw new Error('仅支持 BOSS 岗位页面。');
  const config = await settings();
  const active = await foreground(sender);
  if (message.action === 'getState') return { enabled: config.enabled, paired: Boolean(config.token), active };
  if (message.action === 'setMonitoring') {
    if (!active) throw Object.assign(new Error('请先回到当前岗位标签页，再切换检测状态。'), { code: 'inactive' });
    if (typeof message.enabled !== 'boolean') throw new Error('检测设置不正确。');
    if (message.enabled && !config.token) throw new Error('请先点击浏览器工具栏的助手，填写配对码。');
    await chrome.storage.local.set({ enabled: message.enabled });
    return { enabled: message.enabled, paired: Boolean(config.token) };
  }
  if (!config.enabled || !active) throw Object.assign(new Error('检测已暂停，或该标签页不在前台。'), { code: 'inactive' });
  let task;
  if (message.action === 'observeJob') task = await request('/api/jobs', config, 'POST', cleanJob(message.job));
  else if (message.action === 'getJob') {
    if (typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(message.id)) throw new Error('无效任务编号。');
    task = await request(`/api/jobs/${encodeURIComponent(message.id)}`, config);
  }
  else throw new Error('不支持的操作。');
  // Pairing, pause, or window focus can change while localhost is responding.
  const current = await settings();
  if (!current.enabled || current.token !== config.token || !(await foreground(sender))) {
    throw Object.assign(new Error('检测已暂停，或该标签页不在前台。'), { code: 'inactive' });
  }
  return task;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error.message, code: error.code || '' }));
  return true;
});

async function notifySettings() {
  const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { action: 'settingsChanged' })));
}
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') notifySettings().catch(() => {}); });
