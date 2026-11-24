// ===== Логика портала «Сластёна»: вход, каталог, корзина, кабинет мастерской =====
// Строка заказа (line): {id, n (название), u (кг/шт), p (цена), q (количество)}.
// Цены в заказе — «снимок» на момент отправки, их ставит сервер.

// Состояние экрана
const st={view:'boot',cat:'Все',qs:'',cart:{},tab:'orders',city:'Все',sheet:false,sent:false,msg:'',err:'',day:'',aday:'',busy:false,regDone:false,email:''};
let me=null;      // профиль вошедшего (строка из shops)
let ORD={};       // заказы по дням: ORD['2026-11-25'] = { shop_id: [строки] }
let orders={};    // заказы открытого дня (ссылка на ORD[день])
let DAYS=[];      // ближайшие дни доставки, на которые ещё можно заказать

// ===== Вспомогательные функции =====
const isAdm=()=>!!(me&&me.is_admin&&me.status=='approved');
// Экранирование: всё, что пришло с сервера или от пользователя, вставляем в страницу только через esc()
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const vis=p=>(st.cat=='Все'||cat(p.n)==st.cat)&&p.n.toLowerCase().includes(st.qs.toLowerCase());
const fmt=n=>n.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽';
const q=n=>(+n).toLocaleString('ru-RU',{maximumFractionDigits:3});
// Деньги считаем в копейках, чтобы не копились ошибки округления
const lineSum=l=>Math.round(l.p*l.q*100)/100;
const sum=ls=>ls.reduce((s,l)=>s+Math.round(l.p*l.q*100),0)/100;
const dk=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const dl=d=>d.toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'});
const ds=d=>d.toLocaleDateString('ru-RU',{weekday:'short',day:'numeric',month:'short'});
const dayStr=()=>dl(DAYS.find(d=>dk(d)==(st.view=='admin'?st.aday:st.day))||DAYS[0]);
const val=id=>document.getElementById(id).value;

// Корзина (карта id -> количество) <-> строки заказа
const cartLines=()=>Object.entries(st.cart).map(([id,qty])=>{const p=pr(id);return{id:+id,n:p.n,u:p.u,p:p.p,q:qty}});
const linesToCart=ls=>{const c={};(ls||[]).forEach(l=>c[l.id]=l.q);return c};
// Таблица строк заказа
const linesTable=ls=>`<table>${ls.map(l=>`<tr><td>${esc(l.n)}</td><td class="r">${q(l.q)} ${l.u}</td><td class="r">${fmt(lineSum(l))}</td></tr>`).join('')}</table>`;

// ===== Время и дни доставки =====
// Яровое и Славгород — Алтайский край (UTC+7). Считаем по их времени, а не по часам устройства.
function nowLocal(){
  const p={};
  new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Barnaul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .formatToParts(new Date()).forEach(x=>p[x.type]=x.value);
  return new Date(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);
}
// Заказ на день принимается до 11:00 в день доставки (сервер проверяет то же самое)
function dayOpen(d){return nowLocal()<new Date(d.getFullYear(),d.getMonth(),d.getDate(),11,0)}
// Ближайшие 4 дня доставки (пн, ср, пт), на которые ещё можно заказать
function days(){const n=nowLocal(),r=[];
  for(let k=0;k<21&&r.length<4;k++){const d=new Date(n.getFullYear(),n.getMonth(),n.getDate()+k);
    if([1,3,5].includes(d.getDay())&&dayOpen(d))r.push(d)}
  return r}

// ===== Загрузка данных с сервера =====
async function loadProducts(){P=(await dbProducts()).map(r=>({id:r.id,n:r.name,p:+r.price,u:r.unit,e:EM[cat(r.name)],off:r.off,lim:+r.lim}))}
async function loadShops(){S=await dbShops()}
async function loadDay(day){const m={};(await dbOrders(day)).forEach(r=>m[r.shop_id]=r.items);ORD[day]=m}

// Понятный текст ошибки
function errText(e){
  const m=String((e&&e.message)||e||'');
  if(/Failed to fetch|NetworkError|Load failed/i.test(m))return 'Нет связи с сервером. Проверь интернет и попробуй ещё раз.';
  if(/Invalid login credentials/i.test(m))return 'Неверный email или пароль.';
  if(/already registered/i.test(m))return 'Этот email уже зарегистрирован. Попробуй войти.';
  if(/Email not confirmed/i.test(m))return 'Email не подтверждён. Обратись в мастерскую.';
  if(/rate limit|too many/i.test(m))return 'Слишком много попыток. Подожди немного.';
  if(/JWT|not authenticated/i.test(m))return 'Сессия закончилась. Войди заново.';
  return m||'Что-то пошло не так. Попробуй ещё раз.';
}
// Ошибка при загрузке/действии: если ещё не вошли — на экран входа, иначе показываем сообщение
function fail(e){console.error(e);const t=errText(e);if(!me)go('login',{err:t});else{st.err=t;st.busy=false;draw()}}

// ===== Вход и выход =====
async function boot(){try{if(await dbSession())await enter();else go('login')}catch(e){fail(e)}}

// После входа: грузим профиль и данные, открываем нужный кабинет
async function enter(){
  st.view='boot';st.err='';draw();
  try{
    me=await dbMe();
    if(!me){await dbSignOut();return go('login',{err:'Профиль не найден. Обратитесь в мастерскую.'})}
    if(!isAdm()&&me.status!='approved')return go('wait');
    DAYS=days();st.day=st.aday=dk(DAYS[0]);
    await loadProducts();
    if(isAdm()){await Promise.all([loadShops(),loadDay(st.aday)]);go('admin',{tab:'orders',sheet:false,cart:{}})}
    else{await loadDay(st.day);go('shop',{cart:linesToCart(ORD[st.day][me.id]),sent:false})}
  }catch(e){fail(e)}
}

async function doLogin(){
  if(st.busy)return;
  const email=val('l_e').trim();st.email=email;st.busy=true;
  try{await dbSignIn(email,val('l_p'));st.busy=false;await enter()}
  catch(e){st.busy=false;go('login',{err:errText(e)})}
}
async function logout(){await dbSignOut();me=null;S=[];ORD={};orders={};go('login',{cart:{},sent:false,sheet:false,tab:'orders',city:'Все'})}

// ===== Действия магазина =====
async function setDay(k){
  try{st.day=k;st.sent=false;await loadDay(k);st.cart=linesToCart(ORD[k][me.id]);st.err='';st.msg='';draw()}
  catch(e){fail(e)}
}
function go(v,extra){Object.assign(st,{view:v,err:'',msg:''},extra||{});draw()}

// Максимум, который можно заказать по товару (с учётом лимита и шага 0.5 кг / 1 шт)
function maxQty(p){const step=p.u=='шт'?1:.5;return p.lim>0?Math.floor(p.lim/step)*step:1e9}

// Плюс/минус в карточке товара
function chg(id,dir){const p=pr(id);if(!p||p.off)return;const u=p.u=='шт'?1:.5;
const v=Math.min(maxQty(p),Math.max(0,(st.cart[id]||0)+dir*u));
if(v)st.cart[id]=v;else delete st.cart[id];
st.err='';draw();window.scrollTo(0,st.y||0)}

// Приводит корзину в соответствие с наличием и лимитами и пишет, что изменилось
function cleanCart(){const gone=[],cut=[];
Object.keys(st.cart).forEach(id=>{const p=pr(id);
  if(!p||p.off){gone.push(p?p.n:'товар #'+id);delete st.cart[id];return}
  const m=maxQty(p);
  if(st.cart[id]>m){if(m>0){st.cart[id]=m;cut.push(p.n+' (до '+q(m)+' '+p.u+')')}else{gone.push(p.n);delete st.cart[id]}}});
const parts=[];
if(gone.length)parts.push('нет в наличии, убрано из заказа: '+gone.map(esc).join(', '));
if(cut.length)parts.push('количество уменьшено до лимита: '+cut.map(esc).join(', '));
st.msg=parts.join('. ');
}

// «Повторить прошлый заказ»: копирует последний заказ магазина в корзину (лишнее уберёт cleanCart)
async function repeat(){
  try{const ls=await dbLastOrder();
    if(!ls){st.msg='Прошлых заказов пока нет.';st.err='';return draw()}
    st.cart=linesToCart(ls);st.err='';st.msg='';draw()}
  catch(e){fail(e)}
}

// Отправка заказа. Сервер ещё раз проверяет срок, наличие и лимиты и сам ставит цены.
async function send(){
  if(st.busy)return; // защита от двойного нажатия
  const d=DAYS.find(x=>dk(x)==st.day);
  if(!d||!dayOpen(d)){
    DAYS=days();if(!DAYS.some(x=>dk(x)==st.day))st.day=dk(DAYS[0]);
    st.err='Приём заказов на этот день уже закрыт (до 11:00 в день доставки). Выбери другой день.';return draw()}
  cleanCart();
  if(!Object.keys(st.cart).length){st.err='Корзина пуста.';return draw()}
  st.busy=true;st.err='';draw();
  try{await dbSubmitOrder(st.day,st.cart);await loadDay(st.day);st.sent=true;st.msg='';st.busy=false;draw()}
  catch(e){
    // Скорее всего изменились цены, наличие или лимиты: обновляем товары, чтобы магазин видел актуальное
    console.error(e);st.err=errText(e);st.busy=false;
    try{await loadProducts();cleanCart()}catch(x){console.error(x)}
    draw()}
}

// Сообщения (ошибки и изменения корзины)
function notesHtml(){return [st.err,st.msg].filter(Boolean).map(t=>`<div class="note" role="alert">${st.err==t?esc(t):t}</div>`).join('')}

function hdr(right){return `<div class="top noprint"><div><div class="brand">Сластёна</div><div class="sub">${right}</div></div><button onclick="logout()">Выйти</button></div>`}

// ===== Экраны входа, регистрации, ожидания =====
function boots(){return `<div class="login card"><h1>Сластёна</h1><p class="sub">${st.err?'':'Загрузка…'}</p>${notesHtml()}${st.err?`<div class="row"><button onclick="logout()">Выйти</button><button class="main" onclick="enter()">Повторить</button></div>`:''}</div>`}

function login(){return `<form class="login card" onsubmit="doLogin();return false"><h1>Сластёна</h1><p class="sub">Заказы для магазинов</p>${notesHtml()}
<input id="l_e" type="email" aria-label="Email" placeholder="Email" autocomplete="username" required value="${esc(st.email)}">
<input id="l_p" type="password" aria-label="Пароль" placeholder="Пароль" autocomplete="current-password" required>
<div class="row"><button class="main" type="submit" ${st.busy?'disabled':''}>Войти</button></div>
<p><button type="button" onclick="go('reg')">Новый магазин? Зарегистрироваться</button></p></form>`}

function wait(){const rej=me.status=='rejected';
return `<div class="login card"><h1>Сластёна</h1><h2>${rej?'Заявка отклонена':'Ждём подтверждения'}</h2><p>${rej?'Мастерская не подтвердила регистрацию. Свяжись с мастерской.':'Мастерская проверит данные и подтвердит регистрацию. После этого можно заказывать.'}</p>
<div class="row"><button onclick="logout()">Выйти</button><button class="main" onclick="enter()">Проверить снова</button></div></div>`}

function reg(){
if(st.regDone)return `<div class="login card"><h1>Сластёна</h1><h2 class="ok">Заявка отправлена</h2><p>Мастерская проверит данные и подтвердит регистрацию. После этого войди со своим email и паролем.</p><button class="main" onclick="go('login',{regDone:false})">На экран входа</button></div>`;
const f=(id,l,t)=>`<label class="sub" for="${id}">${l}</label><input id="${id}" type="${t||'text'}" autocomplete="off">`;
return `<div class="login card" style="text-align:left"><h1 style="text-align:center">Регистрация магазина</h1>${f('r_n','Название магазина')}${f('r_o','Организация или ИП (как в документах)')}${f('r_i','ИНН (10 или 12 цифр)')}<label class="sub" for="r_c">Город</label><select id="r_c"><option>Яровое</option><option>Славгород</option></select>${f('r_a','Адрес магазина')}${f('r_p','Контактное лицо и телефон')}${f('r_m','Email (будет логином)','email')}${f('r_w','Пароль (от 6 символов)','password')}<p><label><input type="checkbox" id="r_f" style="width:auto"> Нужна счёт-фактура</label></p><p><label><input type="checkbox" id="r_k" style="width:auto"> Согласен на обработку данных для оформления заказов</label></p><p id="r_e" class="sub" role="alert"></p><div class="row"><button onclick="go('login')">Назад</button><button class="main" onclick="regSend()">Отправить заявку</button></div></div>`}

// Проверяем поля и отправляем заявку. Сервер создаёт её со статусом «ожидает».
async function regSend(){
if(st.busy)return;
const e=t=>document.getElementById('r_e').textContent=t;
const v=id=>val(id).trim();
if(!v('r_n')||!v('r_o')||!v('r_a')||!v('r_p')||!v('r_m')||val('r_w').length<6||!document.getElementById('r_k').checked)return e('Заполни все поля, пароль от 6 символов, и поставь согласие.');
if(!/^(\d{10}|\d{12})$/.test(v('r_i')))return e('ИНН должен содержать 10 или 12 цифр.');
if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('r_m')))return e('Проверь email.');
st.busy=true;e('Отправляем…');
try{
  await dbSignUp(v('r_m'),val('r_w'),{name:v('r_n'),org:v('r_o'),inn:v('r_i'),city:val('r_c'),address:v('r_a'),contact:v('r_p'),needs_invoice:document.getElementById('r_f').checked});
  await dbSignOut();st.busy=false;go('reg',{regDone:true});
}catch(x){st.busy=false;e(errText(x))}}

// ===== Кабинет магазина =====
function shop(){
if(st.sent){const o=orders[me.id]||[];return hdr(esc(me.name))+notesHtml()+`<div class="card"><h2 class="ok">Заказ принят</h2><p>Доставка: ${dayStr()}, после обеда. Изменить заказ можно до 11:00 в день доставки.</p>
${linesTable(o)}<p><b>Итого: ${fmt(sum(o))}</b></p><p class="sub">Оплата на сайте не нужна, счёт выставит мастерская.</p>
<button onclick="st.cart=linesToCart(orders[me.id]);go('shop',{sent:false})">Изменить заказ</button></div>`}
// Перед показом корзины убираем то, чего нет в наличии, и режем по лимитам
cleanCart();
const cl=cartLines(),n=cl.length,t=sum(cl);
return hdr(esc(me.name)+', '+esc(me.city))+notesHtml()+`<div class="note noprint"><b>Выбери день доставки.</b> Заявки на день принимаются до 11:00 (пн, ср, пт), привозим после обеда.</div>
<div class="chips noprint" role="group" aria-label="День доставки">${DAYS.map(d=>`<button class="${dk(d)==st.day?'on':''}" onclick="setDay('${dk(d)}')">${ds(d)}</button>`).join('')}</div>
<div class="noprint" style="margin:0 0 14px"><button onclick="repeat()">Повторить прошлый заказ</button></div>
<input id="qs" type="search" placeholder="Поиск по названию" aria-label="Поиск по названию" value="${esc(st.qs)}" oninput="st.qs=this.value;draw();const i=document.getElementById('qs');i.focus();i.setSelectionRange(i.value.length,i.value.length)" style="width:100%;max-width:420px;margin:0 0 12px;padding:11px 14px;border-radius:14px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink);font:inherit">
<div class="chips noprint">${CATS.map(c=>`<button class="${st.cat==c?'on':''}" onclick="st.cat='${c}';draw()">${c}</button>`).join('')}</div>
<div class="grid">${P.filter(vis).map(p=>`<div class="card prod"><div class="tile" aria-hidden="true">${p.e}</div><div class="b"><h3>${esc(p.n)}</h3><div class="price">${fmt(p.p)} за ${p.u}${p.lim&&!p.off?' · не больше '+q(p.lim)+' '+p.u:''}</div>
${p.off?'<div class="tag" style="margin-top:auto;align-self:flex-start">Нет в наличии</div>':`<div class="step"><button aria-label="Меньше: ${esc(p.n)}" onclick="st.y=scrollY;chg(${p.id},-1)">−</button><b>${q(st.cart[p.id]||0)} ${p.u}</b><button aria-label="Больше: ${esc(p.n)}" onclick="st.y=scrollY;chg(${p.id},1)">+</button></div>`}</div></div>`).join('')}</div>
<div class="bar"><div><b>${fmt(t)}</b><small>${n?n+' поз. в корзине':'Корзина пуста'}</small></div><button class="main" ${n&&!st.busy?'':'disabled'} onclick="send()">${st.busy?'Отправляем…':'Сделать заказ'}</button></div>`}

// ===== Кабинет мастерской =====
// Суммирует одинаковые товары из списка заказов. Порядок: по категориям, внутри — по названию.
function totals(list){const m={};
list.forEach(ls=>ls.forEach(l=>{const t=m[l.id]||(m[l.id]={id:l.id,n:l.n,u:l.u,v:0});t.v+=l.q}));
const ci=n=>Object.keys(EM).indexOf(cat(n));
return Object.values(m).sort((a,b)=>ci(a.n)-ci(b.n)||a.n.localeCompare(b.n,'ru'))}

// Подтверждённые магазины (без самой мастерской) и заявки
const shopsList=()=>S.filter(s=>s.status=='approved'&&!s.is_admin);
const pending=()=>S.filter(s=>s.status=='pending');

function admin(){const cities=['Все','Яровое','Славгород'];
const rows=shopsList().filter(s=>orders[s.id]&&(st.city=='Все'||s.city==st.city));
if(st.sheet)return sheet(rows);
const tot=totals(rows.map(s=>orders[s.id]));
const body=st.tab=='orders'?`<div class="chips" role="group" aria-label="День доставки">${DAYS.map(d=>`<button class="${dk(d)==st.aday?'on':''}" onclick="adminDay('${dk(d)}')">${ds(d)}</button>`).join('')}<button onclick="refreshAdmin()">Обновить</button></div><div class="chips">${cities.map(c=>`<button class="${st.city==c?'on':''}" onclick="go('admin',{city:'${c}'})">${c}</button>`).join('')}</div>
<div class="cols"><div class="card"><h2>Что испечь на ${dayStr()}</h2>${rows.length?`<table>${tot.map(t=>`<tr><td>${esc(t.n)}</td><td class="r"><b>${q(t.v)} ${t.u}</b></td></tr>`).join('')}</table>`:'<p class="sub">Заказов пока нет.</p>'}
<p><button class="main" onclick="go('admin',{sheet:true})" ${rows.length?'':'disabled'}>Печать листа заказа</button></p></div>
<div><h2>Заказы магазинов (${rows.length})</h2>${rows.length?rows.map(s=>`<details><summary><span>${esc(s.name)}, ${esc(s.city)}</span><span>${s.needs_invoice?'<span class="tag">нужна счёт-фактура</span> ':''}${fmt(sum(orders[s.id]))}</span></summary>
${linesTable(orders[s.id])}</details>`).join(''):'<p class="sub">Магазины ещё не заказали.</p>'}</div></div>`
:st.tab=='reg'?regs():st.tab=='goods'?goods():stats();
const tab=(t,l)=>`<button class="${st.tab==t?'on':''}" onclick="adminTab('${t}')">${l}</button>`;
return hdr('Кабинет мастерской')+notesHtml()+`<div class="tabs noprint">${tab('orders','Заказы')}${tab('goods','Товары')}${tab('stats','Статистика')}${tab('reg','Регистрации'+(pending().length?' ('+pending().length+')':''))}</div>`+body}

// Обновление данных мастерской с сервера (новые заказы и заявки)
async function refreshAdmin(){try{await Promise.all([loadShops(),loadDay(st.aday),loadProducts()]);st.err='';draw()}catch(e){fail(e)}}
async function adminDay(k){st.aday=k;await refreshAdmin()}
async function adminTab(t){st.tab=t;st.sheet=false;
  if(t=='stats'){if(!st.smonth)st.smonth=curMonth();try{await loadStats()}catch(e){fail(e)}return}
  await refreshAdmin()}

// Лист заказа для производства: по городам, без названий магазинов, одинаковые позиции суммируются.
// Общий итог по обоим городам — только когда в фильтре выбрано «Все».
const CITY_ORDER=['Яровое','Славгород'];
const sheetLines=list=>totals(list).map(t=>({n:t.n,v:t.v,u:t.u}));
function sheetHtml(title,lines){
  if(!lines.length)return `<h3>${title}</h3><p class="sub">Заказов нет.</p>`;
  return `<h3>${title}</h3><table>${lines.map(l=>`<tr><td>${esc(l.n)}</td><td class="r"><b>${q(l.v)} ${l.u}</b></td></tr>`).join('')}</table>`}
const sheetText=(title,lines)=>title+'\n'+lines.map(l=>l.n+' — '+q(l.v)+' '+l.u).join('\n');
function sheet(rows){const dn=dayStr();
const cities=CITY_ORDER.filter(c=>rows.some(s=>s.city==c));
const blocks=cities.map(c=>({title:c,lines:sheetLines(rows.filter(s=>s.city==c).map(s=>orders[s.id]))}));
if(st.city=='Все'&&cities.length>1)blocks.push({title:'Итого по обоим городам',lines:sheetLines(rows.map(s=>orders[s.id]))});
const txt='Лист заказа на '+dn+'\n\n'+blocks.map(b=>sheetText(b.title,b.lines)).join('\n\n');
return `<div class="noprint top"><button onclick="go('admin',{sheet:false})">Назад</button><button class="main" onclick="try{window.print()}catch(e){}">Печать</button></div>
<div class="card"><h2>Сластёна: лист заказа на ${dn}</h2><p class="sub">Сводка для производства. Что испечь, по городам.</p><div class="noprint"><p class="sub">Скопируй текст ниже или нажми Ctrl+P.</p><textarea readonly rows="8" aria-label="Текст листа заказа" style="width:100%;border-radius:12px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;padding:8px">${esc(txt)}</textarea></div>
${blocks.map(b=>sheetHtml(b.title,b.lines)).join('')}</div>`}

// ===== Статистика за месяц (считается из реальных заказов) =====
// Текущий месяц по времени Барнаула в формате ГГГГ-ММ
function curMonth(){const n=nowLocal();return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')}
// Первый и последний день месяца в формате ГГГГ-ММ-ДД
function monthRange(ym){const [y,m]=ym.split('-').map(Number);const last=new Date(y,m,0).getDate();const mm=String(m).padStart(2,'0');
  return [y+'-'+mm+'-01',y+'-'+mm+'-'+String(last).padStart(2,'0')]}

// Загружает заказы выбранного месяца и сохраняет в st.sdata
async function loadStats(){
  const [a,b]=monthRange(st.smonth);
  st.sdata=await dbOrdersBetween(a,b);
  st.err='';draw();
}
async function setMonth(v){if(!v)return;st.smonth=v;try{await loadStats()}catch(e){fail(e)}}

// Значение для CSV: кавычки, если есть разделитель, кавычка или перенос строки
const csvCell=v=>{const s=String(v==null?'':v);return /[";\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};

// Выгрузка заказов за выбранный месяц в CSV (открывается в Excel).
// Разделитель «;», десятичная запятая — так Excel в русской версии читает числа правильно.
function exportCsv(){
  const rows=st.sdata||[];
  const lines=[['Дата доставки','Город','Магазин','Организация','ИНН','Товар','Ед.','Цена','Количество','Сумма'].join(';')];
  rows.forEach(r=>{
    const s=S.find(x=>x.id==r.shop_id)||{};
    (r.items||[]).forEach(l=>lines.push([r.day,s.city,s.name,s.org,s.inn,l.n,l.u,
      String(l.p).replace('.',','),String(l.q).replace('.',','),String(lineSum(l)).replace('.',',')]
      .map(csvCell).join(';')));
  });
  // \uFEFF — метка UTF-8 (BOM), без неё Excel покажет русский текст кракозябрами
  const blob=new Blob(['\uFEFF'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='zakazy-'+st.smonth+'.csv';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// Экран статистики: выручка, заказы по городам, продано по товарам
function stats(){
  const rows=st.sdata||[];
  const revenue=sum(rows.reduce((all,r)=>all.concat(r.items),[]));
  const cityOf=id=>{const s=S.find(x=>x.id==id);return s?s.city:'Без города'};
  const byCity={};
  rows.forEach(r=>{const c=cityOf(r.shop_id);byCity[c]=byCity[c]||{count:0,sum:0};byCity[c].count++;byCity[c].sum+=sum(r.items)});
  const cityRows=Object.entries(byCity).map(([c,v])=>`<tr><td>${esc(c)}</td><td class="r">${v.count}</td><td class="r">${fmt(v.sum)}</td></tr>`).join('');
  const prods=totals(rows.map(r=>r.items));
  return `<div class="card"><h2>Статистика</h2>
<p><label class="sub" for="smonth">Месяц</label> <input id="smonth" type="month" value="${esc(st.smonth)}" onchange="setMonth(this.value)" style="padding:8px 12px;border-radius:12px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);font:inherit"></p>
<p><b>Заказов:</b> ${rows.length} · <b>Выручка:</b> ${fmt(revenue)}</p>
<p class="noprint"><button class="main" onclick="exportCsv()" ${rows.length?'':'disabled'}>Скачать заказы месяца (Excel, CSV)</button></p>
<h3>По городам</h3>${cityRows?`<table><tr><th>Город</th><th class="r">Заказов</th><th class="r">Сумма</th></tr>${cityRows}</table>`:'<p class="sub">За этот месяц заказов нет.</p>'}
<h3>Продано за месяц</h3>${prods.length?`<table>${prods.map(t=>`<tr><td>${esc(t.n)}</td><td class="r"><b>${q(t.v)} ${t.u}</b></td></tr>`).join('')}</table>`:'<p class="sub">Продаж нет.</p>'}
<p class="sub">Цены берутся из заказов на момент отправки, поэтому смена цены не меняет прошлые месяцы.</p></div>`}

// Вкладка «Товары»: цена, лимит, наличие. Изменения сразу пишутся на сервер.
function filt(){return `<input id="qs" type="search" placeholder="Поиск по названию" aria-label="Поиск по названию" value="${esc(st.qs)}" oninput="st.qs=this.value;draw();const i=document.getElementById('qs');i.focus();i.setSelectionRange(i.value.length,i.value.length)" style="width:100%;max-width:420px;margin:0 0 12px;padding:11px 14px;border-radius:14px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);font:inherit"><div class="chips">${CATS.map(c=>`<button class="${st.cat==c?'on':''}" onclick="st.cat='${c}';draw()">${c}</button>`).join('')}</div>`}
function goods(){const inp='style="width:110px;padding:6px 8px;border-radius:10px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);font:inherit"';
return `<div class="card"><h2>Товары и цены</h2><p class="sub">Измени цену, поставь лимит или отметь «нет в наличии». Магазины увидят это сразу. Пустой лимит значит «без ограничения». Уже отправленные заказы остаются по старым ценам.</p>${filt()}<div style="overflow-x:auto"><table><tr><th>Товар</th><th>Цена, ₽</th><th>Лимит</th><th></th></tr>${P.filter(vis).map(p=>`<tr><td>${esc(p.n)}<br><span class="sub">${p.u}</span></td><td><input ${inp} type="number" step="0.01" min="0.01" value="${p.p}" aria-label="Цена: ${esc(p.n)}" onchange="setP(${p.id},this.value)"></td><td><input ${inp} type="number" step="0.5" min="0" value="${p.lim||''}" placeholder="без лимита" aria-label="Лимит: ${esc(p.n)}" onchange="setL(${p.id},this.value)"></td><td class="r"><button class="${p.off?'main':''}" onclick="togg(${p.id})">${p.off?'Вернуть в наличие':'Нет в наличии'}</button></td></tr>`).join('')}</table></div></div>`}

// Сохранение изменения товара на сервере; при ошибке показываем её и возвращаем старые значения
async function saveProduct(id,fields,local){
  const y=scrollY;
  try{await dbSetProduct(id,fields);Object.assign(pr(id),local);st.err=''}
  catch(e){console.error(e);st.err=errText(e)}
  draw();scrollTo(0,y)}
// Цена должна быть больше нуля
function setP(id,v){const n=parseFloat(v);
if(n>0)return saveProduct(id,{price:n},{p:n});
st.err='Цена должна быть больше 0. Старое значение сохранено.';draw()}
function setL(id,v){const n=parseFloat(v)>0?parseFloat(v):0;return saveProduct(id,{lim:n},{lim:n})}
function togg(id){const off=!pr(id).off;return saveProduct(id,{off},{off})}

// ===== Заявки на регистрацию =====
function regs(){const l=pending();return `<div class="card"><h2>Заявки на регистрацию</h2>${l.length?l.map(s=>`<details open><summary><span>${esc(s.name)}, ${esc(s.city)}</span>${s.needs_invoice?'<span class="tag">нужна счёт-фактура</span>':''}</summary><p>Организация: ${esc(s.org)}</p><p>Адрес: ${esc(s.address)}</p><p>Контакт: ${esc(s.contact)}</p><p class="sub">ИНН: ${esc(s.inn)} · Email: ${esc(s.email)}</p><button class="main" onclick="setStatus('${s.id}','approved')">Подтвердить</button> <button onclick="if(confirm('Отклонить заявку?'))setStatus('${s.id}','rejected')">Отклонить</button></details>`).join(''):'<p class="sub">Новых заявок нет. Магазин появится здесь после регистрации.</p>'}</div>`}
async function setStatus(id,status){
  try{await dbSetShopStatus(id,status);await loadShops();st.err=''}
  catch(e){console.error(e);st.err=errText(e)}
  draw()}

// ===== Отрисовка =====
function draw(){
  orders=ORD[st.view=='admin'?st.aday:st.day]||{};
  const v=st.view;
  document.getElementById('app').innerHTML=v=='boot'?boots():v=='login'?login():v=='reg'?reg():v=='wait'?wait():v=='shop'?shop():admin()}

// ===== Запуск =====
boot();
