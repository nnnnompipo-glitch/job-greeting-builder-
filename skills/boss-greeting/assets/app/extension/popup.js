const tokenInput = document.querySelector('#token');
const enabledInput = document.querySelector('#enabled');
const statusOutput = document.querySelector('#status');
async function ask(action, values = {}) {
  const answer = await chrome.runtime.sendMessage({ action, ...values });
  if (!answer?.ok) throw new Error(answer?.error || '扩展后台没有响应，请重新加载扩展。');
  return answer.data;
}
async function save() {
  const result = await ask('saveSettings', { token: tokenInput.value.trim(), enabled: enabledInput.checked });
  enabledInput.checked = result.enabled;
  return result;
}

function savedStatus(enabled) {
  return enabled ? '已开启并保存。关闭此窗口，返回岗位页等待生成。' : '检测已暂停。勾选上方“检测前台岗位详情并自动生成”即可开启，会自动保存。';
}

enabledInput.addEventListener('change', async () => {
  try { const result = await save(); statusOutput.textContent = savedStatus(result.enabled); }
  catch (error) { statusOutput.textContent = error.message; }
});
document.querySelector('#save').addEventListener('click', async () => {
  try { const result = await save(); statusOutput.textContent = savedStatus(result.enabled); }
  catch (error) { statusOutput.textContent = error.message; }
});
document.querySelector('#test').addEventListener('click', async event => {
  event.target.disabled = true;
  statusOutput.textContent = '正在连接本地服务…';
  try {
    const result = await save();
    const health = await ask('testConnection');
    statusOutput.textContent = health.profileReady === false ? '连接成功。请先补充简历和作品集资料。' :
      result.enabled ? '连接成功，检测已开启。返回岗位页等待生成。' : '连接成功，但检测已暂停。勾选上方自动生成开关即可开启。';
  } catch (error) { statusOutput.textContent = error.message; }
  finally { event.target.disabled = false; }
});
document.querySelector('#model-settings').addEventListener('click', async () => {
  try { await ask('openSettings'); }
  catch (error) { statusOutput.textContent = error.message; }
});
ask('getSettings').then(config => {
  tokenInput.value = config.token || '';
  enabledInput.checked = config.enabled;
  statusOutput.textContent = config.paired ? savedStatus(config.enabled) : '请先启动本地助手，再从 private/pairing.txt 复制配对码。';
}).catch(error => { statusOutput.textContent = error.message; });
