/* Today/overdue view. Data changes happen only after a user presses an action. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const store = DueTasksStore.create();
  let all = [], mode = 'all', onlyFinancial = false, busy = false, loaded = false;
  const drafts = new Map();
  const descriptions = new Set();
  const cards = new Map();
  const commentOf = t => String(t.comment ?? t.cmt ?? '');
  function moscowDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    return ['year','month','day'].map(k => parts.find(x => x.type === k).value).join('-');
  }
  function exactDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T12:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === s;
  }
  function addDays(days, base = moscowDate()) {
    const d = new Date(base + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0,10);
  }
  const human = iso => iso.split('-').reverse().join('.');
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function cleanTitle(value) {
    let s = String(value || '').trim();
    while (s.startsWith('⏭')) {
      const start = s.indexOf('('); if (start < 0) break;
      let depth = 0, end = -1;
      for (let i = start; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && --depth === 0) {end = i + 1; break;}
      }
      if (end < 0) break;
      s = s.slice(end).replace(/^[.\s]+/,'');
    }
    const first = s.split('\n')[0].trim() || 'Задача без названия';
    return first.length > 145 ? first.slice(0,142) + '…' : first;
  }
  function announce(text, error = false) {
    $('notice').textContent = text; $('notice').className = 'notice' + (error ? ' error' : ''); $('notice').hidden = false;
  }
  function setBusy(value) {
    busy = value;
    document.querySelectorAll('.task button,.task input,.task textarea,#refresh').forEach(x => x.disabled = value || !loaded);
    $('connection').textContent = value ? 'Сохраняется…' : loaded ? 'Подключено к трекеру' : 'Нет подключения';
  }
  function actionButton(label, action, task, article, extra = {}) {
    const button = el('button', 'action-button' + (action === 'done' ? ' done-button' : action === 'archive' ? ' archive-button' : ''), label);
    button.type = 'button'; button.dataset.action = action;
    if (extra.days !== undefined) button.dataset.days = extra.days;
    if (extra.kind) button.dataset.kind = extra.kind;
    button.addEventListener('click', () => act(task, article, action, extra));
    return button;
  }
  function card(task, number, group) {
    const id = String(task.id), article = el('article','task');
    article.dataset.id = id; article.dataset.group = group; article.dataset.fin = task.fin ? '1' : '0';
    const top = el('div','task-top'), tags = el('div','tags');
    top.append(el('span','number',String(number).padStart(2,'0')));
    tags.append(el('span','tag ' + group,group === 'today' ? 'Сегодня' : human(task.date)));
    if (task.fin) tags.append(el('span','tag finance','Финансы'));
    if (task.hideUntil && task.hideUntil > moscowDate()) tags.append(el('span','tag','Скрыта до ' + human(task.hideUntil)));
    top.append(tags); article.append(top,el('h3','',cleanTitle(task.txt)));
    const detail = el('details'), summary = el('summary','','Полный текст задачи');
    summary.append(el('span','','↗')); detail.append(summary,el('div','task-body',task.txt || ''));
    const previousComments = [...new Set([task.comment,task.cmt,...(Array.isArray(task.cmts) ? task.cmts.map(x => x?.text) : [])].filter(Boolean).map(String))];
    for (const text of previousComments) {const c = el('div','comment');c.append(el('b','','Сохранённый комментарий'),el('p','',text));detail.append(c);}
    detail.open = descriptions.has(id);
    detail.addEventListener('toggle', () => {if (detail.open) descriptions.add(id); else descriptions.delete(id);});
    article.append(detail);
    const primary = el('div','task-actions');
    primary.append(actionButton('✓ Сделано','done',task,article),actionButton('Оставить','keep',task,article),actionButton('Неактуально','archive',task,article));
    const moves = el('div','task-actions moves');
    for (const days of [1,2,7,30]) moves.append(actionButton('+' + days + (days === 1 ? ' день' : days === 2 ? ' дня' : ' дней'),'move',task,article,{days}));
    moves.append(actionButton('🎲 30–60 дней','move',task,article,{kind:'random'}),actionButton('1 января ' + (Number(moscowDate().slice(0,4))+1),'move',task,article,{kind:'january'}));
    const pick = el('div','date-actions'), dateInput = el('input','date-input');
    dateInput.type = 'date';dateInput.setAttribute('aria-label','Дата переноса задачи');
    pick.append(dateInput,actionButton('На дату','move',task,article,{kind:'picked'}));
    const label = el('label','comment-label','Комментарий / дополнительная информация');
    const textarea = el('textarea','comment-input');textarea.rows=2;textarea.placeholder='Сохранится вместе с выбранным действием';
    textarea.value = drafts.get(id)?.value ?? commentOf(task);
    textarea.addEventListener('input', () => {
      const existing = drafts.get(id);
      drafts.set(id,{value:textarea.value, original:existing?.original || structuredClone(task)});
      article.querySelector('.task-status').textContent = 'Комментарий ещё не сохранён';
    });
    label.append(textarea);
    const commentActions = el('div','task-actions');commentActions.append(actionButton('Сохранить комментарий','comment',task,article));
    const reset = el('button','action-button','Сбросить черновик');reset.type='button';
    reset.addEventListener('click',()=>{drafts.delete(id);textarea.value=commentOf(task);article.querySelector('.task-status').textContent='Показан сохранённый комментарий';});
    commentActions.append(reset);
    const status = el('div','task-status',drafts.has(id) ? 'Комментарий ещё не сохранён' : '');status.setAttribute('role','status');
    article.append(primary,moves,pick,label,commentActions,status);
    cards.set(id,{article,task});return article;
  }
  function render() {
    const day = moscowDate();
    const current = all.filter(t => !t.done && !t.arch && !t.archived && exactDate(t.date) && t.date <= day);
    const today = current.filter(t => t.date === day), overdue = current.filter(t => t.date < day).sort((a,b) => a.date.localeCompare(b.date));
    $('heading').textContent = new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long',timeZone:'Europe/Moscow'}).format(new Date(day+'T12:00:00Z'));
    $('subtitle').textContent = 'Задачи на сегодня и просроченные · ' + day.slice(0,4) + ' · Москва';
    $('today-stat').textContent = today.length;$('overdue-stat').textContent = overdue.length;$('finance-stat').textContent = current.filter(t => t.fin).length;
    for (const [k,n] of [['all',current.length],['today',today.length],['overdue',overdue.length]]) $('tab-'+k).textContent=({all:'Все',today:'Сегодня',overdue:'Просрочено'}[k])+' · '+n;
    cards.clear();let number=0;
    for (const [group,tasks] of [['today',today],['overdue',overdue]]) {
      const list=$(group+'-list');list.replaceChildren();
      for (const t of tasks) list.append(card(t,++number,group));
      if (!tasks.length) {
        const empty=el('div','zero');empty.append(el('span','zero-icon','✓'));
        const text=el('div');text.append(el('h3','',group==='overdue'?'Просроченных задач нет':'На сегодня открытых задач нет'),el('p','',group==='overdue'?'По текущим датам карточек в трекере.':'Запланированные на сегодня задачи здесь появятся после обновления.'));empty.append(text);list.append(empty);
      }
    }
    filter();setBusy(busy);
  }
  function filter() {
    const query=$('search').value.trim().toLocaleLowerCase('ru');let count=0;
    for (const {article,task} of cards.values()) {
      const text=[task.txt,task.comment,task.cmt,...(task.cmts||[]).map(c=>c?.text)].filter(Boolean).join('\n').toLocaleLowerCase('ru');
      const show=(mode==='all'||article.dataset.group===mode)&&(!onlyFinancial||!!task.fin)&&text.includes(query);
      article.hidden=!show;if(show)count++;
    }
    for (const section of document.querySelectorAll('.section')) {
      const shown=section.querySelectorAll('.task:not([hidden])').length;
      const empty=!!section.querySelector('.zero')&&!query&&!onlyFinancial;
      section.hidden=!(mode==='all'||section.dataset.section===mode)||(!shown&&!empty);
      section.querySelector('.section-count').textContent=shown;
    }
    $('count').textContent=`Показано ${count} из ${cards.size}`;
    $('empty').hidden=count>0||!!document.querySelector('.section:not([hidden]) .zero');
  }
  async function refresh() {
    if(busy)return;
    $('refresh').disabled=true;
    try {const data=await store.read();all=data.tasks;loaded=true;render();$('updated').textContent='Обновлено '+new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(new Date())+' МСК';}
    catch(error){loaded=false;setBusy(false);announce('Не удалось загрузить трекер: '+error.message,true);}
    finally{$('refresh').disabled=false;}
  }
  async function act(task, article, action, extra) {
    if(busy||!loaded)return;
    const id=String(task.id), draft=drafts.get(id), original=draft?.original||task;
    const request={action,comment:draft?.value??commentOf(task)};
    if(action==='move') {
      request.date=extra.kind==='picked'?article.querySelector('.date-input').value:extra.kind==='january'?(Number(moscowDate().slice(0,4))+1)+'-01-01':addDays(extra.kind==='random'?30+Math.floor(Math.random()*31):extra.days);
      if(!exactDate(request.date)){article.querySelector('.task-status').textContent='Выберите корректную дату переноса';return;}
    }
    const short=cleanTitle(task.txt);setBusy(true);article.querySelector('.task-status').textContent='Сохраняется…';
    try {
      const result=await store.mutate(original,request);
      drafts.delete(id);all=result.data.tasks;loaded=true;render();
      const outcome={done:'Отмечено выполненным',archive:'Убрано в архив',keep:'Оставлено на текущей дате',comment:'Комментарий сохранён',move:'Перенесено на '+(request.date?human(request.date):'')};
      announce(outcome[action]+': '+short+'. Изменение подтверждено трекером.');
      $('updated').textContent='Сохранение проверено в '+new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(new Date())+' МСК';
    } catch(error) {
      if(error.code==='uncertain') loaded=false;
      article.querySelector('.task-status').textContent=error.message;
      announce(error.message,true);
    } finally {setBusy(false);}
  }
  $('search').addEventListener('input',filter);
  for(const b of document.querySelectorAll('.tab')) b.addEventListener('click',()=>{mode=b.dataset.mode;document.querySelectorAll('.tab').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));filter();});
  $('financial').addEventListener('click',function(){onlyFinancial=!onlyFinancial;this.setAttribute('aria-pressed',String(onlyFinancial));filter();});
  $('expand').addEventListener('click',function(){const all=[...document.querySelectorAll('.task:not([hidden]) details')];const open=all.some(x=>!x.open);all.forEach(x=>x.open=open);this.textContent=open?'Свернуть все описания':'Раскрыть все описания';});
  $('refresh').addEventListener('click',refresh);
  $('print').addEventListener('click',()=>window.print());
  let beforePrint;
  window.addEventListener('beforeprint',()=>{beforePrint=[...document.querySelectorAll('details')].map(x=>[x,x.open]);beforePrint.forEach(([x])=>x.open=true);});
  window.addEventListener('afterprint',()=>{(beforePrint||[]).forEach(([x,open])=>x.open=open);});
  window.addEventListener('beforeunload',event=>{if(busy||drafts.size){event.preventDefault();event.returnValue='';}});
  refresh();
})();
