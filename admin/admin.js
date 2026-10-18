/* =====================================================================
   KUENTA ADMIN
   - Acceso: correo + contraseña + código de 6 dígitos (TOTP, aal2).
   - Toda la autorización está en la base de datos (public.admins + aal2);
     esta página solo llama funciones admin_* que la verifican.
   - Cada consulta del detalle de un usuario queda registrada.
   ===================================================================== */
'use strict';

const CFG = window.KUENTA_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kuenta-admin-auth' }
});
const BUCKET = 'comprobantes';
const PAGE = 50;
const IDLE_MINUTES = 30;

/* ============ utilidades ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nf = new Intl.NumberFormat('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
const int = new Intl.NumberFormat('en-US');
const money = (n, c = 'HNL') => n == null ? '—' : (n < 0 ? '−' : '') + (c === 'USD' ? '$ ' : 'L ') + nf.format(Math.abs(n));
const dt = s => s ? new Date(s).toLocaleString('es-HN', {day:'numeric', month:'short', year:'numeric', hour:'numeric', minute:'2-digit'}) : '—';
const dd = s => s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('es-HN', {day:'numeric', month:'short', year:'numeric'}) : '—';
const ago = s => {
  if (!s) return 'nunca';
  const m = (Date.now() - new Date(s)) / 6e4;
  if (m < 60) return `hace ${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} d`;
};
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const ROLES = {owner:'Dueño', member:'Miembro', viewer:'Solo lectura'};
const STATUS = {trialing:'Prueba', active:'Activo', canceled:'Cancelado', suspended:'Suspendido'};
const SOURCE = {launch_promo:'Lanzamiento', admin:'Administrador', payment:'Pago', default:'Registro'};
const TYPE = {income:'Ingreso', expense:'Gasto', transfer_in:'Transf. entrada', transfer_out:'Transf. salida'};

function errMsg(e){
  const m = String(e?.message || e || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sin conexión. Revisa tu internet.';
  if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/Invalid TOTP|invalid.*code|expired/i.test(m)) return 'Código incorrecto o vencido. Escribe el código actual de tu app.';
  if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos.';
  return m || 'Algo salió mal.';
}
const q = async p => { const {data, error} = await p; if (error) throw error; return data; };
function toast(msg){
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  $('#toast').appendChild(el); setTimeout(() => el.remove(), 3500);
}
const brand = `<div class="brand"><img src="logo-mark.png" alt="">Kuenta <small>Admin</small></div>`;

/* ============ estado ============ */
const A = { view:'loading', tab:'overview', email:'', overview:null, users:[], total:0, page:0, search:'',
            settings:null, detail:null, mfa:null, msg:'' };

/* ============ acceso ============ */
async function checkAccess(){
  const {data:{session}} = await sb.auth.getSession();
  if (!session){ A.view = 'login'; return render(); }
  A.email = session.user.email;
  const st = await q(sb.rpc('admin_status'));
  if (!st.is_admin_account){ A.view = 'denied'; return render(); }
  if (st.aal !== 'aal2'){
    const f = await q(sb.auth.mfa.listFactors());
    const verified = (f.totp || []).filter(x => x.status === 'verified');
    if (verified.length){ A.mfa = {mode:'verify', factorId:verified[0].id}; A.view = 'mfa'; return render(); }
    // Limpia inscripciones incompletas y crea una nueva
    for (const x of (f.all || []).filter(x => x.status !== 'verified')) await sb.auth.mfa.unenroll({factorId:x.id});
    const en = await q(sb.auth.mfa.enroll({factorType:'totp', friendlyName:'Kuenta Admin'}));
    A.mfa = {mode:'enroll', factorId:en.id, qr:en.totp.qr_code, secret:en.totp.secret};
    A.view = 'mfa'; return render();
  }
  A.view = 'app'; render(); loadTab();
}
async function verifyCode(code){
  const ch = await q(sb.auth.mfa.challenge({factorId:A.mfa.factorId}));
  await q(sb.auth.mfa.verify({factorId:A.mfa.factorId, challengeId:ch.id, code}));
  A.mfa = null; await checkAccess();
}

/* ============ vistas ============ */
function render(){
  const r = $('#root');
  if (A.view === 'loading'){ r.innerHTML = `<div class="gate"><div class="spin" role="status" aria-label="Cargando"></div></div>`; return; }
  if (A.view === 'login'){
    r.innerHTML = `<div class="gate"><form class="box" data-f="login" novalidate>${brand}
      <p>Acceso solo para administradores.</p>
      <div class="field"><label for="lg-e">Correo</label><input class="inp" id="lg-e" type="email" autocomplete="username" required></div>
      <div class="field"><label for="lg-p">Contraseña</label><input class="inp" id="lg-p" type="password" autocomplete="current-password" required></div>
      <div class="err" id="ferr">${esc(A.msg)}</div>
      <button class="btn" type="submit">Entrar</button></form></div>`;
    return;
  }
  if (A.view === 'denied'){
    r.innerHTML = `<div class="gate"><div class="box">${brand}<p><b>${esc(A.email)}</b> no es una cuenta administradora.</p>
      <button class="btn ghost" data-a="signOut">Usar otra cuenta</button></div></div>`;
    return;
  }
  if (A.view === 'mfa'){
    const m = A.mfa;
    r.innerHTML = `<div class="gate"><form class="box" data-f="mfa" novalidate>${brand}
      ${m.mode === 'enroll' ? `<p><b>Activa la verificación en dos pasos.</b><br>Escanea el código con Google Authenticator, Microsoft Authenticator o Authy.</p>
        <div class="qr"><img src="${esc(m.qr)}" alt="Código QR para la app autenticadora"></div>
        <p class="mono secret">${esc(m.secret)}</p>` : `<p>Escribe el código de 6 dígitos de tu app autenticadora.</p>`}
      <input class="inp code" id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" aria-label="Código de 6 dígitos" required>
      <div class="err" id="ferr"></div>
      <button class="btn" type="submit">Verificar</button>
      <button class="btn ghost" type="button" data-a="signOut">Cancelar</button></form></div>`;
    setTimeout(() => $('#mfa-code')?.focus(), 50);
    return;
  }
  const tabs = [['overview','Resumen'],['users','Usuarios'],['settings','Configuración']];
  r.innerHTML = `<header class="top"><div class="top-in">${brand}
      <nav class="tabs">${tabs.map(([k, l]) => `<button class="${A.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}">${l}</button>`).join('')}</nav>
      <div class="who"><span>${esc(A.email)}</span><button class="btn ghost sm" data-a="signOut">Salir</button></div></div></header>
    <main id="main"><div class="spin" style="margin-top:40px"></div></main>`;
}
function setMain(html){ const m = $('#main'); if (m) m.innerHTML = html; }

async function loadTab(){
  try {
    if (A.tab === 'overview'){ A.overview = await q(sb.rpc('admin_overview')); setMain(vOverview()); }
    else if (A.tab === 'users'){ await loadUsers(); setMain(vUsers()); }
    else { A.settings = await q(sb.rpc('admin_get_settings')); setMain(vSettings()); }
  } catch (e) { setMain(`<div class="card err">${esc(errMsg(e))}</div>`); }
}

/* ---- Resumen ---- */
function barChart(rows, label){
  const W = 640, H = 200, L = 30, B = 22, T = 10, n = rows.length;
  const max = Math.max(1, ...rows.map(r => r.n));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const top = Math.ceil(max / step) * step;
  const y = v => T + (H - T - B) * (1 - v / top);
  const cw = (W - L - 4) / n, bw = Math.max(2, cw - 3);
  let g = '';
  for (let v = 0; v <= top; v += step) g += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  rows.forEach((r, i) => {
    const x = L + i * cw + 1.5, h = y(0) - y(r.n);
    if (h > 0){
      const rad = Math.min(4, bw / 2, h);
      g += `<path class="bar" d="M${x},${y(0)} V${y(r.n) + rad} Q${x},${y(r.n)} ${x + rad},${y(r.n)} H${x + bw - rad} Q${x + bw},${y(r.n)} ${x + bw},${y(r.n) + rad} V${y(0)} Z"/>`;
    }
    g += `<rect class="hit" x="${L + i * cw}" y="${T}" width="${cw}" height="${H - T - B}" data-tip="${esc(dd(r.day))}: ${r.n} ${label}"/>`;
    if (i % 5 === 0 || i === n - 1) g += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(new Date(r.day + 'T12:00:00').toLocaleDateString('es-HN', {day:'numeric', month:'short'}).replace('.', ''))}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} por día, últimos 30 días">${g}</svg><div class="tip" hidden></div></div>`;
}
function vOverview(){
  const o = A.overview, p = o.plans || {};
  const k = (label, v, extra = '') => `<div class="kpi"><small>${label}</small><b>${v}</b>${extra ? `<em>${extra}</em>` : ''}</div>`;
  const sum = arr => arr.reduce((s, r) => s + r.n, 0);
  return `<div class="head"><div><h1>Resumen</h1><p>Actualizado ${dt(new Date().toISOString())}</p></div><button class="btn ghost sm" data-a="reload">Actualizar</button></div>
  <div class="kpis">
    ${k('Usuarios', int.format(o.users), `${int.format(o.confirmed)} confirmados`)}
    ${k('Nuevos', int.format(o.new_7d), `7 días · ${int.format(o.new_30d)} en 30`)}
    ${k('Activos', int.format(o.active_7d), `7 días · ${int.format(o.active_30d)} en 30`)}
    ${k('Familias', int.format(o.families))}
    ${k('Cuentas', int.format(o.accounts))}
    ${k('Movimientos', int.format(o.transactions), `${int.format(o.transactions_30d)} en 30 días`)}
    ${k('Comprobantes', int.format(o.attachments), bytes(o.attachments_bytes))}
  </div>
  <div class="card" style="margin-bottom:12px"><h2>Planes</h2>
    <div class="kpis" style="margin:0">
      ${k('Pro en promoción', int.format(p.pro_trial || 0))}
      ${k('Pro activo', int.format(p.pro || 0))}
      ${k('Gratis', int.format(p.free || 0))}
      ${k('Suspendidos', int.format(p.suspended || 0))}
      ${k('Vencen en 7 días', int.format(o.expiring_7d))}
    </div></div>
  <div class="grid2">
    <div class="card"><h2>Registros por día</h2><p class="sub">${int.format(sum(o.signups_by_day))} en los últimos 30 días</p>${barChart(o.signups_by_day, 'registros')}</div>
    <div class="card"><h2>Movimientos registrados por día</h2><p class="sub">${int.format(sum(o.transactions_by_day))} en los últimos 30 días</p>${barChart(o.transactions_by_day, 'movimientos')}</div>
  </div>`;
}

/* ---- Usuarios ---- */
async function loadUsers(){
  const rows = await q(sb.rpc('admin_list_users', {p_search:A.search || null, p_limit:PAGE, p_offset:A.page * PAGE}));
  A.users = rows; A.total = rows[0]?.total_count || 0;
}
function planPill(u){
  const e = u.effective_plan;
  const expired = u.current_period_end && new Date(u.current_period_end) < new Date();
  if (e === 'suspended') return `<span class="pill suspended">Suspendido</span>`;
  if (e === 'pro') return `<span class="pill pro">Pro · ${esc(STATUS[u.status] || u.status)}</span>`;
  return `<span class="pill free">Gratis${expired ? ' · venció' : ''}</span>`;
}
function vUsers(){
  const from = A.total ? A.page * PAGE + 1 : 0, to = Math.min(A.total, (A.page + 1) * PAGE);
  return `<div class="head"><div><h1>Usuarios</h1><p>${int.format(A.total)} ${A.search ? 'resultados' : 'en total'}</p></div>
    <button class="btn ghost sm" data-a="exportUsers">Descargar CSV</button></div>
  <form class="toolbar" data-f="search"><input class="inp" id="search" type="search" placeholder="Buscar por nombre o correo" value="${esc(A.search)}" aria-label="Buscar"><button class="btn sm" type="submit">Buscar</button></form>
  <div class="tablewrap"><table>
    <thead><tr><th>Usuario</th><th>Registro</th><th>Último acceso</th><th>Plan</th><th>Vence</th><th>Familia</th>
      <th class="r">Cuentas</th><th class="r">Movimientos</th><th>Último mov.</th><th class="r">Comprobantes</th></tr></thead>
    <tbody>${A.users.map(u => `<tr class="click" data-a="openUser" data-v="${u.user_id}" tabindex="0">
      <td><span class="name">${esc(u.full_name || 'Sin nombre')}</span><span class="em">${esc(u.email)}${u.email_confirmed ? '' : ' · sin confirmar'}</span></td>
      <td>${dd(u.created_at)}</td><td title="${esc(dt(u.last_sign_in_at))}">${ago(u.last_sign_in_at)}</td>
      <td>${planPill(u)}</td><td>${u.current_period_end ? dd(u.current_period_end) : '—'}</td>
      <td>${u.family_name ? `${esc(u.family_name)} <span class="muted">· ${ROLES[u.family_role] || ''}</span>` : '<span class="muted">—</span>'}</td>
      <td class="r">${u.accounts}</td><td class="r">${int.format(u.transactions)}</td><td>${dd(u.last_transaction)}</td>
      <td class="r">${bytes(Number(u.attachments_bytes))}</td></tr>`).join('') || `<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">Sin resultados</td></tr>`}</tbody>
  </table></div>
  <div class="pager"><span>${from}–${to} de ${int.format(A.total)}</span>
    <button class="btn ghost sm" data-a="page" data-v="-1" ${A.page === 0 ? 'disabled' : ''}>Anterior</button>
    <button class="btn ghost sm" data-a="page" data-v="1" ${to >= A.total ? 'disabled' : ''}>Siguiente</button></div>`;
}

/* ---- Detalle de usuario ---- */
async function openUser(id){
  const dr = $('#drawer');
  dr.innerHTML = `<div class="scrim" data-a="closeUser"></div><div class="pane" role="dialog" aria-modal="true"><div class="spin" style="margin-top:60px"></div></div>`;
  dr.hidden = false;
  try { A.detail = await q(sb.rpc('admin_user_detail', {p_user:id})); dr.querySelector('.pane').innerHTML = vDetail(); }
  catch (e) { dr.querySelector('.pane').innerHTML = `<div class="err">${esc(errMsg(e))}</div>`; }
}
function vDetail(){
  const d = A.detail, u = d.user, p = d.profile || {}, s = d.subscription || {}, f = d.family;
  const end = s.current_period_end ? s.current_period_end.slice(0, 10) : '';
  const facts = (rows) => `<div class="facts">${rows.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('')}</div>`;
  const tx = d.transactions || [];
  return `<div class="pane-h"><div><h2>${esc(p.full_name || 'Sin nombre')}</h2><div class="muted">${esc(u.email)} · <span class="mono">${esc(u.id)}</span></div></div>
      <button class="x" data-a="closeUser" aria-label="Cerrar">×</button></div>
    <div class="card">${facts([
      ['Registro', dt(u.created_at)], ['Último acceso', dt(u.last_sign_in_at)],
      ['Correo confirmado', u.email_confirmed_at ? dt(u.email_confirmed_at) : 'No'],
      ['Inicio de mes', `Día ${p.period_start_day ?? '—'}`], ['Diezmo sugerido', `${p.tithe_percent ?? '—'} %`],
      ['Moneda principal', esc(p.default_currency || '—')], ['Categorías propias', d.categories_custom ?? 0]])}</div>

    <div class="card section"><h2>Suscripción</h2>
      <p class="sub">Plan efectivo: <b>${esc(s.effective_plan === 'pro' ? 'Kuenta Pro' : s.effective_plan === 'suspended' ? 'Suspendido' : 'Gratis')}</b> · origen ${esc(SOURCE[s.source] || s.source || '—')} · desde ${dd(s.started_at)}</p>
      <form class="form-row" data-f="sub" data-id="${esc(u.id)}" novalidate>
        <div class="field"><label for="sb-plan">Plan</label><select class="inp" id="sb-plan">${['pro','free'].map(x => `<option value="${x}" ${s.plan_id === x ? 'selected' : ''}>${x === 'pro' ? 'Kuenta Pro' : 'Gratis'}</option>`).join('')}</select></div>
        <div class="field"><label for="sb-status">Estado</label><select class="inp" id="sb-status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="sb-end">Vence (vacío = nunca)</label><input class="inp" id="sb-end" type="date" value="${end}"></div>
        <div class="field"><label for="sb-note">Nota interna</label><input class="inp" id="sb-note" maxlength="300" value="${esc(s.note || '')}"></div>
        <button class="btn" type="submit">Guardar</button>
      </form><div class="err" id="ferr" style="margin-top:6px"></div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Suspendido: la persona puede ver sus datos pero no registrar ni crear nada.</p></div>

    ${f ? `<div class="card section"><h2>Familia: ${esc(f.name)}</h2>
      <div class="tablewrap"><table><thead><tr><th>Miembro</th><th>Rol</th><th>Desde</th></tr></thead><tbody>
      ${(f.members || []).map(m => `<tr><td>${esc(m.name || 'Sin nombre')}${m.user_id === u.id ? ' <span class="muted">(este usuario)</span>' : ''}</td><td>${ROLES[m.role] || m.role}</td><td>${dd(m.joined_at)}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}

    <div class="card section"><h2>Cuentas</h2><div class="tablewrap"><table>
      <thead><tr><th>Cuenta</th><th>Tipo</th><th>Ámbito</th><th class="r">Saldo inicial</th><th class="r">Saldo actual</th><th>Creada</th></tr></thead><tbody>
      ${d.accounts.map(a => `<tr><td>${esc(a.name)}${a.archived ? ' <span class="muted">(archivada)</span>' : ''}</td><td>${esc(a.type)}</td><td>${a.shared ? 'Familia' : 'Personal'}</td>
        <td class="r">${money(a.initial_balance, a.currency)}</td><td class="r"><b>${money(a.balance, a.currency)}</b></td><td>${dd(a.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin cuentas</td></tr>'}
      </tbody></table></div></div>

    <div class="grid2 section">
      <div class="card"><h2>Presupuestos</h2><div class="tablewrap"><table><thead><tr><th>Categoría</th><th class="r">Monto</th><th class="r">Aviso</th></tr></thead><tbody>
        ${d.budgets.map(b => `<tr><td>${esc(b.category)}${b.shared ? ' <span class="muted">· familia</span>' : ''}</td><td class="r">${money(b.amount)}</td><td class="r">${b.alert_percent} %</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin presupuestos</td></tr>'}
      </tbody></table></div></div>
      <div class="card"><h2>Metas</h2><div class="tablewrap"><table><thead><tr><th>Meta</th><th class="r">Ahorrado</th><th class="r">Objetivo</th><th class="r">%</th></tr></thead><tbody>
        ${d.goals.map(g => `<tr><td>${esc(g.name)}${g.shared ? ' <span class="muted">· familia</span>' : ''}</td><td class="r">${money(g.saved)}</td><td class="r">${money(g.target)}</td><td class="r">${g.percent ?? 0}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin metas</td></tr>'}
      </tbody></table></div></div>
    </div>

    <div class="card section"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
      <h2>Movimientos <span class="muted" style="font-weight:600;font-size:13px">${tx.length === 500 ? 'últimos 500' : tx.length}</span></h2>
      <button class="btn ghost sm" data-a="exportTx">Descargar CSV</button></div>
      <div class="tablewrap" style="max-height:520px;overflow:auto"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Categoría</th><th>Cuenta</th><th>Descripción</th><th>Autor</th><th class="r">Monto</th><th>Comprobante</th></tr></thead><tbody>
      ${tx.map(t => `<tr><td>${dd(t.occurred_on)}</td><td>${TYPE[t.type] || t.type}</td><td>${esc(t.category || '—')}</td>
        <td>${esc(t.account)}${t.shared ? ' <span class="muted">· fam.</span>' : ''}</td>
        <td class="wrap">${esc(t.description || '')}${t.notes ? `<div class="muted">${esc(t.notes)}</div>` : ''}</td><td>${esc(t.author || '—')}</td>
        <td class="r">${['income','transfer_in'].includes(t.type) ? '+' : '−'}${money(t.amount, t.currency).replace('−', '')}</td>
        <td>${(t.attachments || []).map((a, i) => `<button class="link" style="color:var(--brand);font-weight:700" data-a="openFile" data-v="${esc(a.path)}">Ver${t.attachments.length > 1 ? ' ' + (i + 1) : ''}</button>`).join(' ') || '<span class="muted">—</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Sin movimientos</td></tr>'}
      </tbody></table></div></div>

    ${d.admin_actions?.length ? `<div class="card section"><h2>Historial de administración</h2><div class="tablewrap"><table><thead><tr><th>Fecha</th><th>Acción</th></tr></thead><tbody>
      ${d.admin_actions.slice(0, 30).map(a => `<tr><td>${dt(a.created_at)}</td><td>${a.action === 'view_user' ? 'Consulta del detalle' : a.action === 'set_subscription' ? `Suscripción: ${esc(a.details?.plan)} · ${esc(STATUS[a.details?.status] || a.details?.status)}${a.details?.note ? ' · ' + esc(a.details.note) : ''}` : esc(a.action)}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
}

/* ---- Configuración ---- */
function vSettings(){
  const pr = A.settings.launch_promo || {};
  return `<div class="head"><div><h1>Configuración</h1><p>Promoción de lanzamiento y planes</p></div></div>
  <div class="card" style="max-width:640px"><h2>Promoción de lanzamiento</h2>
    <p class="sub">Las cuentas nuevas reciben Kuenta Pro gratis durante estos días. Con la promoción apagada, entran al plan Gratis.</p>
    <form class="form-row" data-f="promo" novalidate>
      <div class="field"><label for="pr-on">Estado</label><select class="inp" id="pr-on"><option value="1" ${pr.active ? 'selected' : ''}>Activa</option><option value="0" ${pr.active ? '' : 'selected'}>Apagada</option></select></div>
      <div class="field"><label for="pr-days">Días de Pro gratis</label><input class="inp" id="pr-days" type="number" min="1" max="730" value="${Number(pr.days) || 60}"></div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px;grid-column:1/-1"><input type="checkbox" id="pr-apply"> <span>Aplicar también a quienes ya están en la promoción (su vencimiento = fecha de registro + días)</span></label>
      <button class="btn" type="submit">Guardar</button>
    </form><div class="err" id="ferr" style="margin-top:6px"></div></div>
  <div class="card section" style="max-width:640px"><h2>Planes</h2><div class="tablewrap"><table><thead><tr><th>Plan</th><th class="r">Precio mensual</th><th>Descripción</th></tr></thead><tbody>
    ${(A.settings.plans || []).map(p => `<tr><td><b>${esc(p.name)}</b></td><td class="r">${money(Number(p.price_hnl))}</td><td>${esc(p.description || '')}</td></tr>`).join('')}
  </tbody></table></div><p class="muted" style="font-size:12px;margin:8px 0 0">Todavía no se cobra: el precio es de referencia.</p></div>`;
}

/* ============ exportaciones ============ */
function csvDownload(rows, name){
  const cell = x => { let s = String(x ?? ''); if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function exportUsers(){
  const all = [];
  for (let off = 0; ; off += 200){
    const rows = await q(sb.rpc('admin_list_users', {p_search:A.search || null, p_limit:200, p_offset:off}));
    all.push(...rows); if (rows.length < 200) break;
  }
  csvDownload([['ID','Nombre','Correo','Confirmado','Registro','Último acceso','Plan','Estado','Origen','Vence','Plan efectivo','Familia','Rol','Cuentas','Movimientos','Último movimiento','Comprobantes (bytes)'],
    ...all.map(u => [u.user_id, u.full_name, u.email, u.email_confirmed ? 'sí' : 'no', u.created_at, u.last_sign_in_at, u.plan_id, u.status, u.source,
      u.current_period_end, u.effective_plan, u.family_name, u.family_role, u.accounts, u.transactions, u.last_transaction, u.attachments_bytes])],
    `kuenta-usuarios-${new Date().toISOString().slice(0, 10)}.csv`);
  toast(`CSV con ${all.length} usuarios descargado`);
}
function exportTx(){
  const d = A.detail;
  csvDownload([['Fecha','Tipo','Categoría','Tipo de categoría','Cuenta','Ámbito','Moneda','Monto','Descripción','Nota','Autor','Comprobantes'],
    ...d.transactions.map(t => [t.occurred_on, TYPE[t.type] || t.type, t.category, t.kind, t.account, t.shared ? 'Familia' : 'Personal', t.currency,
      (['income','transfer_in'].includes(t.type) ? '' : '-') + Number(t.amount).toFixed(2), t.description, t.notes, t.author, (t.attachments || []).length])],
    `kuenta-movimientos-${(d.profile?.full_name || d.user.id).replace(/\s+/g, '-').toLowerCase()}.csv`);
}

/* ============ acciones ============ */
const ACT = {
  tab: el => { A.tab = el.dataset.v; render(); loadTab(); },
  reload: () => loadTab(),
  signOut: async () => { await sb.auth.signOut(); A.view = 'login'; A.msg = ''; render(); },
  page: async el => { A.page = Math.max(0, A.page + Number(el.dataset.v)); await loadUsers(); setMain(vUsers()); },
  openUser: el => openUser(el.dataset.v),
  closeUser: () => { const dr = $('#drawer'); dr.hidden = true; dr.innerHTML = ''; },
  exportUsers, exportTx,
  openFile: async el => {
    const {data, error} = await sb.storage.from(BUCKET).createSignedUrl(el.dataset.v, 120);
    if (error) throw error;
    const a = document.createElement('a'); a.href = data.signedUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  }
};
const FORMS = {
  login: async () => {
    const email = $('#lg-e').value.trim(), password = $('#lg-p').value;
    if (!email || !password) return ($('#ferr').textContent = 'Escribe tu correo y contraseña.');
    await q(sb.auth.signInWithPassword({email, password}));
    A.view = 'loading'; render(); await checkAccess();
  },
  mfa: async () => {
    const code = $('#mfa-code').value.replace(/\D/g, '');
    if (code.length !== 6) return ($('#ferr').textContent = 'El código tiene 6 dígitos.');
    await verifyCode(code);
  },
  search: async () => { A.search = $('#search').value.trim(); A.page = 0; await loadUsers(); setMain(vUsers()); $('#search')?.focus(); },
  sub: async f => {
    const end = $('#sb-end').value;
    await q(sb.rpc('admin_set_subscription', {p_user:f.dataset.id, p_plan:$('#sb-plan').value, p_status:$('#sb-status').value,
      p_period_end:end ? new Date(end + 'T23:59:59-06:00').toISOString() : null, p_note:$('#sb-note').value.trim() || null}));
    toast('Suscripción actualizada');
    await openUser(f.dataset.id);
    if (A.tab === 'users'){ await loadUsers(); setMain(vUsers()); }
  },
  promo: async () => {
    const days = Number($('#pr-days').value);
    if (!(days >= 1 && days <= 730)) return ($('#ferr').textContent = 'Los días deben estar entre 1 y 730.');
    const n = await q(sb.rpc('admin_set_launch_promo', {p_active:$('#pr-on').value === '1', p_days:days, p_apply_existing:$('#pr-apply').checked}));
    toast($('#pr-apply').checked ? `Promoción guardada; ${n} cuentas actualizadas` : 'Promoción guardada');
    A.settings = await q(sb.rpc('admin_get_settings')); setMain(vSettings());
  }
};

async function guarded(el, fn){
  if (el.dataset.busy) return; el.dataset.busy = '1';
  try { await fn(); }
  catch (e) { const box = el.closest('form')?.querySelector('#ferr') || el.closest('.pane, .box')?.querySelector('#ferr'); if (box) box.textContent = errMsg(e); else toast(errMsg(e)); }
  finally { delete el.dataset.busy; }
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  const fn = ACT[el.dataset.a]; if (!fn) return;
  e.preventDefault(); guarded(el, () => fn(el));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#drawer').hidden) ACT.closeUser();
  if (e.key === 'Enter' && e.target.matches('tr[data-a]')) ACT.openUser(e.target);
});
document.addEventListener('submit', e => {
  e.preventDefault(); const f = e.target, fn = FORMS[f.dataset.f]; if (!fn) return;
  const err = f.querySelector('#ferr') || f.parentElement.querySelector('#ferr'); if (err) err.textContent = '';
  const btn = f.querySelector('[type=submit]'); if (btn) btn.dataset.busy = '1';
  guarded(f, () => fn(f)).finally(() => { if (btn) delete btn.dataset.busy; });
});
// Tooltip de los gráficos
document.addEventListener('mouseover', e => {
  const h = e.target.closest('.hit'); if (!h) return;
  const c = h.closest('.chart'), tip = c.querySelector('.tip'), r = c.getBoundingClientRect(), b = h.getBoundingClientRect();
  tip.textContent = h.dataset.tip; tip.hidden = false;
  tip.style.left = `${b.left - r.left + b.width / 2}px`; tip.style.top = `${b.top - r.top + 16}px`;
});
document.addEventListener('mouseout', e => {
  const h = e.target.closest('.hit'); if (!h) return;
  h.closest('.chart').querySelector('.tip').hidden = true;
});

// Cierre de sesión por inactividad
let lastActivity = Date.now();
['click','keydown','mousemove','touchstart'].forEach(ev => document.addEventListener(ev, () => { lastActivity = Date.now(); }, {passive:true}));
setInterval(async () => {
  if (A.view === 'app' && Date.now() - lastActivity > IDLE_MINUTES * 6e4){
    await sb.auth.signOut(); A.view = 'login'; A.msg = `Sesión cerrada tras ${IDLE_MINUTES} minutos sin actividad.`; ACT.closeUser(); render();
  }
}, 60000);

checkAccess().catch(e => { A.view = 'login'; A.msg = errMsg(e); render(); });
