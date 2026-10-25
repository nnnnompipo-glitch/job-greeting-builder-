function problem(message) { return Object.assign(new Error(message), {publicMessage:message}); }

// Keep the settings shape readable by older installed extensions, without an HTTP adapter.
export function normalizeModelSettings(input = {}, _options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('Codex 设置格式不正确');
  if (input.provider !== undefined && input.provider !== 'codex') throw problem('本助手统一使用 Codex 登录，请重新运行新版安装器完成迁移');
  for (const field of ['baseUrl','model','apiKey']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].trim() !== '')) {
      throw problem('本助手使用 Codex 现有登录，不接受其他模型地址、模型 ID 或 API Key');
    }
  }
  if (input.responseFormat !== undefined && input.responseFormat !== 'auto') throw problem('Codex 输出格式由助手统一管理');
  const timeoutMs=input.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw problem('Codex 超时应为1000至600000毫秒');
  return {provider:'codex',baseUrl:'',model:'',apiKey:'',responseFormat:'auto',timeoutMs};
}

export function publicModelSettings(input) {
  const {apiKey,...settings}=normalizeModelSettings(input);
  return {...settings,hasApiKey:false};
}
