// Kuenta — send-push
// Envía como notificación push las alertas nuevas (recordatorios, pagos programados, cuotas,
// presupuestos y metas). La llama pg_cron cada 15 minutos (ver migración 06).
// No necesita secretos propios: lee su configuración de public.push_config con la clave de servicio
// (que Supabase inyecta sola) y la primera vez genera sus claves VAPID, que nunca salen del servidor.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUBJECT = 'mailto:kuenta.app.hn@gmail.com';
const MAX_AGE_MS = 2 * 3600e3; // nunca enviar avisos viejos (p. ej. al activar push por primera vez)
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function newVapidKeys(){
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64url(await crypto.subtle.exportKey('raw', kp.publicKey)), privateKey: jwk.d as string };
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const { data: cfg, error: cfgErr } = await sb.from('push_config').select('*').eq('id', 1).single();
  if (cfgErr || !cfg) return new Response('Sin configuración', { status: 500 });
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!cfg.cron_secret || given.length !== cfg.cron_secret.length || given !== cfg.cron_secret) return new Response('Forbidden', { status: 403 });

  if (!cfg.vapid_public || !cfg.vapid_private){
    const k = await newVapidKeys();
    await sb.from('push_config').update({ vapid_public: k.publicKey, vapid_private: k.privateKey, updated_at: new Date().toISOString() }).eq('id', 1);
    cfg.vapid_public = k.publicKey; cfg.vapid_private = k.privateKey;
  }
  webpush.setVapidDetails(SUBJECT, cfg.vapid_public, cfg.vapid_private);

  // Prueba de envío (solo con el secreto): {"test_endpoint": "...", "p256dh": "...", "auth": "..."}
  const body = await req.json().catch(() => ({}));
  if (body?.test_endpoint){
    try {
      const r = await webpush.sendNotification({ endpoint: body.test_endpoint, keys: { p256dh: body.p256dh, auth: body.auth } }, JSON.stringify({ title: 'Prueba', body: 'Kuenta' }), { TTL: 60 });
      return Response.json({ test: 'ok', status: r.statusCode });
    } catch (e) { return Response.json({ test: 'error', status: (e as { statusCode?: number }).statusCode, message: String(e) }); }
  }

  // Los recordatorios de registrar no se acumulan en Alertas
  await sb.from('notifications').delete().eq('type', 'reminder').lt('created_at', new Date(Date.now() - 2 * 864e5).toISOString());

  const { data: notifs, error } = await sb.from('notifications')
    .select('id,user_id,type,title,body,data')
    .is('pushed_at', null).is('read_at', null)
    .gte('created_at', new Date(Date.now() - MAX_AGE_MS).toISOString())
    .order('created_at').limit(500);
  if (error) return new Response(error.message, { status: 500 });
  if (!notifs?.length) return Response.json({ sent: 0 });

  const users = [...new Set(notifs.map(n => n.user_id))];
  const { data: subs } = await sb.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth').in('user_id', users);
  const byUser = new Map<string, NonNullable<typeof subs>>();
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
