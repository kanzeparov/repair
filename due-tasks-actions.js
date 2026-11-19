(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DueTasksStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const BACKUP_KEY = 'codex-due-tasks-latest-backup';
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonicalComment = task => task.comment ?? task.cmt ?? '';
  function error(code, message) { const e = new Error(message); e.code = code; return e; }
  function exactDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + 'T12:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  function baseline(t) {
    return [t.txt ?? '', t.date ?? null, !!t.done, !!t.arch, !!t.archived, canonicalComment(t)];
  }
  function create(options = {}) {
    const fetchFn = options.fetchFn ?? (root.fetch && root.fetch.bind(root));
    const storage = options.storage ?? root.localStorage;
    const api = options.api ?? '/api/tasks';
    const now = options.now ?? (() => new Date());
    const timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error('invalid', 'Некорректный таймаут');
    let serial = 0;
    const nonce = root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Math.random().toString(36).slice(2);
    if (typeof fetchFn !== 'function') throw error('invalid', 'Нет fetch');
    async function timedFetch(init, readBody = false) {
      const controller = new root.AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(error('timeout', 'Истекло время ожидания API'));
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchFn(api, {...init, signal: controller.signal});
            if (!readBody) return response;
            if (!response.ok) throw error('read_failed', 'GET: HTTP ' + response.status);
            return await response.json();
          })(), timeout
        ]);
      } finally { clearTimeout(timer); }
    }
    async function read() {
      const data = await timedFetch({method: 'GET', cache: 'no-store'}, true);
      if (!data || !Array.isArray(data.tasks) || !Number.isFinite(data.rev)) throw error('invalid_data', 'Некорректный tasks/rev');
      return data;
    }
    function find(data, id) {
      const matches = data.tasks.filter(t => t && String(t.id) === String(id));
      if (matches.length !== 1) throw error('conflict', 'Задача отсутствует или ID неоднозначен');
      return matches[0];
    }
    async function mutate(original, request) {
      if (!original || original.id == null || !request || !['keep', 'comment', 'done', 'archive', 'move'].includes(request.action)) throw error('invalid', 'Некорректное действие');
      if (request.comment !== undefined && typeof request.comment !== 'string') throw error('invalid', 'Комментарий должен быть строкой');
      if (request.action === 'comment' && typeof request.comment !== 'string') throw error('invalid', 'Нужен комментарий');
      if (request.action === 'move' && !exactDate(request.date)) throw error('invalid', 'Нужна точная дата YYYY-MM-DD');
      // Snapshot caller input before the first await; never mutate caller or GET objects.
      const initial = clone(original), req = clone(request);
      const expectedBaseline = baseline(initial);
      const dateNow = now();
      if (!(dateNow instanceof Date) || Number.isNaN(dateNow.getTime())) throw error('invalid', 'Некорректное время');
      const ts = dateNow.toISOString();
      const operationId = 'due-' + ts + '-' + nonce + '-' + (++serial);
      async function verify(expected) {
        const data = await read();
        const task = find(data, initial.id);
        if (!Array.isArray(data.log) || !data.log.some(e => e && e.operationId === operationId && String(e.id) === String(initial.id))) throw error('verification_failed', 'Операция отсутствует в журнале');
        for (const [key, value] of Object.entries(expected)) {
          if (task[key] !== value) throw error('verification_failed', 'Не подтверждено поле ' + key);
        }
        return {data, task, operationId};
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await read();
        const liveTask = find(latest, initial.id);
        if (JSON.stringify(baseline(liveTask)) !== JSON.stringify(expectedBaseline)) throw error('conflict', 'Задача изменена; обновите страницу');
        if (latest.log !== undefined && !Array.isArray(latest.log)) throw error('invalid_data', 'Некорректный журнал');
        const data = clone(latest), task = find(data, initial.id), expected = {}, changes = {};
        function set(key, value) { changes[key] = {from: task[key] ?? null, to: value}; task[key] = value; expected[key] = value; }
        if (req.comment !== undefined) {
          const from = canonicalComment(task);
          set('comment', req.comment);
          changes.comment.from = from;
        }
        if (req.action === 'keep') set('reviewedAt', ts);
        else if (req.action === 'done') set('done', true);
        else if (req.action === 'archive') { set('arch', true); set('archived', true); }
        else if (req.action === 'move') { set('date', req.date); set('hideUntil', null); }
        data.log = data.log || [];
        const primary = {move: 'date', comment: 'comment', keep: 'reviewedAt', done: 'done', archive: 'arch'}[req.action];
        data.log.push({ts, src: 'codex-due-tasks', k: req.action, id: task.id, operationId,
          from: changes[primary].from, to: changes[primary].to, changes});
        data.rev = latest.rev + 1;
        if (!Number.isFinite(data.rev) || data.rev === latest.rev) throw error('invalid_data', 'Некорректная ревизия');
        try {
          if (!storage || typeof storage.setItem !== 'function') throw new Error('Нет хранилища');
          storage.setItem(BACKUP_KEY, JSON.stringify(latest));
        } catch (cause) { throw error('backup_failed', 'Резервная копия не сохранена: ' + cause.message); }
        let response;
        try {
          response = await timedFetch({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
        } catch (_) {
          try { return await verify(expected); }
          catch (_) { throw error('uncertain', 'Ответ потерян; сохранение не подтверждено. Обновите данные перед следующим действием.'); }
        }
        if (response.status === 409) {
          if (attempt === 2) throw error('conflict', 'Три конфликта ревизии; обновите страницу');
          continue;
        }
        // Even an error response may follow a committed write. Do not blindly repeat POST.
        try { return await verify(expected); }
        catch (_) { throw error('uncertain', 'Сохранение не подтверждено после POST (HTTP ' + response.status + '). Обновите данные.'); }
      }
    }
    return {read, mutate};
  }
  return {create, BACKUP_KEY, canonicalComment, exactDate};
});
