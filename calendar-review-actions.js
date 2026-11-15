const NOTE_TASK_LINKS={"машиноместо и план по кредиту за него": ["1783696460956", "1790707173716", "1793375822499", "1794254862095"], "финансы этот год": ["1794755652558"], "финансы след год": ["1794755652558"], "ревизия подписок": ["1794755652558"], "ревизия коммуналки дел и вещей на меня": ["1790963599381"], "все счета закрыть до конца года (отпуск)": ["1788719500907", "1789225393489"], "ревизия крпт": ["1790018657919", "1792176233091", "1792578411539", "1792579292133", "1793375757842"], "аспирантура": ["1786980547681", "1788171367369", "1790108144183"], "план аспы и задачи + оплата": ["1790108144183"], "след год java + english докачать": ["1790107645359", "1792176233100"], "суперкомп": ["1791997702279", "1794254862096"], "ai land - группа": ["1790706035950"], "допилить прилу": ["c1793379960649"], "контент ферма": ["1793375838644"], "задача - подарок борису": ["1791028877306"], "авито - вещи допродать": ["1790108144193", "1793375735179"], "ревизия вещей доделатьь": ["1790961609213", "1792321663329"], "ревизия вещей на зиму": ["1792321663329"], "аналист дейс финальная преза": ["1792054518849", "1792054600560", "1792054600561", "1792174954727", "1794252223874"], "аналист презу скинуть": ["1794603746919"], "дозакрыть задачи до конца года": ["1792176233100"]};
let busy=false;
function moscowDate(){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return ['year','month','day'].map(k=>p.find(x=>x.type===k).value).join('-');}

function cleanDescription(value){
 let s=String(value||'').trim();
 // Strip only leading move annotations, balancing parentheses in their provenance.
 while(s.startsWith('⏭')){
  const open=s.indexOf('('),newline=s.indexOf('\n');
  if(open<0||(newline>=0&&newline<open))break;
  let depth=0,end=-1;
  for(let i=open;i<s.length;i++){if(s[i]==='(')depth++;else if(s[i]===')'&&--depth===0){end=i+1;break;}}
  if(end<0)break;
  s=s.slice(end).replace(/^[.\s]+/,'');
 }
 // Remove leading merge bookkeeping, keeping the actual merged task description.
 s=s.replace(/^🔗\s*слито[^:]*:\s*/i,'');
 return s.trim()||String(value||'');
}

function appendDescription(el,text){
 const original=String(text||'Без описания'),clean=cleanDescription(original);
 const body=document.createElement('div');body.className='body';body.textContent=clean;el.append(body);
 if(clean!==original){const more=document.createElement('details'),title=document.createElement('summary'),full=document.createElement('div');title.textContent='Исходный текст и история';full.className='body';full.textContent=original;more.append(title,full);el.append(more);}
}

function normalizeNote(s){return String(s||'').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();}

let notesByTask=new Map(), tasksByNote=new Map();
function rebuildNoteIndex(tasks){
 const keyed=new Map(), exact=new Map(), explicit=new Map();
 notesByTask=new Map();tasksByNote=new Map();
 for(const note of notes){
  keyed.set(noteKey(note),note);
  const norm=normalizeNote(note.text);if(!exact.has(norm))exact.set(norm,[]);exact.get(norm).push(note);
  for(const id of NOTE_TASK_LINKS[note.text]||[]){if(!explicit.has(String(id)))explicit.set(String(id),[]);explicit.get(String(id)).push(note);}
 }
 for(const task of tasks){
  if(task.done||task.arch||task.archived)continue;
  const found=new Set(explicit.get(String(task.id))||[]);
  const source=keyed.get(task.savedNoteKey);if(source)found.add(source);
  for(const note of exact.get(normalizeNote(task.txt))||[])found.add(note);
  const matches=[...found];notesByTask.set(String(task.id),matches);
  for(const note of matches){const key=noteKey(note);if(!tasksByNote.has(key))tasksByNote.set(key,[]);tasksByNote.get(key).push(task);}
 }
}
function relatedNotes(task){return notesByTask.get(String(task.id))||[];}
function markNoteOrigin(el,task){const matches=relatedNotes(task);if(!matches.length&&!task.savedNoteKey)return;el.classList.add(task.savedNoteKey?'from-note':'in-notes');const p=document.createElement('div');p.className='origin';p.textContent=task.savedNoteKey?'🟣 Создано из заметок':'🟠 Есть связанный пункт в заметках';el.append(p);for(const note of matches){const a=document.createElement('a');a.href='#saved-notes';a.textContent='«'+note.text+'»';a.style.display='block';el.append(a);}}

function reviewDay(){return today;}
function noteKey(item){return 'saved-20261113:'+item.group+':'+item.text;}

function targetDate(kind,base=moscowDate()){const d=new Date(base+'T12:00:00Z');if(kind==='jan')return (d.getUTCFullYear()+1)+'-01-01';d.setUTCDate(d.getUTCDate()+Number(kind));return d.toISOString().slice(0,10);}

function appendInsight(el,t){
 const info=REVIEW_INSIGHTS[String(t.id)];const block=document.createElement('div');block.className='note';block.style.marginTop='12px';
 const label=document.createElement('strong');label.textContent=info?.label||'Нужен статус';
 const text=document.createElement('p');text.textContent=info?.text||'В подробный разбор текущих 140 карточек эта задача не входила. Подтверждения выполнения нет; оцени её отдельно.';
 block.append(label,text);
 if(info?.source){const source=document.createElement('small');source.textContent=info.source;block.append(source);}
 if(info?.proposal){const d=document.createElement('details'),sum=document.createElement('summary'),p=document.createElement('p');sum.textContent='Предлагаемый новый текст';p.textContent=info.proposal;d.append(sum,p);block.append(d);}
 el.append(block);
}

function addActions(el,task){
 const label=document.createElement('label');label.textContent='Комментарий / дополнительная информация';label.className='meta';label.style.display='block';label.style.marginTop='12px';
 const input=document.createElement('textarea');input.rows=2;input.placeholder='Дополнительная информация';input.value=task.comment||'';input.style.cssText='width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit';label.append(input);el.append(label);
 const bar=document.createElement('div');bar.className='bar';const status=document.createElement('div');status.className='meta';status.setAttribute('role','status');
 for(const [title,action] of [['Оставить','keep'],['Сохранить комментарий','comment'],['Сделано','done'],[task.note||task.savedNoteKey?'Убрать из разбора':'Неактуально','archive'],['+1 день','1'],['+2 дня','2'],['+7 дней','7'],['+30 дней','30'],['1 января '+(Number(reviewDay().slice(0,4))+1),'jan'],...(REVIEW_INSIGHTS[String(task.id)]?.proposal?[['Принять обновление текста','update']]:[])]){
  const button=document.createElement('button');button.type='button';button.textContent=title;
  button.onclick=async()=>{if(busy){status.textContent='Дождитесь сохранения предыдущей задачи';return;}busy=true;bar.querySelectorAll('button').forEach(b=>b.disabled=true);status.textContent='Сохраняется…';try{await mutateTask(task,action,input.value);await refresh();}catch(e){status.textContent='Не сохранено: '+e.message;}finally{busy=false;bar.querySelectorAll('button').forEach(b=>b.disabled=false);}};bar.append(button);
 }
 el.append(bar,status);
}

async function readTasks(){const r=await fetch('/api/tasks',{cache:'no-store'});if(!r.ok)throw Error('GET '+r.status);const d=await r.json();if(!Array.isArray(d.tasks)||!Number.isFinite(d.rev))throw Error('Некорректные данные трекера');return d;}

async function mutateTask(original,action,comment){
 const date=['keep','comment','done','archive','update'].includes(action)?null:targetDate(action);
 for(let attempt=0;attempt<3;attempt++){
  const data=await readTasks();let task=original.note?data.tasks.find(t=>t.savedNoteKey===noteKey(original.note)):data.tasks.find(t=>String(t.id)===String(original.id));
  const ts=new Date().toISOString();data.log=data.log||[];
  try{localStorage.setItem('task-review-backup',JSON.stringify(data));}catch(e){throw Error('Не удалось сохранить резервную копию в браузере: '+e.message);}
  if(task&&task.done&&!original.done)throw Error('Задача уже закрыта в другой вкладке; обнови страницу');
  if(task&&((task.comment||'')!==(original.comment||'')&&comment!==(original.comment||'')))throw Error('Комментарий изменился в другой вкладке; обнови страницу');
  if(task&&(action==='update')&&task.txt!==original.txt)throw Error('Текст изменился в другой вкладке; обнови страницу');
  if(!task){if(!original.note)throw Error('Задача удалена или изменена в другой вкладке');task={id:'review-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),txt:original.txt,date:null,done:false,fin:false,savedNoteKey:noteKey(original.note)};data.tasks.push(task);data.log.push({ts,k:'add',id:task.id,txt:task.txt,src:'task-review'});}
  if(comment!==(original.comment||'')&&(task.comment||'')!==comment){data.log.push({ts,k:'edit',id:task.id,field:'comment',from:task.comment||'',to:comment,src:'task-review'});task.comment=comment;}
  if(action==='keep'){task.reviewedAt=ts;data.log.push({ts,k:'review',id:task.id,decision:'keep',src:'codex-review'});}
  else if(action==='update'){const proposal=REVIEW_INSIGHTS[String(task.id)]?.proposal;if(!proposal)throw Error('Нет предложенного текста');const before=task.txt;task.txt=proposal;data.log.push({ts,k:'edit',id:task.id,field:'txt',from:before,to:proposal,src:'codex-review'});}
  else if(action==='done'){task.done=true;data.log.push({ts,k:'done',id:task.id,txt:task.txt,src:'task-review'});}
  else if(action==='archive'){task.arch=true;task.archived=true;data.log.push({ts,k:'archive',id:task.id,txt:task.txt,reason:'Неактуально',src:'task-review'});}
  else if(date){const old=task.date;task.date=date;task.hideUntil=null;data.log.push({ts,k:'move',id:task.id,from:old,to:date,txt:task.txt,src:'task-review'});}
  data.rev+=1;const r=await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(r.status===409)continue;if(!r.ok)throw Error('POST '+r.status);const result=await r.json();if(!result.ok)throw Error('Сервер не подтвердил сохранение');
  const saved=(await readTasks()).tasks.find(t=>String(t.id)===String(task.id));
  if(!saved||(comment!==(original.comment||'')&&(saved.comment||'')!==comment)||(action==='update'&&saved.txt!==REVIEW_INSIGHTS[String(task.id)].proposal)||(action==='keep'&&saved.reviewedAt!==ts)||(date&&saved.date!==date)||(action==='done'&&!saved.done)||(action==='archive'&&!saved.arch))throw Error('Не удалось подтвердить сохранение; обновите список перед повтором');
  return;
 }
 throw Error('Данные параллельно меняются. Повторите сохранение');
}
