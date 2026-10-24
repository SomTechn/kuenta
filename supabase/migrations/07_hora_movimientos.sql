-- =====================================================================
--  KUENTA 07 — Hora del movimiento
--  Agrega la hora (opcional) a cada movimiento. Es aditivo: no modifica datos existentes.
--  Los movimientos anteriores siguen mostrando la hora en que se registraron (created_at)
--  cuando coincide con su fecha; la app calcula eso sola.
--  La app funciona antes y después de ejecutar esto: sin la columna, solo oculta el campo "Hora".
-- =====================================================================
alter table public.transactions add column if not exists occurred_time time(0);
comment on column public.transactions.occurred_time is 'Hora local (Honduras) en que ocurrió el movimiento; null = no indicada';
