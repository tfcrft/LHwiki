// Low-resource mode never schedules cloud writes. Editing is recovered from
// localStorage; only an explicit Save or Submit may touch PostgreSQL.
const DRAFT_CLIENT_VERSION = 3;
const LOCAL_DELAY = 220;

function storageKey(userId, draftKey) {
  return `lhwiki:draft:${encodeURIComponent(userId)}:${encodeURIComponent(draftKey)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fingerprint(value) {
  return JSON.stringify(value);
}

export function draftKeyFor(targetType, targetId = null) {
  if (targetType === 'submission') return `submission:${targetId}`;
  if (targetType === 'article') return `article:${targetId}`;
  return `new:${crypto.randomUUID()}`;
}

export function readLocalDraft(userId, draftKey) {
  try {
    const raw = localStorage.getItem(storageKey(userId, draftKey));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.snapshot ? parsed : null;
  } catch {
    return null;
  }
}

export function listLocalDrafts(userId = null) {
  const drafts = [];
  try {
    const prefix = 'lhwiki:draft:';
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      const separator = remainder.indexOf(':');
      if (separator < 0) continue;
      const storedUserId = decodeURIComponent(remainder.slice(0, separator));
      if (userId && storedUserId !== userId) continue;
      const draftKey = decodeURIComponent(remainder.slice(separator + 1));
      const value = readLocalDraft(storedUserId, draftKey);
      if (value) drafts.push({ ...value, userId: storedUserId, draftKey });
    }
  } catch { /* private mode can disable storage */ }
  return drafts.sort((left, right) => Date.parse(right.savedAt || 0) - Date.parse(left.savedAt || 0));
}

export function clearLocalDraft(userId, draftKey) {
  try { localStorage.removeItem(storageKey(userId, draftKey)); } catch { /* private mode can disable storage */ }
}

export function clearUserLocalDrafts(userId) {
  try {
    const prefix = `lhwiki:draft:${encodeURIComponent(userId)}:`;
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch { /* logout should still succeed when storage is unavailable */ }
}

export class DraftManager {
  constructor({ api, userId, draftKey, targetType = 'new', targetId = null, draft = null, warnBeforeUnload = false, onState = () => {}, onConflict = () => {} }) {
    this.api = api;
    this.userId = userId;
    this.draftKey = draft?.draftKey || draftKey;
    this.targetType = draft?.targetType || targetType;
    this.targetId = draft?.targetId || targetId;
    this.id = draft?.id || null;
    this.revision = draft?.revision || null;
    this.snapshot = draft ? this.snapshotFromDraft(draft) : null;
    this.snapshotFingerprint = this.snapshot ? fingerprint(this.snapshot) : null;
    this.updatedAt = draft?.updatedAt || null;
    this.onState = onState;
    this.onConflict = onConflict;
    this.sequence = 0;
    this.savedSequence = 0;
    this.saving = null;
    this.timer = null;
    this.localTimer = null;
    this.retryTimer = null;
    this.retryIndex = 0;
    this.conflicted = false;
    this.removing = false;
    this.warnBeforeUnload = warnBeforeUnload;
    this.lastState = 'saved';
    this.channel = this.createChannel();
    this.trailingSaveRequested = false;
    this.autoRetryBlocked = false;
    this.onlineHandler = () => {
      if (this.sequence > this.savedSequence) this.setState('dirty', '已保存在本机；点击“立即保存”可同步云端');
    };
    window.addEventListener('online', this.onlineHandler);
    this.pagehideHandler = () => this.persistLocal(true);
    window.addEventListener('pagehide', this.pagehideHandler);
    this.beforeUnloadHandler = event => {
      this.persistLocal(true);
      if (!this.warnBeforeUnload || this.sequence < 1) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    this.setState('saved', this.updatedAt ? `已保存于 ${this.formatTime(this.updatedAt)}` : '尚未开始保存');
  }

  snapshotFromDraft(draft) {
    return {
      schemaVersion: Number(draft.schemaVersion) || 1,
      sectionSlug: draft.sectionSlug || '',
      contentType: draft.contentType || '',
      title: draft.title || '',
      summary: draft.summary || '',
      subject: draft.subject || '',
      authorLabel: draft.authorLabel || '',
      anonymous: Boolean(draft.anonymous),
      body: clone(draft.body || [])
    };
  }

  createChannel() {
    if (!('BroadcastChannel' in window)) return null;
    const channel = new BroadcastChannel(`lhwiki:${this.userId}:${this.draftKey}`);
    channel.addEventListener('message', event => {
      if (event.data?.revision > (this.revision || 0)) this.setState('dirty', '另一页面保存了更新，继续书写时会进行版本检查');
    });
    return channel;
  }

  local() {
    return readLocalDraft(this.userId, this.draftKey);
  }

  chooseInitial(initialSnapshot) {
    const local = this.local();
    if (local && (!this.updatedAt || Date.parse(local.savedAt) > Date.parse(this.updatedAt))) {
      this.snapshot = clone(local.snapshot);
      this.snapshotFingerprint = fingerprint(this.snapshot);
      this.sequence = Number(local.sequence) || 1;
      this.savedSequence = Number(local.savedSequence) || 0;
      this.id = this.id || local.draftId || null;
      this.revision = this.revision || local.revision || null;
      this.setState('dirty', '已恢复这台设备上较新的内容');
      return clone(this.snapshot);
    }
    this.snapshot = clone(this.snapshot || initialSnapshot);
    this.snapshotFingerprint = fingerprint(this.snapshot);
    return clone(this.snapshot);
  }

  update(snapshot) {
    const nextSnapshot = clone(snapshot);
    const nextFingerprint = fingerprint(nextSnapshot);
    if (nextFingerprint === this.snapshotFingerprint) return false;
    this.snapshot = nextSnapshot;
    this.snapshotFingerprint = nextFingerprint;
    this.sequence += 1;
    this.setState(navigator.onLine ? 'dirty' : 'offline', navigator.onLine ? '已自动保存在本机；云端需手动保存' : '离线：已保存在这台设备');
    clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => this.persistLocal(), LOCAL_DELAY);
    return true;
  }

  persistLocal(sync = false) {
    clearTimeout(this.localTimer);
    if (!this.snapshot) return;
    try {
      localStorage.setItem(storageKey(this.userId, this.draftKey), JSON.stringify({
        snapshot: this.snapshot,
        savedAt: new Date().toISOString(),
        sequence: this.sequence,
        savedSequence: this.savedSequence,
        draftId: this.id,
        revision: this.revision
      }));
    } catch {
      if (!sync) this.setState('failed', '浏览器无法写入本机恢复副本');
    }
  }

  async saveNow({ automatic = false } = {}) {
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.persistLocal();
    if (!this.snapshot || this.conflicted) return null;
    if (automatic && this.autoRetryBlocked) {
      this.setState('failed', '云端自动保存已暂停，本机副本仍保留；可手动重试');
      return null;
    }
    if (!navigator.onLine) {
      this.setState('offline', '离线：已保存在这台设备');
      return null;
    }
    if (this.saving) {
      if (this.sequence > this.savedSequence) this.trailingSaveRequested = true;
      await this.saving;
      if (this.trailingSaveRequested) {
        this.trailingSaveRequested = false;
        return this.saveNow({ automatic });
      }
      return null;
    }
    const sendingSequence = this.sequence;
    const sendingSnapshot = clone(this.snapshot);
    this.setState('saving', '正在保存到云端…');
    this.saving = this.performSave(sendingSnapshot, sendingSequence);
    try {
      return await this.saving;
    } finally {
      this.saving = null;
    }
  }

  async performSave(snapshot, sendingSequence) {
    try {
      const wasNew = !this.id;
      let response = wasNew
        ? await this.api('/api/drafts', { method: 'POST', body: { clientVersion: DRAFT_CLIENT_VERSION, draftKey: this.draftKey, targetType: this.targetType, targetId: this.targetId, snapshot } })
        : await this.api(`/api/drafts/${encodeURIComponent(this.id)}`, { method: 'PUT', body: { clientVersion: DRAFT_CLIENT_VERSION, expectedRevision: this.revision, snapshot } });
      let draft = response.draft;
      if (wasNew && JSON.stringify(this.snapshotFromDraft(draft)) !== JSON.stringify(snapshot)) {
        response = await this.api(`/api/drafts/${encodeURIComponent(draft.id)}`, { method: 'PUT', body: { clientVersion: DRAFT_CLIENT_VERSION, expectedRevision: draft.revision, snapshot } });
        draft = response.draft;
      }
      this.id = draft.id;
      this.draftKey = draft.draftKey;
      this.revision = draft.revision;
      this.updatedAt = draft.updatedAt;
      this.savedSequence = Math.max(this.savedSequence, sendingSequence);
      this.retryIndex = 0;
      this.autoRetryBlocked = false;
      this.channel?.postMessage({ revision: this.revision, updatedAt: this.updatedAt });
      this.persistLocal();
      if (this.sequence === this.savedSequence) this.setState('saved', `已保存 ${this.formatTime(this.updatedAt)}`);
      else this.setState('dirty', '保存期间有新修改，正在继续保存');
      return draft;
    } catch (error) {
      if (this.removing) return null;
      if (error.status === 409 && error.data?.conflict) {
        this.conflicted = true;
        this.setState('conflict', '这份草稿已在其他页面更新');
        this.onConflict(error.data.conflict, clone(this.snapshot));
        return null;
      }
      if (error.status === 409 && error.data?.upgradeRequired) {
        this.conflicted = true;
        this.setState('conflict', '页面版本已更新，请刷新后继续编辑；本机内容仍已保留');
        return null;
      }
      if ([429, 503].includes(error?.status)) {
        this.autoRetryBlocked = true;
        this.setState('failed', '云端暂时繁忙，自动保存已暂停；本机副本仍保留，可稍后手动保存');
        return null;
      }
      this.setState(navigator.onLine ? 'failed' : 'offline', navigator.onLine ? '云端保存失败，本机副本仍保留；请稍后手动重试' : '离线：已保存在这台设备');
      return null;
    }
  }

  async submit() {
    await this.saveNow();
    if (this.conflicted) throw new Error('请先处理草稿冲突');
    if (this.sequence !== this.savedSequence || ['failed', 'offline'].includes(this.lastState)) throw new Error('最新修改尚未保存到云端，请检查网络后重试');
    if (!this.id || !this.revision) throw new Error('草稿还没有保存到云端，请重试');
    const result = await this.api(`/api/drafts/${encodeURIComponent(this.id)}/submit`, {
      method: 'POST',
      body: { clientVersion: DRAFT_CLIENT_VERSION, expectedRevision: this.revision }
    });
    clearLocalDraft(this.userId, this.draftKey);
    return result;
  }

  async remove() {
    this.removing = true;
    clearTimeout(this.timer);
    clearTimeout(this.localTimer);
    clearTimeout(this.retryTimer);
    if (this.saving) await this.saving;
    if (this.id) await this.api(`/api/drafts/${encodeURIComponent(this.id)}`, { method: 'DELETE' });
    clearLocalDraft(this.userId, this.draftKey);
    this.snapshot = null;
    this.snapshotFingerprint = null;
    this.id = null;
    this.revision = null;
    this.sequence = 0;
    this.savedSequence = 0;
  }

  adoptCloud(draft) {
    this.id = draft.id;
    this.draftKey = draft.draftKey;
    this.revision = draft.revision;
    this.updatedAt = draft.updatedAt;
    this.snapshot = this.snapshotFromDraft(draft);
    this.snapshotFingerprint = fingerprint(this.snapshot);
    this.sequence += 1;
    this.savedSequence = this.sequence;
    this.conflicted = false;
    this.persistLocal();
    this.setState('saved', `已采用云端版本 ${this.formatTime(this.updatedAt)}`);
    return clone(this.snapshot);
  }

  async keepLocalAsCopy(snapshot) {
    const previousDraftKey = this.draftKey;
    this.id = null;
    this.revision = null;
    this.targetType = 'new';
    this.targetId = null;
    this.draftKey = draftKeyFor('new');
    clearLocalDraft(this.userId, previousDraftKey);
    this.channel?.close();
    this.channel = this.createChannel();
    this.snapshot = clone(snapshot);
    this.snapshotFingerprint = fingerprint(this.snapshot);
    this.sequence += 1;
    this.savedSequence = 0;
    this.conflicted = false;
    this.persistLocal();
    await this.saveNow();
  }

  setState(state, message) {
    this.lastState = state;
    this.onState({ state, message, updatedAt: this.updatedAt, revision: this.revision });
  }

  formatTime(value) {
    const time = value ? new Date(value) : new Date();
    return Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.localTimer);
    clearTimeout(this.retryTimer);
    this.channel?.close();
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('pagehide', this.pagehideHandler);
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
  }
}
