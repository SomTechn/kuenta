-- =====================================================================
--  KUENTA 09 — Borrador de presupuesto generado con los gastos del usuario
--  Un borrador por persona: se revisa, se ajusta y al aprobarlo se crean los presupuestos.
--  Es aditivo: no modifica datos existentes.
-- =====================================================================
create table if not exists public.budget_drafts (
  owner_id uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 200),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.budget_drafts enable row level security;
create policy budget_drafts_select on public.budget_drafts for select using (owner_id = (select auth.uid()));
create policy budget_drafts_insert on public.budget_drafts for insert with check (owner_id = (select auth.uid()) and not public.is_suspended());
create policy budget_drafts_update on public.budget_drafts for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy budget_drafts_delete on public.budget_drafts for delete using (owner_id = (select auth.uid()));
create trigger trg_budget_drafts_updated before update on public.budget_drafts for each row execute function public.set_updated_at();
