// Сценарии покупки недвижимости поверх основного плана.
// Базовый денежный поток берём из engine.js (тот же, что считает /plan.html),
// сверху накладываем покупки: первый взнос, ипотечный платёж, аренду, налоги.
// Здесь только расчёт и отрисовка; данные страница загружает сама из /api/plan.

const SC = {};

SC.F = n => Math.round(n || 0).toLocaleString('ru-RU');
SC.MONTH_RU = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

// аннуитетный платёж
SC.annuity = (sum, ratePct, years) => {
  const i = ratePct / 100 / 12, n = years * 12;
  if (i <= 0) return sum / n;
  return sum * i / (1 - Math.pow(1 + i, -n));
};

// Остаток долга и уплаченные проценты через m месяцев
SC.mortgageState = (sum, ratePct, years, m) => {
  const i = ratePct / 100 / 12, pay = SC.annuity(sum, ratePct, years);
  let debt = sum, interest = 0;
  for (let k = 0; k < m; k++) {
    const int = debt * i;
    interest += int;
    debt = Math.max(0, debt - (pay - int));
  }
  return { debt, interest, pay };
};

// Помесячная сетка горизонта плана: [{key:'2026-10', label:'октябрь 2026', cols:[i,i]}]
SC.months = () => {
  const out = [];
  COLS.forEach((c, i) => {
    const p = c.split('.');
    if (!/^\d+$/.test(p[0])) return;
    const year = p[2] ? 2000 + (+p[2]) : 2026;
    const key = year + '-' + p[1];
    const last = out[out.length - 1];
    if (last && last.key === key) last.cols.push(i);
    else out.push({ key, year, m: +p[1], label: SC.MONTH_RU[+p[1] - 1] + ' ' + year, cols: [i] });
  });
  return out;
};

// Базовый поток: доходы, расходы и остаток по месяцам (без сценария)
SC.base = () => {
  const bal = runBalance(), ms = SC.months();
  const HR = new Set(data.hidden || []);
  return ms.map(mo => {
    let inc = 0, exp = 0;
    for (let ri = 0; ri < data.rows.length; ri++) {
      if (HR.has(ri)) continue;
      const v = mo.cols.reduce((a, i) => a + (data.rows[ri][i] || 0), 0);
      if (!v) continue;
      if (TYPE(ri) === 'inc') inc += v; else exp += v;
    }
    const mi = MONTHS.findIndex(x => x.cols[0] === mo.cols[0]);
    return { ...mo, inc, exp, pct: mi < 0 ? 0 : (bal.pct[mi] || 0), endRub: bal.dif[mo.cols[mo.cols.length - 1]] };
  });
};

// Один объект покупки
// {name, price, downPct, ratePct, years, buyKey:'2026-11', rentGross, rentTaxPct, upkeep, renovation,
//  payoffKey:'2027-12' — месяц досрочного ПОЛНОГО гашения ипотеки}
//
// Досрочное гашение: в месяце payoffKey разово списывается весь остаток долга, после чего
// ежемесячный аннуитет и обе ипотечные страховки прекращаются. Коммуналка и аренда остаются:
// объект никуда не делся, ушёл только кредит.
SC.applyPurchase = (rows, obj) => {
  const idx = rows.findIndex(r => r.key === obj.buyKey);
  if (idx < 0) return { pay: 0, down: 0, loan: 0, idx: -1 };
  const down = Math.round(obj.price * obj.downPct / 100);
  const loan = obj.price - down;
  const pay = loan > 0 ? SC.annuity(loan, obj.ratePct, obj.years) : 0;
  // месяц гашения; платежи идут с idx по poIdx включительно, остаток гасим в poIdx
  const poIdx = obj.payoffKey ? rows.findIndex(r => r.key === obj.payoffKey) : -1;
  const paid = poIdx >= idx ? poIdx - idx + 1 : 0;
  const payoff = (poIdx >= idx && loan > 0)
    ? Math.round(SC.mortgageState(loan, obj.ratePct, obj.years, paid).debt) : 0;
  rows.forEach((r, i) => {
    r.sc = r.sc || { out: 0, in: 0, notes: [] };
    if (i === idx) {
      r.sc.out += down + (obj.renovation || 0);
      r.sc.notes.push(`${obj.name}: взнос ${SC.F(down)}` + (obj.renovation ? ` + ремонт ${SC.F(obj.renovation)}` : ''));
    }
    if (i >= idx) {
      const underLoan = poIdx < 0 || i <= poIdx;   // кредит ещё жив
      if (pay && underLoan) r.sc.out += pay;
      if (obj.upkeep) r.sc.out += obj.upkeep;
      // страховки: жизнь считается от остатка долга, имущество от стоимости объекта;
      // обе требует банк, после гашения кредита обе снимаются
      if (obj.insuranceYear && underLoan) r.sc.out += obj.insuranceYear / 12;
      if (obj.lifePct && underLoan) r.sc.out += loan * obj.lifePct / 100 / 12;
      if (obj.propPct && underLoan) r.sc.out += obj.price * obj.propPct / 100 / 12;
      if (i === poIdx && payoff) {
        r.sc.out += payoff;
        r.sc.notes.push(`${obj.name}: досрочное ПОЛНОЕ гашение ипотеки ${SC.F(payoff)} ₽, дальше платежей нет`);
      }
      if (obj.rentGross && (i > idx || obj.rentNow)) {   // rentNow — сдаём с первого месяца
        const net = obj.rentGross * (1 - (obj.rentTaxPct || 0) / 100);
        r.sc.in += net;
      }
    }
  });
  return { pay, down, loan, idx, poIdx, payoff, paidMonths: paid };
};

// Сколько процентов экономит досрочное гашение против жизни по графику до конца срока
SC.payoffSaving = (obj, res) => {
  if (!res.loan || !res.payoff) return 0;
  const full = SC.mortgageState(res.loan, obj.ratePct, obj.years, obj.years * 12).interest;
  const till = SC.mortgageState(res.loan, obj.ratePct, obj.years, res.paidMonths).interest;
  return Math.round(full - till);
};

// Банковские кредиты и ипотека вне сценария: ищем в основном плане живые строки-расходы.
// Ипотека ДОМ.РФ погашена 29.07.2026, потребы и кредитки Райфа закрыты 27–28.07.2026,
// поэтому в норме здесь ноль. Если в плане снова появится кредитная строка, она сюда попадёт.
SC.LOAN_RE = /ипотек|кредит|заём|займ|долг родител/i;
SC.otherLoans = () => {
  const HR = new Set(data.hidden || []);
  const out = [];
  for (let ri = 0; ri < data.rows.length; ri++) {
    if (HR.has(ri) || TYPE(ri) !== 'exp') continue;
    if (!SC.LOAN_RE.test(LBL(ri))) continue;
    const s = data.rows[ri].reduce((a, v) => a + (v || 0), 0);
    if (s) out.push({ ri, sum: s, label: LBL(ri) });
  }
  return { list: out, sum: out.reduce((a, x) => a + x.sum, 0) };
};

// Пересчёт остатка с учётом сценария: идём по месяцам и копим
SC.project = (rows, startRub) => {
  let bal = startRub;
  return rows.map(r => {
    const sc = r.sc || { out: 0, in: 0, notes: [] };
    const delta = r.inc - r.exp + r.pct + sc.in - sc.out;
    bal += delta;
    return { ...r, scOut: sc.out, scIn: sc.in, notes: sc.notes, delta, bal };
  });
};

SC.table = (proj) => {
  let h = '<thead><tr><th>Месяц</th><th>Доходы</th><th>Расходы</th><th>%</th>'
        + '<th>Покупка</th><th>Аренда</th><th>Итог месяца</th><th>Остаток</th></tr></thead><tbody>';
  proj.forEach(r => {
    const neg = r.bal < 0;
    h += `<tr class="${neg ? 'bad-row' : ''}">`
      + `<td title="${r.notes.join(' · ')}">${r.label}${r.notes.length ? ' <b>•</b>' : ''}</td>`
      + `<td class="good">${SC.F(r.inc)}</td><td class="bad">${SC.F(r.exp)}</td><td>${SC.F(r.pct)}</td>`
      + `<td class="${r.scOut ? 'bad' : 'z'}">${r.scOut ? '−' + SC.F(r.scOut) : '·'}</td>`
      + `<td class="${r.scIn ? 'good' : 'z'}">${r.scIn ? '+' + SC.F(r.scIn) : '·'}</td>`
      + `<td class="${r.delta < 0 ? 'bad' : 'good'}">${SC.F(r.delta)}</td>`
      + `<td><b>${SC.F(r.bal)}</b></td></tr>`;
  });
  return h + '</tbody>';
};

SC.kpi = (t, v, s, cls) =>
  `<div class="kpi"><span>${t}</span><b class="${cls || ''}">${v}</b>${s ? `<span>${s}</span>` : ''}</div>`;

// Итоги по объекту на длинном горизонте (за пределами таблицы плана)
SC.longRun = (obj, res) => {
  if (!res.loan) return `${obj.name}: покупка за наличные, ипотеки нет.`;
  const st = SC.mortgageState(res.loan, obj.ratePct, obj.years, obj.years * 12);
  const rentYear = (obj.rentGross || 0) * 12 * (1 - (obj.rentTaxPct || 0) / 100);
  const yieldNet = obj.price ? rentYear / obj.price * 100 : 0;
  return `<b>${obj.name}</b>: кредит ${SC.F(res.loan)} под ${obj.ratePct}% на ${obj.years} лет, `
    + `платёж <b>${SC.F(res.pay)} ₽/мес</b>, переплата за весь срок ${SC.F(st.interest)} ₽`
    + (obj.rentGross ? `. Аренда ${SC.F(obj.rentGross)} ₽/мес, после налога ${SC.F(rentYear / 12)} ₽/мес, `
      + `чистая доходность к цене <b>${yieldNet.toFixed(1)}%</b> годовых, `
      + `платёж перекрывается арендой на ${Math.round(rentYear / 12 / res.pay * 100)}%` : '');
};

// Активы (крипта, биржи, акции, остаток ТБанк) в плане стоят в последней колонке.
// Для покупки их надо продать заранее — эта функция переносит их в нужный месяц.
SC.ASSET_RE=/крипт|bybit|bingx|полюс|plzl|тбанк/i;
SC.assetSum=(rows)=>{
  const last=rows[rows.length-1];
  if(!last) return 0;
  const HR=new Set(data.hidden||[]);
  let s=0;
  for(let ri=0;ri<data.rows.length;ri++){
    if(HR.has(ri)||TYPE(ri)!=='inc') continue;
    if(!SC.ASSET_RE.test(LBL(ri))) continue;
    s+=last.cols.reduce((a,i)=>a+(data.rows[ri][i]||0),0);
  }
  return s;
};
SC.moveAssets=(rows,toKey)=>{
  const sum=SC.assetSum(rows);
  if(!sum) return 0;
  const to=rows.findIndex(r=>r.key===toKey);
  const last=rows.length-1;
  if(to<0||to===last) return 0;
  rows[last].inc-=sum;                       // из конца горизонта убираем
  rows[to].sc=rows[to].sc||{out:0,in:0,notes:[]};
  rows[to].sc.in+=sum;                       // и кладём в месяц покупки
  rows[to].sc.notes.push('продажа крипты, биржевых остатков и акций: '+SC.F(sum));
  return sum;
};

// Перепродажа: купил → через holdM месяцев продал → гасит остаток кредита, платит НДФЛ.
// НДФЛ с продажи имущества считается по своей шкале: 13% с первых 2,4 млн дохода, дальше 15%.
// База — цена продажи минус документально подтверждённые расходы на покупку.
SC.propertyTax=(gain)=>{
  if(gain<=0) return 0;
  return gain<=2400000 ? gain*0.13 : 2400000*0.13+(gain-2400000)*0.15;
};
SC.applyFlip=(rows,obj)=>{
  const idx=rows.findIndex(r=>r.key===obj.buyKey);
  if(idx<0) return {pay:0,down:0,loan:0,idx:-1,net:0,tax:0};
  const down=Math.round(obj.price*obj.downPct/100), loan=obj.price-down;
  const pay=loan>0?SC.annuity(loan,obj.ratePct,obj.years):0;
  const sellIdx=idx+(obj.holdM||0);
  const st=SC.mortgageState(loan,obj.ratePct,obj.years,obj.holdM||0);
  const gain=(obj.sellPrice||0)-obj.price;
  const tax=SC.propertyTax(gain);
  const fee=(obj.sellPrice||0)*((obj.agentPct||0)/100);
  const net=(obj.sellPrice||0)-st.debt-tax-fee;
  rows.forEach((r,i)=>{
    r.sc=r.sc||{out:0,in:0,notes:[]};
    if(i===idx){
      r.sc.out+=down+(obj.renovation||0);
      r.sc.notes.push(`${obj.name}: взнос ${SC.F(down)}`+(obj.renovation?` + ремонт ${SC.F(obj.renovation)}`:''));
    }
    if(i>=idx && i<sellIdx){
      if(pay) r.sc.out+=pay;
      if(obj.upkeep) r.sc.out+=obj.upkeep;
      if(obj.lifePct) r.sc.out+=loan*obj.lifePct/100/12;
      if(obj.propPct) r.sc.out+=obj.price*obj.propPct/100/12;
    }
    if(i===sellIdx){
      r.sc.in+=net;
      r.sc.notes.push(`продажа за ${SC.F(obj.sellPrice)}: гашение долга ${SC.F(st.debt)}, НДФЛ ${SC.F(tax)}`
        +(fee?`, риелтор ${SC.F(fee)}`:'')+` → на руки ${SC.F(net)}`);
    }
  });
  return {pay,down,loan,idx,sellIdx,net,tax,debt:st.debt,interest:st.interest,fee,gain};
};
