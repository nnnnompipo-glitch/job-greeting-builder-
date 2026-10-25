const tokenInput = document.querySelector('#token');
const enabledInput = document.querySelector('#enabled');
const statusOutput = document.querySelector('#status');
const STORAGE_TIMEOUT_MS = 3500;
const MESSAGE_TIMEOUT_MS = 15000;
let actionEpoch = 0;
let trustedStorage = null;
let writes = Promise.resolve();

// A trusted popup can persist pairing without waiting for a service worker.
// Support both Chrome's callback API (including lastError) and Promise API.
function chromeCall(target, method, args, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(message)); else resolve(value);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const callback = value => finish(Boolean(chrome.runtime.lastError), value);
    try {
      if (typeof target?.[method] !== 'function') { finish(true); return; }
      const pending = target[method](...args, callback);
      if (pending && typeof pending.then === 'function') pending.then(value => finish(false, value), () => finish(true));
    } catch { finish(true); }
  });
}

function prepareStorage() {
  if (!trustedStorage) {
    trustedStorage = chromeCall(chrome.storage?.local, 'setAccessLevel', [{accessLevel:'TRUSTED_CONTEXTS'}], STORAGE_TIMEOUT_MS,
      '无法准备安全的本地存储，请重新加载扩展后重试。').catch(error => { trustedStorage = null; throw error; });
  }
  return trustedStorage;
}

async function ask(action) {
  const answer = await chromeCall(chrome.runtime, 'sendMessage', [{action}], MESSAGE_TIMEOUT_MS,
    '扩展后台没有响应，请到 chrome://extensions 重新加载助手，再点测试连接。');
  if (!answer?.ok) throw new Error(answer?.error || '扩展后台没有响应，请重新加载扩展。');
  return answer.data;
}

function save() {
  const token = tokenInput.value.trim();
  if (token && !/^[A-Za-z0-9_-]{24,128}$/.test(token)) return Promise.reject(new Error('配对码格式不正确，请复制完整配对码。'));
  const snapshot = {token, enabled:Boolean(enabledInput.checked && token)};
  const operation = writes.catch(() => {}).then(async () => {
    await prepareStorage();
    await chromeCall(chrome.storage.local, 'set', [snapshot], STORAGE_TIMEOUT_MS,
      '配对信息未保存成功，请重试或重新加载扩展。');
    return {...snapshot, paired:Boolean(token)};
  });
  writes = operation;
  return operation;
}

function savedStatus(enabled, paired = true) {
  if (!paired) return '尚未配对。请填写配对码并点击“保存设置”。';
  return enabled ? '已开启并保存。配对码会保留，关闭此窗口后无需重新输入。' :
    '配对码已保存，检测已暂停。勾选上方“检测前台岗位详情并自动生成”即可开启，会自动保存。';
}

function show(epoch, message) { if (epoch === actionEpoch) statusOutput.textContent = message; }
function edited() { actionEpoch++; statusOutput.textContent = '配对码已修改，请点击“保存设置”。'; }
tokenInput.addEventListener('input', edited);

async function saveAction() {
  const epoch = ++actionEpoch;
  show(epoch, '正在保存到此浏览器…');
  try {
    const result = await save();
    if (epoch === actionEpoch) enabledInput.checked = result.enabled;
    show(epoch, savedStatus(result.enabled, result.paired));
  } catch (error) { show(epoch, error.message); }
}

enabledInput.addEventListener('change', saveAction);
document.querySelector('#save').addEventListener('click', saveAction);
document.querySelector('#test').addEventListener('click', async event => {
  const epoch = ++actionEpoch;
  event.target.disabled = true;
  let saved = false;
  show(epoch, '正在保存配对码…');
  try {
    const result = await save();
    saved = true;
    if (epoch === actionEpoch) enabledInput.checked = result.enabled;
    if (!result.paired) throw new Error('请填写配对码后再测试连接。');
    show(epoch, '配对码已保存，正在连接本地服务…');
    const health = await ask('testConnection');
    show(epoch, health.profileReady === false ? '连接成功。请先补充简历和作品集资料。' :
      result.enabled ? '连接成功，检测已开启。返回岗位页等待生成。' : '连接成功，但检测已暂停。勾选上方自动生成开关即可开启。');
  } catch (error) { show(epoch, (saved ? '设置已保存在此浏览器。' : '') + error.message); }
  finally { event.target.disabled = false; }
});

document.querySelector('#model-settings').addEventListener('click', async () => {
  const epoch = ++actionEpoch;
  try { await ask('openSettings'); }
  catch (error) { show(epoch, error.message); }
});

const initialEpoch = actionEpoch;
(async () => {
  await prepareStorage();
  const config = await chromeCall(chrome.storage.local, 'get', [{token:'',enabled:false}], STORAGE_TIMEOUT_MS,
    '无法读取已保存的配对信息，请重新加载扩展后重试。');
  // A late initial read must not overwrite edits or a newer save/test result.
  if (initialEpoch !== actionEpoch) return;
  tokenInput.value = typeof config?.token === 'string' ? config.token : '';
  enabledInput.checked = Boolean(config?.enabled && tokenInput.value);
  show(initialEpoch, savedStatus(enabledInput.checked, Boolean(tokenInput.value)));
})().catch(error => show(initialEpoch, error.message));
