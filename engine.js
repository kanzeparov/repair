// Расчётный движок плана. Общий для plan.html и dashboard.html — держать его в двух
// копиях нельзя: разойдутся правила распределения по дням, и страницы начнут показывать
// разные цифры по одним и тем же данным. Здесь только чистые вычисления, без DOM.
// Внешние глобалы: data (план), PLAN (дефолтные строки, может отсутствовать).
const COLS=['1.07','16.07','1.08','16.08','1.09','15.09','1.10','16.10','1.11','16.11','1.12','16.12','31.12','янв.27'];
const z=()=>Array(14).fill(0);
const MON_NAMES={'07':'Июль','08':'Август','09':'Сентябрь','10':'Октябрь','11':'Ноябрь','12':'Декабрь'};
const MON_DAYS ={'07':31,'08':31,'09':30,'10':31,'11':30,'12':31};
// Колонки — полумесяцы; группируем подряд идущие по номеру месяца в метке ('31.12' → декабрь).
// days[] — число месяца, с которого действует остаток колонки; len — длина месяца в днях.
const MONTHS=(()=>{
  const g=[];
  COLS.forEach((c,i)=>{
    const p=c.split('.');
    const numeric=/^\d+$/.test(p[0]);
    const key=numeric?p[1]:c;
    const day=numeric?+p[0]:1;
    const last=g[g.length-1];
    if(last&&last.key===key){ last.cols.push(i); last.days.push(day); }
    else g.push({key,name:MON_NAMES[key]||c,cols:[i],days:[day],len:MON_DAYS[key]||31});
  });
  // вес колонки = сколько дней держится её остаток (до следующей колонки или до конца месяца)
  g.forEach(m=>{ m.w=m.days.map((d,i)=> i<m.days.length-1 ? m.days[i+1]-d : m.len-d+1); });
  return g;
})();

const TYPE=ri=> (data.types && data.types[ri]) ||
  (ri<PLAN.length ? PLAN[ri][0] : (data.extraTypes[ri-PLAN.length]||'exp'));
const LBL=ri=> (data.labels&&data.labels[ri]) || (typeof PLAN!=='undefined'&&ri<PLAN.length?PLAN[ri][1]:'Статья');

const RATE=0.12;   // годовая ставка для строки «% на остаток»

let FX=null, CR=null, ST=null;   // курсы ЦБ, цены монет, цены акций MOEX                          // курсы ЦБ и цена токена
const uKey=(r,c)=>r+'_'+c;
// Курс ЦБ — база. Продаёшь валюту (доход) — получаешь на 5% меньше,
// покупаешь (расход) — платишь на 5% больше. SPREAD применяется ко всем валютам.
const SPREAD=0.05;
function cbrUsd(){ return (FX&&FX.cbr) || data.cbrUsd || 0; }
function cbrKzt(){ return (FX&&FX.kzt&&FX.kzt.cbr) || data.cbrKzt || 0; }
function cbrGbp(){ return (FX&&FX.gbp&&FX.gbp.cbr) || data.cbrGbp || 0; }
const side=isInc=> isInc ? (1-SPREAD) : (1+SPREAD);
function fxRate(isInc){  return cbrUsd()*side(isInc); }
function kztRate(isInc){ return cbrKzt()*side(isInc); }
function gbpRate(isInc){ return cbrGbp()*side(isInc); }
function ethUsd(){  return (CR&&CR.eth&&CR.eth.usd) || data.ethUsd || 0; }
function megaUsd(){ return (CR&&CR.mega&&CR.mega.usd) || data.megaUsd || 0; }

const PERIODS=[
 ['2026-07-01',15],['2026-07-16',16],['2026-08-01',15],['2026-08-16',16],
 ['2026-09-01',14],['2026-09-15',16],['2026-10-01',15],['2026-10-16',16],
 ['2026-11-01',15],['2026-11-16',15],['2026-12-01',15],['2026-12-16',15],
 ['2026-12-31',1], ['2027-01-01',31]];
const WD=['вс','пн','вт','ср','чт','пт','сб'];
const MN=['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
// Размазываем только по-настоящему ежедневное. Мелочь вроде «Бады 300 ₽ за период»
// делить на 18 ₽ в день бессмысленно — она ставится одной суммой в середину периода.
const EVEN=/Еда|Ресты|Такси|Продукт|Метро|транспорт/i;
const MID =/Бады|Одежда|Здоровье|Расходник|Маркетплейс|ДР|подарк|Качалка|Квартплат|ЖКХ/i;
const MIN_PER_DAY=300;             // меньше — не дробим

function daysFromLabel(lbl, dates){
  const s=String(lbl);
  const m=s.match(/(\d{1,2})(?:\s*и\s*(\d{1,2}))?\s*числа/i);
  if(m) return [ +m[1], ...(m[2]?[+m[2]]:[]) ];
  // «28.07», «30.07» прямо в названии — берём, если месяц совпал с периодом
  const go=[...s.matchAll(/(\d{1,2})-го/g)].map(x=>+x[1]);   // «аванс 15-го, расчёт 30-го»
  if(go.length) return go;
  const mon=(dates && dates.length) ? dates[0].getMonth()+1 : 0;
  const out=[];
  for(const x of s.matchAll(/(\d{1,2})\.(\d{2})(?!\d)/g)) if(+x[2]===mon) out.push(+x[1]);
  return out.length?out:null;
}
// Зарплата: если день выплаты выпал на выходной, деньги приходят в последний будний
// день до него. Только для зарплатных строк — компенсацию или крипту раньше срока
// никто не отдаст, их сдвигать назад нельзя.
const SALARY=/ЗП|зарплат|аванс|расч[её]т|отпускн|оклад|премия/i;
function prevBusiness(dates,i){
  let j=i;
  while(j>0 && (dates[j].getDay()===0 || dates[j].getDay()===6)) j--;
  return j;
}
function splitOverDays(ri, ci, dates){
  // возвращает массив сумм по дням периода
  const n=dates.length;
  const man=data.days && data.days[ri+'_'+ci];      // ручная разбивка по дням — она главнее
  if(Array.isArray(man) && man.length===n) return man.slice();
  const v=data.rows[ri][ci]||0, out=Array(n).fill(0);
  if(!v) return out;
  const lbl=LBL(ri);
  if(EVEN.test(lbl) && n>1 && Math.abs(v)/n>=MIN_PER_DAY){   // ровно по дням, остаток — в последний
    const per=Math.floor(v/n);
    for(let i=0;i<n;i++) out[i]= i===n-1 ? v-per*(n-1) : per;
    return out;
  }
  const dd=daysFromLabel(lbl, dates);
  if(dd){
    let hit=dd.map(x=>dates.findIndex(d=>d.getDate()===x)).filter(i=>i>=0);
    if(TYPE(ri)==='inc' && SALARY.test(lbl)) hit=hit.map(i=>prevBusiness(dates,i));  // выходной → пятница
    hit=[...new Set(hit)];
    if(hit.length){
      const per=Math.round(v/hit.length);
      hit.forEach((i,k)=> out[i]= k===hit.length-1 ? v-per*(hit.length-1) : per);
      return out;
    }
  }
  if(MID.test(lbl) && n>3){        // периодическая мелочь — двумя тратами за период
    const a=Math.floor(n*0.3), b=Math.floor(n*0.8);
    const half=Math.round(v/2);
    out[a]=half; out[b]=v-half;
    return out;
  }
  out[0]=v;                        // разовое — в первый день периода
  return out;
}

const dkey=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
function periodDates(ci){
  const p=PERIODS[ci]; if(!p) return [];
  const d0=new Date(p[0]+'T12:00:00'), out=[];
  for(let k=0;k<p[1];k++){ const x=new Date(d0); x.setDate(d0.getDate()+k); out.push(x); }
  return out;
}
function today0(){ const t=new Date(); t.setHours(0,0,0,0); return t; }
// Любая нерублёвая ячейка сводится к долларам по кросс-курсу ЦБ: тенге и фунты
// списываются с той же валютной карты и едят тот же остаток.
// Единицы, которые уже выражены в рублях (акции на Мосбирже). Такая ячейка не трогает
// долларовый пул — иначе продажа Полюса «пополняла» бы валюту, которой нет.
const RUB_UNITS={plzl:1};
function usdOf(q){
  if(q && RUB_UNITS[q.u]) return 0;
  if(!q) return 0;
  if(q.u==='usd')  return q.v;
  if(q.u==='mega') return q.v*megaUsd();
  if(q.u==='gbp')  return cbrUsd()? q.v*cbrGbp()/cbrUsd() : 0;
  if(q.u==='kzt')  return cbrUsd()? q.v*cbrKzt()/cbrUsd() : 0;
  return 0;
}
function startUsd(){ const p=data.startParts||{}; return (p.freedom||0)+(p.tbc||0)+(p.bybit||0); }
function dayFlows(){
  // Всё, что приходится на дни до сегодня, сворачивается в сегодня — так же, как в
  // дневной таблице. Иначе движок разносит суммы по уже прошедшим дням.
  const flow=new Map(), t=today0(), tkey=dkey(t);
  for(let ci=0;ci<COLS.length;ci++){
    const dates=periodDates(ci); if(!dates.length) continue;
    data.rows.forEach((row,ri)=>{
      if(!row[ci]) return;
      const isInc=TYPE(ri)==='inc';
      const q=data.units && data.units[ri+'_'+ci];
      const parts=splitOverDays(ri,ci,dates);
      const tot=parts.reduce((a,b)=>a+b,0) || 1;
      const usdTot=q?usdOf(q):0;
      parts.forEach((v,k)=>{
        if(!v) return;
        const d=new Date(dates[k]); d.setHours(0,0,0,0);
        const key = d<t ? tkey : dkey(dates[k]);
        const o=flow.get(key)||{i:0,e:0,ui:0,ue:0};
        if(q && !RUB_UNITS[q.u]){                // валютная ячейка — рубли не трогает
          const u=usdTot*v/tot;
          if(isInc) o.ui+=u; else o.ue+=u;
        } else {
          if(isInc) o.i+=v; else o.e+=v;
        }
        flow.set(key,o);
      });
    });
  }
  return flow;
}
// На вкладе работают только рубли в Райфе. Яндекс, наличные, кредитка ТКФ и валюта
// на Freedom/TBC/Bybit процентов не приносят — вычитаем их из базы начисления.
function nonRaifStart(){
  const p=data.startParts||{};
  return Math.max(0,(data.start||0)-(p.raif||0));
}
function runBalance(){
  // start — это деньги СЕГОДНЯ, а не на 1 июля. Поэтому проценты копим только с
  // сегодняшнего дня: за прошедшие дни начислять не на что, они уже прожиты.
  // Проценты капают на остаток каждого дня, но БАНК ПЛАТИТ ИХ В ПОСЛЕДНИЙ ДЕНЬ МЕСЯЦА.
  // До этой даты они не лежат на счёте и тратить их нельзя — поэтому в остаток они
  // попадают одним зачислением 31-го, а не растворяются по дням.
  const flow=dayFlows(), t=today0();
  const lastDay=x=>new Date(x.getFullYear(),x.getMonth()+1,0).getDate();
  let run=(data.startParts&&data.startParts.raif)||0;   // только рубли в Райфе
  let usd=startUsd(), bought=0;
  const dif=[], pct=[], avgs=[], usdDif=[], dip=[], credits=new Map(), series=[];
  let pend=0;                              // начислено с начала месяца, ещё не выплачено
  MONTHS.forEach(m=>{
    let acc=0, days=0, mAcc=0;             // Σ остатков по дням месяца, Σ начисленного
    m.cols.forEach(ci=>{
      let low=Infinity;
      periodDates(ci).forEach(x=>{
        const f=flow.get(dkey(x))||{i:0,e:0,ui:0,ue:0};
        run+=f.i-f.e;
        usd+=(f.ui||0)-(f.ue||0);
        if(usd<0){                         // валюты не хватило — докупаем по ЦБ+5%
          const need=-usd, cost=need*cbrUsd()*(1+SPREAD);
          run-=cost; bought+=cost; usd=0;
        }
        const d=new Date(x); d.setHours(0,0,0,0);
        if(d>=t){
          series.push({k:dkey(x), run:run, usd:usd, i:f.i, e:f.e, ci:ci});
          acc+=Math.max(0,run); days++; if(run<low) low=run;
          if(run>0 && m.key!=='янв.27'){ const p=run*RATE/365; pend+=p; mAcc+=p; }
        }
        if(x.getDate()===lastDay(x) && pend>0){   // выплата процентов за месяц
          run+=pend; credits.set(dkey(x),pend); pend=0;
        }
      });
      dif[ci]=run; usdDif[ci]=usd;
      dip[ci]=isFinite(low)?low:run;       // самый низкий день периода
    });
    avgs.push(days?acc/days:0);            // средний дневной остаток
    pct.push(mAcc);                        // начислено за месяц — придёт 5-го следующего
  });
  return {dif,pct,avgs,usdDif,bought,dip,credits,series};
}
