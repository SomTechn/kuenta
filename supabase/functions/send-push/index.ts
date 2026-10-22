// Kuenta — send-push
// Envía como notificación push las alertas nuevas (recordatorios, pagos programados, cuotas,
// presupuestos y metas). La llama pg_cron cada 15 minutos (ver migración 06).
// Secretos de la función: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...), CRON_SECRET.
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase automáticamente.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const env = (k: string) => Deno.env.get(k) ?? '';
const MAX_AGE_MS = 2 * 3600e3; // nunca enviar avisos viejos (p. ej. al activar push por primera vez)

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = env('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('Forbidden', { status: 403 });

  webpush.setVapidDetails(env('VAPID_SUBJECT') || 'mailto:kuenta.app.hn@gmail.com', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const { data: notifs, error } = await sb.from('notifications')
    .select('id,user_id,type,title,body,data')
    .is('pushed_at', null).is('read_at', null)
    .gte('created_at', new Date(Date.now() - MAX_AGE_MS).toISOString())
    .order('created_at').limit(500);
  if (error) return new Response(error.message, { status: 500 });
  if (!notifs?.length) return Response.json({ sent: 0 });

  const users = [...new Set(notifs.map(n => n.user_id))];
  const { data: subs } = await sb.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth').in('user_id', users);
  const byUser = new Map<string, typeof subs>();
  (subs ?? []).forEach(s => { const l = byUser.get(s.user_id) ?? []; l.push(s); byUser.set(s.user_id, l); });

  let sent = 0;
  const dead = new Set<string>(), used = new Set<string>();
  for (const n of notifs){
    const payload = JSON.stringify({ title: n.title, body: n.body ?? '', tag: `${n.type}:${n.id}`, type: n.type, data: n.data ?? {} });
    for (const s of byUser.get(n.user_id) ?? []){
      if (dead.has(s.id)) continue;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'normal' });
        sent++; used.add(s.id);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.add(s.id); // el teléfono canceló el permiso o desinstaló la app
        else console.error('push error', code, String(e));
      }
    }
  }
  const now = new Date().toISOString();
  await sb.from('notifications').update({ pushed_at: now }).in('id', notifs.map(n => n.id));
  if (dead.size) await sb.from('push_subscriptions').delete().in('id', [...dead]);
  if (used.size) await sb.from('push_subscriptions').update({ last_used_at: now }).in('id', [...used]);
  return Response.json({ sent, notifications: notifs.length, removed: dead.size });
});
