-- ============================================================
-- Схема базы «Сластёна». Запустить ОДИН раз: Supabase -> SQL Editor -> вставить всё -> Run.
-- Что здесь: таблицы, правила доступа (RLS), приём заказа с проверками на сервере.
-- ============================================================

-- ---------- Магазины (и мастерская) ----------
-- id совпадает с id пользователя в auth.users (вход по email + пароль).
create table public.shops (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text not null check (char_length(trim(name)) between 1 and 100),
  org text not null check (char_length(trim(org)) between 1 and 150),
  inn text not null check (inn ~ '^(\d{10}|\d{12})$'),
  city text not null check (city in ('Яровое','Славгород')),
  address text not null check (char_length(trim(address)) between 1 and 200),
  contact text not null check (char_length(trim(contact)) between 1 and 150),
  needs_invoice boolean not null default false,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Товары ----------
create table public.products (
  id integer primary key,
  name text not null,
  price numeric(10,2) not null check (price > 0),          -- цена не может быть 0
  unit text not null check (unit in ('кг','шт')),
  off boolean not null default false,                       -- true = нет в наличии
  lim numeric(8,3) not null default 0 check (lim >= 0)      -- лимит на один заказ, 0 = без лимита
);

-- ---------- Заказы: один заказ магазина на один день ----------
-- items — «снимок» строк заказа на момент отправки: [{"id":1,"n":"Название","u":"кг","p":331.7,"q":2}]
-- Цена хранится в заказе, поэтому смена цены не меняет старые заказы и счета.
create table public.orders (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  day date not null,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, day)
);
create index orders_day_idx on public.orders(day);

-- ---------- Вспомогательные функции для правил ----------
create function public.is_admin() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists(select 1 from public.shops where id = auth.uid() and is_admin and status = 'approved')
$$;

create function public.is_approved() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists(select 1 from public.shops where id = auth.uid() and status = 'approved')
$$;

-- ---------- Новый пользователь -> заявка магазина (статус «ожидает») ----------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.shops(id, email, name, org, inn, city, address, contact, needs_invoice)
  values (
    new.id, new.email,
    left(trim(new.raw_user_meta_data->>'name'), 100),
    left(trim(new.raw_user_meta_data->>'org'), 150),
    trim(new.raw_user_meta_data->>'inn'),
    new.raw_user_meta_data->>'city',
    left(trim(new.raw_user_meta_data->>'address'), 200),
    left(trim(new.raw_user_meta_data->>'contact'), 150),
    (new.raw_user_meta_data->>'needs_invoice') = 'true'
  );
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- Приём заказа: все проверки на сервере ----------
-- Время считаем по Барнаулу (UTC+7, Яровое и Славгород), а не по часам телефона.
create function public.submit_order(p_day date, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := (now() at time zone 'Asia/Barnaul');
  v_lines jsonb := '[]'::jsonb;
  r record;
  prod record;
  v_q numeric;
begin
  if not public.is_approved() then
    raise exception 'Аккаунт ещё не подтверждён мастерской';
  end if;
  if extract(isodow from p_day) not in (1, 3, 5) then
    raise exception 'Доставка только по понедельникам, средам и пятницам';
  end if;
  if v_now >= p_day + time '11:00' then
    raise exception 'Приём заказов на этот день закрыт (до 11:00 в день доставки)';
  end if;
  if p_day > v_now::date + 21 then
    raise exception 'Слишком далёкая дата';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'object' or p_items = '{}'::jsonb then
    raise exception 'Корзина пуста';
  end if;

  for r in select key, value from jsonb_each_text(p_items) loop
    if r.key !~ '^\d+$' then raise exception 'Неверный товар в заказе'; end if;
    select * into prod from public.products where id = r.key::int;
    if not found then raise exception 'Товар не найден, обнови страницу'; end if;
    if prod.off then raise exception 'Нет в наличии: %', prod.name; end if;
    if r.value !~ '^\d+(\.\d+)?$' then raise exception 'Неверное количество: %', prod.name; end if;
    v_q := r.value::numeric;
    if v_q <= 0 or v_q > 1000 then raise exception 'Неверное количество: %', prod.name; end if;
    if prod.unit = 'шт' and v_q <> trunc(v_q) then
      raise exception 'Количество должно быть целым: %', prod.name;
    end if;
    if prod.unit = 'кг' and (v_q * 2) <> trunc(v_q * 2) then
      raise exception 'Количество кратно 0.5 кг: %', prod.name;
    end if;
    if prod.lim > 0 and v_q > prod.lim then
      raise exception 'Больше лимита (% %): %', prod.lim, prod.unit, prod.name;
    end if;
    v_lines := v_lines || jsonb_build_object('id', prod.id, 'n', prod.name, 'u', prod.unit, 'p', prod.price, 'q', v_q);
  end loop;

  insert into public.orders(shop_id, day, items) values (auth.uid(), p_day, v_lines)
  on conflict (shop_id, day) do update set items = excluded.items, updated_at = now();
end $$;

-- ---------- Правила доступа (RLS) ----------
alter table public.shops enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;

-- Магазин видит только себя, мастерская — всех
create policy shops_select on public.shops for select to authenticated
  using (id = auth.uid() or public.is_admin());
-- Менять данные магазинов (подтверждение заявок) может только мастерская
create policy shops_update on public.shops for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Товары видят подтверждённые магазины и мастерская, менять — только мастерская
create policy products_select on public.products for select to authenticated
  using (public.is_approved());
create policy products_update on public.products for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Заказы: магазин видит только свои, мастерская — все. Записывать напрямую нельзя, только через submit_order.
create policy orders_select on public.orders for select to authenticated
  using (shop_id = auth.uid() or public.is_admin());

-- ---------- Права на уровне таблиц (второй замок) ----------
revoke all on public.shops, public.products, public.orders from anon, authenticated;
grant select on public.shops, public.products, public.orders to authenticated;
grant update (status) on public.shops to authenticated;            -- мастерская меняет только статус заявки
grant update (price, off, lim) on public.products to authenticated; -- цена, наличие, лимит

revoke all on function public.is_admin(), public.is_approved(), public.submit_order(date, jsonb) from public, anon;
grant execute on function public.is_admin(), public.is_approved(), public.submit_order(date, jsonb) to authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ============================================================
-- ПОСЛЕ ЗАПУСКА: мастерская (мама) регистрируется на сайте как обычный магазин,
-- затем в SQL Editor выполнить (подставить её email):
--
--   update public.shops set is_admin = true, status = 'approved'
--   where email = 'почта-мамы@example.com';
-- ============================================================

-- ---------- Товары (начальные данные из макета) ----------
insert into public.products (id, name, price, unit) values
  (1, 'Апельсин', 331.7, 'кг'),
  (2, 'Шоколадная вишня', 331.7, 'кг'),
  (3, 'Вафелька', 321, 'кг'),
  (4, 'Вафли венские', 289.17, 'кг'),
  (5, 'Вафли венские фисташка', 310.09, 'кг'),
  (6, 'Вафли венские шоколад', 295.32, 'кг'),
  (7, 'Вафли фисташка', 321, 'кг'),
  (8, 'Заварное', 315, 'кг'),
  (9, 'Кекс творожный', 335, 'кг'),
  (10, 'Кекс чайный', 262.15, 'кг'),
  (11, 'Лакомка пирожное', 321, 'кг'),
  (12, 'Маффин с шоколадом', 310.3, 'кг'),
  (13, 'Медовое', 342.4, 'кг'),
  (14, 'Новинка', 294, 'кг'),
  (15, 'Печенье «Ароматное»', 252, 'кг'),
  (16, 'Печенье «Глаголик»', 241.5, 'кг'),
  (17, 'Печенье «Загадка»', 246.1, 'кг'),
  (18, 'Печенье «Ночка»', 224.7, 'кг'),
  (19, 'Печенье «Персик»', 251.45, 'кг'),
  (20, 'Печенье «Ромашка»', 235.4, 'кг'),
  (21, 'Печенье «Сахарок»', 231, 'кг'),
  (23, 'Печенье «Фигурное»', 262.5, 'кг'),
  (24, 'Пирожное «Молочный ломтик»', 321, 'кг'),
  (25, 'Пирожное «Детское»', 337.05, 'кг'),
  (26, 'Пирожное «Картошка»', 42, 'шт'),
  (27, 'Пирожное «Корзиночка»', 29.87, 'шт'),
  (28, 'Пирожное медовое', 321, 'кг'),
  (29, 'Пирожное «Птичка»', 321, 'кг'),
  (30, 'Пирожное «Тирамису»', 331.7, 'кг'),
  (31, 'Пирожное «Черепаха»', 189, 'кг'),
  (32, 'Рожок', 342.3, 'кг'),
  (33, 'Рулет Фрутти', 283.55, 'кг'),
  (34, 'Сахарок', 210.09, 'кг'),
  (35, 'Торт «Фантазия» со вкусом апельсина', 378, 'кг'),
  (36, 'Торт «Белочка»', 378, 'кг'),
  (37, 'Торт «Взбитые сливки»', 393.75, 'кг'),
  (38, 'Торт заказной', 399, 'кг'),
  (39, 'Торт «Новинка»', 383.25, 'кг'),
  (40, 'Торт «Спанч Боб»', 330, 'кг'),
  (41, 'Торт «Фантазия» со вкусом банана', 378, 'кг'),
  (42, 'Торт «Фантазия» со вкусом барбариса', 358.97, 'кг'),
  (43, 'Торт «Фантазия» со вкусом мал. со сливками', 378, 'кг'),
  (44, 'Торт «Фантазия» со вкусом мал. со сливками Спанч', 378, 'кг'),
  (45, 'Торт «Фантазия» со вкусом тирамису', 378, 'кг'),
  (46, 'Трубочка вафельная', 315, 'кг'),
  (47, 'Трубочка вафельная с вар. сгущ.', 315, 'кг'),
  (48, 'Фантазия пирожное', 231, 'шт'),
  (49, 'Чародейка', 325.5, 'кг'),
  (50, 'Шишка', 325.5, 'кг'),
  (51, 'Шишка со вкусом фисташки', 335, 'кг'),
  (52, 'Шишка с творожной начинкой', 335, 'кг'),
  (53, 'Эклер', 325.5, 'кг');
