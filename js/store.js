// ===== Связь с сервером (Supabase) =====
// Все обращения к базе — только здесь. app.js про Supabase ничего не знает.
// Publishable-ключ публичный, его можно держать в коде сайта: доступ к данным
// ограничен правилами RLS в базе (см. supabase/schema.sql).
// Секретный ключ (secret / service_role) сюда класть НЕЛЬЗЯ.

const SUPABASE_URL='https://ksnprnpygnbewffsgzpn.supabase.co';
const SUPABASE_KEY='sb_publishable_FL3k06xcPaSDv_o21_Wo1g_8x1Yq4Aj';
const db=supabase.createClient(SUPABASE_URL,SUPABASE_KEY);

// Возвращает данные или бросает ошибку, если сервер вернул error
function ok(r){if(r.error)throw r.error;return r.data}

// ----- Вход -----
async function dbSession(){return ok(await db.auth.getSession()).session}
async function dbSignIn(email,password){ok(await db.auth.signInWithPassword({email,password}))}
async function dbSignUp(email,password,meta){ok(await db.auth.signUp({email,password,options:{data:meta}}))}
async function dbSignOut(){try{await db.auth.signOut()}catch(e){console.error(e)}}

// ----- Чтение -----
// Профиль вошедшего пользователя (строка из shops) или null
async function dbMe(){const s=await dbSession();if(!s)return null;
  return ok(await db.from('shops').select('*').eq('id',s.user.id).maybeSingle())}
async function dbProducts(){return ok(await db.from('products').select('*').order('id'))}
// Только для мастерской: остальным сервер вернёт только их собственную строку
async function dbShops(){return ok(await db.from('shops').select('*').order('created_at'))}
// Заказы на день: магазин получит только свои, мастерская — все
async function dbOrders(day){return ok(await db.from('orders').select('shop_id,items').eq('day',day))}
// Последний заказ магазина (для «Повторить прошлый заказ»)
async function dbLastOrder(){
  const r=ok(await db.from('orders').select('items').order('day',{ascending:false}).limit(1));
  return r.length?r[0].items:null}

// ----- Запись -----
// Заказ принимает сервер: он сам проверяет срок, наличие, лимиты и подставляет цены
async function dbSubmitOrder(day,cart){ok(await db.rpc('submit_order',{p_day:day,p_items:cart}))}

// Если правила доступа ничего не изменили, сервер вернёт пустой список — считаем это ошибкой
async function dbSetProduct(id,fields){
  const r=ok(await db.from('products').update(fields).eq('id',id).select());
  if(!r.length)throw new Error('Нет прав на изменение или товар не найден')}
async function dbSetShopStatus(id,status){
  const r=ok(await db.from('shops').update({status}).eq('id',id).select());
  if(!r.length)throw new Error('Нет прав на изменение или магазин не найден')}
