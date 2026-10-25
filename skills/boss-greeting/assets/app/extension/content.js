(() => {
  if (globalThis.__bossGreetingHelperLoaded) return;
  globalThis.__bossGreetingHelperLoaded = true;
  let host, ui, observer, scanTimer, maxTimer, pollTimer;
  let fingerprint = '', epoch = 0, pendingId = '', scanning = false, scanAgain = false;
  let failed = false, lastUrl = location.href, changingTone = false;
  const tones = {
    professional:'客观克制，以项目和能力为主；不使用感叹或比喻。',
    friendly:'自然口语，亲近有礼；不使用夸张或比喻。',
    bold:'热情有张力，强调主观意愿；事实、能力和成果不夸张。',
    creative:'用一个贴合岗位的简短巧思切入；避免卖萌和强烈感叹。'
  };
  const eligible = () => Boolean(globalThis.RecruitmentPlatforms?.isSupportedURL(location.href));
  const status = value => { if (ui) ui.status.textContent = value; };

  async function ask(action, values = {}) {
    let deadline;
    let response;
    try {
      response = await Promise.race([
        chrome.runtime.sendMessage({ action, ...values }),
        new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('助手响应超时，请重新检测；若刚更新扩展，请刷新当前岗位页。')), 15000); })
      ]);
    } finally { clearTimeout(deadline); }
    if (!response?.ok) throw Object.assign(new Error(response?.error || '扩展已更新，请刷新岗位页。'), { code: response?.code || '' });
    return response.data;
  }
  function stopPoll() { clearTimeout(pollTimer); pollTimer = undefined; }
  function clearJob() {
    epoch++;
    fingerprint = '';
    pendingId = '';
    failed = false;
    stopPoll();
    if (ui) {
      ui.title.textContent = '';
      ui.greeting.value = '';
      ui.matches.replaceChildren();
      ui.cautions.replaceChildren();
      ui.details.hidden = true;
      ui.copy.disabled = true;
    }
  }
  function makePanel() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = 'boss-local-greeting-helper';
    host.style.cssText = 'position:fixed!important;right:18px!important;bottom:24px!important;z-index:2147483646!important;width:342px!important;max-width:calc(100vw - 28px)!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial;font:14px/1.55 system-ui,"Microsoft YaHei",sans-serif;color:#183b34}
      *{box-sizing:border-box}section{background:#fff;border:1px solid #b8d7cf;border-radius:14px;box-shadow:0 9px 40px #163b3526;overflow:hidden}
      header{display:flex;justify-content:space-between;align-items:center;background:#eaf6f1;padding:12px 14px;font-weight:650}
      button{font:inherit;border:0;border-radius:7px;cursor:pointer;padding:7px 11px;background:#087c68;color:white}
      button:disabled{opacity:.45;cursor:default}header button{background:transparent;color:#296c5d;padding:2px 6px;font-size:12px}
      main{padding:13px 14px;max-height:70vh;overflow:auto}p{margin:0 0 9px}.status{font-size:12px;color:#526f64;white-space:pre-wrap}
      .title{font-weight:650;font-size:14px;overflow-wrap:anywhere}.hint{font-size:11px;color:#6c7c75;margin-top:10px;margin-bottom:0}
      textarea{width:100%;min-height:132px;resize:vertical;font:14px/1.65 system-ui,"Microsoft YaHei",sans-serif;padding:10px;border:1px solid #bbd5ca;border-radius:8px;color:#183b34;background:#fcfffd}
      .tone-label{display:block;font-size:12px;font-weight:600;margin-bottom:5px}select{width:100%;font:inherit;padding:7px 9px;border:1px solid #bbd5ca;border-radius:7px;background:#fff;color:#183b34}.tone-hint{font-size:11px;color:#64786c;margin:5px 0 10px}
      .actions{display:flex;gap:8px;margin-top:10px}.secondary{background:#eaf1ee;color:#306052}
      details{font-size:12px;margin-top:12px;color:#4d685d}summary{cursor:pointer}ul{padding-left:18px;margin:8px 0}li{margin:5px 0;overflow-wrap:anywhere}.caution{color:#8b6534}
      [hidden]{display:none!important}
    `;
    const section = document.createElement('section');
    section.setAttribute('aria-label', '求职招呼语助手');
    // Static extension markup only. Job and generated text are assigned with textContent/value.
    section.innerHTML = '<header><span>招呼语助手</span><button type="button" id="collapse" aria-expanded="true">收起</button></header><main><p class="status" id="status" role="status">正在检查本地助手…</p><label class="tone-label" for="tone">招呼语语气</label><select id="tone" aria-label="选择招呼语语气"><option value="professional">严肃专业</option><option value="friendly">亲和活泼</option><option value="bold">热情夸张</option><option value="creative">灵动巧思</option></select><p class="tone-hint" id="tone-hint"></p><p class="title" id="title"></p><textarea id="greeting" aria-label="可编辑的招呼语" placeholder="打开岗位详情后，招呼语会显示在这里。" spellcheck="false"></textarea><div class="actions"><button type="button" id="copy" disabled>复制招呼语</button><button type="button" id="retry" class="secondary">重新检测</button><button type="button" id="toggle" class="secondary" hidden>开启检测</button></div><details id="details" hidden><summary>查看匹配依据与待确认信息</summary><ul id="matches"></ul><ul id="cautions" class="caution"></ul></details><p class="hint">仅检测当前前台岗位。核对并复制后，请自行到招聘平台发送。</p></main>';
    shadow.append(style, section);
    document.documentElement.appendChild(host);
    ui = Object.fromEntries(['status', 'title', 'greeting', 'copy', 'retry', 'toggle', 'tone', 'tone-hint', 'collapse', 'matches', 'cautions', 'details'].map(id => [id, shadow.getElementById(id)]));
    ui['tone-hint'].textContent=tones.professional;
    ui.tone.addEventListener('change',async () => {
      const selected=ui.tone.value;
      if (!Object.hasOwn(tones,selected)) return;
      changingTone=true;ui.tone.disabled=true;clearJob();
      ui['tone-hint'].textContent=tones[selected];status('正在保存语气，随后重新生成当前岗位草稿…');
      try {await ask('setTone',{tone:selected});}
      catch(error) {status(error.message);}
      finally {changingTone=false;if(ui)ui.tone.disabled=false;schedule(0);}
    });
    ui.collapse.addEventListener('click', () => {
      const main = shadow.querySelector('main');
      main.hidden = !main.hidden;
      ui.collapse.textContent = main.hidden ? '展开' : '收起';
      ui.collapse.setAttribute('aria-expanded', String(!main.hidden));
    });
    ui.greeting.addEventListener('input', () => { ui.copy.disabled = !ui.greeting.value.trim(); });
    ui.copy.addEventListener('click', async () => {
      const value = ui.greeting.value.trim();
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        status('已复制。请检查内容后，自行粘贴并发送。');
      } catch {
        ui.greeting.focus();
        ui.greeting.select();
        status('浏览器未允许直接复制，文本已选中，请按 Ctrl+C。');
      }
    });
    ui.retry.addEventListener('click', () => {
      clearJob();
      schedule(0);
    });
    ui.toggle.addEventListener('click', async () => {
      ui.toggle.disabled = true;
      try {
        const config = await ask('getState');
        await ask('setMonitoring', { enabled: !config.enabled });
        clearJob();
        schedule(0);
      } catch (error) { status(error.message); }
      finally { if (ui) ui.toggle.disabled = false; }
    });
  }
  function showResult(result) {
    if (!result || typeof result.greeting !== 'string') throw new Error('生成结果格式不正确，请检查本地服务。');
    ui.greeting.value = result.greeting;
    ui.copy.disabled = !result.greeting.trim();
    ui.matches.replaceChildren();
    ui.cautions.replaceChildren();
    for (const match of Array.isArray(result.matches) ? result.matches : []) {
      const item = document.createElement('li');
      item.textContent = `${String(match.requirement || '')} → ${String(match.evidence || '')}`;
      ui.matches.append(item);
    }
    for (const caution of Array.isArray(result.cautions) ? result.cautions : []) {
      const item = document.createElement('li');
      item.textContent = String(caution);
      ui.cautions.append(item);
    }
    ui.details.hidden = !(ui.matches.childElementCount || ui.cautions.childElementCount);
    status('已生成，可修改后复制。');
  }
  function consume(task, ticket) {
    if (ticket !== epoch) return;
    if (document.visibilityState !== 'visible') {
      pendingId = task.id || pendingId;
      stopPoll();
      return;
    }
    // A response can beat the mutation debounce after the user selects another job.
    // Recheck the scoped detail before displaying any result from that response.
    const visibleJob = eligible() && globalThis.BossJobExtractor.extract();
    if (!visibleJob || JSON.stringify(visibleJob) !== fingerprint) {
      clearJob();
      status('岗位已切换，正在重新检测…');
      schedule(0);
      return;
    }
    if (task.status === 'done') {
      pendingId = '';
      failed = false;
      showResult(task.result);
    } else if (task.status === 'error') {
      pendingId = '';
      failed = true;
      status(task.error || '生成失败，请查看本地助手提示。');
    } else if (task.status === 'queued' || task.status === 'running') {
      pendingId = task.id;
      status(task.status === 'queued' ? '岗位已识别，等待生成…' : '正在结合简历和作品集生成…');
      pollTimer = setTimeout(() => poll(ticket), 1500);
    } else throw new Error('本地服务返回了未知任务状态。');
  }
  async function poll(ticket) {
    stopPoll();
    if (ticket !== epoch || !pendingId || document.visibilityState !== 'visible') return;
    try { consume(await ask('getJob', { id: pendingId }), ticket); }
    catch (error) {
      if (ticket !== epoch) return;
      if (error.code === 'inactive') { status('等待当前岗位标签页回到前台。'); return; }
      failed = true;
      status(error.message);
    }
  }
  // Navigation shells also load this script, but unsupported routes only check
  // location/visibility. No DOM extraction, observer or runtime request runs there.
  function reconcilePanel() {
    if (lastUrl !== location.href) { lastUrl = location.href; clearJob(); }
    if (!eligible()) {
      if (host) { clearJob(); host.remove(); host = null; ui = null; }
      observer?.disconnect();
      observer = null;
      return false;
    }
    if (document.visibilityState !== 'visible') { stopPoll(); return false; }
    if (!host?.isConnected) { clearJob(); makePanel(); }
    if (!observer) {
      observer = new MutationObserver(() => schedule(host?.isConnected ? 1500 : 0));
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
    }
    return true;
  }
  async function scan() {
    // Restore the panel even if an earlier asynchronous state read is pending.
    if (!reconcilePanel() || changingTone) return;
    if (scanning) { scanAgain = true; return; }
    scanning = true;
    try {
      const scanEpoch=epoch;
      const config = await ask('getState');
      if (changingTone || scanEpoch !== epoch || !ui || !host?.isConnected || !eligible() || document.visibilityState !== 'visible') return;
      const tone=Object.hasOwn(tones,config.tone) ? config.tone : 'professional';
      ui.tone.value=tone;ui['tone-hint'].textContent=tones[tone];
      ui.toggle.hidden = !config.paired;
      ui.toggle.textContent = config.enabled ? '暂停检测' : '开启检测';
      if (!config.enabled) {
        if (fingerprint) clearJob();
        status(config.paired ? '检测已暂停。点击下方“开启检测”即可生成当前岗位招呼语。' : '请点击浏览器工具栏中的助手，填写本地服务配对码。');
        return;
      }
      if (!config.active) { stopPoll(); status('等待当前岗位标签页回到前台。'); return; }
      const job = globalThis.BossJobExtractor.extract();
      if (!job) {
        if (fingerprint) clearJob();
        status('等待完整岗位详情。请在平台正常展开职责或登录查看；未识别时可复制岗位文字到聊天中。');
        return;
      }
      const key = JSON.stringify(job);
      if (key === fingerprint) {
        if (pendingId && !pollTimer && !failed) pollTimer = setTimeout(() => poll(epoch), 100);
        return;
      }
      clearJob();
      fingerprint = key;
      ui.title.textContent = `${job.platformLabel ? job.platformLabel+' · ' : ''}${job.company ? `${job.title} · ${job.company}` : job.title}`;
      const ticket = epoch;
      status('已读取当前岗位，正在提交到本地助手…');
      try { consume(await ask('observeJob', { job }), ticket); }
      catch (error) {
        if (ticket !== epoch) return;
        failed = true;
        status(error.message);
      }
    } catch (error) { status(error.message); }
    finally {
      scanning = false;
      if (scanAgain) { scanAgain = false; schedule(300); }
    }
  }
  function schedule(delay = 1500) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { clearTimeout(maxTimer); maxTimer = undefined; scan(); }, delay);
    if (!maxTimer) maxTimer = setTimeout(() => { clearTimeout(scanTimer); maxTimer = undefined; scan(); }, 5000);
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === 'settingsChanged') { clearJob(); schedule(0); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') stopPoll(); else schedule(0); });
  window.addEventListener('focus', () => schedule(0));
  window.addEventListener('popstate', () => schedule(0));
  window.addEventListener('pageshow', () => schedule(0));
  window.addEventListener('hashchange', () => schedule(0));
  let heartbeatTicks = 0;
  setInterval(() => {
    if (lastUrl !== location.href) { lastUrl = location.href; clearJob(); schedule(0); }
    else if (document.visibilityState === 'visible' && eligible() && (!host?.isConnected || ++heartbeatTicks >= 10)) {
      heartbeatTicks = 0;
      schedule(0);
    }
  }, 500);
  schedule(0);
})();
