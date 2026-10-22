-- =====================================================================
--  KUENTA 06 — Recordatorios, pagos programados, deudas y retos de ahorro
--  Ejecútalo completo en Supabase → SQL Editor (es aditivo: no toca datos existentes).
--  Después sigue los pasos de README.md → "Notificaciones push".
-- =====================================================================

-- ---------- notificaciones: nuevos tipos y marca de envío push ----------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('budget','goal','family','system','reminder','scheduled','debt','savings'));
alter table public.notifications add column if not exists pushed_at timestamptz;
create index if not exists notifications_push_idx on public.notifications (created_at) where pushed_at is null;

-- ---------- preferencias de recordatorios (una fila por persona) ----------
create table if not exists public.reminder_settings (
  user_id uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  enabled boolean not null default true,
  times text[] not null default array['09:00','13:00','20:00'],
  timezone text not null default 'America/Tegucigalpa',
  skip_if_logged boolean not null default true,
  scheduled_enabled boolean not null default true,
  debt_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint reminder_times_check check (cardinality(times) <= 6 and array_to_string(times, ',') ~ '^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$|^$'),
  constraint reminder_tz_check check (char_length(timezone) <= 64)
);
alter table public.reminder_settings enable row level security;
create policy reminder_select on public.reminder_settings for select using (user_id = (select auth.uid()));
create policy reminder_insert on public.reminder_settings for insert with check (user_id = (select auth.uid()));
create policy reminder_update on public.reminder_settings for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create trigger trg_reminder_updated before update on public.reminder_settings for each row execute function public.set_updated_at();

-- ---------- suscripciones push (un registro por teléfono/navegador) ----------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) <= 1000 and endpoint ~ '^https://'),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  user_agent text check (char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.push_subscriptions enable row level security;
create policy push_select on public.push_subscriptions for select using (user_id = (select auth.uid()));
create policy push_delete on public.push_subscriptions for delete using (user_id = (select auth.uid()));

-- Guarda la suscripción de este dispositivo. Si el teléfono la tenía otra cuenta, pasa a la actual.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null then raise exception 'No autenticado'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300));
  insert into public.reminder_settings (user_id) values (auth.uid()) on conflict (user_id) do nothing;
end $$;
revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

-- ---------- pagos programados (gastos recurrentes) ----------
create table if not exists public.scheduled_payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete cascade,
  family_id uuid references public.families(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  category_id uuid not null references public.categories(id),
  name text not null check (char_length(trim(name)) between 1 and 60),
  amount numeric(14,2) not null check (amount > 0),
  frequency text not null default 'monthly' check (frequency in ('once','weekly','biweekly','monthly','bimonthly','quarterly','yearly')),
  anchor_day smallint check (anchor_day between 1 and 31),
  next_date date not null,
  end_date date,
  remind_day_before boolean not null default true,
  remind_same_day boolean not null default true,
  is_active boolean not null default true,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(owner_id, family_id) = 1)
);
create index if not exists scheduled_next_idx on public.scheduled_payments (next_date) where is_active;
alter table public.scheduled_payments enable row level security;
create policy scheduled_select on public.scheduled_payments for select using (public.can_view_scope(owner_id, family_id));
create policy scheduled_insert on public.scheduled_payments for insert with check (public.can_edit_scope(owner_id, family_id) and public.can_write_account(account_id));
create policy scheduled_update on public.scheduled_payments for update using (public.can_edit_scope(owner_id, family_id)) with check (public.can_edit_scope(owner_id, family_id) and public.can_write_account(account_id));
create policy scheduled_delete on public.scheduled_payments for delete using (public.can_edit_scope(owner_id, family_id));
create trigger trg_scheduled_updated before update on public.scheduled_payments for each row execute function public.set_updated_at();

-- La cuenta y la categoría deben ser del mismo ámbito (personal o familiar) que el pago
create or replace function public.validate_scheduled_payment()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_acc public.accounts; v_cat public.categories;
begin
  select * into v_acc from public.accounts where id = new.account_id;
  select * into v_cat from public.categories where id = new.category_id;
  if v_cat.kind = 'income' then raise exception 'Un pago programado debe usar una categoría de gasto o generosidad'; end if;
  if v_acc.family_id is distinct from new.family_id or v_cat.family_id is distinct from new.family_id
     or (new.family_id is null and (v_acc.owner_id <> new.owner_id or v_cat.owner_id <> new.owner_id)) then
    raise exception 'La cuenta y la categoría deben ser del mismo ámbito que el pago';
  end if;
  return new;
end $$;
create trigger trg_validate_scheduled before insert or update on public.scheduled_payments for each row execute function public.validate_scheduled_payment();

-- ---------- deudas ----------
create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  lender text check (char_length(lender) <= 60),
  kind text not null default 'prestamo' check (kind in ('prestamo','tarjeta','hipoteca','vehiculo','personal','cooperativa','otro')),
  currency char(3) not null default 'HNL' check (currency in ('HNL','USD')),
  original_amount numeric(14,2) not null check (original_amount > 0),
  current_balance numeric(14,2) not null check (current_balance >= 0),   -- saldo al empezar a llevarla en Kuenta
  annual_rate numeric(6,3) not null default 0 check (annual_rate between 0 and 300),
  rate_type text not null default 'saldo' check (rate_type in ('saldo','flat')),
  term_months smallint check (term_months between 1 and 600),
  installment numeric(14,2) check (installment > 0),
  start_date date not null default current_date,    -- fecha del préstamo (puede ser antigua)
  tracking_from date not null default current_date, -- desde cuándo se registran pagos en Kuenta
  payment_day smallint check (payment_day between 1 and 31),
  account_id uuid references public.accounts(id) on delete set null,
  category_id uuid references public.categories(id) on delete set null,
  icon text not null default '🏦' check (char_length(icon) <= 8),
  status text not null default 'active' check (status in ('active','paid','archived')),
  notes text check (char_length(notes) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.debts enable row level security;
create policy debts_select on public.debts for select using (owner_id = (select auth.uid()));
create policy debts_insert on public.debts for insert with check (owner_id = (select auth.uid()) and not public.is_suspended());
create policy debts_update on public.debts for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()) and not public.is_suspended());
create policy debts_delete on public.debts for delete using (owner_id = (select auth.uid()));
create trigger trg_debts_updated before update on public.debts for each row execute function public.set_updated_at();

create table if not exists public.debt_payments (
  id uuid primary key default gen_random_uuid(),
  debt_id uuid not null references public.debts(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  principal numeric(14,2) not null check (principal >= 0),
  interest numeric(14,2) not null default 0 check (interest >= 0),
  is_extra boolean not null default false,
  paid_on date not null default current_date,
  transaction_id uuid references public.transactions(id) on delete set null,
  note text check (char_length(note) <= 200),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (principal + interest <= amount + 0.01)
);
create index if not exists debt_payments_debt_idx on public.debt_payments (debt_id, paid_on);
alter table public.debt_payments enable row level security;
create policy debt_pay_select on public.debt_payments for select using (exists (select 1 from public.debts d where d.id = debt_id and d.owner_id = (select auth.uid())));
create policy debt_pay_insert on public.debt_payments for insert with check (not public.is_suspended() and exists (select 1 from public.debts d where d.id = debt_id and d.owner_id = (select auth.uid())));
create policy debt_pay_delete on public.debt_payments for delete using (exists (select 1 from public.debts d where d.id = debt_id and d.owner_id = (select auth.uid())));

-- ---------- retos de ahorro ----------
create table if not exists public.savings_challenges (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('52semanas','sobres','hormiga','redondeo','nogasto')),
  name text not null check (char_length(trim(name)) between 1 and 60),
  base_amount numeric(12,2) not null default 0 check (base_amount >= 0),
  slots smallint not null default 0 check (slots between 0 and 366),
  done smallint[] not null default '{}',
  start_date date not null default current_date,
  goal_id uuid references public.goals(id) on delete set null,
  status text not null default 'active' check (status in ('active','completed','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(done) <= 366)
);
alter table public.savings_challenges enable row level security;
create policy challenges_select on public.savings_challenges for select using (owner_id = (select auth.uid()));
create policy challenges_insert on public.savings_challenges for insert with check (owner_id = (select auth.uid()) and not public.is_suspended());
create policy challenges_update on public.savings_challenges for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()) and not public.is_suspended());
create policy challenges_delete on public.savings_challenges for delete using (owner_id = (select auth.uid()));
create trigger trg_challenges_updated before update on public.savings_challenges for each row execute function public.set_updated_at();

-- ---------- generador de avisos (lo llama pg_cron cada 15 minutos) ----------
-- Crea filas en notifications; la función de borde "send-push" las envía al teléfono.
create or replace function public.queue_reminders()
returns integer language plpgsql security definer set search_path to '' as $$
declare
  v_count int := 0; n int;
begin
  -- 1) Recordatorio de registrar movimientos, a las horas de cada persona (solo si tiene push activo)
  insert into public.notifications (user_id, type, title, body, data, dedupe_key)
  select rs.user_id, 'reminder', '¿Ya registraste tus movimientos? ✍️',
         case when extract(hour from slot.t::time) < 12 then 'Empieza el día en orden: anota lo que gastaste o recibiste.'
              when extract(hour from slot.t::time) < 18 then 'Un minuto ahora te ahorra olvidos: registra tus gastos del almuerzo.'
              else 'Cierra el día: registra lo que gastaste hoy y mira cuánto te queda.' end,
         jsonb_build_object('screen', 'add'),
         'rem:' || (now() at time zone rs.timezone)::date || ':' || slot.t
  from public.reminder_settings rs
  cross join lateral unnest(rs.times) as slot(t)
  where rs.enabled
    and exists (select 1 from public.push_subscriptions ps where ps.user_id = rs.user_id)
    and ((now() at time zone rs.timezone)::date + slot.t::time) <= (now() at time zone rs.timezone)
    and ((now() at time zone rs.timezone)::date + slot.t::time) > (now() at time zone rs.timezone) - interval '30 minutes'
    and not (rs.skip_if_logged and exists (
      select 1 from public.transactions t where t.created_by = rs.user_id and t.created_at > now() - interval '3 hours'))
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n = row_count; v_count := v_count + n;

  -- 2) Pagos programados: un día antes, el mismo día y si quedó atrasado (desde las 7 a. m. hora local)
  insert into public.notifications (user_id, type, title, body, data, dedupe_key)
  select r.uid,
         'scheduled',
         case when sp.next_date = x.today + 1 then 'Mañana toca pagar: ' || sp.name
              when sp.next_date = x.today then 'Hoy toca pagar: ' || sp.name
              else 'Pago atrasado: ' || sp.name end,
         (case when a.currency = 'USD' then '$ ' else 'L ' end) || to_char(sp.amount, 'FM999,999,990.00')
           || ' · ' || a.name || '. Toca para registrarlo.',
         jsonb_build_object('screen', 'scheduled', 'id', sp.id),
         'sch:' || sp.id || ':' || sp.next_date || ':' || (case when sp.next_date = x.today + 1 then 'before' when sp.next_date = x.today then 'day' else 'late' end)
  from public.scheduled_payments sp
  join public.accounts a on a.id = sp.account_id
  cross join lateral public.scope_recipients(sp.owner_id, sp.family_id) as r(uid)
  left join public.reminder_settings rs on rs.user_id = r.uid
  cross join lateral (select (now() at time zone coalesce(rs.timezone, 'America/Tegucigalpa')) as local_now) l
  cross join lateral (select l.local_now::date as today) x
  where sp.is_active and coalesce(rs.scheduled_enabled, true)
    and extract(hour from l.local_now) >= 7
    and ((sp.next_date = x.today + 1 and sp.remind_day_before)
      or (sp.next_date = x.today and sp.remind_same_day)
      or (sp.next_date between x.today - 3 and x.today - 1))
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n = row_count; v_count := v_count + n;

  -- 3) Cuotas de deudas según el día de pago (un día antes y el mismo día), si aún no se registró el pago
  insert into public.notifications (user_id, type, title, body, data, dedupe_key)
  select d.owner_id, 'debt',
         case when due.dt = x.today + 1 then 'Mañana vence tu cuota: ' || d.name else 'Hoy vence tu cuota: ' || d.name end,
         coalesce((case when d.currency = 'USD' then '$ ' else 'L ' end) || to_char(d.installment, 'FM999,999,990.00') || '. ', '')
           || 'Pagar a tiempo evita intereses de mora.',
         jsonb_build_object('screen', 'debt', 'id', d.id),
         'debt:' || d.id || ':' || due.dt || ':' || (case when due.dt = x.today + 1 then 'before' else 'day' end)
  from public.debts d
  left join public.reminder_settings rs on rs.user_id = d.owner_id
  cross join lateral (select (now() at time zone coalesce(rs.timezone, 'America/Tegucigalpa')) as local_now) l
  cross join lateral (select l.local_now::date as today) x
  cross join lateral (
    select (date_trunc('month', m)::date + (least(d.payment_day,
              extract(day from (date_trunc('month', m) + interval '1 month - 1 day'))::int) - 1)) as dt
    from (values (x.today::timestamp), ((x.today + 1)::timestamp)) v(m)
  ) due
  where d.status = 'active' and d.payment_day is not null and coalesce(rs.debt_enabled, true)
    and extract(hour from l.local_now) >= 7
    and due.dt in (x.today, x.today + 1)
    and not exists (select 1 from public.debt_payments p where p.debt_id = d.id and p.paid_on > due.dt - 20)
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n = row_count; v_count := v_count + n;

  -- Limpieza: los recordatorios de registrar no se acumulan en Alertas
  delete from public.notifications where type = 'reminder' and created_at < now() - interval '2 days';
  return v_count;
end $$;
revoke all on function public.queue_reminders() from public, anon, authenticated;

-- ---------- programación (pg_cron + pg_net) ----------
-- Requiere dos secretos en Vault (ver README):
--   kuenta_push_url    → https://<proyecto>.supabase.co/functions/v1/send-push
--   kuenta_cron_secret → el mismo valor que CRON_SECRET de la función de borde
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.run_reminders()
returns void language plpgsql security definer set search_path to '' as $$
declare v_url text; v_secret text;
begin
  perform public.queue_reminders();
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'kuenta_push_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'kuenta_cron_secret';
  if v_url is not null and v_secret is not null then
    perform net.http_post(url := v_url, body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret));
  end if;
end $$;
revoke all on function public.run_reminders() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'kuenta-reminders';
select cron.schedule('kuenta-reminders', '*/15 * * * *', $$select public.run_reminders()$$);
