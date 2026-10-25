import { readFile, writeFile, rename, mkdir, copyFile, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeModelSettings, publicModelSettings } from './providers.mjs';
import { normalizePreferences } from './core.mjs';
import { checkCodexLogin } from '../scripts/codex.mjs';

export function isProfileReady(profile) {
  return typeof profile === 'string' && profile.trim().length >= 80 && !profile.includes('<!-- PROFILE_NOT_CONFIGURED -->');
}

export async function atomicWrite(filename, data, operations = {}) {
  const io = {mkdir, writeFile, rename, copyFile, unlink, ...operations};
  await io.mkdir(path.dirname(filename), {recursive:true});
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await io.writeFile(temporary, data, {encoding:'utf8', mode:0o600});
    try { await io.rename(temporary, filename); }
    catch(error) {
      if (error.code !== 'EXDEV') throw error;
      // Redirected filesystems can reject same-directory rename. Copy only for EXDEV.
      await io.copyFile(temporary, filename);
    }
  } finally {
    // Only this call's unique temporary file is eligible for cleanup.
    await io.unlink(temporary).catch(()=>{});
  }
}

export class SettingsStore {
  constructor({root, config, configPath = path.join(root,'private','config.json'),checkCodex=checkCodexLogin}) {
    this.root = root; this.config = config; this.configPath = configPath;
    this.profilePath = path.join(root,'private','profile.md'); this.writes = Promise.resolve();
    this.checkCodex=checkCodex;
  }
  model() { return normalizeModelSettings(this.config.model || {provider:'codex',timeoutMs:this.config.timeoutMs || 120000}, {allowIncomplete:true}); }
  preferences() { return normalizePreferences(this.config.preferences); }
  async profile() {
    try { return (await readFile(this.profilePath,'utf8')).replace(/^\uFEFF/,''); }
    catch(error) { if (error.code === 'ENOENT') return ''; throw new Error('无法读取本机个人资料'); }
  }
  async ready() { return isProfileReady(await this.profile()); }
  async get() {
    const profile = await this.profile();
    return {model:publicModelSettings(this.model()),preferences:this.preferences(),profile,profileReady:isProfileReady(profile)};
  }
  prepareModel(input) {
    return normalizeModelSettings(input);
  }
  async update(body) {
    const operation = this.writes.then(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body) || (!('model' in body) && !('profile' in body) && !('preferences' in body))) throw new Error('请提供模型设置、个人资料或语气偏好');
      if ('profile' in body && (typeof body.profile !== 'string' || body.profile.length > 60000)) throw new Error('个人资料需要为文字，且不能超过60000字符');
      const next = {...this.config};
      if ('model' in body) next.model = this.prepareModel(body.model);
      if ('preferences' in body) next.preferences = normalizePreferences(body.preferences);
      if ('profile' in body) await atomicWrite(this.profilePath, body.profile);
      await atomicWrite(this.configPath, JSON.stringify(next,null,2));
      this.config = next;
      return this.get();
    });
    this.writes = operation.catch(()=>{});
    return operation;
  }
  async test(input) {
    if (input?.model) this.prepareModel(input.model); else this.model();
    return this.checkCodex({codexPath:this.config.codexPath,env:process.env});
  }
  async context() {
    await this.writes;
    const profile = await this.profile();
    if (!isProfileReady(profile)) throw new Error('请在“模型与个人资料设置”中填写真实资料，并删除模板首行占位标记');
    const model = this.model();
    const preferences = this.preferences();
    const cacheKey = createHash('sha256').update(JSON.stringify({model,preferences})).digest('hex');
    return {profile,preferences,cacheKey,config:{...this.config,model,preferences,root:this.root}};
  }
}
