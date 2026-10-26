-- =====================================================================
--  KUENTA 08 — Cargar un gasto de una cuenta personal al presupuesto de la familia
--  El movimiento sigue en tu cuenta personal con su categoría personal (el dinero sale de ahí),
--  pero cuenta para el presupuesto de la categoría familiar indicada en family_category_id.
--  Es aditivo: no modifica datos existentes.
-- =====================================================================

-- Si la familia se elimina, el gasto queda solo como personal
alter table public.transactions add column if not exists family_category_id uuid
  references public.categories(id) on delete set null;
create index if not exists transactions_family_cat_idx on public.transactions (family_category_id) where family_category_id is not null;

-- Reglas: solo gastos, desde una cuenta personal, a una categoría de gasto de tu familia
create or replace function public.validate_family_charge()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_acc public.accounts; v_fc public.categories;
begin
  if new.family_category_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.family_category_id is not distinct from old.family_category_id
     and new.account_id = old.account_id and new.type = old.type then
    return new;  -- sin cambios en el cargo (p. ej. el sistema borra al autor)
  end if;
  if new.type <> 'expense' then
    raise exception 'Solo los gastos se pueden cargar al presupuesto de la familia';
  end if;
  select * into v_acc from public.accounts where id = new.account_id;
  if v_acc.family_id is not null then
    new.family_category_id := null; -- en una cuenta compartida ya es de la familia
    return new;
  end if;
  select * into v_fc from public.categories where id = new.family_category_id;
  if v_fc.id is null or v_fc.family_id is null or v_fc.kind not in ('expense','generosity') then
    raise exception 'Elige una categoría de gasto de la familia';
  end if;
  if not exists (select 1 from public.family_members m
                 where m.family_id = v_fc.family_id and m.user_id = v_acc.owner_id and m.role in ('owner','member')) then
    raise exception 'Solo los miembros de la familia pueden cargar gastos a su presupuesto';
  end if;
  return new;
end $$;
revoke all on function public.validate_family_charge() from public, anon, authenticated;
create trigger trg_validate_family_charge before insert or update on public.transactions
  for each row execute function public.validate_family_charge();

-- Los miembros de la familia ven el total de esos cargos (no ven tus cuentas personales)
create or replace function public.family_charges(p_from date)
returns table (id uuid, family_category_id uuid, amount numeric, currency char(3), occurred_on date, occurred_time time, created_by uuid, description text)
language sql stable security definer set search_path to '' as $$
  select t.id, t.family_category_id, t.amount, a.currency, t.occurred_on, t.occurred_time, t.created_by, t.description
  from public.transactions t
  join public.categories c on c.id = t.family_category_id
  join public.accounts a on a.id = t.account_id
  where c.family_id = public.my_family_id() and t.type = 'expense' and t.occurred_on >= p_from
$$;
revoke all on function public.family_charges(date) from public, anon;
grant execute on function public.family_charges(date) to authenticated;

-- Alertas de presupuesto: un gasto cargado a la familia cuenta para el presupuesto familiar y no para el personal
create or replace function public.check_budget_alert()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  v_cat    public.categories;
  v_fcat   public.categories;
  v_bcat   public.categories;
  v_budget public.budgets;
  v_day    int;
  v_start  date;
  v_end    date;
  v_spent  numeric(14,2);
  v_pct    numeric;
  v_level  int;
begin
  select * into v_cat from public.categories where id = new.category_id;
  select * into v_fcat from public.categories where id = new.family_category_id;

  for v_budget in
    select b.* from public.budgets b
    where b.is_active and b.category_id in (v_cat.id, v_cat.parent_id, v_fcat.id, v_fcat.parent_id)
  loop
    select * into v_bcat from public.categories where id = v_budget.category_id;

    select p.period_start_day into v_day
    from public.profiles p
    where p.id = coalesce(v_bcat.owner_id,
                          (select f.owner_id from public.families f where f.id = v_bcat.family_id));

    select gp.period_start, gp.period_end into v_start, v_end
    from public.get_period(new.occurred_on, coalesce(v_day, 1)) gp;

    select coalesce(sum(t.amount), 0) into v_spent
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    where t.type = 'expense'
      and a.currency = v_budget.currency
      and t.occurred_on between v_start and v_end
      and (
        ((t.category_id = v_bcat.id or t.category_id in (select c.id from public.categories c where c.parent_id = v_bcat.id))
          and (v_bcat.family_id is not null or t.family_category_id is null))
        or t.family_category_id = v_bcat.id
        or t.family_category_id in (select c.id from public.categories c where c.parent_id = v_bcat.id)
      );

    v_pct := v_spent * 100 / v_budget.amount;
    v_level := case
      when v_pct >= 100 then 100
      when v_pct >= v_budget.alert_percent then v_budget.alert_percent
      else null end;

    if v_level is not null then
      insert into public.notifications (user_id, type, title, body, data, dedupe_key)
      select r, 'budget',
        case when v_level = 100
          then 'Presupuesto agotado: ' || v_bcat.name
          else 'Llevas ' || v_level || '% de ' || v_bcat.name end,
        'Gastado ' || v_budget.currency || ' ' || to_char(v_spent, 'FM999,999,990.00')
          || ' de ' || to_char(v_budget.amount, 'FM999,999,990.00'),
        jsonb_build_object('budget_id', v_budget.id, 'category_id', v_bcat.id,
                           'spent', v_spent, 'percent', round(v_pct, 1)),
        'budget:' || v_budget.id || ':' || v_start || ':' || v_level
      from public.scope_recipients(v_bcat.owner_id, v_bcat.family_id) r
      on conflict (user_id, dedupe_key) do nothing;
    end if;
  end loop;
  return null;
end $$;

create or replace trigger trg_budget_alert after insert or update of amount, category_id, family_category_id, occurred_on, account_id
  on public.transactions for each row when (new.type = 'expense') execute function public.check_budget_alert();
