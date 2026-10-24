/* =====================================================================
   KUENTA — App (vanilla JS + Supabase)
   Seguridad:
   - Toda la autorización real está en la base de datos (RLS + RPC).
   - Todo texto del usuario se escapa con esc() antes de pintarse.
   - El PIN se guarda solo como hash PBKDF2 (150k iteraciones) en este dispositivo.
   - Huella/Face ID usa WebAuthn como candado local sobre la sesión.
   ===================================================================== */
'use strict';

/* ============ configuración ============ */
const CFG = window.KUENTA_CONFIG || {};
const CONFIGURED = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(CFG.SUPABASE_URL || '') && (CFG.SUPABASE_ANON_KEY || '').length > 30;
const sb = CONFIGURED ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
}) : null;
const BUCKET = 'comprobantes';
const HISTORY_MONTHS = 24;
const LOCK_MINUTES = 5; // la app pide PIN/huella tras 5 minutos en segundo plano (fijo, no lo cambia el usuario)
const PDF_LIBS = [
  ['https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk'],
  ['https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js', 'sha384-fCAW/rDWORTbQXSiB7mOg0QtQ5c+r0f544y6XoKjuVva0nMBlCpNUjiFeG5iMdS3']
];

/* ============ utilidades ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const localISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
let TODAY = localISO(new Date());
const mk = (y, m, d) => new Date(y, m, d, 12);
function addDays(s, n){ const [y,m,d] = s.split('-').map(Number); return localISO(mk(y, m-1, d+n)); }
function addMonths(s, n){ const [y,m,d] = s.split('-').map(Number); return localISO(mk(y, m-1+n, d)); }
function period(ref = TODAY, sd = startDay()){
  const [y,m,d] = ref.split('-').map(Number);
  const s = d >= sd ? mk(y, m-1, sd) : mk(y, m-2, sd);
  return { start: localISO(s), end: localISO(mk(s.getFullYear(), s.getMonth()+1, sd-1)) };
}
const nf = new Intl.NumberFormat('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
const money = (n, c = 'HNL') => (n < 0 ? '−' : '') + (c === 'USD' ? '$ ' : 'L ') + nf.format(Math.abs(n));
const short = (n, c = 'HNL') => (c === 'USD' ? '$' : 'L') + (Math.abs(n) >= 1000 ? (n/1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1) + 'k' : Math.round(n));
const dLong = s => new Date(s + 'T12:00:00').toLocaleDateString('es-HN', {weekday:'long', day:'numeric', month:'long'});
const dShort = s => new Date(s + 'T12:00:00').toLocaleDateString('es-HN', {day:'numeric', month:'short'}).replace('.', '');
const mon = s => new Date(s + 'T12:00:00').toLocaleDateString('es-HN', {month:'short'}).replace('.', '');
const daysLeft = end => Math.round((new Date(end + 'T12:00:00') - new Date(TODAY + 'T12:00:00')) / 864e5) + 1;
const soft = c => `color-mix(in srgb, ${c} 16%, transparent)`;
const parseAmt = v => Number(String(v ?? '').replace(/,/g, '').trim());
const round2 = n => Math.round(n * 100) / 100;
const firstName = n => (n || '').trim().split(/\s+/)[0] || 'Tú';
const LS = {
  get(k, d = null){ try { const v = localStorage.getItem('kuenta.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem('kuenta.' + k, JSON.stringify(v)); } catch {} },
  del(k){ try { localStorage.removeItem('kuenta.' + k); } catch {} }
};

const P = {
  home:'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  list:'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  chart:'M5 20V11M12 20V5M19 20v-6M3 20h18',
  grid:'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  plus:'M12 5v14M5 12h14',
  bell:'M6 16v-5a6 6 0 1 1 12 0v5l2 2H4zM10 21a2 2 0 0 0 4 0',
  back:'M15 5l-7 7 7 7', right:'M9 5l7 7-7 7', close:'M6 6l12 12M18 6 6 18',
  out:'M7 17 17 7M9 7h8v8', in:'M17 7 7 17M15 17H7V9',
  swap:'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  clip:'M20.5 11.5 12 20a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
  finger:'M12 11v3.5a9 9 0 0 1-1.5 5M8.6 8.6A5 5 0 0 1 17 12v2a12 12 0 0 1-.8 4M7 12a5 5 0 0 1 .4-2M7 15a10 10 0 0 0 1.2 4.5M4.5 9a8 8 0 0 1 14.6-1.5M19.6 12a14 14 0 0 1-.3 3',
  lock:'M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3',
  search:'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  users:'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2.5 21a6.5 6.5 0 0 1 13 0M16 3.6a4 4 0 0 1 0 7.3M18 14.5a6 6 0 0 1 3.5 6.5',
  mail:'M4 6h16v12H4zM4 7l8 6 8-6',
  heart:'M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6a5 5 0 1 1 7.5 6.6z',
  target:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  gauge:'M4 18a8 8 0 1 1 16 0M12 18l4-6',
  tag:'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
  file:'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  gear:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1',
  wallet:'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M16.5 13.5h.01',
  copy:'M9 9h11v11H9zM5 15H4V4h11v1',
  trash:'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  check:'M5 12l5 5 9-10',
  camera:'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  download:'M12 4v11M7 10l5 5 5-5M4 20h16',
  logout:'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  calendar:'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  card:'M3 6h18v12H3zM3 10h18M7 15h4',
  spark:'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
  share:'M12 3v12M7 8l5-5 5 5M5 14v6h14v-6',
  edit:'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  eye:'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeoff:'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2'
};
const ic = (n, cls = '') => `<span class="ic ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${P[n]}"/></svg></span>`;

const EMOJI_GROUPS = [
  ['Comida', '🛒 🍽️ ☕ 🍔 🍕 🌮 🍗 🥖 🍰 🍺 🥤 🍎 🥩 🧃'],
  ['Transporte', '⛽ 🚌 🚕 🚗 🏍️ 🛵 🚲 🅿️ 🔧 ✈️ 🚢'],
  ['Hogar', '🏠 💡 💧 🔥 📶 📺 🛋️ 🧹 🧺 🔨 🪴 🔑'],
  ['Salud y cuidado', '🩺 💊 🦷 👓 🏋️ 💈 💅 🧴 🧘'],
  ['Familia y estudios', '👶 🧒 🎒 📚 🎓 🐾 🐶 🐱 👵 💍'],
  ['Diversión', '🎬 🎮 🎵 🎉 🏖️ ⚽ 📖 🎨 🎤 🎟️'],
  ['Compras', '👕 👟 👜 📱 💻 🎁 📦 🛍️ ⌚'],
  ['Dinero y trabajo', '💼 💵 💰 💳 🏦 📈 📉 🧾 🪙 🤝 🏪 🛠️'],
  ['Generosidad', '🙏 💝 ⛪ 🤲 ❤️ 🕊️ 🌱'],
  ['Otros', '📌 ⭐ 🔔 📅 🧩 🏷️ ❓']
].map(([t, l]) => [t, l.split(' ')]);
const EMOJIS = EMOJI_GROUPS.flatMap(g => g[1]);
const GOAL_EMOJIS = ['🎯','🛟','🏝️','🚗','🏠','🎓','💍','💻','✈️','🏥','👶','🐷','📱','🎸','🏍️','⛪'];
const COLORS = ['#0B7F5C','#13A26F','#22C55E','#84CC16','#0A5C4F','#0D9488','#06B6D4','#0EA5E9','#2563EB','#1E3A8A',
  '#4F46E5','#7C3AED','#9333EA','#C026D3','#DB2777','#E11D48','#DC2626','#EA580C','#F97316','#E8A21C',
  '#EAB308','#A16207','#78350F','#57534E','#64748B','#334155','#0F1B2D','#000000'];
/* Bancos de Honduras. El color es el principal de cada marca (aproximado); el usuario lo puede cambiar. */
const BANKS = [
  {id:'atlantida', n:'Banco Atlántida', s:'Atlántida', c:'#003DA5'},
  {id:'bac', n:'BAC Credomatic', s:'BAC', c:'#E30613'},
  {id:'ficohsa', n:'Banco Ficohsa', s:'Ficohsa', c:'#003C7E'},
  {id:'banpais', n:'Banpaís (Banco del País)', s:'Banpaís', c:'#00529B'},
  {id:'occidente', n:'Banco de Occidente', s:'Occidente', c:'#007A3D'},
  {id:'davivienda', n:'Davivienda', s:'Davivienda', c:'#ED1C24'},
  {id:'lafise', n:'Banco Lafise', s:'Lafise', c:'#00704A'},
  {id:'promerica', n:'Banco Promerica', s:'Promerica', c:'#00A651'},
  {id:'banrural', n:'Banrural Honduras', s:'Banrural', c:'#00843D'},
  {id:'azteca', n:'Banco Azteca', s:'Azteca', c:'#2E9E45'},
  {id:'trabajadores', n:'Banco de los Trabajadores', s:'Bantrab', c:'#1F4E9A'},
  {id:'ficensa', n:'Banco Ficensa', s:'Ficensa', c:'#004A8F'},
  {id:'banhcafe', n:'Banhcafé', s:'Banhcafé', c:'#6B3E26'},
  {id:'popular', n:'Banco Popular', s:'Banco Popular', c:'#F28C00'},
  {id:'bancohonduras', n:'Banco de Honduras', s:'Banco de Honduras', c:'#0B4EA2'},
  {id:'banadesa', n:'Banadesa', s:'Banadesa', c:'#2E7D32'},
  {id:'tigomoney', n:'Tigo Money', s:'Tigo Money', c:'#00377B'}
];
const BANK_TYPES = ['banco','tarjeta','ahorro','billetera','inversion'];
const bankName = (b, type) => type === 'tarjeta' ? `Tarjeta ${b.s}` : type === 'ahorro' ? `Ahorro ${b.s}` : b.n;
const guessBank = a => a.name ? BANKS.find(b => a.name.toLowerCase().includes(b.s.toLowerCase())) || null : null;
/* Selector de color: paleta + color personalizado */
const isHex = v => /^#[0-9A-Fa-f]{6}$/.test(v || '');
function colorPicker(sel, disabled = false){
  const custom = isHex(sel) && !COLORS.includes(sel.toUpperCase()) && !COLORS.includes(sel);
  return `<div class="swatches">${COLORS.map(c => `<button type="button" class="${sel === c ? 'on' : ''}" style="background:${c}" data-a="pickColor" data-v="${c}" aria-label="Color ${c}" ${disabled ? 'disabled' : ''}></button>`).join('')}
    <label class="swc ${custom ? 'on' : ''}" style="${custom ? `background:${sel}` : ''}" title="Elegir otro color"><input type="color" value="${isHex(sel) ? sel : '#0B7F5C'}" data-in="color" aria-label="Elegir otro color" ${disabled ? 'disabled' : ''}><span aria-hidden="true">+</span></label></div>`;
}
function setColor(c, root){
  S.form.color = c;
  const box = root || $('#sheet .swatches'); if (!box) return;
  let hit = false;
  box.querySelectorAll('button').forEach(b => { const on = b.dataset.v.toLowerCase() === c.toLowerCase(); b.classList.toggle('on', on); hit ||= on; });
  const sw = box.querySelector('.swc'); sw.classList.toggle('on', !hit); sw.style.background = hit ? '' : c; sw.querySelector('input').value = c;
  updAccPreview();
}
function updAccPreview(){
  const pv = $('#accprev'); if (!pv) return;
  const type = $('#ac-t')?.value || 'banco', b = BANKS.find(x => x.id === $('#ac-b')?.value);
  pv.style.setProperty('--c', S.form.color);
  pv.querySelector('.ai').textContent = TYPE_ICON[type];
  pv.querySelector('b').textContent = $('#ac-n').value.trim() || 'Nombre de la cuenta';
  pv.querySelector('small').textContent = [b ? b.s : null, TYPES[type]].filter(Boolean).join(' · ');
}
function pickBank(id){
  const b = BANKS.find(x => x.id === id), n = $('#ac-n');
  S.form.bank = id;
  if (b){
    setColor(b.c);
    const auto = bankName(b, $('#ac-t').value);
    if (!n.value.trim() || n.value === S.form.autoName){ n.value = auto; S.form.autoName = auto; }
  }
  updAccPreview();
}
const TYPES = {efectivo:'Efectivo',banco:'Banco',tarjeta:'Tarjeta de crédito',ahorro:'Ahorro',billetera:'Billetera digital',inversion:'Inversión',otro:'Otro'};
const TYPE_ICON = {efectivo:'💵',banco:'🏦',tarjeta:'💳',ahorro:'🐷',billetera:'📲',inversion:'📈',otro:'👛'};
const ROLES = {owner:'Dueño', member:'Miembro', viewer:'Solo lectura'};
const KIND = {income:'Ingresos', expense:'Gastos', generosity:'Generosidad'};
const UNKNOWN_CAT = {id:null, name:'Sin categoría', icon:'❔', color:'#64748B', kind:'expense', parent:null, scope:'p'};

/* ============ estado ============ */
const freshUI = () => ({screen:'home', back:null, txFilter:'all', txAcc:'', txQuery:'', statsScope:'personal', statsOff:0,
  budScope:'personal', catScope:'p', catKind:'expense', repFrom:'', repTo:'', repScope:'personal'});
let S = {};
function resetState(){
  S = { user:null, profile:null, family:null, users:{}, invites:[], accounts:[], balances:{}, categories:[], tx:[], atts:{},
    budgets:[], goals:[], notifs:[], reminder:null, scheduled:[], debts:[], challenges:[], v06:false, ui:freshUI(), auth:'login', authMsg:'', locked:false, pinEntry:'', needPinSetup:false,
    loadedAt:0, txFrom:null, draft:null, form:{} };
}
resetState();

/* ============ consultas locales ============ */
const me = () => S.user?.id;
const startDay = () => S.profile?.period_start_day || 1;
// Lo familiar usa el día de inicio del dueño (igual que las alertas del servidor)
const famDay = () => (S.family && S.users[S.family.owner]?.sd) || startDay();
const dayFor = scope => scope === 'family' || scope === 'f' ? famDay() : startDay();
const acc = id => S.accounts.find(a => a.id === id);
const cat = id => S.categories.find(c => c.id === id) || UNKNOWN_CAT;
const uname = id => S.users[id]?.name || (id === me() ? (S.profile?.full_name || 'Tú') : 'Exmiembro');
const role = () => S.family?.members[me()] || null;
const isOwner = () => role() === 'owner';
const hasFamily = () => !!S.family;
const canWriteAcc = a => a.shared ? ['owner','member'].includes(role()) : a.owner === me();
const canEditScope = sc => sc === 'p' ? true : ['owner','member'].includes(role());
const canEditTx = t => { const a = acc(t.acc); return !!a && canWriteAcc(a) && (t.by === me() || (a.shared && isOwner())); };
const visAccounts = () => S.accounts.filter(a => !a.archived);
const writableAccounts = () => visAccounts().filter(canWriteAcc);
const balance = a => S.balances[a.id] ?? a.init;
const rootOf = c => c.parent ? cat(c.parent) : c;

function summary(start, end, scope, cur = 'HNL'){
  let inc = 0, exp = 0, gen = 0;
  for (const t of S.tx){
    if (t.tg || t.date < start || t.date > end) continue;
    const a = acc(t.acc); if (!a || a.cur !== cur || (scope === 'family') !== a.shared) continue;
    if (t.type === 'income') inc += t.amount;
    else if (cat(t.cat).kind === 'generosity') gen += t.amount; else exp += t.amount;
  }
  return {inc, exp, gen, net: inc - exp - gen, rate: inc > 0 ? (inc - exp - gen) / inc * 100 : null};
}
function breakdown(start, end, scope, kind){
  const m = new Map();
  for (const t of S.tx){
    if (t.tg || t.type !== (kind === 'income' ? 'income' : 'expense') || t.date < start || t.date > end) continue;
    const a = acc(t.acc); if (!a || a.cur !== 'HNL' || (scope === 'family') !== a.shared) continue;
    const c = cat(t.cat); if (c.kind !== kind) continue;
    const r = rootOf(c); const key = r.id || 'none';
    m.set(key, (m.get(key) || 0) + t.amount);
  }
  const tot = [...m.values()].reduce((x, y) => x + y, 0);
  return [...m].map(([id, v]) => ({c: id === 'none' ? UNKNOWN_CAT : cat(id), v, p: tot ? v / tot * 100 : 0})).sort((a, b) => b.v - a.v);
}
function budgetInfo(b, ref = TODAY){
  const c = cat(b.cat), p = period(ref, dayFor(c.scope));
  let spent = 0;
  for (const t of S.tx){
    if (t.type !== 'expense' || t.date < p.start || t.date > p.end) continue;
    const tc = cat(t.cat); if (tc.id !== c.id && tc.parent !== c.id) continue;
    if (acc(t.acc)?.cur !== b.cur) continue;
    spent += t.amount;
  }
  const pct = spent / b.amount * 100;
  return {c, spent, pct, state: pct >= 100 ? 'over' : pct >= b.alert ? 'warn' : 'ok', left: b.amount - spent, p};
}
function goalInfo(g){
  const la = g.linked ? acc(g.linked) : null;
  const saved = la ? balance(la) : g.contrib.reduce((s, x) => s + x.amount, 0);
  const pct = Math.max(0, Math.min(100, saved / g.target * 100));
  const months = g.date ? Math.max(1, Math.round((new Date(g.date) - new Date(TODAY)) / (30.4 * 864e5))) : 12;
  return {saved, pct, months, monthly: Math.max(0, (g.target - saved) / months)};
}

/* ============ errores ============ */
function errMsg(e){
  const m = String(e?.message || e || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sin conexión. Revisa tu internet e intenta de nuevo.';
  if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/Email not confirmed/i.test(m)) return 'Confirma tu correo antes de entrar. Revisa tu bandeja de entrada.';
  if (/Password should be at least|weak password/i.test(m)) return 'La contraseña es muy débil. Usa al menos 8 caracteres con letras y números.';
  if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos.';
  if (/row-level security|permission denied/i.test(m)) return 'No tienes permiso para hacer esto.';
  if (/budgets_category_id_key/i.test(m)) return 'Esa categoría ya tiene presupuesto.';
  if (/duplicate key/i.test(m)) return 'Ese registro ya existe.';
  if (/foreign key/i.test(m)) return 'No se puede eliminar porque está en uso.';
  if (/JWT|session/i.test(m)) return 'Tu sesión venció. Vuelve a entrar.';
  return m || 'Algo salió mal. Intenta de nuevo.';
}
const q = async p => { const {data, error} = await p; if (error) throw error; return data; };

/* ============ carga de datos ============ */
const mapAcc = r => ({id:r.id, name:r.name, type:r.type, cur:r.currency, init:+r.initial_balance, limit:r.credit_limit == null ? null : +r.credit_limit,
  color:r.color, icon:r.icon, shared:!!r.family_id, family_id:r.family_id, owner:r.owner_id, archived:r.is_archived, sort:r.sort_order});
const mapCat = r => ({id:r.id, scope:r.family_id ? 'f' : 'p', name:r.name, kind:r.kind, icon:r.icon, color:r.color, parent:r.parent_id, archived:r.is_archived, sort:r.sort_order});
/* Hora del movimiento: la indicada (migración 07) o, si no hay, la hora en que se registró ese mismo día */
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function txTime(r){
  if (r.occurred_time) return r.occurred_time.slice(0, 5);
  if (!r.created_at) return '';
  const c = new Date(r.created_at);
  return localISO(c) === r.occurred_on ? `${pad(c.getHours())}:${pad(c.getMinutes())}` : '';
}
const mapTx = r => ({id:r.id, acc:r.account_id, cat:r.category_id, type:r.type, amount:+r.amount, date:r.occurred_on, time:txTime(r), desc:r.description || '', note:r.notes || '', by:r.created_by, tg:r.transfer_group});
const txKey = t => t.date + ' ' + (t.time || '00:00');
const byNewest = (a, b) => txKey(b).localeCompare(txKey(a));
/* Agrega la hora a una fila nueva o editada, solo si la base ya tiene la columna */
const withTime = (row, time) => S.hasTime ? {...row, occurred_time:time || null} : row;
const mapBud = r => ({id:r.id, cat:r.category_id, amount:+r.amount, alert:r.alert_percent, cur:r.currency});
const mapGoal = r => ({id:r.id, scope:r.family_id ? 'f' : 'p', name:r.name, target:+r.target_amount, date:r.target_date, icon:r.icon, color:r.color, linked:r.account_id, status:r.status, contrib:[]});

async function fetchAll(build){
  const out = [];
  for (let from = 0; ; from += 1000){
    const d = await q(build().range(from, from + 999));
    out.push(...d); if (d.length < 1000) break;
  }
  return out;
}
async function loadFamily(){
  const mems = await q(sb.from('family_members').select('family_id,user_id,role'));
  const mine = mems.find(m => m.user_id === me());
  if (!mine){ S.family = null; S.invites = []; }
  else {
    const f = await q(sb.from('families').select('id,name,owner_id').eq('id', mine.family_id).single());
    S.family = {id:f.id, name:f.name, owner:f.owner_id, members:Object.fromEntries(mems.map(m => [m.user_id, m.role]))};
    S.invites = mine.role === 'owner' ? await q(sb.from('family_invitations').select('id,email,role,token,expires_at')
      .eq('status', 'pending').gt('expires_at', new Date().toISOString()).order('created_at', {ascending:false})) : [];
  }
  const profs = await q(sb.from('profiles').select('id,full_name,period_start_day'));
  S.users = Object.fromEntries(profs.map(p => [p.id, {name:p.full_name || 'Sin nombre', short:firstName(p.full_name), sd:p.period_start_day}]));
}
async function loadAccounts(){
  S.accounts = (await q(sb.from('accounts').select('*').order('sort_order').order('created_at'))).map(mapAcc);
  await loadBalances();
}
async function loadBalances(){
  const rows = await q(sb.from('account_balances').select('account_id,balance'));
  S.balances = Object.fromEntries(rows.map(r => [r.account_id, +r.balance]));
}
async function loadCategories(){ S.categories = (await fetchAll(() => sb.from('categories').select('*').order('sort_order').order('name'))).map(mapCat); }
async function loadBudgets(){ S.budgets = (await q(sb.from('budgets').select('*').eq('is_active', true))).map(mapBud); }
async function loadGoals(){
  const [gs, cs] = await Promise.all([q(sb.from('goals').select('*').neq('status', 'archived').order('created_at')),
    fetchAll(() => sb.from('goal_contributions').select('goal_id,amount,contributed_on').order('contributed_on'))]);
  S.goals = gs.map(mapGoal);
  cs.forEach(c => { const g = S.goals.find(x => x.id === c.goal_id); if (g) g.contrib.push({amount:+c.amount, date:c.contributed_on}); });
}
async function loadTx(){
  S.txFrom = addMonths(period().start, -HISTORY_MONTHS);
  const cols = 'id,account_id,category_id,type,amount,occurred_on,description,notes,created_by,transfer_group,created_at';
  const txQuery = withHour => fetchAll(() => sb.from('transactions').select(cols + (withHour ? ',occurred_time' : ''))
    .gte('occurred_on', S.txFrom).order('occurred_on', {ascending:false}).order('created_at', {ascending:false}));
  // Si la base aún no tiene la columna de hora (migración 07), la app sigue funcionando sin ella
  const txRows = S.hasTime === false ? txQuery(false) : txQuery(true).then(r => { S.hasTime = true; return r; }, e => {
    if (!/occurred_time/.test(String(e?.message || ''))) throw e;
    S.hasTime = false; return txQuery(false);
  });
  const [rows, atts] = await Promise.all([
    txRows,
    fetchAll(() => sb.from('attachments').select('id,transaction_id,storage_path,mime_type,uploaded_by'))
  ]);
  S.tx = rows.map(mapTx);
  S.atts = {};
  atts.forEach(a => (S.atts[a.transaction_id] ||= []).push(a));
}
async function loadNotifs(){
  S.notifs = await q(sb.from('notifications').select('id,type,title,body,data,read_at,created_at').order('created_at', {ascending:false}).limit(100));
}
async function loadProfile(){ S.profile = await q(sb.from('profiles').select('*').eq('id', me()).single()); }
async function loadSubscription(){
  // Si la base aún no tiene suscripciones (antes de la migración 05), la app sigue funcionando
  try {
    const rows = await q(sb.from('subscriptions').select('plan_id,status,source,started_at,current_period_end,plans(name)').eq('user_id', me()));
    S.sub = rows[0] || null;
  } catch { S.sub = null; }
}
/* Plan efectivo: vencido o cancelado = Gratis */
function planInfo(){
  const s = S.sub;
  if (!s) return {plan:'free', name:'Gratis', label:'Plan Gratis', suspended:false};
  if (s.status === 'suspended') return {plan:'suspended', name:'Suspendida', label:'Cuenta suspendida', suspended:true};
  const end = s.current_period_end ? s.current_period_end.slice(0, 10) : null;
  const live = ['trialing','active'].includes(s.status) && (!s.current_period_end || new Date(s.current_period_end) > new Date());
  if (!live || s.plan_id === 'free') return {plan:'free', name:'Gratis', label:'Plan Gratis', suspended:false};
  const name = s.plans?.name || 'Kuenta Pro';
  const left = end ? daysLeft(end) - 1 : null;
  const detail = s.source === 'launch_promo' ? `Gratis por lanzamiento${end ? ` hasta el ${dShort(end)} ${end.slice(0, 4)}` : ''}`
    : end ? `Vigente hasta el ${dShort(end)} ${end.slice(0, 4)}` : 'Sin vencimiento';
  return {plan:s.plan_id, name, label:name, detail, left, suspended:false};
}
async function loadAll(){
  await loadProfile();
  await Promise.all([loadSubscription(), loadFamily(), loadAccounts(), loadCategories(), loadBudgets(), loadGoals(), loadTx(), loadNotifs(), loadPlanner()]);
  S.loadedAt = Date.now();
}
/* Tras un cambio: refresca saldos y avisa las alertas nuevas que creó el servidor */
async function afterWrite(){
  const before = new Set(S.notifs.map(n => n.id));
  await Promise.all([loadBalances(), loadNotifs()]);
  S.notifs.filter(n => !before.has(n.id) && !n.read_at && ['budget','goal'].includes(n.type))
    .forEach(n => toast(n.title, /agotado/i.test(n.title) ? 'over' : n.type === 'goal' ? 'ok' : 'warn'));
}

/* ============ toasts y hojas ============ */
function toast(msg, kind, action){
  const el = document.createElement('div');
  el.className = 'toast'; el.setAttribute('role', 'status');
  const dotc = kind === 'warn' ? 'var(--warn)' : kind === 'over' ? 'var(--neg)' : 'var(--pos)';
  el.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${dotc};flex:none"></span><span>${esc(msg)}</span>`;
  if (action){
    const b = document.createElement('button'); b.textContent = action.label;
    b.onclick = async () => { b.disabled = true; try { await action.run(); el.remove(); } catch (e) { toast(errMsg(e), 'over'); b.disabled = false; } };
    el.appendChild(b);
  }
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), action ? 8000 : kind === 'over' ? 5000 : 3200);
}
function openSheet(html){
  const s = $('#sheet');
  s.innerHTML = `<div class="scrim" data-a="closeSheet"></div><div class="panel-s" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  s.hidden = false;
  const f = s.querySelector('input:not([type=file]):not([type=checkbox]),select'); if (f && !f.disabled && window.innerWidth > 600) f.focus();
}
function closeSheet(){
  const s = $('#sheet'); s.hidden = true; s.innerHTML = '';
  if (S.draft?.preview) URL.revokeObjectURL(S.draft.preview);
}
const sheetHead = t => `<div class="sheet-h"><h2>${t}</h2><button class="iconbtn" data-a="closeSheet" aria-label="Cerrar">${ic('close','sm')}</button></div>`;

/* ============ navegación y render ============ */
function go(screen, back){ S.ui.screen = screen; S.ui.back = back || null; render(); $('#view').scrollTop = 0; }
function render(){
  const v = $('#view'), n = $('#nav');
  if (!CONFIGURED){ v.className = 'full'; v.innerHTML = vSetupConfig(); n.hidden = true; return; }
  if (!S.user){ v.className = 'full'; v.innerHTML = vAuth(); n.hidden = true; return; }
  if (!S.profile){ v.className = 'full'; v.innerHTML = vSplash(); n.hidden = true; return; }
  if (planInfo().suspended){ v.className = 'full'; v.innerHTML = vSuspended(); n.hidden = true; return; }
  if (S.locked){ v.className = 'full'; v.innerHTML = vLock(); n.hidden = true; setTimeout(autoBio, 250); return; }
  if (S.needPinSetup){ v.className = 'full'; v.innerHTML = vPinSetup(); n.hidden = true; return; }
  v.className = '';
  const views = {home:vHome, tx:vTx, stats:vStats, more:vMore, budgets:vBudgets, goals:vGoals, family:vFamily,
    categories:vCategories, reports:vReports, alerts:vAlerts, settings:vSettings, accounts:vAccounts,
    reminders:vReminders, scheduled:vScheduled, debts:vDebts, debt:vDebt, savings:vSavings};
  v.innerHTML = (views[S.ui.screen] || vHome)();
  if (pendingGo) setTimeout(applyGo, 0);
  const tabs = [['home','Inicio','home'],['tx','Movimientos','list'],null,['stats','Estadísticas','chart'],['more','Más','grid']];
  const main = ['home','tx','stats','more'].includes(S.ui.screen) ? S.ui.screen : 'more';
  n.innerHTML = tabs.map(t => t ? `<button data-a="tab" data-v="${t[0]}" class="${main === t[0] ? 'on' : ''}" ${main === t[0] ? 'aria-current="page"' : ''}>${ic(t[2])}${t[1]}</button>`
    : `<button class="fab" data-a="add" data-v="expense" aria-label="Registrar movimiento">${ic('plus')}</button>`).join('');
  n.hidden = false;
}
const subhead = (title, extra = '') => `<div class="subhead"><button class="iconbtn" data-a="back" aria-label="Volver">${ic('back','sm')}</button><h1>${title}</h1>${extra}</div>`;
const brand = `<div class="brand"><img class="logo" src="icons/logo-mark.png" alt="" width="52" height="52"><div class="word">Kuenta</div></div>`;
const vSuspended = () => `<div class="lock">${brand}<div style="text-align:center;max-width:320px"><b style="font-size:17px">Tu cuenta está suspendida</b>
  <p class="muted" style="font-size:14px">Por ahora no puedes usar Kuenta. Si crees que es un error, escríbenos${CFG.SUPPORT_EMAIL ? ` a <b style="user-select:all">${esc(CFG.SUPPORT_EMAIL)}</b>` : ''}.</p></div>
  <button class="btn sm" data-a="signOut">Cerrar sesión</button></div>`;
const vSplash = () => `<div class="lock">${brand}<div class="spin" role="status" aria-label="Cargando"></div></div>`;
const vSetupConfig = () => `<div class="lock">${brand}<div class="note" style="max-width:340px">Falta conectar Supabase. Abre <b>config.js</b> y pega la URL de tu proyecto y la clave <b>anon</b>.</div></div>`;

/* ============ autenticación ============ */
const credit = `<div class="credit"><img src="icons/somar-labs.png" alt="" width="18" height="18">Una app de <b>Somar Labs</b></div>`;
const vAuth = () => vAuthInner().replace(/<\/div>$/, credit + '</div>');
function vAuthInner(){
  const m = S.authMsg ? `<div class="${S.authMsg.startsWith('!') ? 'err' : 'ok-msg'}" style="text-align:center">${esc(S.authMsg.replace(/^!/, ''))}</div>` : '';
  const pending = pendingInvite() ? '<div class="note" style="max-width:340px">Te invitaron a una familia en Kuenta. Entra o crea tu cuenta para aceptar.</div>' : '';
  if (S.auth === 'signup') return `<div class="lock">${brand}<h1 style="font-size:20px">Crea tu cuenta</h1>${pending}
    <form class="form" data-f="signup" novalidate>
      <div class="field"><label for="su-n">Nombre completo</label><input class="inp" id="su-n" required maxlength="80" autocomplete="name"></div>
      <div class="field"><label for="su-e">Correo</label><input class="inp" id="su-e" type="email" required autocomplete="email" inputmode="email"></div>
      ${pwField('su-p', 'Contraseña', 'required minlength="8" autocomplete="new-password" placeholder="Mínimo 8 caracteres, con letras y números"')}
      ${pwField('su-p2', 'Repite la contraseña', 'required autocomplete="new-password"')}
      <div class="err" id="ferr"></div>${m}
      <p class="muted" style="font-size:12.5px;margin:0;text-align:center">Al crear tu cuenta aceptas los <a class="link" href="terminos.html" target="_blank" rel="noopener">Términos de uso</a> y la <a class="link" href="privacidad.html" target="_blank" rel="noopener">Política de privacidad</a>.</p>
      <button class="btn" type="submit">Crear cuenta</button>
      <button type="button" class="textbtn" data-a="authMode" data-v="login">Ya tengo cuenta</button></form></div>`;
  if (S.auth === 'verify'){
    const em = S.verifyEmail || '', gmail = /@gmail\.com$/i.test(em);
    return `<div class="lock">${brand}<div class="verify">
      <div class="vi">${ic('mail')}</div>
      <h1 style="font-size:21px;text-align:center">Revisa tu correo</h1>
      <p class="muted" style="margin:0;text-align:center">Te enviamos un enlace para confirmar tu cuenta a<br><b style="color:var(--fg);word-break:break-all">${esc(em)}</b></p>
      <div class="vsteps">
        <div class="vs"><span>1</span><div><b>Busca un correo de "Kuenta"</b><small>Lo envía ${esc(CFG.SUPPORT_EMAIL || 'Kuenta')}. Puede tardar hasta 5 minutos.</small></div></div>
        <div class="vs"><span>2</span><div><b>Si no está en la bandeja principal</b><small>Revisa <b>Spam</b> o <b>Correo no deseado</b>${gmail ? ', y las pestañas <b>Promociones</b> y <b>Social</b> de Gmail' : ''}. Si está ahí, márcalo como "No es spam".</small></div></div>
        <div class="vs"><span>3</span><div><b>Toca "Confirmar mi cuenta"</b><small>Se abrirá Kuenta y podrás entrar con tu correo y contraseña.</small></div></div>
      </div>
      ${m}
      ${gmail ? '<a class="btn" href="https://mail.google.com/mail/u/0/#search/in%3Aanywhere+from%3Akuenta" target="_blank" rel="noopener">Abrir Gmail</a>' : ''}
      <button type="button" class="btn ghost" data-a="resendConfirm">¿No llegó? Reenviar correo</button>
      <button type="button" class="textbtn" data-a="authMode" data-v="login">Ya confirmé, quiero entrar</button>
      <button type="button" class="textbtn" style="color:var(--muted);font-size:13px" data-a="authMode" data-v="signup">Me equivoqué de correo</button>
    </div></div>`;
  }
  if (S.auth === 'forgot') return `<div class="lock">${brand}<h1 style="font-size:20px">Recupera tu acceso</h1>
    <form class="form" data-f="forgot" novalidate><p class="muted" style="margin:0;text-align:center">Te enviaremos un enlace para crear una contraseña nueva.</p>
      <div class="field"><label for="fg-e">Correo</label><input class="inp" id="fg-e" type="email" required autocomplete="email" value="${esc(savedEmail())}"></div>
      <div class="err" id="ferr"></div>${m}
      <button class="btn" type="submit">Enviar enlace</button>
      <button type="button" class="textbtn" data-a="authMode" data-v="login">Volver</button></form></div>`;
  if (S.auth === 'recovery') return `<div class="lock">${brand}<h1 style="font-size:20px">Nueva contraseña</h1>
    <form class="form" data-f="recovery" novalidate>
      ${pwField('rc-p', 'Contraseña nueva', 'required minlength="8" autocomplete="new-password"')}
      ${pwField('rc-p2', 'Repítela', 'required autocomplete="new-password"')}
      <div class="err" id="ferr"></div><button class="btn" type="submit">Guardar contraseña</button></form></div>`;
  return `<div class="lock">${brand}${pending}
    <form class="form" data-f="login" novalidate>
      <div class="field"><label for="lg-e">Correo</label><input class="inp" id="lg-e" type="email" required autocomplete="username" inputmode="email" value="${esc(savedEmail())}"></div>
      ${pwField('lg-p', 'Contraseña', 'required autocomplete="current-password"')}
      <label class="check"><input type="checkbox" id="lg-r" ${LS.get('rememberEmail', true) ? 'checked' : ''}> Recordar mi correo en este teléfono</label>
      <div class="err" id="ferr"></div>${m}
      <button class="btn" type="submit">Entrar</button>
      <button type="button" class="textbtn" data-a="authMode" data-v="forgot">Olvidé mi contraseña</button>
      <div class="muted" style="text-align:center;font-size:14px">¿Nuevo en Kuenta? <button type="button" class="textbtn" data-a="authMode" data-v="signup">Crear cuenta</button></div></form></div>`;
}
/* Campo de contraseña con botón para mostrarla u ocultarla */
const pwField = (id, label, attrs) => `<div class="field"><label for="${id}">${label}</label><div class="pw"><input class="inp" id="${id}" type="password" ${attrs}>
  <button type="button" class="pweye" data-a="togglePw" data-v="${id}" aria-label="Mostrar contraseña" aria-pressed="false">${ic('eye','sm')}</button></div></div>`;
const savedEmail = () => LS.get('email', '');
const strongPass = p => p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

/* ============ PIN y biometría (candado local) ============ */
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function hashPin(pin, salt){
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt, iterations:150000}, key, 256);
  return b64(bits);
}
const INVITE_KEY = 'invite';
function pendingInvite(){
  const r = LS.get(INVITE_KEY);
  if (!r || !r.token || Date.now() > r.exp){ LS.del(INVITE_KEY); return null; }
  return r.token;
}
const pinRec = () => LS.get('pin.' + me());
async function setPin(pin){ const salt = crypto.getRandomValues(new Uint8Array(16)); LS.set('pin.' + me(), {salt:b64(salt), hash:await hashPin(pin, salt)}); LS.set('tries.' + me(), 0); }
async function checkPin(pin){ const r = pinRec(); return !!r && (await hashPin(pin, unb64(r.salt))) === r.hash; }
const bioRec = () => LS.get('bio.' + me());
async function bioAvailable(){ try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; } }
async function bioEnroll(){
  const cred = await navigator.credentials.create({publicKey:{
    challenge:crypto.getRandomValues(new Uint8Array(32)), rp:{name:'Kuenta'},
    user:{id:new TextEncoder().encode(me()).slice(0, 64), name:S.user.email, displayName:S.profile.full_name || S.user.email},
    pubKeyCredParams:[{type:'public-key', alg:-7}, {type:'public-key', alg:-257}],
    authenticatorSelection:{authenticatorAttachment:'platform', userVerification:'required', residentKey:'discouraged'}, timeout:60000}});
  LS.set('bio.' + me(), {id:b64(cred.rawId)});
}
async function bioVerify(){
  const r = bioRec(); if (!r) return false;
  await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials:[{type:'public-key', id:unb64(r.id)}], userVerification:'required', timeout:60000}});
  return true;
}
function vLock(){
  const tries = LS.get('tries.' + me(), 0);
  return `<div class="lock">${brand}
    <div style="text-align:center"><b style="font-size:17px">Hola, ${esc(firstName(S.profile.full_name))}</b><div class="muted" style="font-size:13.5px">${bioRec() ? 'Usa tu huella o Face ID, o ingresa tu PIN' : 'Ingresa tu PIN para continuar'}</div></div>
    <div class="dots" id="dots">${[0,1,2,3].map(i => `<i class="${i < S.pinEntry.length ? 'f' : ''}"></i>`).join('')}</div>
    <div class="err" style="min-height:20px">${tries ? `PIN incorrecto. Te quedan ${5 - tries} intentos.` : ''}</div>
    <div class="keys">${['1','2','3','4','5','6','7','8','9','bio','0','del'].map(k =>
      k === 'bio' ? (bioRec() ? `<button data-a="bio" aria-label="Usar huella" style="color:var(--brand)">${ic('finger')}</button>` : '<span></span>')
      : k === 'del' ? `<button data-a="pin" data-v="del" aria-label="Borrar" style="font-size:16px">⌫</button>`
      : `<button data-a="pin" data-v="${k}">${k}</button>`).join('')}</div>
    ${bioRec() ? `<button class="finger" data-a="bio">${ic('finger')} Usar huella o Face ID</button>` : ''}
    <button class="textbtn" data-a="forgotPin">Olvidé mi PIN</button>
    <button class="textbtn" data-a="signOut" style="color:var(--muted)">Entrar con otra cuenta</button></div>`;
}
function vPinSetup(){
  const step = S.form.pinStep || 1;
  return `<div class="lock">${brand}
    <div style="text-align:center;max-width:300px"><b style="font-size:17px">${step === 1 ? 'Crea tu PIN de 4 dígitos' : 'Confírmalo'}</b>
      <div class="muted" style="font-size:13.5px">Lo pediremos al abrir Kuenta y tras 5 minutos fuera de la app. Se guarda cifrado solo en este teléfono.</div></div>
    <div class="dots" id="dots">${[0,1,2,3].map(i => `<i class="${i < S.pinEntry.length ? 'f' : ''}"></i>`).join('')}</div>
    <div class="err" style="min-height:20px">${S.form.pinErr ? esc(S.form.pinErr) : ''}</div>
    <div class="keys">${['1','2','3','4','5','6','7','8','9','','0','del'].map(k => k === '' ? '<span></span>'
      : `<button data-a="pinSetup" data-v="${k}" ${k === 'del' ? 'aria-label="Borrar" style="font-size:16px"' : ''}>${k === 'del' ? '⌫' : k}</button>`).join('')}</div>
    <button class="textbtn" data-a="signOut">Cerrar sesión</button></div>`;
}
/* La sesión se mantiene abierta en el teléfono: al abrir Kuenta solo se pide la huella o el PIN.
   La contraseña solo se pide al entrar por primera vez, tras "Olvidé mi PIN" o tras 5 intentos fallidos. */
let justLoggedIn = false;
function maybeLock(){ if (pinRec()){ S.locked = true; S.pinEntry = ''; S.bioAsked = false; } }
function unlock(){ LS.set('tries.' + me(), 0); S.locked = false; S.bioAsked = false; render(); }
/* Al mostrar el candado, abre la huella o Face ID sin que haya que tocar nada */
async function autoBio(){
  if (S.bioAsked || !S.locked || !bioRec() || document.visibilityState !== 'visible') return;
  S.bioAsked = true;
  try { if (await bioVerify()) unlock(); } catch {}
}

/* ============ inicio ============ */
function txRow(t, inDay = false){
  const a = acc(t.acc); if (!a) return '';
  let icon, color, title, sub, sign, cls = '';
  if (t.tg){
    const other = S.tx.find(x => x.tg === t.tg && x.id !== t.id), oa = other && acc(other.acc);
    icon = '⇄'; color = 'var(--brand)';
    title = t.type === 'transfer_out' ? `A ${oa ? oa.name : 'otra cuenta'}` : `De ${oa ? oa.name : 'otra cuenta'}`;
    sub = 'Transferencia · ' + a.name; sign = t.type === 'transfer_out' ? -1 : 1;
  } else {
    const c = cat(t.cat); icon = c.icon; color = c.color; title = t.desc || c.name;
    sub = c.name + ' · ' + a.name; sign = t.type === 'income' ? 1 : -1;
    cls = t.type === 'income' ? 'pos' : c.kind === 'generosity' ? 'gen' : '';
  }
  const by = a.shared && t.by !== me() ? `<span class="avatar sm" title="${esc(uname(t.by))}">${esc(uname(t.by)[0])}</span>` : '';
  return `<button class="tx" data-a="txDetail" data-v="${t.id}">
    <span class="tile" style="background:${soft(color)};color:${color}">${esc(icon)}</span>
    <span class="mid"><b>${esc(title)}</b><small>${S.atts[t.id] ? ic('clip','sm') : ''}${esc(sub)}</small></span>
    ${by}<span class="amt"><b class="${cls}">${sign > 0 ? '+' : '−'}${money(t.amount, a.cur).replace('−','')}</b><small>${inDay ? (t.time ? fmtTime(t.time) : '') : dShort(t.date) + (t.time ? ' · ' + fmtTime(t.time) : '')}</small></span></button>`;
}
function accCard(a){
  const b = balance(a);
  const extra = a.type === 'tarjeta' && a.limit ? `<span>Disponible ${money(a.limit + b)}</span>` : `<span>${TYPES[a.type]}</span>`;
  return `<button class="acard" data-a="accTx" data-v="${a.id}" style="background:linear-gradient(140deg, ${a.color}, color-mix(in srgb, ${a.color} 62%, #000))">
    <div class="row"><span class="lbl">${esc(a.icon)} ${esc(a.name)}</span>${a.shared ? '<span class="chip-w">Compartida</span>' : `<span class="chip-w">${a.cur}</span>`}</div>
    <div class="bal num">${money(b, a.cur)}</div>
    <div class="foot">${extra}<span>${a.type === 'tarjeta' ? 'Saldo de la tarjeta' : 'Saldo'}</span></div></button>`;
}
/* Resumen del mes: cifras grandes, centavos discretos y barra de reparto del ingreso */
function bigMoney(n){
  const [ent, dec] = nf.format(Math.abs(n)).split('.');
  const size = ent.length > 9 ? 'xs' : ent.length > 7 ? 's' : '';
  return `<b class="big ${size}">${n < 0 ? '−' : ''}<span class="cur">L</span>${ent}<span class="dec">.${dec}</span></b>`;
}
/* Diezmo pendiente del mes financiero.
   Base: ingresos de cuentas personales en lempiras. No cuentan las transferencias
   (entre cuentas propias o con la familia) ni los aportes que entran a cuentas compartidas.
   Pagado: movimientos en una categoría "Diezmo" (personal, o familiar registrada por ti). */
const isTitheCat = c => c && c.kind === 'generosity' && /diezmo/i.test(c.name);
function titheInfo(p){
  const pct = +S.profile.tithe_percent || 0;
  let base = 0, paid = 0;
  for (const t of S.tx){
    if (t.tg || t.date < p.start || t.date > p.end) continue;
    const a = acc(t.acc); if (!a || a.cur !== 'HNL') continue;
    if (t.type === 'income' && !a.shared) base += t.amount;
    else if (t.type === 'expense' && isTitheCat(cat(t.cat)) && (!a.shared || t.by === me())) paid += t.amount;
  }
  const due = round2(base * pct / 100);
  return {pct, base, due, paid, pending:Math.max(0, round2(due - paid)), extra:Math.max(0, round2(paid - due))};
}
function titheCard(){
  const pct = +S.profile.tithe_percent || 0; if (!pct) return '';
  const p = period(), t = titheInfo(p), prev = titheInfo(period(addMonths(p.start, -1)));
  const fill = t.due ? Math.min(100, t.paid / t.due * 100) : (t.paid ? 100 : 0);
  const done = t.due > 0 && t.pending === 0;
  return `<div class="section"><div class="sec-h"><h2>Diezmo</h2><span class="muted" style="font-size:12.5px">${pct}% de tus ingresos</span></div>
    <div class="tithe ${done ? 'done' : ''}">
      <div class="th-top"><span class="mi">${ic('heart','sm')}</span>
        <div class="th-tx"><small>${done ? '¡Al día este mes!' : t.due ? 'Pendiente este mes' : 'Aún no registras ingresos este mes'}</small>${t.due ? bigMoney(done ? t.paid : t.pending) : '<b class="big">—</b>'}</div>
        ${t.pending > 0 ? `<button class="btn sm" data-a="payTithe" data-v="${t.pending}">Registrar</button>` : ''}</div>
      ${t.due ? `<div class="bar" style="margin-top:12px"><i style="width:${fill}%;background:var(--gold)"></i></div>
      <div class="th-foot"><span>Dado <b>${money(t.paid)}</b></span><span>Corresponde <b>${money(t.due)}</b></span></div>` : ''}
      ${t.extra > 0 ? `<div class="th-note">Diste ${money(t.extra)} más de lo que corresponde. ¡Gracias por tu generosidad!</div>` : ''}
      ${prev.pending > 0 ? `<div class="th-note">El mes pasado quedó pendiente ${money(prev.pending)}. <button class="link" data-a="payTithe" data-v="${prev.pending}" data-d="${period(addMonths(p.start, -1)).end}">Registrarlo</button></div>` : ''}
    </div></div>`;
}
function monthCard(sm){
  const base = Math.max(sm.inc, sm.exp + sm.gen, 1);
  const w = v => Math.max(0, v / base * 100).toFixed(1);
  const left = sm.inc - sm.exp - sm.gen;
  return `<div class="month">
    <div class="mgrid">
      <div class="mt inc"><span class="mi">${ic('in','sm')}</span><small>Ingresos</small>${bigMoney(sm.inc)}</div>
      <div class="mt exp"><span class="mi">${ic('out','sm')}</span><small>Gastos</small>${bigMoney(sm.exp)}</div>
    </div>
    <div class="mt gen wide"><span class="mi">${ic('heart','sm')}</span><div class="mtx"><small>Generosidad</small>${bigMoney(sm.gen)}</div>
      <div class="mleft ${left < 0 ? 'neg' : ''}"><small>${left < 0 ? 'Te pasaste' : 'Te queda'}</small><b>${money(Math.abs(left))}</b></div></div>
    ${sm.inc > 0 || sm.exp > 0 ? `<div class="mbar" role="img" aria-label="Del ingreso: gastos ${w(sm.exp)}%, generosidad ${w(sm.gen)}%">
      <i class="e" style="width:${w(sm.exp)}%"></i><i class="g" style="width:${w(sm.gen)}%"></i><i class="l" style="width:${w(Math.max(left, 0))}%"></i></div>
    <div class="mleg"><span><i class="e"></i>Gastos</span><span><i class="g"></i>Generosidad</span><span><i class="l"></i>Libre</span></div>` : ''}
  </div>`;
}
function vHome(){
  const p = period(), accs = visAccounts();
  const sm = summary(p.start, p.end, 'personal');
  const totalHNL = accs.filter(a => a.cur === 'HNL').reduce((s, a) => s + balance(a), 0);
  const totalUSD = accs.filter(a => a.cur === 'USD').reduce((s, a) => s + balance(a), 0);
  const unread = S.notifs.filter(n => !n.read_at).length;
  const buds = S.budgets.map(b => ({b, ...budgetInfo(b)})).sort((x, y) => y.pct - x.pct).slice(0, 3);
  const recent = [...S.tx].sort(byNewest).slice(0, 6);
  const name = firstName(S.profile.full_name), up = upcoming(7);
  return `
  <div class="top"><div class="hello"><div class="avatar">${esc(name[0])}</div><div style="min-width:0"><b>Hola, ${esc(name)}</b><small>Mes financiero · ${dShort(p.start)} – ${dShort(p.end)}</small></div></div>
    <button class="iconbtn" data-a="nav" data-v="alerts" aria-label="Alertas${unread ? `, ${unread} sin leer` : ''}">${ic('bell')}${unread ? `<span class="dot">${unread > 9 ? '9+' : unread}</span>` : ''}</button></div>
  <div class="cards">
    ${accs.length ? `<div class="acard" style="background:linear-gradient(140deg,var(--card-a),var(--card-b))">
      <div class="row"><span class="lbl">Saldo total</span><span class="chip-w">${accs.length} ${accs.length === 1 ? 'cuenta' : 'cuentas'}</span></div>
      <div class="bal num">${money(totalHNL)}</div>
      <div class="foot"><div class="mini"><div><small>Ingresos</small><b>${short(sm.inc)}</b></div><div><small>Gastos</small><b>${short(sm.exp)}</b></div><div><small>Dado</small><b>${short(sm.gen)}</b></div></div>${totalUSD ? `<span>+ ${money(totalUSD, 'USD')}</span>` : ''}</div>
    </div>${accs.map(accCard).join('')}` : ''}
    <button class="acard new" data-a="newAcc">${ic('plus')}<b>${accs.length ? 'Agregar cuenta' : 'Crea tu primera cuenta'}</b><small class="muted">Efectivo, banco, tarjeta o ahorro</small></button>
  </div>
  <div class="quick">
    <button data-a="add" data-v="expense"><span class="q out">${ic('out')}</span>Gasto</button>
    <button data-a="add" data-v="income"><span class="q in">${ic('in')}</span>Ingreso</button>
    <button data-a="add" data-v="transfer"><span class="q tr">${ic('swap')}</span>Transferir</button>
    <button data-a="tab" data-v="more"><span class="q">${ic('grid')}</span>Más</button>
  </div>
  ${up.length ? `<div class="section"><div class="sec-h"><h2>Próximos pagos</h2><button class="link" data-a="nav" data-v="scheduled">Ver todos</button></div>
    <div class="list">${up.slice(0, 4).map(upRow).join('')}</div></div>` : ''}
  <div class="section"><div class="sec-h"><h2>Este mes</h2><button class="link" data-a="tab" data-v="stats">Estadísticas</button></div>
    ${monthCard(sm)}${saveTeaser()}</div>
  ${titheCard()}
  ${buds.length ? `<div class="section"><div class="sec-h"><h2>Presupuestos</h2><button class="link" data-a="nav" data-v="budgets">Ver todos</button></div>
    <div class="list">${buds.map(budRow).join('')}</div></div>` : ''}
  <div class="section"><div class="sec-h"><h2>Movimientos recientes</h2>${recent.length ? '<button class="link" data-a="tab" data-v="tx">Ver todos</button>' : ''}</div>
    <div class="list">${recent.length ? recent.map(txRow).join('') : `<div class="empty">${accs.length ? 'Toca <b>+</b> para registrar tu primer movimiento.' : 'Crea una cuenta para empezar a registrar.'}</div>`}</div></div>`;
}
function budRow(x){
  const {b, c, spent, pct, state, left, p} = x.b ? x : {b:x, ...budgetInfo(x)};
  const label = state === 'over' ? `Excedido ${money(-left, b.cur)}` : `Quedan ${money(left, b.cur)}`;
  return `<button class="bud" data-a="editBudget" data-v="${b.id}">
    <div class="h"><span class="tile" style="background:${soft(c.color)}">${esc(c.icon)}</span>
    <span class="t"><b>${esc(c.name)}</b><small class="num">${money(spent, b.cur)} de ${money(b.amount, b.cur)}${c.scope === 'f' ? ' · Familia' : ''}</small></span>
    <span class="pill ${state}">${Math.round(pct)}%</span></div>
    <div class="bar"><i class="${state}" style="width:${Math.min(100, pct)}%"></i></div>
    <small class="muted" style="font-size:12px">${label} · ${daysLeft(p.end)} días restantes</small></button>`;
}

/* ============ movimientos ============ */
function vTx(){
  const u = S.ui;
  let list = S.tx;
  if (u.txAcc) list = list.filter(t => t.acc === u.txAcc);
  if (u.txFilter !== 'all') list = list.filter(t => u.txFilter === 'transfer' ? !!t.tg
    : u.txFilter === 'income' ? t.type === 'income'
    : u.txFilter === 'generosity' ? (!t.tg && cat(t.cat).kind === 'generosity')
    : t.type === 'expense' && cat(t.cat).kind === 'expense');
  if (u.txQuery){ const qq = u.txQuery.toLowerCase(); list = list.filter(t => t.desc.toLowerCase().includes(qq) || (!t.tg && cat(t.cat).name.toLowerCase().includes(qq)) || t.note.toLowerCase().includes(qq)); }
  list = [...list].sort(byNewest);
  const lim = S.ui.txLimit || 150;
  let html = '', day = '';
  for (const t of list.slice(0, lim)){ if (t.date !== day){ day = t.date; html += `<div class="dayh">${dLong(day)}</div>`; } html += txRow(t, true); }
  const f = [['all','Todos'],['expense','Gastos'],['income','Ingresos'],['generosity','Generosidad'],['transfer','Transferencias']];
  return `<div class="subhead"><h1>Movimientos</h1></div>
  <div class="search">${ic('search','sm')}<input id="q" type="search" placeholder="Buscar por comercio, nota o categoría" value="${esc(u.txQuery)}" data-in="txQuery" aria-label="Buscar"></div>
  <div class="chips">${f.map(([k, l]) => `<button class="chip ${u.txFilter === k ? 'on' : ''}" data-a="txFilter" data-v="${k}">${l}</button>`).join('')}</div>
  <div class="chips" style="margin-top:8px"><button class="chip ${!u.txAcc ? 'on' : ''}" data-a="txAcc" data-v="">Todas las cuentas</button>${S.accounts.map(a => `<button class="chip ${u.txAcc === a.id ? 'on' : ''}" data-a="txAcc" data-v="${a.id}">${esc(a.icon)} ${esc(a.name)}</button>`).join('')}</div>
  <div class="list" style="margin-top:6px">${html || '<div class="empty" style="margin-top:12px">No hay movimientos con estos filtros.</div>'}</div>
  ${list.length > lim ? `<button class="btn ghost" style="margin-top:12px" data-a="moreTx">Ver más (${list.length - lim})</button>` : ''}`;
}
async function txDetail(id){
  const t = S.tx.find(x => x.id === id); if (!t) return;
  const a = acc(t.acc), c = t.tg ? null : cat(t.cat);
  const other = t.tg ? S.tx.find(x => x.tg === t.tg && x.id !== t.id) : null;
  const editable = canEditTx(t);
  const color = c ? c.color : 'var(--brand)';
  const typeLabel = t.tg ? 'Transferencia' : t.type === 'income' ? 'Ingreso' : c.kind === 'generosity' ? 'Generosidad' : 'Gasto';
  const atts = S.atts[t.id] || [];
  const fromA = t.type === 'transfer_in' ? acc(other?.acc) : a, toA = t.type === 'transfer_in' ? a : acc(other?.acc);
  openSheet(`${sheetHead(typeLabel)}
    <div style="text-align:center;margin-bottom:16px"><span class="tile" style="margin:0 auto 8px;width:56px;height:56px;font-size:26px;background:${soft(color)};color:${color}">${esc(c ? c.icon : '⇄')}</span>
      <div class="num" style="font-size:32px;font-weight:700">${money(t.amount, a.cur)}</div><div class="muted">${esc(t.desc || (c && c.name) || '')}</div></div>
    <div class="panel"><table class="rep">
      ${c ? `<tr><td class="muted">Categoría</td><td class="r">${esc(c.icon)} ${esc(c.parent ? cat(c.parent).name + ' › ' : '')}${esc(c.name)}</td></tr>` : ''}
      <tr><td class="muted">${t.tg ? 'Desde' : 'Cuenta'}</td><td class="r">${esc(t.tg ? (fromA?.name || '—') : a.name)}</td></tr>
      ${t.tg ? `<tr><td class="muted">Hacia</td><td class="r">${esc(toA?.name || '—')}</td></tr>` : ''}
      <tr><td class="muted">Fecha${t.time ? ' y hora' : ''}</td><td class="r">${dLong(t.date)}${t.time ? ' · ' + fmtTime(t.time) : ''}</td></tr>
      <tr><td class="muted">Registrado por</td><td class="r">${esc(uname(t.by))}</td></tr>
      ${t.note ? `<tr><td class="muted">Nota</td><td class="r" style="white-space:normal">${esc(t.note)}</td></tr>` : ''}
    </table></div>
    ${t.tg ? '' : `<div class="section" style="margin-top:16px"><div class="sec-h"><h2>Comprobante</h2></div><div id="attbox">
      ${atts.length ? '<div class="spin" style="margin:10px auto"></div>' : editable ? `<label class="upload">${ic('camera')} Adjuntar foto o PDF<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-up="${t.id}"></label>` : '<div class="empty">Sin comprobante</div>'}
    </div></div>`}
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
      ${editable ? `<button class="btn" data-a="editTx" data-v="${t.id}">${ic('edit','sm')} Editar ${t.tg ? 'transferencia' : 'movimiento'}</button>
        <div id="delbox"><button class="btn danger" data-a="askDel" data-v="${t.id}">${ic('trash','sm')} Eliminar ${t.tg ? 'transferencia' : 'movimiento'}</button></div>`
      : `<div class="note">${role() === 'viewer' && a.shared ? 'Tu rol es de solo lectura.' : 'Solo quien lo registró o el dueño de la familia puede modificarlo.'}</div>`}
    </div>`);
  if (atts.length){
    const box = $('#attbox');
    try {
      const parts = await Promise.all(atts.map(async x => {
        const {data, error} = await sb.storage.from(BUCKET).createSignedUrl(x.storage_path, 300);
        if (error) throw error;
        return x.mime_type === 'application/pdf'
          ? `<a class="btn ghost" href="${esc(data.signedUrl)}" target="_blank" rel="noopener noreferrer">${ic('file','sm')} Abrir PDF</a>`
          : `<div class="receipt"><img src="${esc(data.signedUrl)}" alt="Comprobante"></div>`;
      }));
      if (box) box.innerHTML = parts.join('') + (editable ? `<label class="upload" style="margin-top:8px">${ic('camera')} Agregar otro<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-up="${t.id}"></label>` : '');
    } catch (e) { if (box) box.innerHTML = `<div class="err">${esc(errMsg(e))}</div>`; }
  }
}

/* ============ comprobantes ============ */
async function compress(file){
  if (!/^image\//.test(file.type) || (file.size < 600 * 1024 && file.type !== 'image/png')) return file;
  const bmp = await createImageBitmap(file).catch(() => null); if (!bmp) return file;
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  return blob && blob.size < file.size ? new File([blob], 'comprobante.jpg', {type:'image/jpeg'}) : file;
}
function validFile(file){
  if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type)) { toast('Solo se aceptan fotos JPG, PNG, WEBP o PDF.', 'over'); return false; }
  if (file.size > 5 * 1024 * 1024 && file.type === 'application/pdf') { toast('El PDF pasa de 5 MB. Elige uno más liviano.', 'over'); return false; }
  return true;
}
async function uploadAttachment(txId, file){
  const f = await compress(file);
  if (f.size > 5 * 1024 * 1024) throw new Error('El archivo pasa de 5 MB aun comprimido.');
  const ext = f.type === 'application/pdf' ? 'pdf' : f.type.split('/')[1].replace('jpeg', 'jpg');
  const path = `${me()}/${txId}/${crypto.randomUUID()}.${ext}`;
  await q(sb.storage.from(BUCKET).upload(path, f, {contentType:f.type, upsert:false, cacheControl:'3600'}));
  try {
    const row = await q(sb.from('attachments').insert({transaction_id:txId, storage_path:path, mime_type:f.type, size_bytes:f.size, uploaded_by:me()}).select().single());
    (S.atts[txId] ||= []).push(row);
  } catch (e) { await sb.storage.from(BUCKET).remove([path]); throw e; }
}

/* ============ registrar (3 toques) ============ */
function startAdd(type){
  const accs = writableAccounts();
  if (!accs.length){ toast(S.accounts.length ? 'Tu rol no permite registrar movimientos.' : 'Primero crea una cuenta.', 'warn'); if (!S.accounts.length) accSheet(null); return; }
  if (type === 'transfer' && accs.length < 2){ toast('Necesitas al menos dos cuentas para transferir.', 'warn'); return; }
  const last = LS.get('lastAcc.' + me());
  const first = accs.find(a => a.id === last) || accs.find(a => !a.shared) || accs[0];
  S.draft = {type, amount:'0', acc:first.id, cat:null, date:TODAY, time:nowHM(), desc:'', note:'', file:null, preview:null, step:1,
    from:first.id, to:(accs.find(a => a.id !== first.id) || first).id, toAmount:''};
  renderAdd();
}
/* Editar un movimiento: el mismo formulario de registro, con sus datos cargados */
function startEdit(id){
  const t = S.tx.find(x => x.id === id); if (!t || !canEditTx(t)) return;
  const base = {amount:String(t.amount), date:t.date, time:t.time, desc:t.desc, note:t.note, file:null, preview:null, fresh:true};
  if (t.tg){
    const out = t.type === 'transfer_out' ? t : S.tx.find(x => x.tg === t.tg && x.type === 'transfer_out');
    const inn = S.tx.find(x => x.tg === t.tg && x.type === 'transfer_in');
    if (!out || !inn) return toast('No se encontró la otra parte de la transferencia.', 'over');
    S.draft = {...base, type:'transfer', amount:String(out.amount), from:out.acc, to:inn.acc, toAmount:acc(out.acc)?.cur !== acc(inn.acc)?.cur ? String(inn.amount) : '',
      desc:out.desc, editTg:t.tg, acc:out.acc, cat:null, step:1};
  } else S.draft = {...base, type:t.type, acc:t.acc, cat:t.cat, step:1, editId:t.id};
  renderAdd();
}
function amountText(d){
  const cur = acc(d.type === 'transfer' ? d.from : d.acc)?.cur || 'HNL';
  const [i, f] = d.amount.split('.');
  return (cur === 'USD' ? '$ ' : 'L ') + Number(i).toLocaleString('en-US') + (d.amount.includes('.') ? '.' + f : '');
}
function renderAdd(){
  const d = S.draft, accs = writableAccounts();
  // Solo el dueño de la familia saca dinero de una cuenta compartida
  const fromAccs = isOwner() ? accs : accs.filter(a => !a.shared);
  const editing = !!(d.editId || d.editTg), title = editing ? 'Editar movimiento' : 'Nuevo movimiento';
  // Al editar no se puede convertir un gasto en transferencia ni al revés
  const types = d.editTg ? [] : d.editId ? [['expense','Gasto'],['income','Ingreso']] : [['expense','Gasto'],['income','Ingreso'],['transfer','Transferir']];
  const seg = types.length ? `<div class="seg" style="margin-bottom:12px">${types.map(([k, l]) =>
    `<button class="${d.type === k ? 'on' : ''}" data-a="dType" data-v="${k}">${l}</button>`).join('')}</div>` : '';
  const when = `<div class="row2"><div class="field"><label for="dDate">Fecha</label><input class="inp" id="dDate" type="date" value="${d.date}" max="${TODAY}" data-in="date"></div>
      ${S.hasTime ? `<div class="field"><label for="dTime">Hora</label><input class="inp" id="dTime" type="time" value="${esc(d.time || '')}" data-in="time"></div>` : ''}</div>`;
  const accChips = (key, label) => `<div class="eyebrow" style="margin:12px 0 6px">${label}</div><div class="accsel">${(key === 'from' ? fromAccs : accs).map(a =>
    `<button class="${d[key] === a.id ? 'on' : ''}" data-a="dAcc" data-k="${key}" data-v="${a.id}"><span style="font-size:18px">${esc(a.icon)}</span><span>${esc(a.name)}<small class="num">${money(balance(a), a.cur)}</small></span></button>`).join('')}</div>`;
  const keypad = `<div class="keys">${['1','2','3','4','5','6','7','8','9','.','0','del'].map(k =>
    `<button data-a="key" data-v="${k}" ${k === 'del' ? 'aria-label="Borrar"' : ''}>${k === 'del' ? '⌫' : k}</button>`).join('')}</div>`;
  const amt = `<div class="amount"><span class="num ${d.fresh ? 'fresh' : ''}" id="amt">${amountText(d)}</span>${d.fresh ? '<small class="muted" style="display:block;font-size:12px">Escribe para cambiar el monto</small>' : ''}</div>`;
  if (d.type === 'transfer'){
    if (!fromAccs.length){
      openSheet(`${sheetHead(title)}${seg}<div class="empty">Para transferir necesitas una cuenta personal. Solo el dueño de la familia puede sacar dinero de las cuentas compartidas.</div>`);
      return;
    }
    if (!fromAccs.some(a => a.id === d.from)) d.from = fromAccs[0].id;
    if (d.to === d.from) d.to = (accs.find(a => a.id !== d.from) || accs[0]).id;
    const fa = acc(d.from), ta = acc(d.to), diff = fa.cur !== ta.cur;
    openSheet(`${sheetHead(title)}${seg}${amt}${accChips('from','Desde')}${accChips('to','Hacia')}
      ${diff ? `<div class="field" style="margin-top:12px"><label for="toAmt">Monto que recibe ${esc(ta.name)} (${ta.cur})</label><input class="inp" id="toAmt" inputmode="decimal" placeholder="Monedas distintas: indica el monto recibido" value="${esc(d.toAmount)}" data-in="toAmount"></div>` : ''}
      <div class="field" style="margin-top:12px"><label for="trDesc">Descripción (opcional)</label><input class="inp" id="trDesc" maxlength="120" value="${esc(d.desc)}" data-in="desc" placeholder="Ej: Aporte a la casa"></div>
      <div class="field" style="margin-top:12px"><label for="dDate">Fecha</label><input class="inp" id="dDate" type="date" value="${d.date}" max="${TODAY}" data-in="date"></div>
      <div class="err" id="derr" style="margin-top:8px"></div>${keypad}
      <button class="btn" style="margin-top:12px" data-a="saveTransfer">${ic(editing ? 'check' : 'swap','sm')} ${editing ? 'Guardar cambios' : 'Transferir'}</button>`);
    return;
  }
  if (d.step === 1){
    openSheet(`${sheetHead(title)}${seg}${amt}${accChips('acc','Cuenta')}${keypad}
      <div class="err" id="derr" style="margin-top:8px"></div>
      <button class="btn" style="margin-top:6px" data-a="dNext">${editing ? 'Siguiente' : 'Elegir categoría'} ${ic('right','sm')}</button>`);
    return;
  }
  const a = acc(d.acc), sc = a.shared ? 'f' : 'p';
  const kinds = d.type === 'income' ? ['income'] : ['expense','generosity'];
  const since = addDays(TODAY, -60), usage = {};
  S.tx.forEach(t => { if (t.cat && t.date >= since) usage[t.cat] = (usage[t.cat] || 0) + 1; });
  const cats = S.categories.filter(c => c.scope === sc && kinds.includes(c.kind) && !c.archived)
    .sort((x, y) => (usage[y.id] || 0) - (usage[x.id] || 0) || (x.kind === y.kind ? x.sort - y.sort : x.kind === 'generosity' ? 1 : -1));
  openSheet(`<div class="sheet-h"><button class="iconbtn" data-a="dBack" aria-label="Atrás">${ic('back','sm')}</button>
      <div style="text-align:center;min-width:0"><div class="num" style="font-size:22px;font-weight:700">${money(Number(d.amount), a.cur)}</div><small class="muted">${esc(a.icon)} ${esc(a.name)}</small></div>
      <button class="iconbtn" data-a="closeSheet" aria-label="Cerrar">${ic('close','sm')}</button></div>
    <div class="eyebrow" style="margin-bottom:8px">Categoría${sc === 'f' ? ' de la familia' : ''} · más usadas primero</div>
    ${cats.length ? `<div class="catgrid">${cats.map(c => `<button class="${d.cat === c.id ? 'on' : ''}" data-a="dCat" data-v="${c.id}"><span class="e">${esc(c.icon)}</span>${esc(c.name)}</button>`).join('')}</div>`
      : '<div class="empty">No hay categorías para esta cuenta. Créalas en Más → Categorías.</div>'}
    <div class="form" style="margin-top:16px">
      ${when}
      <div class="field"><label for="dDesc">Descripción</label><input class="inp" id="dDesc" maxlength="120" placeholder="Ej: La Colonia" value="${esc(d.desc)}" data-in="desc"></div>
      <div class="field"><label for="dNote">Nota (opcional)</label><input class="inp" id="dNote" maxlength="500" value="${esc(d.note)}" data-in="note"></div>
      ${editing ? '' : d.file ? `<div class="receipt">${d.preview ? `<img src="${d.preview}" alt="Comprobante adjunto">` : `<div class="note">${ic('file','sm')} ${esc(d.file.name)}</div>`}</div><button type="button" class="textbtn" data-a="dRmFile">Quitar comprobante</button>`
        : `<label class="upload">${ic('camera')} Adjuntar comprobante (opcional)<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-up="draft"></label>`}
      <div class="err" id="derr"></div>
      <button class="btn" data-a="saveTx" ${d.cat ? '' : 'disabled'}>${ic('check','sm')} ${editing ? 'Guardar cambios' : 'Guardar ' + (d.type === 'income' ? 'ingreso' : 'gasto')}</button>
    </div>`);
}
/* La fecha y la hora no pueden estar en el futuro (5 minutos de margen) */
function whenError(d){
  if (!d.date || d.date > TODAY) return 'La fecha no puede ser futura.';
  if (S.hasTime && d.time && !/^([01]\d|2[0-3]):[0-5]\d/.test(d.time)) return 'Revisa la hora.';
  if (S.hasTime && d.time && d.date === TODAY && d.time > (() => { const x = new Date(Date.now() + 5 * 60000); return localISO(x) > TODAY ? '23:59' : `${pad(x.getHours())}:${pad(x.getMinutes())}`; })()) return 'La hora no puede ser futura.';
  return '';
}
async function saveTx(){
  const d = S.draft, amount = round2(Number(d.amount)), c = cat(d.cat), a = acc(d.acc);
  if (!(amount > 0)) return ($('#derr').textContent = 'Escribe un monto mayor que cero.');
  const we = whenError(d); if (we) return ($('#derr').textContent = we);
  const fields = withTime({account_id:d.acc, category_id:d.cat, type:d.type, amount, occurred_on:d.date,
    description:d.desc.trim().slice(0, 120) || null, notes:d.note.trim().slice(0, 500) || null}, d.time && d.time.slice(0, 5));
  if (d.editId){
    const row = await q(sb.from('transactions').update(fields).eq('id', d.editId).select().single());
    const i = S.tx.findIndex(x => x.id === d.editId); if (i >= 0) S.tx[i] = mapTx(row);
    LS.set('lastAcc.' + me(), d.acc); closeSheet(); S.draft = null;
    await afterWrite(); render(); txDetail(row.id); toast('Cambios guardados');
    return;
  }
  const row = await q(sb.from('transactions').insert({...fields, created_by:me()}).select().single());
  const t = mapTx(row); S.tx.unshift(t);
  LS.set('lastAcc.' + me(), d.acc); LS.set('lastTx.' + me(), Date.now()); markRemindersRead();
  const file = d.file; closeSheet(); S.draft = null; render();
  if (file){ try { await uploadAttachment(t.id, file); render(); } catch (e) { toast('El movimiento se guardó, pero el comprobante no: ' + errMsg(e), 'over'); } }
  if (t.type === 'expense') toast(`${c.kind === 'generosity' ? 'Generosidad' : 'Gasto'} guardado`);
  else {
    const pct = +S.profile.tithe_percent;
    const tithe = S.categories.find(x => x.scope === 'p' && x.kind === 'generosity' && /^diezmo$/i.test(x.name) && !x.archived);
    if (!a.shared && pct > 0 && tithe && a.cur === 'HNL'){
      const amt = round2(t.amount * pct / 100);
      toast(`Ingreso guardado. ¿Registrar diezmo de ${money(amt)}?`, 'ok', {label:'Registrar', run: async () => {
        const r = await q(sb.from('transactions').insert(withTime({account_id:t.acc, category_id:tithe.id, type:'expense', amount:amt, occurred_on:t.date,
          description:('Diezmo de ' + (t.desc || c.name)).slice(0, 120), created_by:me()}, t.time)).select().single());
        S.tx.unshift(mapTx(r)); await afterWrite(); render(); toast('Diezmo registrado');
      }});
    } else toast('Ingreso guardado');
  }
  await afterWrite(); render();
}
async function saveTransfer(){
  const d = S.draft, amount = round2(Number(d.amount)), err = $('#derr');
  const fa = acc(d.from), ta = acc(d.to);
  if (d.from === d.to) return (err.textContent = 'Elige dos cuentas distintas.');
  if (!(amount > 0)) return (err.textContent = 'Escribe un monto mayor que cero.');
  let toAmt = null;
  if (fa.cur !== ta.cur){ toAmt = round2(parseAmt(d.toAmount)); if (!(toAmt > 0)) return (err.textContent = `Indica cuánto recibe ${ta.name} en ${ta.cur}.`); }
  if (!d.date || d.date > TODAY) return (err.textContent = 'La fecha no puede ser futura.');
  // Editar = crear la nueva y luego borrar la anterior (si algo falla, nunca se pierde dinero: a lo sumo queda duplicada)
  await q(sb.rpc('create_transfer', {p_from:fa.id, p_to:ta.id, p_amount:amount, p_date:d.date,
    p_description:(d.desc.trim() || `${fa.name} → ${ta.name}`).slice(0, 120), p_to_amount:toAmt}));
  if (d.editTg) await q(sb.rpc('delete_transfer', {p_group:d.editTg}));
  const edited = !!d.editTg; closeSheet(); S.draft = null;
  await Promise.all([loadTx(), afterWrite()]); render(); toast(edited ? 'Transferencia actualizada' : 'Transferencia realizada');
}

/* ============ estadísticas ============ */
function donut(items){
  const r = 56, C = 2 * Math.PI * r; let off = 0;
  const segs = items.map(x => { const len = C * x.p / 100; const s = `<circle cx="75" cy="75" r="${r}" fill="none" stroke="${x.c.color}" stroke-width="20" stroke-dasharray="${Math.max(0, len - 2)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 75 75)"/>`; off += len; return s; }).join('');
  return `<svg viewBox="0 0 150 150" width="150" height="150" role="img" aria-label="Gastos por categoría"><circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="20"/>${segs}</svg>`;
}
function trendChart(scope){
  const sd = dayFor(scope), cur = period(TODAY, sd).start, data = [];
  for (let i = 5; i >= 0; i--){ const s = addMonths(cur, -i), e = period(s, sd).end; data.push({s, e, ...summary(s, e, scope)}); }
  const max = Math.max(1, ...data.map(d => Math.max(d.inc, d.exp + d.gen)));
  const step = max > 60000 ? 20000 : max > 30000 ? 10000 : max > 12000 ? 5000 : max > 4000 ? 2000 : 1000, top = Math.ceil(max / step) * step;
  const W = 340, H = 180, L = 34, B = 24, T = 8, cw = (W - L - 6) / 6, y = v => T + (H - T - B) * (1 - v / top);
  let g = '';
  for (let v = 0; v <= top; v += step) g += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${short(v).replace('L','')}</text>`;
  data.forEach((d, i) => {
    const x = L + i * cw + cw * .18, bw = cw * .3;
    g += `<rect x="${x}" y="${y(d.inc)}" width="${bw}" height="${Math.max(0, y(0) - y(d.inc))}" rx="4" fill="var(--pos)"><title>Ingresos ${money(d.inc)}</title></rect>`;
    g += `<rect x="${x + bw + 3}" y="${y(d.exp)}" width="${bw}" height="${Math.max(0, y(0) - y(d.exp))}" fill="var(--neg)"><title>Gastos ${money(d.exp)}</title></rect>`;
    g += `<rect x="${x + bw + 3}" y="${y(d.exp + d.gen)}" width="${bw}" height="${Math.max(0, y(d.exp) - y(d.exp + d.gen))}" fill="var(--gold)"><title>Generosidad ${money(d.gen)}</title></rect>`;
    g += `<text x="${L + i * cw + cw / 2}" y="${H - 6}" text-anchor="middle" ${i === 5 ? 'style="font-weight:700;fill:var(--fg)"' : ''}>${mon(d.e)}</text>`;
  });
  const key = (c, l) => `<span><i style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${c}"></i> ${l}</span>`;
  return `<div style="overflow-x:auto"><svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" style="min-width:300px" role="img" aria-label="Ingresos y gastos de los últimos 6 meses">${g}</svg></div>
    <div style="display:flex;gap:14px;font-size:12px;color:var(--muted);margin-top:6px;flex-wrap:wrap">${key('var(--pos)','Ingresos')}${key('var(--neg)','Gastos')}${key('var(--gold)','Generosidad')}</div>`;
}
function ring(pct, color, label){
  const r = 26, C = 2 * Math.PI * r;
  return `<div class="ring"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="7"/><circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C * pct / 100} ${C}"/></svg><b>${label}</b></div>`;
}
const scopeSeg = (key, val) => hasFamily() ? `<div class="seg"><button type="button" class="${val === 'personal' ? 'on' : ''}" data-a="setScope" data-k="${key}" data-v="personal">Personal</button><button type="button" class="${val === 'family' ? 'on' : ''}" data-a="setScope" data-k="${key}" data-v="family">Familia</button></div>` : '';
function vStats(){
  const u = S.ui; if (!hasFamily()) u.statsScope = 'personal';
  const sc = u.statsScope, sd = dayFor(sc);
  const p = period(addMonths(period(TODAY, sd).start, u.statsOff), sd);
  const sm = summary(p.start, p.end, sc), bd = breakdown(p.start, p.end, sc, 'expense');
  const tithePct = sm.inc ? sm.gen / sm.inc * 100 : 0, goalPct = +S.profile.tithe_percent, ti = titheInfo(p);
  let members = '';
  if (sc === 'family'){
    const m = {}; S.tx.forEach(t => { const a = acc(t.acc); if (!a?.shared || t.type !== 'expense' || t.date < p.start || t.date > p.end) return; m[t.by] = (m[t.by] || 0) + t.amount; });
    const tot = Object.values(m).reduce((a, b) => a + b, 0);
    members = `<div class="section"><div class="sec-h"><h2>Gasto por miembro</h2></div><div class="panel legend">${Object.entries(m).sort((a, b) => b[1] - a[1]).map(([id, v]) =>
      `<div class="li"><span class="avatar sm">${esc(uname(id)[0])}</span><span>${esc(uname(id))}</span><b>${money(v)}</b><small>${Math.round(v / tot * 100)}%</small></div>`).join('') || '<span class="muted">Sin gastos en este período.</span>'}</div></div>`;
  }
  return `<div class="subhead"><h1>Estadísticas</h1></div>${scopeSeg('statsScope', sc)}
  <div style="display:flex;align-items:center;justify-content:space-between;margin:14px 0">
    <button class="iconbtn" data-a="statsOff" data-v="-1" aria-label="Período anterior">${ic('back','sm')}</button>
    <div style="text-align:center"><b class="num">${dShort(p.start)} – ${dShort(p.end)}</b><div class="muted" style="font-size:12px">${u.statsOff === 0 ? 'Mes financiero actual' : `Hace ${-u.statsOff} ${u.statsOff === -1 ? 'mes' : 'meses'}`}</div></div>
    <button class="iconbtn" data-a="statsOff" data-v="1" aria-label="Período siguiente" ${u.statsOff >= 0 ? 'disabled style="opacity:.35"' : ''}>${ic('right','sm')}</button></div>
  <div class="panel" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <div><div class="eyebrow">Ingresos</div><div class="num pos" style="font-size:19px;font-weight:700">${money(sm.inc)}</div></div>
    <div><div class="eyebrow">Gastos</div><div class="num" style="font-size:19px;font-weight:700">${money(sm.exp)}</div></div>
    <div><div class="eyebrow">Generosidad</div><div class="num gen" style="font-size:19px;font-weight:700">${money(sm.gen)}</div></div>
    <div><div class="eyebrow">Ahorro</div><div class="num" style="font-size:19px;font-weight:700;color:${sm.net >= 0 ? 'var(--pos)' : 'var(--neg)'}">${sm.rate === null ? '—' : Math.round(sm.rate) + '%'}</div><small class="muted num">${money(sm.net)}</small></div>
  </div>
  <div class="section"><div class="sec-h"><h2>Gastos por categoría</h2></div>
    <div class="panel">${bd.length ? `<div style="display:flex;justify-content:center;margin-bottom:12px;position:relative">${donut(bd)}<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;pointer-events:none"><div><small class="muted">Total</small><div class="num" style="font-weight:700">${short(sm.exp)}</div></div></div></div>
      <div class="legend">${bd.map(x => `<div class="li"><i style="background:${x.c.color}"></i><span>${esc(x.c.icon)} ${esc(x.c.name)}</span><b>${money(x.v)}</b><small>${x.p.toFixed(1)}%</small></div>`).join('')}</div>` : '<div class="muted">Sin gastos en este período.</div>'}</div></div>
  ${sc === 'personal' ? `<div class="section"><div class="sec-h"><h2>Generosidad</h2></div><div class="panel" style="display:flex;gap:14px;align-items:center">
    ${ring(goalPct ? Math.min(100, tithePct / goalPct * 100) : 0, 'var(--gold)', Math.round(tithePct) + '%')}
    <div style="min-width:0"><b>${money(sm.gen)} dados este mes</b><div class="muted" style="font-size:13px">Equivale al ${tithePct.toFixed(1)}% de tus ingresos.${goalPct ? ` Diezmo (${goalPct}%): corresponde ${money(ti.due)}, dado ${money(ti.paid)}${ti.pending ? `, <b style="color:var(--gold)">pendiente ${money(ti.pending)}</b>` : ' — al día'}.` : ''}</div></div></div></div>` : ''}
  <div class="section"><div class="sec-h"><h2>Últimos 6 meses</h2></div><div class="panel">${trendChart(sc)}</div></div>
  ${members}`;
}

/* ============ Más ============ */
function vMore(){
  const items = [['accounts','wallet','Cuentas',`${visAccounts().length} activas`],['budgets','gauge','Presupuestos',`${S.budgets.length} activos`],
    ['goals','target','Metas de ahorro',`${S.goals.length} metas`],['savings','spark','Ahorro inteligente','Tu plan, nivel y retos'],
    ['debts','card','Deudas',`${S.debts.filter(d => d.status === 'active').length} activas`],['scheduled','calendar','Pagos programados',`${S.scheduled.filter(s => s.active).length} activos`],
    ['family','users','Familia',S.family ? S.family.name : 'Crea o únete a una'],
    ['categories','tag','Categorías','Personaliza las tuyas'],['reports','file','Informes','PDF y Excel por fechas'],
    ['reminders','bell','Recordatorios',S.reminder?.enabled ? S.reminder.times.map(fmtTime).join(' · ') : 'Desactivados'],
    ['alerts','bell','Alertas',`${S.notifs.filter(n => !n.read_at).length} sin leer`],['settings','gear','Ajustes','Seguridad y preferencias']];
  return `<div class="subhead"><h1>Más</h1></div>
  <div class="panel" style="display:flex;align-items:center;gap:12px;margin-bottom:14px"><div class="avatar">${esc(firstName(S.profile.full_name)[0])}</div>
    <div style="flex:1;min-width:0"><b>${esc(S.profile.full_name || 'Sin nombre')}</b><div class="muted" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis">${esc(S.user.email)}</div></div>
    <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end"><span class="pill ${planInfo().plan === 'pro' ? 'gold' : 'mute'}">${esc(planInfo().name)}</span>${role() ? `<span class="pill brand">${ROLES[role()]}</span>` : ''}</div></div>
  <div class="hub">${items.map(([k, i, t, s]) => `<button data-a="nav" data-v="${k}"><span class="hi">${ic(i,'sm')}</span><span style="min-width:0"><b>${t}</b><small>${esc(s)}</small></span></button>`).join('')}</div>
  ${pinRec() ? `<button class="btn ghost" style="margin-top:16px" data-a="lockNow">${ic('lock','sm')} Bloquear ahora</button>` : ''}`;
}

/* ---- cuentas ---- */
function vAccounts(){
  const group = (title, arr) => arr.length ? `<div class="section"><div class="sec-h"><h2>${title}</h2></div><div class="list">${arr.map(a => {
    const b = balance(a);
    return `<button class="tx" data-a="editAcc" data-v="${a.id}" style="${a.archived ? 'opacity:.6' : ''}"><span class="tile" style="background:${soft(a.color)}">${esc(a.icon)}</span>
      <span class="mid"><b>${esc(a.name)}</b><small>${TYPES[a.type]} · ${a.cur}${a.archived ? ' · Archivada' : ''}</small></span>
      <span class="amt"><b class="${b < 0 ? 'neg' : ''}">${money(b, a.cur)}</b></span></button>`; }).join('')}</div></div>` : '';
  return `${subhead('Cuentas', `<button class="btn sm" data-a="newAcc">${ic('plus','sm')} Nueva</button>`)}
  ${S.accounts.length ? '' : '<div class="empty">Aún no tienes cuentas. Crea la primera: efectivo, banco, tarjeta o ahorro.</div>'}
  ${group('Personales', S.accounts.filter(a => !a.shared))}
  ${group('Compartidas con la familia', S.accounts.filter(a => a.shared))}
  ${hasFamily() && !isOwner() ? '<div class="note" style="margin-top:14px">Solo el dueño de la familia puede crear cuentas compartidas.</div>' : ''}`;
}
function accSheet(id){
  const a = id ? acc(id) : {name:'', type:'banco', cur:S.profile.default_currency || 'HNL', init:0, limit:null, color:COLORS[0], icon:'🏦', shared:false, owner:me(), archived:false};
  const editable = !id || (a.shared ? isOwner() : a.owner === me());
  const hasTx = id && S.tx.some(t => t.acc === id);
  const gb = guessBank(a);
  S.form = {color:a.color, bank:gb ? gb.id : '', autoName:''};
  openSheet(`${sheetHead(id ? 'Editar cuenta' : 'Nueva cuenta')}
    <form class="form" data-f="acc" data-id="${id || ''}" novalidate>
      <div class="accprev" id="accprev" style="--c:${a.color}"><span class="ai">${esc(TYPE_ICON[a.type] || a.icon)}</span><div><b>${esc(a.name || 'Nombre de la cuenta')}</b><small>${[gb ? gb.s : null, TYPES[a.type]].filter(Boolean).join(' · ')}</small></div></div>
      <div class="row2"><div class="field"><label for="ac-t">Tipo</label><select class="inp" id="ac-t" data-in="acctype" ${editable ? '' : 'disabled'}>${Object.entries(TYPES).map(([k, l]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="ac-c">Moneda</label><select class="inp" id="ac-c" ${hasTx || !editable ? 'disabled' : ''}><option value="HNL" ${a.cur === 'HNL' ? 'selected' : ''}>Lempiras (L)</option><option value="USD" ${a.cur === 'USD' ? 'selected' : ''}>Dólares ($)</option></select></div></div>
      <div class="field" id="bankf" ${BANK_TYPES.includes(a.type) ? '' : 'hidden'}><label for="ac-b">Banco o billetera</label><select class="inp" id="ac-b" data-in="bank" ${editable ? '' : 'disabled'}>
        <option value="">Otro / ninguno</option>${BANKS.map(b => `<option value="${b.id}" ${gb && gb.id === b.id ? 'selected' : ''}>${esc(b.n)}</option>`).join('')}</select></div>
      <div class="field"><label for="ac-n">Nombre</label><input class="inp" id="ac-n" data-in="accName" required maxlength="50" value="${esc(a.name)}" placeholder="Ej: Ahorro Banpaís" ${editable ? '' : 'disabled'}></div>
      <div class="row2"><div class="field"><label for="ac-i">Saldo inicial</label><input class="inp" id="ac-i" inputmode="decimal" value="${a.init}" ${editable ? '' : 'disabled'}></div>
      <div class="field"><label for="ac-l">Límite (tarjetas)</label><input class="inp" id="ac-l" inputmode="decimal" value="${a.limit ?? ''}" placeholder="Opcional" ${editable ? '' : 'disabled'}></div></div>
      <div class="field"><label>Color${gb || BANK_TYPES.includes(a.type) ? ' <span class="muted" style="font-weight:600">· al elegir un banco se usa su color</span>' : ''}</label>${colorPicker(a.color, !editable)}</div>
      ${!id ? `<div class="toggle"><div class="t"><b>Compartida con la familia</b><small>${!hasFamily() ? 'Crea una familia en Más → Familia para compartir cuentas.' : isOwner() ? 'Los miembros podrán verla y registrar movimientos.' : 'Solo el dueño de la familia puede crear cuentas compartidas.'}</small></div>
        <label class="sw"><input type="checkbox" id="ac-s" ${isOwner() ? '' : 'disabled'}><span></span></label></div>` : ''}
      <div class="note">Para tarjetas de crédito, registra las compras como gastos: el saldo quedará en negativo y verás cuánto debes.</div>
      <div class="err" id="ferr"></div>
      ${editable ? `<button class="btn" type="submit">${id ? 'Guardar cambios' : 'Crear cuenta'}</button>` : '<div class="note">Solo el dueño puede editar las cuentas compartidas.</div>'}
      ${id && editable ? `<button type="button" class="btn ghost" data-a="archiveAcc" data-v="${id}">${a.archived ? 'Restaurar cuenta' : 'Archivar cuenta'}</button>` : ''}
    </form>`);
}

/* ---- presupuestos ---- */
function vBudgets(){
  const sc = hasFamily() ? S.ui.budScope : 'personal';
  const list = S.budgets.filter(b => cat(b.cat).scope === (sc === 'family' ? 'f' : 'p'));
  const tot = list.reduce((s, b) => s + b.amount, 0), spent = list.reduce((s, b) => s + budgetInfo(b).spent, 0);
  const p = period(TODAY, dayFor(sc));
  return `${subhead('Presupuestos', canEditScope(sc === 'family' ? 'f' : 'p') ? `<button class="btn sm" data-a="newBudget">${ic('plus','sm')} Nuevo</button>` : '')}
  ${scopeSeg('budScope', sc)}<div style="height:14px"></div>
  <div class="panel" style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><span class="eyebrow">Total del mes</span><span class="muted" style="font-size:12px">${daysLeft(p.end)} días restantes</span></div>
    <div class="num" style="font-size:24px;font-weight:700;margin:4px 0 8px">${money(spent)} <span class="muted" style="font-size:14px;font-weight:600">de ${money(tot)}</span></div>
    <div class="bar"><i class="brand" style="width:${tot ? Math.min(100, spent / tot * 100) : 0}%"></i></div></div>
  <div class="list">${list.map(budRow).join('') || '<div class="empty">Crea tu primer presupuesto para recibir alertas antes de pasarte.</div>'}</div>`;
}
function budgetSheet(id){
  const b = id ? S.budgets.find(x => x.id === id) : null;
  const sc = b ? cat(b.cat).scope : (hasFamily() && S.ui.budScope === 'family' ? 'f' : 'p');
  const editable = canEditScope(sc);
  const used = new Set(S.budgets.map(x => x.cat));
  const opts = S.categories.filter(c => c.scope === sc && c.kind !== 'income' && !c.archived && (!used.has(c.id) || (b && b.cat === c.id)));
  openSheet(`${sheetHead(b ? 'Editar presupuesto' : 'Nuevo presupuesto')}
    <form class="form" data-f="budget" data-id="${id || ''}" novalidate>
      <div class="field"><label for="bu-c">Categoría</label><select class="inp" id="bu-c" ${b || !editable ? 'disabled' : ''}>${opts.map(c => `<option value="${c.id}" ${b && b.cat === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.parent ? cat(c.parent).name + ' › ' : '')}${esc(c.name)}</option>`).join('')}</select></div>
      <div class="row2"><div class="field"><label for="bu-a">Monto mensual (L)</label><input class="inp" id="bu-a" inputmode="decimal" required value="${b ? b.amount : ''}" placeholder="2000" ${editable ? '' : 'disabled'}></div>
      <div class="field"><label for="bu-p">Avisarme al</label><select class="inp" id="bu-p" ${editable ? '' : 'disabled'}>${[50,70,80,90].map(v => `<option value="${v}" ${(b ? b.alert : 80) === v ? 'selected' : ''}>${v}%</option>`).join('')}</select></div></div>
      <div class="note">Se reinicia cada mes financiero (día ${startDay()}). Las subcategorías suman en su categoría.</div>
      <div class="err" id="ferr"></div>
      ${editable ? `<button class="btn" type="submit">Guardar</button>${b ? `<button type="button" class="btn danger" data-a="delBudget" data-v="${b.id}">Eliminar presupuesto</button>` : ''}` : '<div class="note">Tu rol es de solo lectura.</div>'}
    </form>`);
}

/* ---- metas ---- */
function vGoals(){
  return `${subhead('Metas de ahorro', `<button class="btn sm" data-a="newGoal">${ic('plus','sm')} Nueva</button>`)}
  <div class="list">${S.goals.map(g => { const i = goalInfo(g); const done = g.status === 'completed' || i.pct >= 100;
    return `<div class="panel" style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:12px;align-items:center">${ring(i.pct, g.color, Math.round(i.pct) + '%')}
        <div style="flex:1;min-width:0"><b style="font-size:16px">${esc(g.icon)} ${esc(g.name)}</b>
        <div class="num" style="font-size:14px">${money(i.saved)} <span class="muted">de ${money(g.target)}</span></div>
        <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">${g.scope === 'f' ? '<span class="pill brand">Familia</span>' : '<span class="pill mute">Personal</span>'}${g.linked && acc(g.linked) ? `<span class="pill mute">Saldo de ${esc(acc(g.linked).name)}</span>` : ''}${done ? '<span class="pill ok">Cumplida</span>' : ''}</div></div></div>
      ${done || !g.date ? '' : `<div class="note">Ahorra <b class="num">${money(i.monthly)}</b> al mes para llegar el ${dShort(g.date)} ${g.date.slice(0, 4)}.</div>`}
      ${canEditScope(g.scope) ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${!g.linked && !done ? `<button class="btn ghost sm" data-a="contrib" data-v="${g.id}">${ic('plus','sm')} Aportar</button>` : ''}<button class="btn ghost sm" data-a="archiveGoal" data-v="${g.id}">Archivar</button></div>` : ''}
    </div>`; }).join('') || '<div class="empty">Crea una meta: fondo de emergencia, viaje o estudios.</div>'}</div>`;
}
function goalSheet(pre = {}){
  S.form = {icon:pre.icon || '🎯'};
  const scopes = `<option value="p">Personal</option>${hasFamily() && canEditScope('f') ? '<option value="f">Familia</option>' : ''}`;
  const linkable = visAccounts().filter(a => a.type === 'ahorro' && a.cur === 'HNL' && canWriteAcc(a));
  openSheet(`${sheetHead('Nueva meta')}<form class="form" data-f="goal" novalidate>
    <div class="field"><label for="go-n">Nombre</label><input class="inp" id="go-n" required maxlength="60" placeholder="Ej: Fondo de emergencia" value="${esc(pre.name || '')}"></div>
    <div class="row2"><div class="field"><label for="go-t">Meta (L)</label><input class="inp" id="go-t" inputmode="decimal" required placeholder="25000" value="${pre.target || ''}"></div>
    <div class="field"><label for="go-d">Fecha objetivo</label><input class="inp" id="go-d" type="date" required min="${addDays(TODAY, 1)}" value="${pre.date || addMonths(TODAY, 12)}"></div></div>
    <div class="row2"><div class="field"><label for="go-s">De quién es</label><select class="inp" id="go-s">${scopes}</select></div>
    <div class="field"><label for="go-a">Medir con</label><select class="inp" id="go-a"><option value="">Mis aportes</option>${linkable.map(a => `<option value="${a.id}" data-sc="${a.shared ? 'f' : 'p'}">Saldo de ${esc(a.name)}</option>`).join('')}</select></div></div>
    <div class="field"><label>Ícono</label><div class="emojis">${GOAL_EMOJIS.map(e => `<button type="button" class="${e === S.form.icon ? 'on' : ''}" data-a="pickIcon" data-v="${e}">${e}</button>`).join('')}</div></div>
    <div class="err" id="ferr"></div><button class="btn" type="submit">Crear meta</button></form>`);
}
function contribSheet(id){
  const g = S.goals.find(x => x.id === id), i = goalInfo(g);
  openSheet(`${sheetHead(esc(g.icon) + ' ' + esc(g.name))}<form class="form" data-f="contrib" data-id="${id}" novalidate>
    <div class="note">Llevas ${money(i.saved)} de ${money(g.target)}. Faltan ${money(Math.max(0, g.target - i.saved))}.</div>
    <div class="field"><label for="co-a">Monto (L)</label><input class="inp" id="co-a" inputmode="decimal" required placeholder="${Math.round(i.monthly) || 500}"></div>
    <div class="toggle"><div class="t"><b>Es un retiro</b><small>Resta del ahorro de la meta</small></div><label class="sw"><input type="checkbox" id="co-w"><span></span></label></div>
    <div class="err" id="ferr"></div><button class="btn" type="submit">Guardar</button></form>`);
}

/* ---- familia ---- */
function vFamily(){
  const f = S.family;
  if (!f) return `${subhead('Familia')}
    <div class="panel"><b style="font-size:16px">Comparte cuentas con tu familia</b><p class="muted" style="margin:6px 0 0;font-size:13.5px">Crea tu familia y serás el dueño: podrás crear cuentas compartidas e invitar a tu esposa, hijos o padres. Tus cuentas personales siguen siendo privadas.</p></div>
    <form class="panel form" data-f="family" style="margin-top:12px" novalidate><div class="field"><label for="fa-n">Nombre de la familia</label><input class="inp" id="fa-n" required maxlength="60" placeholder="Ej: Familia Mejía"></div>
      <div class="err" id="ferr"></div><button class="btn" type="submit">Crear familia</button></form>
    <div class="note" style="margin-top:12px">¿Te invitaron? Abre el enlace que te enviaron y entra con el mismo correo de la invitación.</div>`;
  const link = tok => `${location.origin}${location.pathname}?invite=${tok}`;
  return `${subhead(esc(f.name))}
  <div class="panel"><div class="sec-h"><h2>Miembros</h2><span class="muted" style="font-size:12px">${Object.keys(f.members).length} personas</span></div>
    ${Object.entries(f.members).map(([id, r]) => `<div class="member"><div class="avatar">${esc(uname(id)[0])}</div><div class="t"><b>${esc(uname(id))}${id === me() ? ' (tú)' : ''}</b><small>${ROLES[r]}</small></div>
      ${isOwner() && r !== 'owner' ? `<select class="inp" style="width:auto;padding:7px 8px;font-size:12.5px" data-in="role" data-id="${id}" aria-label="Rol de ${esc(uname(id))}"><option value="member" ${r === 'member' ? 'selected' : ''}>Miembro</option><option value="viewer" ${r === 'viewer' ? 'selected' : ''}>Solo lectura</option></select>
        <button class="iconbtn" data-a="askRemove" data-v="${id}" aria-label="Quitar a ${esc(uname(id))}" style="color:var(--neg)">${ic('trash','sm')}</button>`
      : `<span class="pill ${r === 'owner' ? 'gold' : 'mute'}">${ROLES[r]}</span>`}</div>`).join('')}
    <div id="rmbox"></div>
  </div>
  <div class="note" style="margin-top:10px"><b>Dueño:</b> crea cuentas compartidas e invita. <b>Miembro:</b> registra movimientos en lo compartido. <b>Solo lectura:</b> ve, no modifica. Las cuentas personales nunca se comparten.</div>
  ${isOwner() ? `<div class="section"><div class="sec-h"><h2>Invitar</h2></div>
    <form class="panel form" data-f="invite" novalidate><div class="field"><label for="in-e">Correo de la persona</label><input class="inp" id="in-e" type="email" required placeholder="nombre@gmail.com"></div>
      <div class="field"><label for="in-r">Rol</label><select class="inp" id="in-r"><option value="member">Miembro</option><option value="viewer">Solo lectura</option></select></div>
      <div class="err" id="ferr"></div><button class="btn" type="submit">Crear invitación</button></form></div>
    <div class="section"><div class="sec-h"><h2>Invitaciones pendientes</h2></div><div class="list">${S.invites.map(i => `<div class="panel" style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(i.email)}</b><span class="pill mute">${ROLES[i.role]}</span></div>
      <div style="display:flex;gap:8px;align-items:center"><code class="tok">${esc(link(i.token))}</code>
        <button class="iconbtn" data-a="copy" data-v="${esc(link(i.token))}" aria-label="Copiar enlace">${ic('copy','sm')}</button></div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><small class="muted">Vence el ${dShort(i.expires_at.slice(0, 10))} · un solo uso</small><button class="link" style="color:var(--neg)" data-a="revoke" data-v="${i.id}">Revocar</button></div></div>`).join('') || '<div class="empty">No hay invitaciones pendientes.</div>'}</div></div>`
  : `<div id="leavebox" style="margin-top:16px"><button class="btn danger" data-a="askLeave">Salir de la familia</button></div>`}`;
}

/* ---- categorías ---- */
function vCategories(){
  const u = S.ui; if (!hasFamily()) u.catScope = 'p';
  const roots = S.categories.filter(c => c.scope === u.catScope && c.kind === u.catKind && !c.parent);
  const editable = canEditScope(u.catScope);
  return `${subhead('Categorías', editable ? `<button class="btn sm" data-a="newCat">${ic('plus','sm')} Nueva</button>` : '')}
  ${hasFamily() ? `<div class="seg" style="margin-bottom:10px"><button class="${u.catScope === 'p' ? 'on' : ''}" data-a="catScope" data-v="p">Personales</button><button class="${u.catScope === 'f' ? 'on' : ''}" data-a="catScope" data-v="f">De la familia</button></div>` : ''}
  <div class="chips" style="margin-bottom:12px">${Object.entries(KIND).map(([k, l]) => `<button class="chip ${u.catKind === k ? 'on' : ''}" data-a="catKind" data-v="${k}">${l}</button>`).join('')}</div>
  <div class="list">${roots.map(c => {
    const kids = S.categories.filter(k => k.parent === c.id);
    const row = (x, sub) => `<button class="tx" ${editable ? `data-a="editCat" data-v="${x.id}"` : ''} style="${sub ? 'margin-left:28px;width:calc(100% - 28px)' : ''}${x.archived ? ';opacity:.55' : ''}"><span class="tile" style="background:${soft(x.color)}">${esc(x.icon)}</span><span class="mid"><b>${esc(x.name)}</b><small>${sub ? 'Subcategoría' : kids.length ? kids.length + ' subcategorías' : KIND[x.kind]}${x.archived ? ' · Archivada' : ''}</small></span>${editable ? ic('right','sm') : ''}</button>`;
    return row(c, false) + kids.map(k => row(k, true)).join(''); }).join('') || '<div class="empty">No hay categorías de este tipo.</div>'}</div>`;
}
function catSheet(id){
  const c = id ? cat(id) : {name:'', kind:S.ui.catKind, icon:EMOJIS[0], color:COLORS[0], parent:null, scope:S.ui.catScope, archived:false};
  S.form = {icon:c.icon, color:c.color};
  const parents = S.categories.filter(x => x.scope === c.scope && x.kind === c.kind && !x.parent && x.id !== id);
  const used = id && (S.tx.some(t => t.cat === id) || S.categories.some(k => k.parent === id) || S.budgets.some(b => b.cat === id));
  openSheet(`${sheetHead(id ? 'Editar categoría' : 'Nueva categoría')}
    <form class="form" data-f="cat" data-id="${id || ''}" novalidate>
      <div class="field"><label for="ca-n">Nombre</label><input class="inp" id="ca-n" required maxlength="40" value="${esc(c.name)}" placeholder="Ej: Gimnasio"></div>
      <div class="row2"><div class="field"><label for="ca-k">Tipo</label><select class="inp" id="ca-k" ${id ? 'disabled' : ''}>${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="ca-p">Dentro de</label><select class="inp" id="ca-p"><option value="">Ninguna (principal)</option>${parents.map(x => `<option value="${x.id}" ${c.parent === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div></div>
      <div class="field"><label>Ícono</label><div class="emopick">${EMOJI_GROUPS.map(([t, l]) => `<div class="eg"><small>${t}</small><div class="emojis">${l.map(e => `<button type="button" class="${c.icon === e ? 'on' : ''}" data-a="pickIcon" data-v="${e}" aria-label="Ícono ${e}">${e}</button>`).join('')}</div></div>`).join('')}</div>
        <div class="emocustom"><span class="emoprev" id="emoprev">${esc(c.icon)}</span><input class="inp" id="ca-e" data-in="emoji" maxlength="8" placeholder="¿No está? Escribe o pega cualquier emoji" value="${EMOJIS.includes(c.icon) ? '' : esc(c.icon)}" autocomplete="off"></div></div>
      <div class="field"><label>Color</label>${colorPicker(c.color)}</div>
      <div class="err" id="ferr"></div>
      <button class="btn" type="submit">Guardar</button>
      ${id ? `<button type="button" class="btn danger" data-a="delCat" data-v="${id}">${used ? (c.archived ? 'Restaurar' : 'Archivar (está en uso)') : 'Eliminar'}</button>` : ''}
    </form>`);
}

/* ---- informes ---- */
function repTx(){
  const u = S.ui;
  return S.tx.filter(t => !t.tg && t.date >= u.repFrom && t.date <= u.repTo && (u.repScope === 'family') === !!acc(t.acc)?.shared)
    .sort((a, b) => txKey(a).localeCompare(txKey(b)));
}
function vReports(){
  const u = S.ui, p = period(TODAY, dayFor(u.repScope));
  if (!u.repFrom){ u.repFrom = p.start; u.repTo = p.end; }
  if (!hasFamily()) u.repScope = 'personal';
  const sc = u.repScope, valid = u.repFrom && u.repTo && u.repFrom <= u.repTo;
  const tooOld = u.repFrom < S.txFrom;
  let body = '';
  if (valid){
    const sm = summary(u.repFrom, u.repTo, sc), tx = repTx();
    const sections = [['Ingresos por categoría', breakdown(u.repFrom, u.repTo, sc, 'income')], ['Gastos por categoría', breakdown(u.repFrom, u.repTo, sc, 'expense')], ['Generosidad', breakdown(u.repFrom, u.repTo, sc, 'generosity')]];
    body = `<div class="section panel">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px"><div><div class="eyebrow">Informe ${sc === 'family' ? 'familiar' : 'personal'}</div><h2 style="font-size:18px">${dShort(u.repFrom)} ${u.repFrom.slice(0, 4)} – ${dShort(u.repTo)} ${u.repTo.slice(0, 4)}</h2></div><img class="logo sm" src="icons/logo-mark.png" alt="Kuenta" width="32" height="32"></div>
      <table class="rep"><tr><td>Ingresos</td><td class="r pos">${money(sm.inc)}</td></tr><tr><td>Gastos</td><td class="r">${money(sm.exp)}</td></tr><tr><td>Generosidad</td><td class="r gen">${money(sm.gen)}</td></tr>
        <tr><td><b>Balance</b></td><td class="r"><b style="color:${sm.net >= 0 ? 'var(--pos)' : 'var(--neg)'}">${money(sm.net)}</b></td></tr><tr><td>Tasa de ahorro</td><td class="r">${sm.rate === null ? '—' : sm.rate.toFixed(1) + '%'}</td></tr></table>
      ${sections.map(([t, arr]) => arr.length ? `<div class="eyebrow" style="margin:16px 0 4px">${t}</div><table class="rep">${arr.map(x => `<tr><td>${esc(x.c.icon)} ${esc(x.c.name)}</td><td class="r">${money(x.v)}</td><td class="r muted">${x.p.toFixed(1)}%</td></tr>`).join('')}</table>` : '').join('')}
      <div class="eyebrow" style="margin:16px 0 4px">${tx.length} movimientos</div>
      <div style="overflow-x:auto"><table class="rep" style="min-width:340px"><tr><th>Fecha</th><th>Detalle</th><th class="r">Monto</th></tr>${tx.slice(-40).reverse().map(t => `<tr><td class="num" style="white-space:nowrap">${dShort(t.date)}</td><td>${esc(t.desc || cat(t.cat).name)}</td><td class="r ${t.type === 'income' ? 'pos' : ''}">${t.type === 'income' ? '+' : '−'}${money(t.amount, acc(t.acc).cur).replace('−', '')}</td></tr>`).join('')}</table></div>
      ${tx.length > 40 ? `<div class="muted" style="font-size:12px;margin-top:6px">Se muestran los 40 más recientes. El archivo exportado incluye los ${tx.length}.</div>` : ''}
    </div>
    <div class="row2" style="margin-top:14px"><button class="btn" data-a="exportPdf">${ic('download','sm')} PDF</button><button class="btn ghost" data-a="exportCsv">${ic('download','sm')} Excel</button></div>`;
  }
  return `${subhead('Informes')}
  <div class="panel form">
    <div class="chips">${[['cur','Mes actual'],['prev','Mes anterior'],['q','Últimos 3 meses'],['y','Este año']].map(([k, l]) => `<button type="button" class="chip" data-a="repPreset" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="row2"><div class="field"><label for="rf">Desde</label><input class="inp" id="rf" type="date" value="${u.repFrom}" min="${S.txFrom}" data-in="repFrom"></div><div class="field"><label for="rt">Hasta</label><input class="inp" id="rt" type="date" value="${u.repTo}" data-in="repTo"></div></div>
    ${scopeSeg('repScope', sc)}
    ${valid ? '' : '<div class="err">La fecha "Desde" debe ser anterior a "Hasta".</div>'}
    ${tooOld ? `<div class="note">La app guarda en memoria los últimos ${HISTORY_MONTHS} meses (desde ${dShort(S.txFrom)} ${S.txFrom.slice(0, 4)}).</div>` : ''}
  </div>${body}`;
}
function download(blob, name){
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportCsv(){
  const rows = [['Fecha','Hora','Tipo','Categoría','Subcategoría','Descripción','Nota','Cuenta','Moneda','Monto','Registrado por']];
  repTx().forEach(t => { const c = cat(t.cat), a = acc(t.acc), r = rootOf(c);
    rows.push([t.date, t.time, t.type === 'income' ? 'Ingreso' : c.kind === 'generosity' ? 'Generosidad' : 'Gasto', r.name, c.parent ? c.name : '', t.desc, t.note, a.name, a.cur, (t.type === 'income' ? '' : '-') + t.amount.toFixed(2), uname(t.by)]); });
  const csv = '﻿' + rows.map(r => r.map(x => { let s = String(x ?? ''); if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }).join(',')).join('\r\n');
  download(new Blob([csv], {type:'text/csv;charset=utf-8'}), `kuenta-${S.ui.repFrom}_${S.ui.repTo}.csv`);
  toast('Archivo para Excel descargado');
}
function loadScript(src, integrity){
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.integrity = integrity; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar el generador de PDF. Revisa tu conexión.')); document.head.appendChild(s); });
}
async function exportPdf(){
  if (!window.jspdf){ for (const [src, sri] of PDF_LIBS) await loadScript(src, sri); }
  const u = S.ui, sc = u.repScope, sm = summary(u.repFrom, u.repTo, sc), tx = repTx();
  const plain = s => String(s ?? '').replace(/[^\u0000-ÿ]/g, '').trim();
  const pm = (n, c = 'HNL') => (n < 0 ? '-' : '') + (c === 'USD' ? '$ ' : 'L ') + nf.format(Math.abs(n));
  const doc = new window.jspdf.jsPDF({unit:'pt', format:'letter'});
  const brandRGB = [10, 92, 79], W = doc.internal.pageSize.getWidth();
  doc.setFillColor(...brandRGB); doc.rect(0, 0, W, 72, 'F');
  doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.text('kuenta', 40, 44);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.text(plain(`Informe ${sc === 'family' ? 'familiar' + (S.family ? ' · ' + S.family.name : '') : 'personal · ' + (S.profile.full_name || '')}`), W - 40, 34, {align:'right'});
  doc.text(`${u.repFrom}  a  ${u.repTo}`, W - 40, 50, {align:'right'});
  doc.setTextColor(20);
  const table = (startY, head, body, opts = {}) => { doc.autoTable(Object.assign({startY, head:[head], body, theme:'striped', margin:{left:40, right:40},
    headStyles:{fillColor:brandRGB, fontStyle:'bold'}, styles:{fontSize:9.5, cellPadding:5}, columnStyles:{1:{halign:'right'}, 2:{halign:'right'}}}, opts)); return doc.lastAutoTable.finalY + 18; };
  let y = table(92, ['Resumen', 'Monto'], [['Ingresos', pm(sm.inc)], ['Gastos', pm(sm.exp)], ['Generosidad', pm(sm.gen)], ['Balance', pm(sm.net)], ['Tasa de ahorro', sm.rate === null ? '-' : sm.rate.toFixed(1) + '%']]);
  for (const [t, kind] of [['Ingresos por categoría', 'income'], ['Gastos por categoría', 'expense'], ['Generosidad', 'generosity']]){
    const arr = breakdown(u.repFrom, u.repTo, sc, kind); if (!arr.length) continue;
    y = table(y, [t, 'Monto', '%'], arr.map(x => [plain(x.c.name), pm(x.v), x.p.toFixed(1) + '%']));
  }
  table(y, ['Fecha', 'Detalle', 'Categoría', 'Cuenta', 'Monto'], tx.map(t => [t.date + (t.time ? ' ' + t.time : ''), plain(t.desc || cat(t.cat).name), plain(cat(t.cat).name), plain(acc(t.acc).name),
    (t.type === 'income' ? '+' : '-') + pm(t.amount, acc(t.acc).cur)]), {columnStyles:{1:{halign:'left'}, 2:{halign:'left'}, 4:{halign:'right'}}});
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++){ doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120);
    doc.text(`Generado con Kuenta el ${TODAY}`, 40, doc.internal.pageSize.getHeight() - 24);
    doc.text(`Página ${i} de ${n}`, W - 40, doc.internal.pageSize.getHeight() - 24, {align:'right'}); }
  doc.save(`kuenta-${u.repFrom}_${u.repTo}.pdf`);
  toast('PDF descargado');
}

/* ---- alertas ---- */
function vAlerts(){
  const iconFor = {budget:['gauge','var(--warn)'], goal:['target','var(--pos)'], family:['users','var(--brand)'], system:['bell','var(--muted)'],
    reminder:['bell','var(--brand)'], scheduled:['calendar','var(--warn)'], debt:['card','var(--neg)'], savings:['spark','var(--gold)']};
  return `${subhead('Alertas', S.notifs.some(n => !n.read_at) ? '<button class="link" data-a="readAll">Marcar leídas</button>' : '')}
  <div class="list">${S.notifs.map(n => { const [i, c] = iconFor[n.type] || iconFor.system; return `<button class="tx" data-a="readOne" data-v="${n.id}" style="${n.read_at ? 'opacity:.65' : ''}">
    <span class="tile" style="background:${soft(c)};color:${c}">${ic(i,'sm')}</span>
    <span class="mid"><b style="white-space:normal">${esc(n.title)}</b><small>${esc(n.body || '')}</small></span>
    <span class="amt"><small>${dShort(n.created_at.slice(0, 10))}</small>${n.read_at ? '' : '<b style="color:var(--brand);font-size:18px" aria-label="Sin leer">•</b>'}</span></button>`; }).join('') || '<div class="empty">Sin alertas por ahora.</div>'}</div>
  <div class="note" style="margin-top:14px">Te avisamos cuando un presupuesto llega a su límite de aviso o al 100%, cuando cumples una meta, cuando alguien se une a tu familia, un día antes y el mismo día de tus pagos programados y cuotas. <button class="link" data-a="nav" data-v="reminders">Configurar recordatorios</button></div>`;
}

/* ---- ajustes ---- */
function vSettings(){
  const pr = S.profile, p = period(), theme = LS.get('theme', 'system');
  const pl = planInfo();
  return `${subhead('Ajustes')}
  <div class="panel" style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
    <span class="tile" style="background:var(--gold-soft);color:var(--gold)">★</span>
    <div style="flex:1;min-width:0"><div class="eyebrow">Tu plan</div><b style="font-size:16px">${esc(pl.name)}</b>
      <div class="muted" style="font-size:12.5px">${esc(pl.detail || 'Funciones esenciales de Kuenta')}${pl.left != null && pl.left >= 0 ? ` · quedan ${pl.left} ${pl.left === 1 ? 'día' : 'días'}` : ''}</div></div></div>
  <div class="panel"><div class="eyebrow" style="margin-bottom:6px">Perfil</div>
    <form class="form" data-f="profile" novalidate style="padding-block:6px"><div class="field"><label for="pf-n">Tu nombre</label><div style="display:flex;gap:8px"><input class="inp" id="pf-n" maxlength="80" value="${esc(pr.full_name)}"><button class="btn sm" type="submit">Guardar</button></div></div></form>
  </div>
  <div class="panel" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:6px">Finanzas</div>
    <div class="toggle"><div class="t"><b>Inicio del mes financiero</b><small>Período actual: ${dShort(p.start)} – ${dShort(p.end)}</small></div>
      <select class="inp" style="width:auto" data-in="period_start_day" aria-label="Día de inicio">${Array.from({length:28}, (_, i) => `<option value="${i + 1}" ${pr.period_start_day === i + 1 ? 'selected' : ''}>Día ${i + 1}</option>`).join('')}</select></div>
    <div class="toggle"><div class="t"><b>Diezmo</b><small>Te mostramos cuánto corresponde y cuánto falta cada mes</small></div>
      <select class="inp" style="width:auto" data-in="tithe_percent" aria-label="Porcentaje de diezmo">${[0,5,10,12,15,20].map(v => `<option value="${v}" ${+pr.tithe_percent === v ? 'selected' : ''}>${v ? v + '%' : 'No sugerir'}</option>`).join('')}</select></div>
    <div class="toggle"><div class="t"><b>Moneda principal</b><small>Para cuentas nuevas</small></div>
      <select class="inp" style="width:auto" data-in="default_currency" aria-label="Moneda principal"><option value="HNL" ${pr.default_currency === 'HNL' ? 'selected' : ''}>Lempiras</option><option value="USD" ${pr.default_currency === 'USD' ? 'selected' : ''}>Dólares</option></select></div>
  </div>
  <div class="panel" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:6px">Seguridad</div>
    <div class="toggle"><div class="t"><b>PIN de acceso</b><small>Se pide al abrir y tras 5 minutos fuera de la app</small></div><button class="btn ghost sm" data-a="changePin">Cambiar</button></div>
    <div class="toggle"><div class="t"><b>Huella o Face ID</b><small id="biohint">${bioRec() ? 'Activo en este teléfono' : 'Requiere PIN activo'}</small></div><label class="sw"><input type="checkbox" data-in="bio" ${bioRec() ? 'checked' : ''} ${pinRec() ? '' : 'disabled'} aria-label="Huella o Face ID"><span></span></label></div>
    <div class="toggle"><div class="t"><b>Contraseña</b><small>La de tu cuenta Kuenta</small></div><button class="btn ghost sm" data-a="changePass">Cambiar</button></div>
  </div>
  <div class="panel" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:8px">Apariencia</div>
    <div class="seg">${[['system','Sistema'],['light','Claro'],['dark','Oscuro']].map(([k, l]) => `<button class="${theme === k ? 'on' : ''}" data-a="theme" data-v="${k}">${l}</button>`).join('')}</div></div>
  <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px">
    ${pinRec() ? `<button class="btn ghost" data-a="lockNow">${ic('lock','sm')} Bloquear ahora</button>` : ''}
    <button class="btn danger" data-a="signOut">${ic('logout','sm')} Cerrar sesión</button></div>
  <div class="panel" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:6px">Legal</div>
    <div class="toggle"><div class="t"><b>Términos de uso</b></div><a class="link" href="terminos.html" target="_blank" rel="noopener">Abrir</a></div>
    <div class="toggle"><div class="t"><b>Política de privacidad</b></div><a class="link" href="privacidad.html" target="_blank" rel="noopener">Abrir</a></div>
    ${CFG.SUPPORT_EMAIL ? `<div class="toggle"><div class="t"><b>Soporte</b><small>${esc(CFG.SUPPORT_EMAIL)}</small></div><a class="link" href="mailto:${esc(CFG.SUPPORT_EMAIL)}?subject=${encodeURIComponent('Ayuda con Kuenta')}">Escribir</a></div>` : ''}
  </div>
  <button class="textbtn" style="color:var(--neg);margin:18px auto 4px;display:block" data-a="deleteAccount">Eliminar mi cuenta</button>
  ${credit}`;
}
function deleteSheet(){
  const others = S.family ? Object.keys(S.family.members).filter(id => id !== me()) : [];
  let fam = '';
  if (isOwner() && others.length){
    fam = `<div class="field"><label>¿Qué pasa con ${esc(S.family.name)}?</label>
      <label class="toggle" style="justify-content:flex-start;gap:10px"><input type="radio" name="fa" value="transfer" checked> <span>Trasladarla a otro miembro</span></label>
      <select class="inp" id="del-owner" aria-label="Nuevo dueño">${others.map(id => `<option value="${id}">${esc(uname(id))} · ${ROLES[S.family.members[id]]}</option>`).join('')}</select>
      <label class="toggle" style="justify-content:flex-start;gap:10px"><input type="radio" name="fa" value="delete"> <span>Eliminarla para todos: se borran sus cuentas compartidas, movimientos, presupuestos y metas</span></label></div>`;
  } else if (isOwner()){
    fam = `<div class="note">Tu familia ${esc(S.family.name)} también se eliminará, porque no tiene otros miembros.</div>`;
  } else if (S.family){
    fam = `<div class="note">Saldrás de ${esc(S.family.name)}. Lo que registraste en sus cuentas compartidas se conserva, sin tu nombre.</div>`;
  }
  openSheet(`${sheetHead('Eliminar mi cuenta')}<form class="form" data-f="deleteAccount" novalidate>
    <div class="note" style="background:var(--neg-soft);color:var(--neg)">Se borrarán para siempre tu perfil, tus cuentas personales, movimientos, presupuestos, metas, categorías y comprobantes. No se puede deshacer.</div>
    ${fam}
    <div class="field"><label for="del-confirm">Escribe ELIMINAR para confirmar</label><input class="inp" id="del-confirm" autocomplete="off" autocapitalize="characters"></div>
    <div class="err" id="ferr"></div>
    <button class="btn danger" type="submit">Eliminar mi cuenta para siempre</button></form>`);
}
/* Borra los comprobantes propios; conserva los de cuentas compartidas si la familia sigue */
async function deleteMyFiles(keepShared){
  const st = sb.storage.from(BUCKET), uid = me(), keep = new Set();
  if (keepShared){
    const rows = await fetchAll(() => sb.from('attachments').select('storage_path,transactions(account_id)').eq('uploaded_by', uid));
    rows.forEach(r => { if (acc(r.transactions?.account_id)?.shared) keep.add(r.storage_path); });
  }
  const folders = await q(st.list(uid, {limit:1000}));
  const paths = [];
  for (const f of folders){
    const files = await q(st.list(`${uid}/${f.name}`, {limit:1000}));
    files.forEach(x => paths.push(`${uid}/${f.name}/${x.name}`));
  }
  const del = paths.filter(p => !keep.has(p));
  for (let i = 0; i < del.length; i += 100) await q(st.remove(del.slice(i, i + 100)));
}
function pinSheet(){
  S.form = {np:'', np1:''};
  openSheet(`${sheetHead('Nuevo PIN')}<p class="muted" style="text-align:center;margin:0" id="nptitle">Escribe 4 dígitos</p>
    <div class="dots" id="npdots">${'<i></i>'.repeat(4)}</div><div class="err" id="nperr" style="text-align:center;min-height:18px"></div>
    <div class="keys">${['1','2','3','4','5','6','7','8','9','','0','del'].map(k => k ? `<button data-a="npin" data-v="${k}">${k === 'del' ? '⌫' : k}</button>` : '<span></span>').join('')}</div>`);
}
function passSheet(){
  openSheet(`${sheetHead('Cambiar contraseña')}<form class="form" data-f="pass" novalidate>
    ${pwField('pw-1', 'Contraseña nueva', 'minlength="8" autocomplete="new-password"')}
    ${pwField('pw-2', 'Repítela', 'autocomplete="new-password"')}
    <div class="err" id="ferr"></div><button class="btn" type="submit">Guardar</button></form>`);
}
function applyTheme(){ const t = LS.get('theme', 'system'); if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); }

async function copyText(text, ok){
  try { await navigator.clipboard.writeText(text); toast(ok); }
  catch { openSheet(`${sheetHead('Copiar')}<p class="muted">Mantén presionado el texto para copiarlo:</p><textarea class="inp" rows="4" readonly style="font-size:13px;user-select:text">${esc(text)}</textarea>`);
    const ta = $('#sheet textarea'); ta.focus(); ta.select(); }
}

/* ============ acciones ============ */
const A = {
  tab: el => { if (el.dataset.v !== 'tx') S.ui.txAcc = ''; S.ui.txLimit = 150; go(el.dataset.v); },
  nav: el => go(el.dataset.v, S.ui.screen),
  back: () => go(S.ui.back || 'more'),
  closeSheet,
  authMode: el => { S.auth = el.dataset.v; S.authMsg = ''; render(); },
  resendConfirm: async el => {
    const left = Math.ceil(((S.resendAt || 0) + 60000 - Date.now()) / 1000);
    if (left > 0){ S.authMsg = `!Espera ${left} segundos para reenviar.`; render(); return; }
    const email = S.verifyEmail; if (!email) return;
    el.dataset.busy = '1';
    try {
      const inv = pendingInvite();
      await q(sb.auth.resend({type:'signup', email, options:{emailRedirectTo:location.origin + location.pathname + (inv ? `?invite=${inv}` : '')}}));
      S.resendAt = Date.now(); S.authMsg = 'Listo, te enviamos otro correo. Revisa también Spam.';
    } catch (e) { S.authMsg = '!' + errMsg(e); }
    render();
  },
  signOut: async () => { await dropPushHere(); await sb.auth.signOut(); },
  forgotPin: async () => {
    LS.del('pin.' + me()); LS.del('bio.' + me()); LS.set('tries.' + me(), 0);
    S.authMsg = 'Entra con tu correo y contraseña para crear un PIN nuevo.';
    await sb.auth.signOut();
  },
  pin: async el => {
    const v = el.dataset.v;
    if (v === 'del') S.pinEntry = S.pinEntry.slice(0, -1); else if (S.pinEntry.length < 4) S.pinEntry += v;
    $('#dots').innerHTML = [0,1,2,3].map(i => `<i class="${i < S.pinEntry.length ? 'f' : ''}"></i>`).join('');
    if (S.pinEntry.length < 4) return;
    const ok = await checkPin(S.pinEntry); S.pinEntry = '';
    if (ok){ unlock(); return; }
    const tries = LS.get('tries.' + me(), 0) + 1; LS.set('tries.' + me(), tries);
    if (tries >= 5){ LS.del('pin.' + me()); LS.del('bio.' + me()); LS.set('tries.' + me(), 0); S.authMsg = '!Por seguridad cerramos tu sesión tras 5 intentos de PIN. Entra con tu correo y contraseña.'; await sb.auth.signOut(); return; }
    render(); $('#dots').classList.add('shake');
  },
  bio: async () => { try { if (await bioVerify()) unlock(); } catch { toast('No se pudo verificar tu huella. Usa tu PIN.', 'warn'); } },
  togglePw: el => { const i = $('#' + el.dataset.v), show = i.type === 'password'; i.type = show ? 'text' : 'password';
    el.innerHTML = ic(show ? 'eyeoff' : 'eye', 'sm'); el.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña'); el.setAttribute('aria-pressed', show); i.focus(); },
  pinSetup: async el => {
    const v = el.dataset.v;
    S.pinEntry = v === 'del' ? S.pinEntry.slice(0, -1) : (S.pinEntry + v).slice(0, 4); S.form.pinErr = '';
    if (S.pinEntry.length < 4){ $('#dots').innerHTML = [0,1,2,3].map(i => `<i class="${i < S.pinEntry.length ? 'f' : ''}"></i>`).join(''); return; }
    if ((S.form.pinStep || 1) === 1){ S.form.pin1 = S.pinEntry; S.form.pinStep = 2; S.pinEntry = ''; render(); return; }
    if (S.pinEntry !== S.form.pin1){ S.form = {pinErr:'Los PIN no coinciden. Empieza de nuevo.'}; S.pinEntry = ''; render(); return; }
    await setPin(S.pinEntry); S.pinEntry = ''; S.form = {}; S.needPinSetup = false; render();
    if (await bioAvailable()) toast('PIN creado. ¿Activar también tu huella o Face ID?', 'ok', {label:'Activar', run: async () => { await bioEnroll(); toast('Huella activada'); }});
    else toast('PIN creado');
  },
  lockNow: () => { maybeLock(); closeSheet(); render(); },
  add: el => startAdd(el.dataset.v),
  payTithe: el => {
    const tc = S.categories.find(c => c.scope === 'p' && isTitheCat(c) && !c.archived);
    if (!tc) return toast('Crea una categoría de generosidad llamada "Diezmo" para registrarlo.', 'warn');
    startAdd('expense'); if (!S.draft) return;
    const own = writableAccounts().filter(a => !a.shared && a.cur === 'HNL');
    if (own.length && acc(S.draft.acc)?.shared) S.draft.acc = (own.find(a => a.id === LS.get('lastAcc.' + me())) || own[0]).id;
    S.draft.amount = String(round2(+el.dataset.v)); S.draft.cat = tc.id;
    S.draft.desc = el.dataset.d ? 'Diezmo del mes anterior' : 'Diezmo'; if (el.dataset.d) S.draft.date = el.dataset.d; renderAdd();
  },
  dType: el => { const d = S.draft; d.type = el.dataset.v; d.step = 1; d.cat = null;
    if (d.type === 'transfer'){ const accs = writableAccounts(); d.from = d.acc; d.to = (accs.find(a => a.id !== d.acc) || accs[0]).id; }
    renderAdd(); },
  editTx: el => { closeSheet(); startEdit(el.dataset.v); },
  dAcc: el => { const d = S.draft, k = el.dataset.k, before = acc(d[k]);
    d[k] = el.dataset.v; if (k === 'acc' && before?.shared !== acc(d.acc)?.shared) d.cat = null; renderAdd(); },
  key: el => {
    const d = S.draft, k = el.dataset.v;
    if (d.fresh && k !== 'del') d.amount = '0'; // al editar, la primera tecla reemplaza el monto
    let a = d.amount;
    if (k === 'del') a = a.length > 1 ? a.slice(0, -1) : '0';
    else if (k === '.') { if (!a.includes('.')) a += '.'; }
    else { if (a.includes('.') && a.split('.')[1].length >= 2) return; if (a.replace('.', '').length >= 10) return; a = a === '0' ? k : a + k; }
    d.amount = a; $('#amt').textContent = amountText(d);
    if (d.fresh){ d.fresh = false; $('#amt').classList.remove('fresh'); $('#amt').nextElementSibling?.remove(); }
    const e = $('#derr'); if (e) e.textContent = '';
  },
  dNext: () => { if (!(Number(S.draft.amount) > 0)) { $('#derr').textContent = 'Escribe un monto mayor que cero.'; return; } S.draft.step = 2; renderAdd(); },
  dBack: () => { S.draft.step = 1; renderAdd(); },
  dCat: el => { S.draft.cat = el.dataset.v; renderAdd(); },
  dRmFile: () => { if (S.draft.preview) URL.revokeObjectURL(S.draft.preview); S.draft.file = null; S.draft.preview = null; renderAdd(); },
  saveTx, saveTransfer,
  txDetail: el => txDetail(el.dataset.v),
  moreTx: () => { S.ui.txLimit = (S.ui.txLimit || 150) + 150; render(); },
  askDel: el => { $('#delbox').innerHTML = `<div class="note" style="margin-bottom:8px">¿Seguro? Esta acción no se puede deshacer.</div><div class="row2"><button class="btn ghost" data-a="closeSheet">Cancelar</button><button class="btn danger" data-a="doDel" data-v="${el.dataset.v}">Sí, eliminar</button></div>`; },
  doDel: async el => {
    const t = S.tx.find(x => x.id === el.dataset.v);
    if (t.tg){ await q(sb.rpc('delete_transfer', {p_group:t.tg})); S.tx = S.tx.filter(x => x.tg !== t.tg); }
    else {
      const mine = (S.atts[t.id] || []).filter(x => x.storage_path.startsWith(me() + '/')).map(x => x.storage_path);
      await q(sb.from('transactions').delete().eq('id', t.id));
      if (mine.length) await sb.storage.from(BUCKET).remove(mine);
      delete S.atts[t.id]; S.tx = S.tx.filter(x => x.id !== t.id);
    }
    closeSheet(); await afterWrite(); render(); toast('Movimiento eliminado');
  },
  accTx: el => { S.ui.txAcc = el.dataset.v; S.ui.txFilter = 'all'; go('tx'); },
  txFilter: el => { S.ui.txFilter = el.dataset.v; render(); },
  txAcc: el => { S.ui.txAcc = el.dataset.v; render(); },
  setScope: el => { S.ui[el.dataset.k] = el.dataset.v; render(); },
  statsOff: el => { S.ui.statsOff = Math.max(-HISTORY_MONTHS + 1, Math.min(0, S.ui.statsOff + Number(el.dataset.v))); render(); },
  editBudget: el => budgetSheet(el.dataset.v),
  newBudget: () => budgetSheet(null),
  delBudget: async el => { await q(sb.from('budgets').delete().eq('id', el.dataset.v)); S.budgets = S.budgets.filter(b => b.id !== el.dataset.v); closeSheet(); render(); toast('Presupuesto eliminado'); },
  newGoal: () => goalSheet(),
  contrib: el => contribSheet(el.dataset.v),
  archiveGoal: async el => { await q(sb.from('goals').update({status:'archived'}).eq('id', el.dataset.v)); S.goals = S.goals.filter(g => g.id !== el.dataset.v); render(); toast('Meta archivada'); },
  newAcc: () => accSheet(null), editAcc: el => accSheet(el.dataset.v),
  archiveAcc: async el => { const a = acc(el.dataset.v); await q(sb.from('accounts').update({is_archived:!a.archived}).eq('id', a.id)); a.archived = !a.archived; closeSheet(); render(); toast(a.archived ? 'Cuenta archivada' : 'Cuenta restaurada'); },
  pickColor: el => setColor(el.dataset.v, el.parentElement),
  pickIcon: el => { S.form.icon = el.dataset.v; el.closest('.emopick, .emojis').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
    const pv = $('#emoprev'); if (pv) pv.textContent = el.dataset.v; const ce = $('#ca-e'); if (ce) ce.value = ''; },
  catScope: el => { S.ui.catScope = el.dataset.v; render(); },
  catKind: el => { S.ui.catKind = el.dataset.v; render(); },
  newCat: () => catSheet(null), editCat: el => catSheet(el.dataset.v),
  delCat: async el => {
    const c = cat(el.dataset.v);
    const used = S.tx.some(t => t.cat === c.id) || S.categories.some(k => k.parent === c.id) || S.budgets.some(b => b.cat === c.id);
    if (used){ await q(sb.from('categories').update({is_archived:!c.archived}).eq('id', c.id)); c.archived = !c.archived; toast(c.archived ? 'Categoría archivada' : 'Categoría restaurada'); }
    else { await q(sb.from('categories').delete().eq('id', c.id)); S.categories = S.categories.filter(x => x.id !== c.id); toast('Categoría eliminada'); }
    closeSheet(); render();
  },
  copy: el => copyText(el.dataset.v, 'Enlace copiado. Envíalo por WhatsApp o correo.'),
  revoke: async el => { await q(sb.rpc('revoke_family_invitation', {p_invitation:el.dataset.v})); S.invites = S.invites.filter(i => i.id !== el.dataset.v); render(); toast('Invitación revocada'); },
  askRemove: el => { $('#rmbox').innerHTML = `<div class="note" style="margin:10px 0 8px">¿Quitar a ${esc(uname(el.dataset.v))}? Sus movimientos en cuentas compartidas se conservan.</div><div class="row2"><button class="btn ghost" data-a="nav" data-v="family">Cancelar</button><button class="btn danger" data-a="doRemove" data-v="${el.dataset.v}">Quitar</button></div>`; },
  doRemove: async el => { await q(sb.rpc('remove_family_member', {p_user:el.dataset.v})); await loadFamily(); render(); toast('Miembro quitado'); },
  askLeave: () => { $('#leavebox').innerHTML = `<div class="note" style="margin-bottom:8px">Dejarás de ver las cuentas compartidas. Tus cuentas personales no cambian.</div><div class="row2"><button class="btn ghost" data-a="nav" data-v="family">Cancelar</button><button class="btn danger" data-a="doLeave">Salir</button></div>`; },
  doLeave: async () => { await q(sb.rpc('leave_family')); await loadAll(); go('more'); toast('Saliste de la familia'); },
  repPreset: el => { const u = S.ui, sd = dayFor(u.repScope), p = period(TODAY, sd), k = el.dataset.v;
    if (k === 'cur'){ u.repFrom = p.start; u.repTo = p.end; }
    else if (k === 'prev'){ const pp = period(addMonths(p.start, -1), sd); u.repFrom = pp.start; u.repTo = pp.end; }
    else if (k === 'q'){ u.repFrom = addMonths(p.start, -2); u.repTo = p.end; }
    else { u.repFrom = TODAY.slice(0, 4) + '-01-01'; u.repTo = TODAY; } render(); },
  exportCsv, exportPdf,
  readAll: async () => { const ids = S.notifs.filter(n => !n.read_at).map(n => n.id); const now = new Date().toISOString();
    await q(sb.from('notifications').update({read_at:now}).in('id', ids)); S.notifs.forEach(n => n.read_at ||= now); render(); },
  readOne: async el => { const n = S.notifs.find(x => x.id === el.dataset.v), d = n.data || {};
    if (!n.read_at){ const now = new Date().toISOString(); await q(sb.from('notifications').update({read_at:now}).eq('id', n.id)); n.read_at = now; }
    if (d.screen) openTarget(d.screen, d.id); else render(); },
  theme: el => { LS.set('theme', el.dataset.v); applyTheme(); render(); },
  changePin: pinSheet, changePass: passSheet, deleteAccount: deleteSheet,
  npin: async el => {
    const v = el.dataset.v, f = S.form;
    f.np = v === 'del' ? f.np.slice(0, -1) : (f.np + v).slice(0, 4);
    $('#npdots').innerHTML = [0,1,2,3].map(i => `<i class="${i < f.np.length ? 'f' : ''}"></i>`).join(''); $('#nperr').textContent = '';
    if (f.np.length < 4) return;
    if (!f.np1){ f.np1 = f.np; f.np = ''; $('#nptitle').textContent = 'Confírmalo'; $('#npdots').innerHTML = '<i></i>'.repeat(4); return; }
    if (f.np !== f.np1){ f.np = ''; f.np1 = ''; $('#nptitle').textContent = 'Escribe 4 dígitos'; $('#nperr').textContent = 'No coinciden. Empieza de nuevo.'; $('#npdots').innerHTML = '<i></i>'.repeat(4); return; }
    await setPin(f.np); closeSheet(); render(); toast('PIN guardado');
  }
};

/* ============ formularios ============ */
const F = {
  login: async () => {
    const email = $('#lg-e').value.trim(), password = $('#lg-p').value, err = $('#ferr');
    if (!email || !password) return (err.textContent = 'Escribe tu correo y contraseña.');
    S.authMsg = '';
    const remember = $('#lg-r').checked; LS.set('rememberEmail', remember);
    if (remember) LS.set('email', email); else LS.del('email');
    justLoggedIn = true;
    try { await q(sb.auth.signInWithPassword({email, password})); }
    catch (e) {
      justLoggedIn = false;
      if (/Email not confirmed/i.test(String(e?.message || ''))){ S.auth = 'verify'; S.verifyEmail = email; S.authMsg = '!Todavía no confirmas tu correo. Sigue estos pasos o reenvía el correo.'; render(); return; }
      throw e;
    }
  },
  signup: async () => {
    const name = $('#su-n').value.trim(), email = $('#su-e').value.trim(), p1 = $('#su-p').value, p2 = $('#su-p2').value, err = $('#ferr');
    if (!name) return (err.textContent = 'Escribe tu nombre.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return (err.textContent = 'Escribe un correo válido.');
    if (!strongPass(p1)) return (err.textContent = 'La contraseña necesita al menos 8 caracteres, con letras y números.');
    if (p1 !== p2) return (err.textContent = 'Las contraseñas no coinciden.');
    const inv = pendingInvite();
    const redirect = location.origin + location.pathname + (inv ? `?invite=${inv}` : '');
    const data = await q(sb.auth.signUp({email, password:p1, options:{data:{full_name:name}, emailRedirectTo:redirect}}));
    if (LS.get('rememberEmail', true)) LS.set('email', email);
    if (!data.session){ S.auth = 'verify'; S.verifyEmail = email; S.authMsg = ''; render(); }
  },
  forgot: async () => {
    const email = $('#fg-e').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ($('#ferr').textContent = 'Escribe un correo válido.');
    await q(sb.auth.resetPasswordForEmail(email, {redirectTo:location.origin + location.pathname}));
    S.authMsg = 'Si el correo existe, te llegará un enlace en unos minutos. Revisa también Spam o Promociones.'; render();
  },
  recovery: async () => {
    const p1 = $('#rc-p').value, p2 = $('#rc-p2').value, err = $('#ferr');
    if (!strongPass(p1)) return (err.textContent = 'Al menos 8 caracteres, con letras y números.');
    if (p1 !== p2) return (err.textContent = 'Las contraseñas no coinciden.');
    await q(sb.auth.updateUser({password:p1}));
    S.auth = 'login'; toast('Contraseña actualizada'); await boot(true);
  },
  deleteAccount: async () => {
    const err = $('#ferr');
    if ($('#del-confirm').value.trim().toUpperCase() !== 'ELIMINAR') return (err.textContent = 'Escribe ELIMINAR para confirmar.');
    const others = S.family ? Object.keys(S.family.members).filter(id => id !== me()) : [];
    let action = null, newOwner = null;
    if (isOwner() && others.length){
      action = document.querySelector('input[name=fa]:checked')?.value;
      if (action === 'transfer') newOwner = $('#del-owner').value;
      if (!action || (action === 'transfer' && !newOwner)) return (err.textContent = 'Elige qué pasa con tu familia.');
    }
    const uid = me(), familySurvives = !!S.family && (!isOwner() || action === 'transfer');
    await deleteMyFiles(familySurvives);
    await q(sb.rpc('delete_my_account', {p_family_action:action, p_new_owner:newOwner}));
    ['pin.', 'bio.', 'tries.', 'lastAcc.', 'lastTx.', 'push.', 'remDone.'].forEach(k => LS.del(k + uid));
    LS.del('email');
    S.authMsg = 'Tu cuenta fue eliminada. Gracias por usar Kuenta.';
    closeSheet();
    await sb.auth.signOut({scope:'local'}).catch(() => {});
  },
  pass: async () => {
    const p1 = $('#pw-1').value, p2 = $('#pw-2').value, err = $('#ferr');
    if (!strongPass(p1)) return (err.textContent = 'Al menos 8 caracteres, con letras y números.');
    if (p1 !== p2) return (err.textContent = 'Las contraseñas no coinciden.');
    await q(sb.auth.updateUser({password:p1})); closeSheet(); toast('Contraseña actualizada');
  },
  profile: async () => {
    const name = $('#pf-n').value.trim().slice(0, 80); if (!name) return;
    S.profile = await q(sb.from('profiles').update({full_name:name}).eq('id', me()).select().single());
    S.users[me()] = {name, short:firstName(name)}; render(); toast('Nombre actualizado');
  },
  acc: async f => {
    const id = f.dataset.id, err = $('#ferr'), name = $('#ac-n').value.trim();
    if (!name) return (err.textContent = 'Escribe un nombre para la cuenta.');
    if (S.accounts.some(a => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) return (err.textContent = 'Ya tienes una cuenta con ese nombre.');
    const init = parseAmt($('#ac-i').value || 0), limRaw = $('#ac-l').value.trim(), limit = limRaw ? parseAmt(limRaw) : null;
    if (isNaN(init)) return (err.textContent = 'El saldo inicial debe ser un número.');
    if (limit !== null && !(limit >= 0)) return (err.textContent = 'El límite debe ser un número positivo.');
    const type = $('#ac-t').value;
    const row = {name, type, color:S.form.color, icon:TYPE_ICON[type], initial_balance:round2(init), credit_limit:limit === null ? null : round2(limit)};
    if (!$('#ac-c').disabled) row.currency = $('#ac-c').value;
    if (id){ await q(sb.from('accounts').update(row).eq('id', id)); toast('Cuenta actualizada'); }
    else {
      const shared = $('#ac-s')?.checked;
      if (shared && !isOwner()) return (err.textContent = 'Solo el dueño de la familia puede crear cuentas compartidas.');
      await q(sb.from('accounts').insert({...row, owner_id:me(), family_id:shared ? S.family.id : null, sort_order:S.accounts.length}));
      toast(shared ? 'Cuenta compartida creada' : 'Cuenta creada');
    }
    closeSheet(); await loadAccounts(); render();
  },
  budget: async f => {
    const id = f.dataset.id, err = $('#ferr'), amount = round2(parseAmt($('#bu-a').value)), alert = Number($('#bu-p').value);
    if (!(amount > 0)) return (err.textContent = 'Escribe un monto mayor que cero.');
    if (id) await q(sb.from('budgets').update({amount, alert_percent:alert}).eq('id', id));
    else { const c = $('#bu-c').value; if (!c) return (err.textContent = 'Todas las categorías ya tienen presupuesto.'); await q(sb.from('budgets').insert({category_id:c, amount, alert_percent:alert, currency:'HNL'})); }
    closeSheet(); await loadBudgets(); render(); toast(id ? 'Presupuesto actualizado' : 'Presupuesto creado');
  },
  goal: async () => {
    const err = $('#ferr'), name = $('#go-n').value.trim(), target = round2(parseAmt($('#go-t').value)), date = $('#go-d').value, sc = $('#go-s').value;
    const linkSel = $('#go-a'), linked = linkSel.value || null, linkedSc = linked ? linkSel.selectedOptions[0].dataset.sc : null;
    if (!name) return (err.textContent = 'Escribe un nombre.');
    if (!(target > 0)) return (err.textContent = 'La meta debe ser mayor que cero.');
    if (!date || date <= TODAY) return (err.textContent = 'Elige una fecha futura.');
    if (linked && linkedSc !== sc) return (err.textContent = sc === 'f' ? 'Una meta familiar solo puede medirse con una cuenta compartida.' : 'Una meta personal solo puede medirse con una cuenta personal.');
    await q(sb.from('goals').insert({name, target_amount:target, target_date:date, icon:S.form.icon, color:COLORS[S.goals.length % COLORS.length],
      owner_id:sc === 'p' ? me() : null, family_id:sc === 'f' ? S.family.id : null, account_id:linked, currency:'HNL'}));
    closeSheet(); await loadGoals(); render(); toast('Meta creada');
  },
  contrib: async f => {
    const g = S.goals.find(x => x.id === f.dataset.id), err = $('#ferr'); let amount = round2(parseAmt($('#co-a').value));
    if (!(amount > 0)) return (err.textContent = 'Escribe un monto mayor que cero.');
    if ($('#co-w').checked){ if (amount > goalInfo(g).saved) return (err.textContent = 'No puedes retirar más de lo ahorrado.'); amount = -amount; }
    await q(sb.from('goal_contributions').insert({goal_id:g.id, amount, contributed_on:TODAY, created_by:me()}));
    closeSheet(); await Promise.all([loadGoals(), afterWrite()]); render(); toast(amount > 0 ? 'Aporte guardado' : 'Retiro guardado');
  },
  cat: async f => {
    const id = f.dataset.id, err = $('#ferr'), name = $('#ca-n').value.trim();
    if (!name) return (err.textContent = 'Escribe un nombre.');
    const parent = $('#ca-p').value || null, kind = id ? cat(id).kind : $('#ca-k').value, scope = id ? cat(id).scope : S.ui.catScope;
    if (S.categories.some(c => c.id !== id && c.scope === scope && c.kind === kind && c.name.toLowerCase() === name.toLowerCase())) return (err.textContent = 'Ya existe una categoría con ese nombre.');
    if (parent && id && S.categories.some(k => k.parent === id)) return (err.textContent = 'Esta categoría tiene subcategorías; no puede ir dentro de otra.');
    const row = {name, parent_id:parent, icon:S.form.icon, color:S.form.color};
    if (id) await q(sb.from('categories').update(row).eq('id', id));
    else await q(sb.from('categories').insert({...row, kind, owner_id:scope === 'p' ? me() : null, family_id:scope === 'f' ? S.family.id : null, sort_order:100}));
    S.ui.catKind = kind; closeSheet(); await loadCategories(); render(); toast(id ? 'Categoría actualizada' : 'Categoría creada');
  },
  family: async () => {
    const name = $('#fa-n').value.trim(); if (!name) return ($('#ferr').textContent = 'Escribe un nombre para tu familia.');
    await q(sb.rpc('create_family', {p_name:name})); await Promise.all([loadFamily(), loadCategories()]); render(); toast('Familia creada. Ya puedes invitar y crear cuentas compartidas.');
  },
  invite: async () => {
    const email = $('#in-e').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ($('#ferr').textContent = 'Escribe un correo válido.');
    const token = await q(sb.rpc('invite_family_member', {p_email:email, p_role:$('#in-r').value}));
    await loadFamily(); render();
    copyText(`${location.origin}${location.pathname}?invite=${token}`, 'Invitación creada y enlace copiado. Envíalo por WhatsApp o correo.');
  }
};

/* =====================================================================
   RECORDATORIOS, PAGOS PROGRAMADOS, DEUDAS Y AHORRO
   ===================================================================== */
let pendingGo = null; // pantalla que pidió abrir una notificación (?go=)
const DEFAULT_TIMES = ['09:00','13:00','20:00'];
const localTZ = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Tegucigalpa'; } catch { return 'America/Tegucigalpa'; } };
const defaultReminder = () => ({enabled:true, times:[...DEFAULT_TIMES], timezone:localTZ(), skip_if_logged:true, scheduled_enabled:true, debt_enabled:true, saved:false});
const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'a. m.' : 'p. m.'}`; };
const needs06 = () => S.v06 ? '' : '<div class="note" style="margin-bottom:12px">Esta función se está activando en tu cuenta. Vuelve a intentarlo en un rato.</div>';

/* ---- fechas ---- */
const lastDay = (y, m) => new Date(y, m, 0).getDate(); // m: 1-12
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number), d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const dayIn = (ym, day) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(Math.min(day, lastDay(y, m)))}`; };
const dDiff = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
const monthsBetween = (a, b) => { const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number); return Math.max(0, (y2 - y1) * 12 + m2 - m1 - (d2 < d1 ? 1 : 0)); };
const monthLabel = s => new Date(s + 'T12:00:00').toLocaleDateString('es-HN', {month:'short', year:'numeric'}).replace('.', '');
const whenLabel = s => { const d = dDiff(TODAY, s);
  return d < 0 ? {t:`Atrasado ${-d} ${d === -1 ? 'día' : 'días'}`, c:'over'} : d === 0 ? {t:'Hoy', c:'warn'} : d === 1 ? {t:'Mañana', c:'warn'} : d <= 7 ? {t:`En ${d} días`, c:'brand'} : {t:dShort(s), c:'mute'}; };
const roundTo = (n, s) => Math.max(s, Math.round(n / s) * s);
const fmtRate = r => `${Math.round(r * 100) / 100}%`;

/* ---- carga ---- */
const mapSch = r => ({id:r.id, scope:r.family_id ? 'f' : 'p', acc:r.account_id, cat:r.category_id, name:r.name, amount:+r.amount, freq:r.frequency, anchor:r.anchor_day,
  next:r.next_date, end:r.end_date, before:r.remind_day_before, same:r.remind_same_day, active:r.is_active});
const mapDebt = r => ({id:r.id, name:r.name, lender:r.lender || '', kind:r.kind, cur:r.currency, orig:+r.original_amount, bal0:+r.current_balance, rate:+r.annual_rate,
  rtype:r.rate_type, term:r.term_months, inst:r.installment == null ? null : +r.installment, start:r.start_date, from:r.tracking_from, payDay:r.payment_day,
  acc:r.account_id, cat:r.category_id, icon:r.icon, status:r.status, notes:r.notes || '', pays:[]});
const mapDebtPay = r => ({id:r.id, amount:+r.amount, principal:+r.principal, interest:+r.interest, extra:r.is_extra, date:r.paid_on, tx:r.transaction_id});
const mapCh = r => ({id:r.id, kind:r.kind, name:r.name, base:+r.base_amount, slots:r.slots, done:r.done || [], start:r.start_date, goal:r.goal_id, status:r.status});
async function loadReminders(){ const r = await q(sb.from('reminder_settings').select('*').eq('user_id', me()).maybeSingle()); S.reminder = r ? {...r, saved:true} : defaultReminder(); }
async function loadScheduled(){ S.scheduled = (await q(sb.from('scheduled_payments').select('*').order('next_date').order('created_at'))).map(mapSch); }
async function loadDebts(){
  const [ds, ps] = await Promise.all([q(sb.from('debts').select('*').neq('status', 'archived').order('created_at')),
    fetchAll(() => sb.from('debt_payments').select('*').order('paid_on').order('created_at'))]);
  S.debts = ds.map(mapDebt);
  ps.forEach(p => { const d = S.debts.find(x => x.id === p.debt_id); if (d) d.pays.push(mapDebtPay(p)); });
}
async function loadChallenges(){ S.challenges = (await q(sb.from('savings_challenges').select('*').neq('status', 'archived').order('created_at'))).map(mapCh); }
// Si la base aún no tiene la migración 06, el resto de la app sigue funcionando
async function loadPlanner(){
  try { await Promise.all([loadReminders(), loadScheduled(), loadDebts(), loadChallenges()]); S.v06 = true; }
  catch { S.v06 = false; S.reminder = S.reminder || defaultReminder(); }
}

/* ---- abrir lo que pidió una notificación ---- */
function openTarget(screen, id){
  closeSheet();
  if (screen === 'add') return startAdd('expense');
  if (screen === 'scheduled'){ go('scheduled', 'home'); if (id && S.scheduled.some(s => s.id === id)) schSheet(id); return; }
  if (screen === 'debt' && S.debts.some(d => d.id === id)){ S.ui.debtId = id; go('debt', 'debts'); return; }
  if (screen === 'debt') screen = 'debts';
  if (['debts','savings','alerts','budgets','goals','reminders'].includes(screen)) go(screen, 'home');
}
function applyGo(){ const g = pendingGo; pendingGo = null; if (g && S.profile && !S.locked && !S.needPinSetup) openTarget(g.screen, g.id); }
function markRemindersRead(){
  const ids = S.notifs.filter(n => n.type === 'reminder' && !n.read_at).map(n => n.id); if (!ids.length) return;
  const now = new Date().toISOString(); S.notifs.forEach(n => { if (ids.includes(n.id)) n.read_at = now; });
  sb.from('notifications').update({read_at:now}).in('id', ids).then(() => {}, () => {});
}

/* ============ recordatorios y notificaciones ============ */
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function pushState(){
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return isIOS() && !isStandalone() ? 'ios' : 'no';
  if (Notification.permission === 'denied') return 'denied';
  const v = LS.get('push.' + me());
  if (Notification.permission === 'granted' && v) return v === true ? 'push' : 'local';
  return 'off';
}
const swReady = () => Promise.race([navigator.serviceWorker.ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error('Las notificaciones necesitan abrir Kuenta con https. Intenta de nuevo.')), 5000))]);
async function enablePush(){
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('No diste permiso. Puedes activarlo después en los ajustes del navegador.', 'warn');
  const reg = await swReady();
  let mode = 'local';
  // La clave pública la genera el servidor (función send-push); si aún no existe, avisamos con la app abierta
  const vapid = 'PushManager' in window && S.v06 ? await q(sb.rpc('vapid_public_key')).catch(() => null) : null;
  if (vapid){
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:unb64(vapid)});
    const j = sub.toJSON();
    await q(sb.rpc('save_push_subscription', {p_endpoint:j.endpoint, p_p256dh:j.keys.p256dh, p_auth:j.keys.auth, p_user_agent:navigator.userAgent.slice(0, 300)}));
    mode = true;
  }
  LS.set('push.' + me(), mode);
  if (!S.reminder.saved) await saveReminder({});
  await reg.showNotification('¡Listo! Así te avisaremos ✍️', {body:'Te recordaremos registrar tus movimientos y tus pagos.', icon:'icons/icon-192.png', badge:'icons/favicon-48.png', tag:'kuenta-test'});
  render(); toast(mode === true ? 'Notificaciones activadas en este teléfono' : 'Avisos activados mientras Kuenta esté abierta');
}
async function dropPushHere(){
  try {
    LS.del('push.' + me());
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = await reg?.pushManager?.getSubscription();
    if (sub){ await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
  } catch {}
}
async function saveReminder(patch){
  const r = {...(S.reminder || defaultReminder()), ...patch};
  const times = [...new Set((r.times || []).map(t => String(t).slice(0, 5)).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort().slice(0, 6);
  const row = {user_id:me(), enabled:!!r.enabled, times, timezone:localTZ(), skip_if_logged:!!r.skip_if_logged, scheduled_enabled:!!r.scheduled_enabled, debt_enabled:!!r.debt_enabled};
  if (S.v06) await q(sb.from('reminder_settings').upsert(row));
  S.reminder = {...row, saved:true};
}
/* Respaldo local: si este teléfono no recibe push del servidor, avisa mientras Kuenta está abierta */
function localReminderTick(){
  TODAY = localISO(new Date());
  if (!S.profile || S.locked || S.needPinSetup || !S.reminder?.enabled) return;
  if (LS.get('push.' + me()) === true) return; // el servidor ya le avisa a este teléfono
  const now = new Date(), hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`, mins = t => +t.slice(0, 2) * 60 + +t.slice(3);
  let rec = LS.get('remDone.' + me(), {day:'', times:[]});
  if (rec.day !== TODAY) rec = {day:TODAY, times:[]};
  const due = S.reminder.times.filter(t => t <= hm && mins(hm) - mins(t) <= 30 && !rec.times.includes(t));
  if (!due.length) return;
  rec.times.push(...due); LS.set('remDone.' + me(), rec);
  if (S.reminder.skip_if_logged && Date.now() - LS.get('lastTx.' + me(), 0) < 3 * 3600e3) return;
  const title = '¿Ya registraste tus movimientos? ✍️';
  if (document.visibilityState === 'visible') toast(title, 'ok', {label:'Registrar', run: async () => startAdd('expense')});
  else if (window.Notification?.permission === 'granted' && 'serviceWorker' in navigator)
    swReady().then(reg => reg.showNotification(title, {body:'Toma un minuto y anota lo de hoy.', icon:'icons/icon-192.png', badge:'icons/favicon-48.png', tag:'kuenta-rem', data:{url:'./?go=add'}})).catch(() => {});
}
function vReminders(){
  const r = S.reminder || defaultReminder(), st = pushState();
  const status = {
    push:['ok', 'Activas en este teléfono', 'Te llegan aunque Kuenta esté cerrada.'],
    local:['warn', 'Activas con Kuenta abierta', 'Por ahora te avisamos mientras Kuenta esté abierta o en segundo plano.'],
    off:['mute', 'Desactivadas en este teléfono', 'Actívalas para recibir tus recordatorios.'],
    denied:['over', 'Bloqueadas', 'Bloqueaste las notificaciones. Permítelas para Kuenta en los ajustes del navegador o del teléfono.'],
    ios:['warn', 'Falta instalar Kuenta', 'En iPhone: toca Compartir ⬆️ → "Agregar a inicio", abre Kuenta desde ese ícono y vuelve aquí.'],
    no:['mute', 'No disponibles', 'Este navegador no permite notificaciones. Prueba con Chrome, Edge o Safari actualizado.']}[st];
  const tg = (k, title, sub) => `<div class="toggle"><div class="t"><b>${title}</b><small>${sub}</small></div><label class="sw"><input type="checkbox" data-in="remOpt" data-k="${k}" ${r[k] ? 'checked' : ''} aria-label="${title}"><span></span></label></div>`;
  return `${subhead('Recordatorios')}${needs06()}
  <div class="panel"><div class="eyebrow" style="margin-bottom:8px">Notificaciones</div>
    <div style="display:flex;align-items:center;gap:12px"><span class="tile" style="background:var(--brand-soft);color:var(--brand)">${ic('bell','sm')}</span>
      <div style="flex:1;min-width:0"><b>${status[1]}</b><small class="muted" style="display:block;font-size:12.5px">${status[2]}</small></div><span class="pill ${status[0]}">${st === 'push' || st === 'local' ? 'Sí' : 'No'}</span></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      ${st === 'off' || (st === 'local' && S.v06) ? `<button class="btn sm" data-a="pushOn">${ic('bell','sm')} Activar notificaciones</button>` : ''}
      ${st === 'push' || st === 'local' ? `<button class="btn ghost sm" data-a="pushTest">Probar</button><button class="btn ghost sm" data-a="pushOff">Desactivar aquí</button>` : ''}</div></div>
  <div class="panel" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:2px">Registrar movimientos</div>
    ${tg('enabled', 'Recordarme registrar', 'Un aviso a cada hora que elijas')}
    ${r.enabled ? `<div style="padding:10px 0 4px">${r.times.map((t, i) => `<div class="timechip"><input class="inp" type="time" value="${esc(t)}" data-in="remTime" data-i="${i}" aria-label="Recordatorio ${i + 1}">
      <button class="iconbtn" data-a="remDel" data-v="${i}" aria-label="Quitar ${fmtTime(t)}" style="color:var(--neg)">${ic('trash','sm')}</button></div>`).join('') || '<div class="muted" style="font-size:13px;margin-bottom:8px">Sin horas. Agrega al menos una.</div>'}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${r.times.length < 6 ? `<button class="btn ghost sm" data-a="remAdd">${ic('plus','sm')} Agregar hora</button>` : ''}
      <button class="textbtn" style="font-size:13px" data-a="remReset">Usar 9:00 a. m., 1:00 p. m. y 8:00 p. m.</button></div></div>` : ''}
    ${tg('skip_if_logged', 'No insistir si ya registré', 'Si anotaste algo en las últimas 3 horas, no te avisamos')}</div>
  <div class="panel" style="margin-top:12px"><div class="eyebrow" style="margin-bottom:2px">Pagos y deudas</div>
    ${tg('scheduled_enabled', 'Pagos programados', 'Un día antes y el mismo día de cada pago')}
    ${tg('debt_enabled', 'Cuotas de deudas', 'Un día antes y el día de pago de cada cuota')}</div>
  <div class="note" style="margin-top:12px">Las notificaciones nunca muestran tus saldos. Los avisos de pagos y cuotas también aparecen en <button class="link" data-a="nav" data-v="alerts">Alertas</button>.</div>`;
}

/* ============ pagos programados ============ */
const FREQ = {once:'Una sola vez', weekly:'Cada semana', biweekly:'Cada 2 semanas', monthly:'Cada mes', bimonthly:'Cada 2 meses', quarterly:'Cada 3 meses', yearly:'Cada año'};
const FREQ_M = {monthly:1, bimonthly:2, quarterly:3, yearly:12};
function nextOcc(s, from = s.next){
  if (s.freq === 'weekly') return addDays(from, 7);
  if (s.freq === 'biweekly') return addDays(from, 14);
  const m = FREQ_M[s.freq]; return m ? dayIn(ymAdd(from.slice(0, 7), m), s.anchor || +from.slice(8)) : null;
}
function schDueUntil(s, end){ const out = []; let d = s.next; while (d && d <= end && out.length < 60 && !(s.end && d > s.end)){ out.push(d); d = nextOcc(s, d); } return out; }
const sortSch = () => S.scheduled.sort((a, b) => a.next.localeCompare(b.next));
function upcoming(days){
  const lim = addDays(TODAY, days), out = [];
  S.scheduled.filter(s => s.active && s.next <= lim).forEach(s => { const c = cat(s.cat); out.push({kind:'sch', id:s.id, date:s.next, name:s.name, amount:s.amount, cur:acc(s.acc)?.cur || 'HNL', icon:c.icon, color:c.color}); });
  S.debts.filter(d => d.status === 'active').forEach(d => { const due = debtDue(d); if (due && due <= lim && debtBal(d) > 0) out.push({kind:'debt', id:d.id, date:due, name:'Cuota · ' + d.name, amount:debtPay(d), cur:d.cur, icon:d.icon, color:'#DC2626'}); });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function upRow(u){
  const w = whenLabel(u.date);
  return `<button class="tx" data-a="${u.kind === 'sch' ? 'schOpen' : 'debtOpen'}" data-v="${u.id}"><span class="tile" style="background:${soft(u.color)};color:${u.color}">${esc(u.icon)}</span>
    <span class="mid"><b>${esc(u.name)}</b><small>${u.kind === 'sch' ? 'Pago programado' : 'Deuda'} · ${dShort(u.date)}</small></span>
    <span class="amt"><b>${money(u.amount, u.cur)}</b><span class="pill ${w.c}">${w.t}</span></span></button>`;
}
function schRow(s){
  const c = cat(s.cat), a = acc(s.acc), w = whenLabel(s.next);
  return `<button class="tx" data-a="schOpen" data-v="${s.id}" style="${s.active ? '' : 'opacity:.6'}"><span class="tile" style="background:${soft(c.color)};color:${c.color}">${esc(c.icon)}</span>
    <span class="mid"><b>${esc(s.name)}</b><small>${FREQ[s.freq]} · ${esc(a ? a.name : 'Cuenta archivada')}${s.scope === 'f' ? ' · Familia' : ''}</small></span>
    <span class="amt"><b>${money(s.amount, a?.cur)}</b>${s.active ? `<span class="pill ${w.c}">${w.t}</span>` : '<span class="pill mute">Pausado</span>'}</span></button>`;
}
function vScheduled(){
  const p = period(), act = S.scheduled.filter(s => s.active);
  let tot = 0, n = 0;
  act.forEach(s => { if ((acc(s.acc)?.cur || 'HNL') !== 'HNL') return; const k = schDueUntil(s, p.end).length; tot += k * s.amount; n += k; });
  const wk = addDays(TODAY, 7);
  const grp = (t, arr) => arr.length ? `<div class="section"><div class="sec-h"><h2>${t}</h2></div><div class="list">${arr.map(schRow).join('')}</div></div>` : '';
  return `${subhead('Pagos programados', S.v06 && writableAccounts().length ? `<button class="iconbtn" data-a="schNew" aria-label="Nuevo pago programado" style="background:var(--brand);color:var(--on-brand);border:0">${ic('plus','sm')}</button>` : '')}${needs06()}
  <div class="panel"><div class="eyebrow">Por pagar hasta el ${dShort(p.end)}</div><div class="num" style="font-size:24px;font-weight:700;margin-top:2px">${money(tot)}</div>
    <small class="muted">${n} ${n === 1 ? 'pago' : 'pagos'} en tu mes financiero · te avisamos un día antes y el mismo día</small></div>
  ${grp('Atrasados', act.filter(s => s.next < TODAY))}${grp('Próximos 7 días', act.filter(s => s.next >= TODAY && s.next <= wk))}
  ${grp('Más adelante', act.filter(s => s.next > wk))}${grp('Pausados o terminados', S.scheduled.filter(s => !s.active))}
  ${S.scheduled.length ? '' : `<div class="empty" style="margin-top:14px">Programa la luz, el agua, el internet, la renta, el colegio o tus suscripciones y nunca se te pasa una fecha.${S.v06 && writableAccounts().length ? '<br><button class="btn sm" style="margin:12px auto 0" data-a="schNew">Programar mi primer pago</button>' : ''}</div>`}`;
}
function schCatOpts(a, sel){
  if (!a) return '';
  const sc = a.shared ? 'f' : 'p';
  return S.categories.filter(c => c.scope === sc && c.kind !== 'income' && !c.archived)
    .map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.parent ? cat(c.parent).name + ' › ' : '')}${esc(c.name)}</option>`).join('');
}
function schForm(id){
  const s = id ? S.scheduled.find(x => x.id === id) : null, accs = writableAccounts();
  const a0 = (s && accs.find(a => a.id === s.acc)) || accs.find(a => !a.shared) || accs[0];
  openSheet(`${sheetHead(s ? 'Editar pago' : 'Nuevo pago programado')}<form class="form" data-f="sched" data-id="${id || ''}" novalidate>
    <div class="field"><label for="sp-n">Nombre</label><input class="inp" id="sp-n" maxlength="60" value="${esc(s?.name || '')}" placeholder="Ej: Luz ENEE, Internet, Renta"></div>
    <div class="row2"><div class="field"><label for="sp-a">Monto</label><input class="inp" id="sp-a" inputmode="decimal" value="${s ? s.amount : ''}" placeholder="850"></div>
    <div class="field"><label for="sp-f">Frecuencia</label><select class="inp" id="sp-f">${Object.entries(FREQ).map(([k, l]) => `<option value="${k}" ${(s ? s.freq : 'monthly') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <div class="field"><label for="sp-ac">Se paga desde</label><select class="inp" id="sp-ac" data-in="schAcc">${accs.map(a => `<option value="${a.id}" ${a0 && a0.id === a.id ? 'selected' : ''}>${esc(a.icon)} ${esc(a.name)}${a.shared ? ' · Familia' : ''}</option>`).join('')}</select></div>
    <div class="field"><label for="sp-c">Categoría</label><select class="inp" id="sp-c">${schCatOpts(a0, s?.cat)}</select></div>
    <div class="row2"><div class="field"><label for="sp-d">${s ? 'Próxima fecha' : 'Primera fecha'}</label><input class="inp" id="sp-d" type="date" value="${s ? s.next : addDays(TODAY, 1)}"></div>
    <div class="field"><label for="sp-e">Termina (opcional)</label><input class="inp" id="sp-e" type="date" value="${s?.end || ''}"></div></div>
    <div class="toggle"><div class="t"><b>Avisarme un día antes</b></div><label class="sw"><input type="checkbox" id="sp-b" ${!s || s.before ? 'checked' : ''}><span></span></label></div>
    <div class="toggle"><div class="t"><b>Avisarme el mismo día</b></div><label class="sw"><input type="checkbox" id="sp-s" ${!s || s.same ? 'checked' : ''}><span></span></label></div>
    <div class="err" id="ferr"></div><button class="btn" type="submit">Guardar</button></form>`);
}
function schSheet(id){
  const s = S.scheduled.find(x => x.id === id); if (!s) return;
  const c = cat(s.cat), a = acc(s.acc), w = whenLabel(s.next), ed = canEditScope(s.scope) && !!a && canWriteAcc(a);
  openSheet(`${sheetHead(esc(s.name))}
    <div style="text-align:center;margin-bottom:14px"><span class="tile" style="margin:0 auto 8px;width:56px;height:56px;font-size:26px;background:${soft(c.color)};color:${c.color}">${esc(c.icon)}</span>
      <div class="num" style="font-size:30px;font-weight:700">${money(s.amount, a?.cur)}</div>
      <span class="pill ${s.active ? w.c : 'mute'}" style="text-transform:none">${s.active ? `${w.t} · ${dLong(s.next)}` : 'Pausado'}</span></div>
    <div class="panel"><table class="rep"><tr><td class="muted">Frecuencia</td><td class="r">${FREQ[s.freq]}</td></tr>
      <tr><td class="muted">Cuenta</td><td class="r">${esc(a?.name || '—')}</td></tr><tr><td class="muted">Categoría</td><td class="r">${esc(c.icon)} ${esc(c.name)}</td></tr>
      ${s.end ? `<tr><td class="muted">Hasta</td><td class="r">${dShort(s.end)} ${s.end.slice(0, 4)}</td></tr>` : ''}
      <tr><td class="muted">Avisos</td><td class="r">${[s.before && 'Un día antes', s.same && (s.before ? 'el mismo día' : 'El mismo día')].filter(Boolean).join(' y ') || 'Sin aviso'}</td></tr></table></div>
    ${ed && s.active ? `<form class="form" data-f="schPay" data-id="${s.id}" style="margin-top:14px" novalidate>
      <div class="row2"><div class="field"><label for="sp-pa">Monto pagado</label><input class="inp" id="sp-pa" inputmode="decimal" value="${s.amount}"></div>
      <div class="field"><label for="sp-pd">Fecha</label><input class="inp" id="sp-pd" type="date" value="${s.next <= TODAY ? s.next : TODAY}" max="${TODAY}"></div></div>
      <div class="err" id="ferr"></div>
      <button class="btn" type="submit">${ic('check','sm')} Registrar pago</button>
      <button type="button" class="btn ghost" data-a="schSkip" data-v="${s.id}">${s.freq === 'once' ? 'Ya lo registré · terminar' : 'Ya lo registré · pasar al siguiente'}</button></form>` : ''}
    ${ed ? `<div class="row2" style="margin-top:10px"><button class="btn ghost" data-a="schEdit" data-v="${s.id}">Editar</button><button class="btn ghost" data-a="schToggle" data-v="${s.id}">${s.active ? 'Pausar' : 'Reanudar'}</button></div>
      <div id="schdel" style="margin-top:10px"><button class="btn danger" data-a="schAskDel" data-v="${s.id}">${ic('trash','sm')} Eliminar</button></div>`
      : '<div class="note" style="margin-top:12px">Tu rol no permite modificar este pago.</div>'}`);
}
/* Pasa al siguiente vencimiento; si ya no hay más (una sola vez o pasó la fecha final), lo termina */
async function schAdvance(s){
  const nn = s.freq === 'once' ? null : nextOcc(s), done = !nn || (s.end && nn > s.end);
  await q(sb.from('scheduled_payments').update(done ? {is_active:false} : {next_date:nn}).eq('id', s.id));
  if (done) s.active = false; else s.next = nn;
  sortSch();
  return done ? null : nn;
}

/* ============ deudas ============ */
const DEBT_KINDS = {prestamo:['🏦','Préstamo bancario'], tarjeta:['💳','Tarjeta de crédito'], hipoteca:['🏠','Hipoteca'], vehiculo:['🚗','Préstamo de vehículo'],
  personal:['🤝','Préstamo personal o familiar'], cooperativa:['🏛️','Cooperativa'], otro:['📄','Otra deuda']};
const mRate = d => d.rate / 1200;
const annuity = (B, r, n) => n > 0 ? (r ? B * r / (1 - Math.pow(1 + r, -n)) : B / n) : 0;
const flatPay = (orig, r, n) => orig / n + orig * r;
const debtBal = d => Math.max(0, round2(d.bal0 - d.pays.reduce((s, p) => s + p.principal, 0)));
function debtPay(d){
  if (d.inst) return d.inst;
  if (d.term) return round2(d.rtype === 'flat' ? flatPay(d.orig, mRate(d), d.term) : annuity(d.orig, mRate(d), d.term));
  return round2(Math.max(debtBal(d) * 0.05, 100));
}
// Interés de un mes: sobre el saldo, o sobre el monto prestado si es flat
const debtInt = (d, B) => round2(d.rtype === 'flat' ? d.orig * mRate(d) : B * mRate(d));
function simulate(d, B, pay, extra = 0){
  const rows = []; let tot = 0, m = 0;
  while (B > 0.005 && m < 600){
    const i = debtInt(d, B), p = pay + extra;
    if (p <= i) return {ok:false, months:Infinity, interest:Infinity, rows, i};
    const pr = Math.min(B, p - i); B = round2(B - pr); tot += i; m++;
    rows.push({m, pay:round2(pr + i), i, pr:round2(pr), B});
  }
  return {ok:B <= 0.005, months:m, interest:round2(tot), rows};
}
/* Saldo estimado de un préstamo que ya tiene k cuotas pagadas */
function estBalance(orig, r, n, pay, k, flat){
  if (n) k = Math.min(k, n);
  if (flat) return Math.max(0, round2(orig - (n ? orig / n : pay - orig * r) * k));
  let B = orig; for (let i = 0; i < k && B > 0; i++) B = B * (1 + r) - pay;
  return Math.max(0, round2(B));
}
/* Próxima cuota según el día de pago. Una cuota cuenta como pagada si hubo un pago en los 20 días previos (o después). */
function debtDue(d){
  if (!d.payDay || d.status !== 'active') return null;
  const ym = TODAY.slice(0, 7), last = d.pays.length ? d.pays[d.pays.length - 1].date : null;
  for (const k of [-1, 0, 1, 2]){
    const x = dayIn(ymAdd(ym, k), d.payDay);
    if (x < d.from || (last && last > addDays(x, -20))) continue;
    return x;
  }
  return null;
}
function debtInfo(d){
  const bal = debtBal(d), pay = debtPay(d), sim = simulate(d, bal, pay);
  return {bal, pay, sim, pct:Math.max(0, Math.min(100, (1 - bal / d.orig) * 100)), due:bal > 0 ? debtDue(d) : null};
}
/* Varias deudas a la vez: cada una paga su cuota; el extra (y las cuotas que se liberan) van a la prioritaria */
function planDebts(debts, extra, method){
  const ds = debts.map(d => ({d, B:debtBal(d), pay:debtPay(d), at:0})).filter(x => x.B > 0.005);
  const budget = ds.reduce((s, x) => s + x.pay, 0) + extra, order = [];
  let m = 0, tot = 0;
  while (ds.some(x => x.B > 0.005) && m < 600){
    m++; let avail = budget;
    for (const x of ds) if (x.B > 0.005){ const i = debtInt(x.d, x.B); x.B += i; tot += i; }
    for (const x of ds) if (x.B > 0.005){ const p = Math.min(x.pay, x.B, avail); x.B -= p; avail -= p; }
    ds.filter(x => x.B > 0.005).sort(method === 'avalanche' ? (a, b) => b.d.rate - a.d.rate || a.B - b.B : (a, b) => a.B - b.B)
      .forEach(x => { const p = Math.min(avail, x.B); x.B -= p; avail -= p; });
    ds.forEach(x => { if (x.B <= 0.005 && !x.at){ x.B = 0; x.at = m; order.push(x); } });
  }
  return {ok:ds.every(x => x.B <= 0.005), months:m, interest:round2(tot), order};
}
function debtTips(act, infos, st){
  const t = [], live = act.filter(d => infos.get(d.id).bal > 0); if (!live.length) return t;
  const top = [...live].sort((a, b) => b.rate - a.rate)[0], ti = infos.get(top.id);
  if (live.length > 1 && top.rate > 0) t.push(['🎯', `Pon cada lempira extra en <b>${esc(top.name)}</b>: con ${fmtRate(top.rate)} anual es la que más te cuesta. A las demás, solo su cuota.`]);
  if (ti.sim.ok && top.rate > 0){
    const x = roundTo(ti.pay * 0.1, 50), s = simulate(top, ti.bal, ti.pay, x);
    if (s.ok && ti.sim.months - s.months >= 1) t.push(['💡', `Si a <b>${esc(top.name)}</b> le abonas ${money(x, top.cur)} más al mes, terminas <b>${ti.sim.months - s.months} ${ti.sim.months - s.months === 1 ? 'mes' : 'meses'} antes</b> y te ahorras <b>${money(ti.sim.interest - s.interest, top.cur)}</b> en intereses.`]);
    const bw = simulate(top, ti.bal, ti.pay, ti.pay / 12);
    if (top.kind !== 'tarjeta' && bw.ok && ti.sim.months - bw.months >= 1) t.push(['📅', `Paga media cuota cada quincena (${money(ti.pay / 2, top.cur)}): al año harás una cuota extra sin sentirlo. En <b>${esc(top.name)}</b> son ${ti.sim.months - bw.months} meses menos y ${money(ti.sim.interest - bw.interest, top.cur)} de ahorro (confirma con tu banco que el abono va a capital).`]);
    const lump = simulate(top, ti.bal, ti.pay, ti.pay * 2 / 12);
    if (lump.ok && ti.sim.interest - lump.interest > 100) t.push(['🎁', `Abona a capital una cuota de tu <b>décimo cuarto mes</b> (junio) y otra de tu <b>aguinaldo</b> (diciembre): te ahorras cerca de ${money(ti.sim.interest - lump.interest, top.cur)}.`]);
  }
  live.filter(d => d.kind === 'tarjeta' && d.rate >= 30).forEach(d => t.push(['💳', `Tu tarjeta <b>${esc(d.name)}</b> cobra ${fmtRate(d.rate)} al año. No pagues solo el mínimo y no la uses mientras la bajas.`]));
  const big = live.find(d => d.rate > 30 && infos.get(d.id).sim.ok && infos.get(d.id).bal >= 10000);
  if (big){ const i = infos.get(big.id), alt = simulate({...big, rate:22, rtype:'saldo'}, i.bal, i.pay);
    if (alt.ok && i.sim.interest - alt.interest > 1000) t.push(['🏦', `Si consolidas <b>${esc(big.name)}</b> a 22% anual pagando la misma cuota, te ahorrarías cerca de ${money(i.sim.interest - alt.interest, big.cur)}. Pregunta en tu banco o cooperativa y revisa las comisiones.`]); }
  if (live.length > 1){ const sm = [...live].sort((a, b) => infos.get(a.id).bal - infos.get(b.id).bal)[0];
    if (sm.id !== top.id) t.push(['❄️', `¿Necesitas motivación? <b>${esc(sm.name)}</b> es la más pequeña (${money(infos.get(sm.id).bal, sm.cur)}). Liquidarla primero te da una victoria rápida y liberas su cuota.`]); }
  if (st.inc > 0){ const r = live.filter(d => d.cur === 'HNL').reduce((s, d) => s + infos.get(d.id).pay, 0) / st.inc * 100;
    if (r >= 40) t.push(['⚠️', `Tus cuotas se llevan el <b>${Math.round(r)}%</b> de tus ingresos. Evita deudas nuevas hasta bajar del 30%.`]);
    else if (r > 0 && r < 20) t.push(['✅', `Tus cuotas son el ${Math.round(r)}% de tus ingresos: un nivel sano. ¡Sigue así!`]); }
  if (live.some(d => !infos.get(d.id).sim.ok)) t.push(['🚨', 'Hay una deuda cuya cuota no alcanza ni para los intereses: el saldo nunca baja. Habla con tu acreedor para reestructurarla.']);
  return t;
}
function debtRow(d, i){
  const w = i.due ? whenLabel(i.due) : null;
  return `<button class="bud" data-a="debtOpen" data-v="${d.id}">
    <div class="h"><span class="tile" style="background:var(--neg-soft)">${esc(d.icon)}</span>
    <span class="t"><b>${esc(d.name)}</b><small class="num">Debes ${money(i.bal, d.cur)}${d.rate ? ` · ${fmtRate(d.rate)} anual` : ''}</small></span>
    ${d.status === 'paid' ? '<span class="pill ok">Liquidada</span>' : w ? `<span class="pill ${w.c}">${w.t}</span>` : ''}</div>
    <div class="bar"><i class="brand" style="width:${i.pct}%"></i></div>
    <small class="muted" style="font-size:12px">${Math.round(i.pct)}% pagado${i.bal > 0 ? ` · cuota ${money(i.pay, d.cur)}${i.sim.ok ? ` · libre en ${monthLabel(addMonths(TODAY, i.sim.months))}` : ''}` : ''}</small></button>`;
}
function vDebts(){
  const infos = new Map(S.debts.map(d => [d.id, debtInfo(d)]));
  const act = S.debts.filter(d => d.status === 'active'), paid = S.debts.filter(d => d.status === 'paid');
  const hn = act.filter(d => d.cur === 'HNL' && infos.get(d.id).bal > 0), st = moneyStats();
  const total = hn.reduce((s, d) => s + infos.get(d.id).bal, 0), monthly = hn.reduce((s, d) => s + infos.get(d.id).pay, 0);
  const allOk = hn.every(d => infos.get(d.id).sim.ok);
  const base = {ok:allOk && hn.length > 0, months:hn.length ? Math.max(...hn.map(d => infos.get(d.id).sim.months)) : 0, interest:hn.reduce((s, d) => s + infos.get(d.id).sim.interest, 0)};
  let strat = '';
  if (hn.length){
    const extra = S.ui.debtExtra ?? roundTo(monthly * 0.1 || 500, 50);
    const av = planDebts(hn, extra, 'avalanche'), sn = planDebts(hn, extra, 'snowball');
    const best = av.ok && (!sn.ok || av.interest <= sn.interest) ? 'av' : 'sn', plan = best === 'av' ? av : sn;
    const cell = (k, t, r) => `<div class="${best === k ? 'best' : ''}"><small>${t}</small><b>${r.ok ? `${r.months} ${r.months === 1 ? 'mes' : 'meses'}` : '—'}</b><small>${r.ok ? 'Intereses ' + short(r.interest) : 'No alcanza'}</small></div>`;
    strat = `<div class="section"><div class="sec-h"><h2>Sal de deudas más rápido</h2></div><div class="panel form">
      <div class="field"><label for="dx">Si cada mes pones extra (L)</label><input class="inp" id="dx" inputmode="decimal" value="${extra}" data-in="debtExtra"></div>
      <div class="cmp">${cell('base', 'Solo cuotas', base)}${cell('av', 'Avalancha', av)}${cell('sn', 'Bola de nieve', sn)}</div>
      ${base.ok && plan.ok && base.months > plan.months ? `<div class="ok-msg">Con ${money(extra)} extra terminas ${base.months - plan.months} meses antes y ahorras ${money(Math.max(0, base.interest - plan.interest))} en intereses.</div>` : ''}
      <div class="note"><b>Avalancha:</b> el extra va a la deuda con la tasa más alta: pagas menos intereses. <b>Bola de nieve:</b> va a la más pequeña: ganas motivación. Al terminar una, su cuota pasa a la siguiente.</div>
      ${plan.ok && hn.length > 1 ? `<div class="eyebrow">Orden recomendado (${best === 'av' ? 'avalancha' : 'bola de nieve'})</div><div class="list">${plan.order.map((o, k) =>
        `<div class="tx"><span class="tile" style="background:var(--surface-2);font-family:var(--f-display);font-weight:700">${k + 1}</span><span class="mid"><b>${esc(o.d.name)}</b><small>Liquidada en ${monthLabel(addMonths(TODAY, o.at))}</small></span></div>`).join('')}</div>` : ''}
    </div></div>`;
  }
  const tips = debtTips(act, infos, st);
  return `${subhead('Deudas', S.v06 ? `<button class="btn sm" data-a="debtNew">${ic('plus','sm')} Nueva</button>` : '')}${needs06()}
  ${hn.length ? `<div class="hero debt"><div class="eyebrow">Total que debes</div><div class="num" style="font-size:32px;font-weight:700">${money(total)}</div>
    <small>${hn.length} ${hn.length === 1 ? 'deuda' : 'deudas'} · cuotas de ${money(monthly)} al mes</small>
    <div class="row3"><div><small>Libre de deudas</small><b>${base.ok ? monthLabel(addMonths(TODAY, base.months)) : '—'}</b></div>
      <div><small>Intereses por pagar</small><b>${base.ok ? money(base.interest) : '—'}</b></div>
      ${st.inc > 0 ? `<div><small>De tu ingreso</small><b>${Math.round(monthly / st.inc * 100)}%</b></div>` : ''}</div></div>`
    : `<div class="empty">${act.length ? '¡No tienes saldos pendientes! 🎉' : 'Agrega tus préstamos, tarjetas o deudas con familiares. Puedes incluir los que ya llevas tiempo pagando: calculamos tu saldo, tus intereses y cuándo quedas libre.'}${S.v06 && !act.length ? '<br><button class="btn sm" style="margin:12px auto 0" data-a="debtNew">Agregar mi primera deuda</button>' : ''}</div>`}
  ${act.length ? `<div class="section"><div class="sec-h"><h2>Activas</h2></div><div class="list">${act.map(d => debtRow(d, infos.get(d.id))).join('')}</div></div>` : ''}
  ${act.some(d => d.cur === 'USD') ? '<div class="note" style="margin-top:10px">Las deudas en dólares se muestran aparte y no entran en el total en lempiras.</div>' : ''}
  ${strat}
  ${tips.length ? `<div class="section"><div class="sec-h"><h2>Sugerencias para ti</h2></div><div class="tips">${tips.map(([e, h]) => `<div class="tip"><span>${e}</span><div>${h}</div></div>`).join('')}</div></div>` : ''}
  ${paid.length ? `<div class="section"><div class="sec-h"><h2>Liquidadas 🎉</h2></div><div class="list">${paid.map(d => debtRow(d, infos.get(d.id))).join('')}</div></div>` : ''}`;
}
function amortTable(rows, d, from){
  const lbl = m => { const x = dayIn(ymAdd(from.slice(0, 7), m - 1), +from.slice(8)); return `${mon(x)} ${x.slice(0, 4)}`; };
  return `<table class="rep" style="min-width:330px"><tr><th>Mes</th><th class="r">Cuota</th><th class="r">Interés</th><th class="r">Capital</th><th class="r">Saldo</th></tr>
    ${rows.map(r => `<tr><td style="text-transform:capitalize;white-space:nowrap">${lbl(r.m)}</td><td class="r">${nf.format(r.pay)}</td><td class="r neg">${nf.format(r.i)}</td><td class="r">${nf.format(r.pr)}</td><td class="r">${nf.format(r.B)}</td></tr>`).join('')}</table>
    <div class="muted" style="font-size:11.5px;margin-top:6px">Montos en ${d.cur === 'USD' ? 'dólares' : 'lempiras'}. Es una estimación: tu banco puede calcular con días exactos, seguros o comisiones.</div>`;
}
function vDebt(){
  const d = S.debts.find(x => x.id === S.ui.debtId);
  if (!d){ S.ui.screen = 'debts'; return vDebts(); }
  const i = debtInfo(d), K = DEBT_KINDS[d.kind] || DEBT_KINDS.otro, w = i.due ? whenLabel(i.due) : null;
  const paidTot = d.pays.reduce((s, p) => s + p.amount, 0), paidInt = d.pays.reduce((s, p) => s + p.interest, 0);
  const elapsed = monthsBetween(d.start, TODAY);
  return `${subhead(esc(d.name))}
  <div class="hero debt"><div class="eyebrow">${K[0]} ${K[1]}${d.lender ? ' · ' + esc(d.lender) : ''}</div>
    <div class="num" style="font-size:32px;font-weight:700;margin-top:4px">${money(i.bal, d.cur)}</div><small>Saldo pendiente de ${money(d.orig, d.cur)} · ${Math.round(i.pct)}% pagado</small>
    <div class="bar" style="margin-top:10px;background:rgba(255,255,255,.22)"><i style="width:${i.pct}%;background:#fff"></i></div>
    <div class="row3"><div><small>Cuota</small><b>${money(i.pay, d.cur)}</b></div><div><small>Tasa anual</small><b>${fmtRate(d.rate)}${d.rtype === 'flat' ? ' flat' : ''}</b></div>
      <div><small>Libre en</small><b>${i.bal <= 0 ? '¡Ya!' : i.sim.ok ? monthLabel(addMonths(TODAY, i.sim.months)) : '—'}</b></div></div></div>
  ${w ? `<div class="panel" style="margin-top:12px;display:flex;align-items:center;gap:10px"><span class="tile" style="background:var(--warn-soft);color:var(--warn)">${ic('calendar','sm')}</span>
    <div style="flex:1;min-width:0"><b>Próxima cuota</b><small class="muted" style="display:block">${dLong(i.due)}</small></div><span class="pill ${w.c}">${w.t}</span></div>` : ''}
  ${i.bal > 0 ? `<div class="row2" style="margin-top:12px"><button class="btn" data-a="debtPayNew" data-v="${d.id}">${ic('check','sm')} Registrar pago</button><button class="btn ghost" data-a="debtSim" data-v="${d.id}">${ic('chart','sm')} Simular</button></div>` : ''}
  ${!i.sim.ok && i.bal > 0 ? `<div class="note" style="margin-top:12px;background:var(--neg-soft);color:var(--neg)">Con una cuota de ${money(i.pay, d.cur)} no cubres ni los intereses (${money(debtInt(d, i.bal), d.cur)} al mes): el saldo nunca baja. Sube el pago o habla con tu acreedor.</div>` : ''}
  <div class="section panel"><table class="rep">
    ${i.bal > 0 && i.sim.ok ? `<tr><td class="muted">Te faltan</td><td class="r">${i.sim.months} ${i.sim.months === 1 ? 'cuota' : 'cuotas'} aprox.</td></tr><tr><td class="muted">Intereses por pagar</td><td class="r neg">${money(i.sim.interest, d.cur)}</td></tr>` : ''}
    <tr><td class="muted">Pagado en Kuenta</td><td class="r">${money(paidTot, d.cur)}${paidInt ? ` <small class="muted">(${money(paidInt, d.cur)} de intereses)</small>` : ''}</td></tr>
    <tr><td class="muted">Fecha del préstamo</td><td class="r">${dShort(d.start)} ${d.start.slice(0, 4)}${elapsed ? ` · hace ${elapsed} ${elapsed === 1 ? 'mes' : 'meses'}` : ''}</td></tr>
    ${d.term ? `<tr><td class="muted">Plazo</td><td class="r">${d.term} meses</td></tr>` : ''}
    <tr><td class="muted">Día de pago</td><td class="r">${d.payDay ? 'Día ' + d.payDay : 'Sin día fijo'}</td></tr>
    ${d.notes ? `<tr><td class="muted">Notas</td><td class="r" style="white-space:normal">${esc(d.notes)}</td></tr>` : ''}</table></div>
  ${i.bal > 0 && i.sim.ok ? `<div class="section"><div class="sec-h"><h2>Próximas cuotas</h2><button class="link" data-a="debtSim" data-v="${d.id}">Plan completo</button></div>
    <div class="panel" style="overflow-x:auto">${amortTable(i.sim.rows.slice(0, 6), d, i.due || addMonths(TODAY, 1))}</div></div>` : ''}
  <div class="section"><div class="sec-h"><h2>Pagos registrados</h2></div><div class="list">${[...d.pays].reverse().map(p => `<div class="tx">
    <span class="tile" style="background:var(--pos-soft);color:var(--pos)">${ic('check','sm')}</span>
    <span class="mid"><b>${money(p.amount, d.cur)}${p.extra ? ' · abono extra' : ''}</b><small>${dShort(p.date)} ${p.date.slice(0, 4)} · capital ${money(p.principal, d.cur)} · interés ${money(p.interest, d.cur)}</small></span>
    <button class="iconbtn" data-a="debtPayDel" data-v="${p.id}" data-d="${d.id}" aria-label="Eliminar pago" style="color:var(--neg)">${ic('trash','sm')}</button></div>`).join('') || '<div class="empty">Aún no registras pagos de esta deuda.</div>'}</div></div>
  <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px"><button class="btn ghost" data-a="debtEdit" data-v="${d.id}">Editar deuda</button>
    <div id="debtdel"><button class="btn danger" data-a="debtAskDel" data-v="${d.id}">${ic('trash','sm')} Eliminar deuda</button></div></div>`;
}
function debtForm(id){
  const d = id ? S.debts.find(x => x.id === id) : null, old = !!d && (d.start < d.from || d.bal0 !== d.orig);
  S.form = {est:null};
  openSheet(`${sheetHead(d ? 'Editar deuda' : 'Nueva deuda')}<form class="form" data-f="debt" data-id="${id || ''}" novalidate>
    <div class="row2"><div class="field"><label for="db-k">Tipo</label><select class="inp" id="db-k">${Object.entries(DEBT_KINDS).map(([k, [e, l]]) => `<option value="${k}" ${(d ? d.kind : 'prestamo') === k ? 'selected' : ''}>${e} ${l}</option>`).join('')}</select></div>
    <div class="field"><label for="db-c">Moneda</label><select class="inp" id="db-c" data-in="debtCalc"><option value="HNL">Lempiras</option><option value="USD" ${d?.cur === 'USD' ? 'selected' : ''}>Dólares</option></select></div></div>
    <div class="field"><label for="db-n">Nombre</label><input class="inp" id="db-n" maxlength="60" value="${esc(d?.name || '')}" placeholder="Ej: Préstamo carro, Tarjeta BAC"></div>
    <div class="field"><label for="db-l">¿A quién le debes? (opcional)</label><input class="inp" id="db-l" maxlength="60" value="${esc(d?.lender || '')}" placeholder="Banco, cooperativa o persona"></div>
    <div class="row2"><div class="field"><label for="db-o">Monto prestado</label><input class="inp" id="db-o" inputmode="decimal" value="${d ? d.orig : ''}" placeholder="50000" data-in="debtCalc"></div>
    <div class="field"><label for="db-r">Tasa anual (%)</label><input class="inp" id="db-r" inputmode="decimal" value="${d ? d.rate : ''}" placeholder="18" data-in="debtCalc"></div></div>
    <div class="field"><label for="db-rt">Cómo cobran el interés</label><select class="inp" id="db-rt" data-in="debtCalc"><option value="saldo">Sobre el saldo (lo más común)</option><option value="flat" ${d?.rtype === 'flat' ? 'selected' : ''}>Flat: siempre sobre el monto prestado</option></select></div>
    <div class="row2"><div class="field"><label for="db-t">Plazo (meses)</label><input class="inp" id="db-t" inputmode="numeric" value="${d?.term || ''}" placeholder="36" data-in="debtCalc"></div>
    <div class="field"><label for="db-i">Cuota mensual</label><input class="inp" id="db-i" inputmode="decimal" value="${d?.inst || ''}" placeholder="La calculamos" data-in="debtCalc"></div></div>
    <div class="field"><label for="db-pd">Día de pago</label><select class="inp" id="db-pd"><option value="">Sin día fijo</option>${Array.from({length:31}, (_, i) => `<option value="${i + 1}" ${d?.payDay === i + 1 ? 'selected' : ''}>Día ${i + 1} de cada mes</option>`).join('')}</select></div>
    <div class="toggle"><div class="t"><b>Ya llevo tiempo pagándola</b><small>Para préstamos o tarjetas que tienen meses o años</small></div><label class="sw"><input type="checkbox" id="db-old" data-in="debtCalc" ${old ? 'checked' : ''}><span></span></label></div>
    <div id="db-oldbox" class="row2" ${old ? '' : 'hidden'}><div class="field"><label for="db-sd">Fecha del préstamo</label><input class="inp" id="db-sd" type="date" max="${TODAY}" value="${old ? d.start : ''}" data-in="debtCalc"></div>
      <div class="field"><label for="db-b">${d ? 'Saldo al empezar en Kuenta' : 'Saldo actual'}</label><input class="inp" id="db-b" inputmode="decimal" value="${old ? d.bal0 : ''}" placeholder="Lo estimamos"></div></div>
    <div class="note" id="db-hint" hidden></div>
    <div class="field"><label for="db-no">Notas (opcional)</label><input class="inp" id="db-no" maxlength="300" value="${esc(d?.notes || '')}" placeholder="Ej: incluye seguro de vida"></div>
    <div class="err" id="ferr"></div><button class="btn" type="submit">${d ? 'Guardar cambios' : 'Agregar deuda'}</button></form>`);
  debtCalcHint();
}
function debtCalcHint(){
  const box = $('#db-hint'); if (!box) return;
  const cur = $('#db-c').value, orig = parseAmt($('#db-o').value), r = (parseAmt($('#db-r').value) || 0) / 1200, n = parseInt($('#db-t').value, 10) || 0;
  const inst = parseAmt($('#db-i').value) || 0, flat = $('#db-rt').value === 'flat', old = $('#db-old').checked, h = [];
  $('#db-oldbox').hidden = !old; S.form.est = null;
  const calc = orig > 0 && n > 0 ? (flat ? flatPay(orig, r, n) : annuity(orig, r, n)) : 0;
  if (calc) h.push(`Cuota calculada: <b>${money(calc, cur)}</b>${inst && Math.abs(inst - calc) > 1 ? '. Usaremos la que escribiste (puede incluir seguros).' : '.'}`);
  if (old && orig > 0){
    const sd = $('#db-sd').value, pay = inst || calc;
    if (sd && sd < TODAY && pay){
      const k = monthsBetween(sd, TODAY), est = estBalance(orig, r, n, pay, k, flat); S.form.est = est;
      h.push(`Llevas unas <b>${n ? Math.min(k, n) : k}</b> cuotas${n ? ` de ${n}` : ''}. Saldo estimado hoy: <b>${money(est, cur)}</b>. <button type="button" class="link" data-a="useEst">Usar este saldo</button><br><small>Si tienes el estado de cuenta, escribe el saldo exacto.</small>`);
    } else if (!sd) h.push('Elige la fecha del préstamo y estimamos cuánto te falta.');
  }
  box.innerHTML = h.join('<br>'); box.hidden = !h.length;
}
function debtPaySheet(id){
  const d = S.debts.find(x => x.id === id), B = debtBal(d), accs = writableAccounts().filter(a => a.cur === d.cur);
  const recent = d.pays.some(p => !p.extra && p.date > addDays(TODAY, -20)), a0 = accs.find(a => a.id === d.acc) || accs.find(a => !a.shared) || accs[0];
  S.form = {debt:id, iTouched:false};
  openSheet(`${sheetHead('Pago de ' + esc(d.name))}<form class="form" data-f="debtPay" data-id="${id}" novalidate>
    <div class="note">Debes ${money(B, d.cur)}. ${recent ? 'Ya registraste una cuota en los últimos días: este pago irá completo a capital salvo que indiques intereses.' : `Interés estimado de este mes: ${money(Math.min(B, debtInt(d, B)), d.cur)}.`}</div>
    <div class="row2"><div class="field"><label for="dp-a">Monto pagado</label><input class="inp" id="dp-a" inputmode="decimal" value="${Math.min(debtPay(d), round2(B + debtInt(d, B)))}" data-in="dpCalc"></div>
    <div class="field"><label for="dp-d">Fecha</label><input class="inp" id="dp-d" type="date" value="${TODAY}" max="${TODAY}"></div></div>
    <div class="toggle"><div class="t"><b>Abono extra a capital</b><small>Todo el monto baja tu saldo, sin intereses</small></div><label class="sw"><input type="checkbox" id="dp-x" data-in="dpCalc"><span></span></label></div>
    <div class="field" id="dp-ibox"><label for="dp-i">De eso, intereses (según tu banco)</label><input class="inp" id="dp-i" inputmode="decimal" value="${recent ? 0 : Math.min(B, debtInt(d, B))}" data-in="dpInt"></div>
    <div class="note" id="dp-prev"></div>
    <div class="toggle"><div class="t"><b>Registrarlo también como gasto</b><small>Descuenta el pago de una de tus cuentas</small></div><label class="sw"><input type="checkbox" id="dp-tx" data-in="dpCalc" ${accs.length ? 'checked' : 'disabled'}><span></span></label></div>
    <div id="dp-txbox" class="row2" ${accs.length ? '' : 'hidden'}><div class="field"><label for="dp-ac">Cuenta</label><select class="inp" id="dp-ac" data-in="dpAcc">${accs.map(a => `<option value="${a.id}" ${a0 && a0.id === a.id ? 'selected' : ''}>${esc(a.icon)} ${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="dp-c">Categoría</label><select class="inp" id="dp-c">${debtCatOpts(a0, d)}</select></div></div>
    <div class="err" id="ferr"></div><button class="btn" type="submit">${ic('check','sm')} Guardar pago</button></form>`);
  dpPreview();
}
function debtCatOpts(a, d){
  if (!a) return '';
  const sc = a.shared ? 'f' : 'p', cats = S.categories.filter(c => c.scope === sc && c.kind === 'expense' && !c.archived);
  const pick = cats.find(c => c.id === d.cat) || cats.find(c => /deud|préstam|prestam|crédit|credit|tarjeta|banco/i.test(c.name));
  return `${pick ? '' : '<option value="">Elige una categoría</option>'}${cats.map(c => `<option value="${c.id}" ${pick && pick.id === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.parent ? cat(c.parent).name + ' › ' : '')}${esc(c.name)}</option>`).join('')}`;
}
function dpPreview(){
  const d = S.debts.find(x => x.id === S.form.debt); if (!d || !$('#dp-a')) return;
  const B = debtBal(d), amt = parseAmt($('#dp-a').value) || 0, extra = $('#dp-x').checked;
  $('#dp-ibox').hidden = extra; $('#dp-txbox').hidden = !$('#dp-tx').checked;
  const i = extra ? 0 : Math.min(amt, parseAmt($('#dp-i').value) || 0), pr = Math.min(B, Math.max(0, amt - i));
  $('#dp-prev').innerHTML = amt > 0 ? `A capital <b>${money(pr, d.cur)}</b> · intereses <b>${money(i, d.cur)}</b> · saldo después <b>${money(B - pr, d.cur)}</b>${B - pr <= 0.005 ? ' 🎉' : ''}` : 'Escribe el monto que pagaste.';
}
function debtSimSheet(id){
  const d = S.debts.find(x => x.id === id), i = debtInfo(d);
  S.form = {debt:id};
  openSheet(`${sheetHead('Simular plan de pagos')}<div class="note">${esc(d.name)}: saldo ${money(i.bal, d.cur)} · tasa ${fmtRate(d.rate)} anual${d.rtype === 'flat' ? ' flat' : ''}</div>
    <div class="row2" style="margin-top:12px"><div class="field"><label for="sim-p">Cuota mensual</label><input class="inp" id="sim-p" inputmode="decimal" value="${i.pay}" data-in="simCalc"></div>
    <div class="field"><label for="sim-x">Abono extra al mes</label><input class="inp" id="sim-x" inputmode="decimal" value="${roundTo(i.pay * 0.1, 50)}" data-in="simCalc"></div></div>
    <div class="chips" style="margin-top:10px">${[0, 100, 250, 500, 1000, 2000].map(v => `<button type="button" class="chip" data-a="simQuick" data-v="${v}">${v ? '+' + short(v, d.cur) : 'Sin extra'}</button>`).join('')}</div>
    <div id="simres" style="margin-top:12px"></div>`);
  simRender();
}
function simRender(){
  const d = S.debts.find(x => x.id === S.form.debt), box = $('#simres'); if (!d || !box) return;
  const B = debtBal(d), pay = parseAmt($('#sim-p').value) || 0, x = parseAmt($('#sim-x').value) || 0;
  const a = simulate(d, B, pay), b = simulate(d, B, pay, x), from = debtDue(d) || addMonths(TODAY, 1);
  const cell = (t, r, best) => `<div class="${best ? 'best' : ''}"><small>${t}</small><b>${r.ok ? `${r.months} ${r.months === 1 ? 'mes' : 'meses'}` : 'Nunca'}</b><small>${r.ok ? `Fin ${monthLabel(addMonths(TODAY, r.months))}` : 'No cubre intereses'}</small><small>${r.ok ? 'Intereses ' + money(r.interest, d.cur) : ''}</small></div>`;
  const win = a.ok && b.ok && x > 0 ? `<div class="ok-msg" style="margin-top:10px">Con ${money(x, d.cur)} extra terminas <b>${a.months - b.months} ${a.months - b.months === 1 ? 'mes' : 'meses'} antes</b> y te ahorras <b>${money(a.interest - b.interest, d.cur)}</b> en intereses. 🚀</div>`
    : !a.ok && b.ok ? `<div class="ok-msg" style="margin-top:10px">Con el extra sí logras pagarla: ${b.months} meses.</div>` : '';
  const rows = (x > 0 ? b : a).rows;
  box.innerHTML = `<div class="cmp" style="grid-template-columns:1fr 1fr">${cell('Solo la cuota', a, false)}${cell(x > 0 ? `Con +${short(x, d.cur)} al mes` : 'Con extra', b, x > 0 && b.ok)}</div>${win}
    ${rows.length ? `<div class="eyebrow" style="margin:16px 0 6px">Plan de pagos${x > 0 ? ' con el extra' : ''} · ${rows.length} cuotas</div>
      <div class="panel" style="overflow:auto;max-height:340px">${amortTable(rows, d, from)}</div>` : ''}`;
}

/* ============ ahorro inteligente ============ */
/* Promedio de los últimos 3 meses financieros con movimientos (si eres nuevo, usa el mes actual) */
function moneyStats(){
  const cur = period(), months = [];
  for (let i = 1; i <= 3; i++){ const p = period(addMonths(cur.start, -i)); months.push(summary(p.start, p.end, 'personal')); }
  let use = months.filter(m => m.inc > 0 || m.exp > 0);
  if (!use.length) use = [summary(cur.start, cur.end, 'personal')];
  const avg = k => use.reduce((s, m) => s + m[k], 0) / use.length;
  const inc = avg('inc'), exp = avg('exp'), gen = avg('gen');
  return {inc, exp, gen, n:use.length, rate:inc > 0 ? (inc - exp - gen) / inc * 100 : null};
}
function savingsPlan(st){
  if (!(st.inc > 0)) return {monthly:0};
  const free = st.inc - st.exp - st.gen;
  let m = free > 0 ? Math.min(Math.max(free * 0.6, st.inc * 0.05), st.inc * 0.25) : st.inc * 0.05;
  m = roundTo(m, m >= 1000 ? 100 : 50);
  return {monthly:m, free, pct:m / st.inc * 100, daily:m / 30, tight:free <= 0};
}
const dailyLike = d => d <= 35 ? 'menos que una baleada con todo 🌮' : d <= 70 ? 'lo que cuesta un almuerzo corriente 🍛' : d <= 150 ? 'menos que un delivery de pizza 🍕' : 'lo que cuesta una salida al cine 🎬';
const LEVELS = [{min:0, e:'🌱', n:'Semilla'}, {min:5, e:'🐜', n:'Hormiguita'}, {min:10, e:'🐿️', n:'Ardilla'}, {min:20, e:'🦉', n:'Búho sabio'}, {min:30, e:'🦁', n:'León del ahorro'}];
function levelFor(rate){
  const r = Math.max(0, rate ?? 0); let i = 0;
  LEVELS.forEach((l, k) => { if (r >= l.min) i = k; });
  const L = LEVELS[i], next = LEVELS[i + 1];
  return {...L, next, toNext:next ? Math.min(100, (r - L.min) / (next.min - L.min) * 100) : 100};
}
/* Días seguidos registrando (cuenta hasta hoy, o hasta ayer si hoy aún no registras) */
function streak(){
  const days = new Set(S.tx.filter(t => t.by === me()).map(t => t.date));
  let d = days.has(TODAY) ? TODAY : addDays(TODAY, -1), n = 0;
  while (days.has(d)){ n++; d = addDays(d, -1); }
  return n;
}
/* Gastos hormiga: compras pequeñas (hasta L 150) de los últimos 30 días */
function hormiga(){
  const since = addDays(TODAY, -30), byCat = {}; let n = 0, sum = 0;
  for (const t of S.tx){
    if (t.type !== 'expense' || t.tg || t.date < since || t.by !== me() || t.amount > 150) continue;
    const a = acc(t.acc); if (!a || a.shared || a.cur !== 'HNL') continue;
    const c = cat(t.cat); if (c.kind !== 'expense') continue;
    n++; sum += t.amount; const r = rootOf(c).id || 'none'; byCat[r] = (byCat[r] || 0) + t.amount;
  }
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  return {n, sum:round2(sum), daily:sum / 30, top:top ? (top[0] === 'none' ? UNKNOWN_CAT : cat(top[0])) : null};
}
const CH = {
  sobres:{e:'✉️', n:'Reto de los 100 sobres', slots:100, bases:[1, 2, 5, 10], viral:true, unit:'sobres',
    d:'100 sobres numerados del 1 al 100. Cada día sacas uno al azar y guardas ese número por tu base.', val:(c, i) => c.base * i},
  '52semanas':{e:'📅', n:'Reto de las 52 semanas', slots:52, bases:[5, 10, 20, 50, 100], viral:true, unit:'semanas',
    d:'La semana 1 guardas tu base, la semana 2 el doble, la 3 el triple… hasta la semana 52.', val:(c, i) => c.base * i},
  hormiga:{e:'🐜', n:'30 días sin gastos hormiga', slots:30, bases:[20, 30, 50, 80, 100], unit:'días',
    d:'Cada día que evites antojos (cafecitos, churros, delivery), guarda lo que te ibas a gastar.', val:c => c.base},
  nogasto:{e:'🧘', n:'Semana sin gastar', slots:7, bases:[50, 100, 150, 200, 300], unit:'días',
    d:'7 días solo con lo esencial. Marca cada día que lo logres y guarda lo que no gastaste.', val:c => c.base},
  redondeo:{e:'🪙', n:'Reto del redondeo', slots:0, bases:[10, 50, 100], unit:'',
    d:'Cada gasto se redondea al siguiente múltiplo de tu base y la diferencia es ahorro. Kuenta lo calcula sola.', val:() => 0}
};
const chTotal = c => { const k = CH[c.kind]; let s = 0; for (let i = 1; i <= k.slots; i++) s += k.val(c, i); return s; };
function roundUp(c){
  let sum = 0, n = 0;
  for (const t of S.tx){
    if (t.type !== 'expense' || t.tg || t.by !== me() || t.date < c.start) continue;
    const a = acc(t.acc); if (!a || a.shared || a.cur !== 'HNL') continue;
    const up = round2(Math.ceil(t.amount / c.base - 1e-9) * c.base - t.amount); if (up > 0){ sum += up; n++; }
  }
  return {sum:round2(sum), n};
}
const chSaved = c => c.kind === 'redondeo' ? roundUp(c).sum : c.done.reduce((s, i) => s + CH[c.kind].val(c, i), 0);
const pickBase = (bases, target) => [...bases].reverse().find(v => v <= target) || bases[0];
function chSuggestBase(kind, pl){
  const b = CH[kind].bases, m = pl.monthly || 0;
  if (kind === 'sobres') return pickBase(b, m * 3.3 / 5050);   // 100 días ≈ 3.3 meses
  if (kind === '52semanas') return pickBase(b, m * 12 / 1378);
  if (kind === 'hormiga') return pickBase(b, hormiga().daily || 50);
  if (kind === 'nogasto') return pickBase(b, m / 30 * 2 || 100);
  return 50;
}
function chTotalText(kind, base){
  const t = chTotal({kind, base});
  if (kind === 'sobres') return `Al abrir los 100 sobres tendrás <b>${money(t)}</b>. El más pequeño es ${money(base)} y el más grande ${money(base * 100)}.`;
  if (kind === '52semanas') return `En un año tendrás <b>${money(t)}</b>. Semana 1: ${money(base)} · semana 52: ${money(base * 52)}.`;
  if (kind === 'redondeo'){ const r = Math.ceil(137 / base) * base; return `Ejemplo: un gasto de L 137 se redondea a ${money(r)} y ahorras ${money(r - 137)}. Se calcula con los gastos de tus cuentas personales.`; }
  return `Si lo logras todos los días tendrás <b>${money(t)}</b>.`;
}
function badges(st, sk){
  const prev = period(addMonths(period().start, -1)), ps = summary(prev.start, prev.end, 'personal');
  const mine = S.tx.filter(t => t.by === me()), spent = new Set(mine.filter(t => t.type === 'expense').map(t => t.date));
  const quiet = mine.length > 0 && [1, 2, 3, 4, 5, 6, 7].some(i => { const d = addDays(TODAY, -i); return !spent.has(d) && mine.some(t => t.date < d); });
  return [['✍️', 'Primer registro', mine.length > 0], ['🔥', 'Racha de 7 días', sk >= 7], ['🏆', 'Racha de 30 días', sk >= 30], ['💚', 'Mes en verde', ps.inc > 0 && ps.net > 0],
    ['🐿️', 'Ahorras 10%', (st.rate ?? 0) >= 10], ['🧘', 'Día sin gastos', quiet], ['🎯', 'Meta cumplida', S.goals.some(g => g.status === 'completed' || goalInfo(g).pct >= 100)],
    ['🎲', 'Aceptaste un reto', S.challenges.length > 0], ['🥇', 'Reto completado', S.challenges.some(c => c.status === 'completed')], ['🎉', 'Deuda liquidada', S.debts.some(d => d.status === 'paid')],
    ['📅', 'Pagos al día', S.scheduled.some(s => s.active) && S.scheduled.every(s => !s.active || s.next >= TODAY)], ['🦁', 'Ahorras 30%', (st.rate ?? 0) >= 30]];
}
function saveTeaser(){
  if (!S.tx.length) return '';
  const st = moneyStats(), lv = levelFor(st.rate), sk = streak(), pl = savingsPlan(st);
  return `<button class="panel" data-a="nav" data-v="savings" style="display:flex;align-items:center;gap:12px;width:100%;text-align:left">
    <span class="lvl"><span class="e">${sk >= 2 ? '🔥' : lv.e}</span></span><span style="flex:1;min-width:0"><b>${sk >= 2 ? `${sk} días seguidos registrando` : `Nivel ${lv.n}`}</b>
    <small class="muted" style="display:block;font-size:12.5px">${pl.monthly ? `Tu plan: ahorra ${money(pl.monthly)} al mes` : 'Descubre cuánto puedes ahorrar'}</small></span>${ic('right','sm')}</button>`;
}
function chRow(c){
  const k = CH[c.kind], pct = k.slots ? Math.round(c.done.length / k.slots * 100) : null;
  return `<button class="bud" data-a="chOpen" data-v="${c.id}"><div class="h"><span class="tile" style="background:var(--brand-soft)">${k.e}</span>
    <span class="t"><b>${esc(c.name)}</b><small class="num">${money(chSaved(c))} guardados${k.slots ? ` · ${c.done.length}/${k.slots} ${k.unit}` : ''}</small></span>
    ${c.status === 'completed' ? '<span class="pill ok">¡Logrado!</span>' : pct !== null ? `<span class="pill brand">${pct}%</span>` : '<span class="pill gold">Automático</span>'}</div>
    ${pct !== null ? `<div class="bar"><i class="brand" style="width:${pct}%"></i></div>` : ''}</button>`;
}
function vSavings(){
  const st = moneyStats(), pl = savingsPlan(st), lv = levelFor(st.rate), sk = streak(), h = hormiga();
  const act = S.challenges.filter(c => c.status !== 'archived'), running = new Set(act.filter(c => c.status === 'active').map(c => c.kind));
  const rate = st.rate === null ? null : Math.round(st.rate);
  const hero = pl.monthly ? `<div class="hero"><div class="eyebrow">Tu plan de ahorro</div>
      <div style="display:flex;align-items:baseline;gap:6px;margin-top:4px">${bigMoney(pl.monthly)}<span style="font-weight:700">al mes</span></div>
      <small>${pl.tight ? 'Hoy gastas casi todo lo que ganas. Empieza con un 5% y súbelo poco a poco: lo importante es el hábito.' : `Es el ${Math.round(pl.pct)}% de tu ingreso: ${money(pl.daily)} al día, ${dailyLike(pl.daily)}.`}</small>
      <div class="row3"><div><small>En 6 meses</small><b>${money(pl.monthly * 6)}</b></div><div><small>En 1 año</small><b>${money(pl.monthly * 12)}</b></div><div><small>En 5 años</small><b>${money(pl.monthly * 60)}</b></div></div>
      <div class="row2" style="margin-top:14px"><button class="btn sm" data-a="planGoal" data-v="${pl.monthly}">${ic('target','sm')} Crear meta</button><button class="btn sm ghost" data-a="shareLevel">${ic('share','sm')} Compartir</button></div></div>
    <div class="muted" style="font-size:12px;margin:8px 2px 0">Calculado con tus ingresos (${money(st.inc)}) y gastos (${money(st.exp + st.gen)}) promedio de ${st.n === 1 ? 'este mes' : `los últimos ${st.n} meses`}.</div>`
    : `<div class="hero"><div class="eyebrow">Tu plan de ahorro</div><b style="font-family:var(--f-display);font-size:19px;display:block;margin:6px 0">¿Cuánto puedes ahorrar sin sufrir?</b>
      <small>Registra tus ingresos y gastos de este mes y Kuenta te dirá cuánto guardar, según lo que de verdad ganas y gastas.</small>
      <div class="row2" style="margin-top:14px"><button class="btn sm" data-a="add" data-v="income">${ic('in','sm')} Registrar ingreso</button><button class="btn sm ghost" data-a="add" data-v="expense">${ic('out','sm')} Registrar gasto</button></div></div>`;
  const avail = Object.entries(CH).filter(([k]) => !running.has(k));
  const needCut = pl.tight ? breakdown(period(addMonths(period().start, -1)).start, period(addMonths(period().start, -1)).end, 'personal', 'expense')[0] : null;
  return `${subhead('Ahorro inteligente')}${needs06()}${hero}
  ${needCut ? `<div class="tip" style="margin-top:10px"><span>✂️</span><div>Para lograrlo, recorta un 10% en <b>${esc(needCut.c.name)}</b>, tu gasto más grande: son ${money(needCut.v * 0.1)} al mes.</div></div>` : ''}
  <div class="row2" style="margin-top:12px">
    <div class="panel lvl"><span class="e">${lv.e}</span><div style="min-width:0;flex:1"><small class="muted">Tu nivel</small><b style="display:block">${lv.n}</b>
      ${lv.next ? `<div class="bar" style="margin-top:6px"><i style="width:${lv.toNext}%;background:var(--gold)"></i></div><small class="muted" style="font-size:11px">${lv.next.e} al ahorrar ${lv.next.min}%</small>` : '<small class="muted" style="font-size:11px">¡Nivel máximo!</small>'}</div></div>
    <div class="panel lvl"><span class="e" style="background:var(--warn-soft)">🔥</span><div style="min-width:0"><small class="muted">Racha</small><b style="display:block">${sk} ${sk === 1 ? 'día' : 'días'}</b>
      <small class="muted" style="font-size:11px">${sk ? 'registrando seguido' : 'Registra hoy y empieza'}</small></div></div></div>
  ${rate !== null ? `<div class="muted" style="font-size:12.5px;margin:8px 2px 0">Ahorras el <b style="color:var(--fg)">${rate}%</b> de lo que ganas.${lv.next ? ` Llega al ${lv.next.min}% para ser ${lv.next.e} ${lv.next.n}.` : ''}</div>` : ''}
  ${act.length ? `<div class="section"><div class="sec-h"><h2>Tus retos</h2></div><div class="list">${act.map(chRow).join('')}</div></div>` : ''}
  ${S.v06 && avail.length ? `<div class="section"><div class="sec-h"><h2>${act.length ? 'Más retos' : 'Empieza un reto'}</h2><span class="muted" style="font-size:12px">Ajustados a tus ingresos</span></div>
    <div class="cards">${avail.map(([key, k]) => `<button class="chcard" data-a="chNew" data-v="${key}">${k.viral ? '<span class="pill gold viral">🔥 Viral</span>' : ''}<span class="e">${k.e}</span><b>${k.n}</b><small>${k.d}</small>
      ${k.slots ? `<span class="pill brand" style="align-self:flex-start;margin-top:auto">Meta ${short(chTotal({kind:key, base:chSuggestBase(key, pl)}))}</span>` : ''}</button>`).join('')}</div></div>` : ''}
  ${h.n >= 5 ? `<div class="section"><div class="sec-h"><h2>Gastos hormiga 🐜</h2></div><div class="panel">
    <b>${h.n} compras pequeñas suman ${money(h.sum)} en 30 días</b>
    <div class="muted" style="font-size:13px;margin-top:4px">${h.top ? `La mayoría en ${esc(h.top.icon)} ${esc(h.top.name)}. ` : ''}Si recortas la mitad, ahorras <b style="color:var(--pos)">${money(h.sum / 2)}</b> al mes: <b style="color:var(--pos)">${money(h.sum * 6)}</b> al año.</div>
    ${running.has('hormiga') || !S.v06 ? '' : '<button class="btn ghost sm" style="margin-top:10px" data-a="chNew" data-v="hormiga">Aceptar el reto anti-hormiga</button>'}</div></div>` : ''}
  ${st.inc > 0 ? `<div class="section"><div class="sec-h"><h2>Regla 50/30/20</h2><span class="muted" style="font-size:12px">con tu ingreso de ${short(st.inc)}</span></div><div class="panel legend">
    <div class="li"><i style="background:var(--brand)"></i><span>Necesidades: casa, comida, transporte, servicios</span><b>${money(st.inc * .5)}</b></div>
    <div class="li"><i style="background:var(--gold)"></i><span>Gustos: salidas, compras, antojos</span><b>${money(st.inc * .3)}</b></div>
    <div class="li"><i style="background:var(--pos)"></i><span>Ahorro y pago de deudas</span><b>${money(st.inc * .2)}</b></div>
    <div class="note">${rate >= 20 ? `¡Ya ahorras el ${rate}%! Vas por encima de la regla.` : `Hoy ahorras el ${Math.max(0, rate)}%. Te falta ${20 - Math.max(0, rate)}% para llegar al 20%.`}</div></div></div>` : ''}
  <div class="section"><div class="sec-h"><h2>Logros</h2><span class="muted" style="font-size:12px">${badges(st, sk).filter(b => b[2]).length} de ${badges(st, sk).length}</span></div>
    <div class="badges">${badges(st, sk).map(([e, n, on]) => `<div class="badge ${on ? '' : 'off'}" title="${on ? 'Logrado' : 'Por lograr'}"><span>${e}</span>${n}</div>`).join('')}</div></div>
  <div class="note" style="margin-top:14px">Al compartir solo se muestran porcentajes y niveles, nunca tus montos.</div>`;
}
function chNewSheet(kind){
  const k = CH[kind], pl = savingsPlan(moneyStats()), base = chSuggestBase(kind, pl);
  S.form = {kind, base};
  const goals = S.goals.filter(g => g.scope === 'p' && !g.linked && g.status === 'active');
  openSheet(`${sheetHead(`${k.e} ${k.n}`)}<p class="muted" style="margin:0 0 12px">${k.d}</p>
    <div class="eyebrow" style="margin-bottom:6px">${kind === 'redondeo' ? 'Redondear al siguiente' : kind === 'sobres' || kind === '52semanas' ? 'Tu base' : 'Cuánto guardas cada día'}</div>
    <div class="chips" id="chbases">${k.bases.map(v => `<button type="button" class="chip ${v === base ? 'on' : ''}" data-a="chBase" data-v="${v}">${money(v).replace('.00', '')}</button>`).join('')}</div>
    <div class="note" id="chtotal" style="margin-top:10px">${chTotalText(kind, base)}</div>
    ${pl.monthly && k.slots ? `<div class="muted" style="font-size:12px;margin-top:6px">Te sugerimos ${money(base).replace('.00', '')} según tu plan de ${money(pl.monthly)} al mes.</div>` : ''}
    ${goals.length && kind !== 'redondeo' ? `<div class="field" style="margin-top:12px"><label for="ch-g">Sumar lo que guardes a una meta (opcional)</label><select class="inp" id="ch-g"><option value="">No, solo llevar la cuenta</option>${goals.map(g => `<option value="${g.id}">${esc(g.icon)} ${esc(g.name)}</option>`).join('')}</select></div>` : ''}
    <div class="err" id="derr" style="margin-top:8px"></div>
    <button class="btn" style="margin-top:14px" data-a="chCreate">¡Acepto el reto! 💪</button>`);
}
function chSheet(id){
  const c = S.challenges.find(x => x.id === id); if (!c) return;
  const k = CH[c.kind], scroll = $('#sheet .panel-s')?.scrollTop || 0, live = c.status === 'active';
  let body;
  if (c.kind === 'redondeo'){
    const r = roundUp(c);
    body = `<div class="panel" style="text-align:center"><div class="eyebrow">Ahorro por redondeo desde el ${dShort(c.start)}</div><div class="num" style="font-size:32px;font-weight:700;color:var(--pos);margin:4px 0">${money(r.sum)}</div>
      <small class="muted">${r.n} ${r.n === 1 ? 'gasto redondeado' : 'gastos redondeados'} al siguiente ${money(c.base).replace('.00', '')}</small></div>
      <div class="note" style="margin-top:10px">Cada fin de mes pasa este monto a tu cuenta de ahorro con <b>Transferir</b>. ¡Es dinero que ni sentiste!</div>`;
  } else {
    const pct = Math.round(c.done.length / k.slots * 100), day = dDiff(c.start, TODAY);
    const cur = c.kind === '52semanas' ? Math.floor(day / 7) + 1 : c.kind === 'sobres' ? null : day + 1;
    body = `<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">${ring(pct, 'var(--brand)', pct + '%')}
      <div><div class="num" style="font-size:22px;font-weight:700">${money(chSaved(c))}</div><small class="muted">de ${money(chTotal(c))} · ${c.done.length}/${k.slots} ${k.unit}</small></div></div>
      ${c.kind === 'sobres' && live ? `<button class="btn" data-a="chRandom" data-v="${c.id}" style="margin-bottom:10px">🎲 Sacar un sobre al azar</button><div id="chpick"></div>` : ''}
      ${live && cur && cur <= k.slots && !c.done.includes(cur) ? `<div class="note" style="margin-bottom:10px">Hoy toca: <b>${c.kind === '52semanas' ? 'semana' : 'día'} ${cur}</b> → guarda ${money(k.val(c, cur))}. <button class="link" data-a="chToggle" data-v="${c.id}" data-i="${cur}">Ya lo guardé</button></div>` : ''}
      ${c.status === 'completed' ? '<div class="ok-msg" style="margin-bottom:10px">¡Reto completado! 🎉 Compártelo y reta a alguien más.</div>' : ''}
      <div class="slots">${Array.from({length:k.slots}, (_, n) => n + 1).map(i => `<button class="${c.done.includes(i) ? 'on' : ''} ${i === cur ? 'now' : ''}" data-a="chToggle" data-v="${c.id}" data-i="${i}" data-n="${i}" title="${money(k.val(c, i))}" aria-label="${i}: ${money(k.val(c, i))}${c.done.includes(i) ? ', guardado' : ''}">${i}</button>`).join('')}</div>
      <small class="muted" style="display:block;margin-top:8px">Toca un número cuando guardes ese monto. Tócalo otra vez para desmarcarlo.</small>`;
  }
  const g = c.goal && S.goals.find(x => x.id === c.goal);
  openSheet(`${sheetHead(`${k.e} ${esc(c.name)}`)}${body}
    ${g ? `<div class="note" style="margin-top:10px">Lo que marques se suma a tu meta ${esc(g.icon)} ${esc(g.name)}.</div>` : ''}
    <div class="row2" style="margin-top:14px"><button class="btn ghost" data-a="chShare" data-v="${c.id}">${ic('share','sm')} Compartir</button>
      <button class="btn ghost" data-a="chArchive" data-v="${c.id}">${c.status === 'completed' ? 'Archivar' : 'Abandonar'}</button></div>`);
  const ps = $('#sheet .panel-s'); if (ps) ps.scrollTop = scroll;
}
/* Imagen para historias (1080×1350). Solo porcentajes y niveles: nunca montos. */
async function shareImage({emoji, title, big, sub, text}){
  const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  try { await Promise.all([document.fonts.load('700 120px Sora'), document.fonts.load('600 44px Manrope')]); } catch {}
  const grd = g.createLinearGradient(0, 0, W, H); grd.addColorStop(0, '#0A5C4F'); grd.addColorStop(1, '#13A26F');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 90;
  [[W - 60, 140, 260], [60, H - 160, 220]].forEach(([x, y, r]) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); });
  const fit = (t, max, size, font) => { let s = size; do { g.font = `${font.replace('#', s)}`; s -= 4; } while (g.measureText(t).width > max && s > 30); };
  const wrap = (t, y, lh) => { const words = t.split(' '); let line = ''; for (const w of words){ const tt = line ? line + ' ' + w : w; if (g.measureText(tt).width > 900 && line){ g.fillText(line, W / 2, y); line = w; y += lh; } else line = tt; } g.fillText(line, W / 2, y); };
  g.textAlign = 'center'; g.fillStyle = '#fff';
  g.font = '230px serif'; g.fillText(emoji, W / 2, 440);
  g.globalAlpha = .85; g.font = '600 46px Manrope, sans-serif'; wrap(title, 560, 58); g.globalAlpha = 1;
  fit(big, 940, 150, '700 #px Sora, sans-serif'); g.fillText(big, W / 2, 760);
  g.font = '600 44px Manrope, sans-serif'; wrap(sub, 870, 58);
  g.fillStyle = '#F6BE45'; const bw = 520, bx = (W - bw) / 2, by = 1010;
  g.beginPath(); g.roundRect ? g.roundRect(bx, by, bw, 96, 48) : g.rect(bx, by, bw, 96); g.fill();
  g.fillStyle = '#04231A'; g.font = '700 42px Manrope, sans-serif'; g.fillText('¿Te animas? 💪', W / 2, by + 62);
  try { const img = new Image(); img.src = 'icons/logo-mark.png'; await img.decode(); g.drawImage(img, W / 2 - 170, H - 175, 72, 72); } catch {}
  g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = '700 54px Sora, sans-serif'; g.fillText('Kuenta', W / 2 - 80, H - 120);
  g.globalAlpha = .8; g.font = '500 32px Manrope, sans-serif'; g.textAlign = 'center'; g.fillText(location.host, W / 2, H - 50); g.globalAlpha = 1;
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const file = new File([blob], 'kuenta-ahorro.png', {type:'image/png'});
  if (navigator.canShare && navigator.canShare({files:[file]})){
    try { await navigator.share({files:[file], text}); } catch (e) { if (e.name !== 'AbortError') throw e; }
  } else { download(blob, 'kuenta-ahorro.png'); copyText(text, 'Imagen descargada y texto copiado. ¡Compártelo en tus historias!'); }
}

/* ---- acciones ---- */
Object.assign(A, {
  pushOn: enablePush,
  pushOff: async () => { await dropPushHere(); render(); toast('Notificaciones desactivadas en este teléfono'); },
  pushTest: async () => { const reg = await swReady(); await reg.showNotification('¿Ya registraste tus movimientos? ✍️', {body:'Así se verán tus recordatorios.', icon:'icons/icon-192.png', badge:'icons/favicon-48.png', tag:'kuenta-test', data:{url:'./?go=add'}}); },
  remAdd: async () => { const used = new Set(S.reminder.times); const t = ['09:00','13:00','20:00','07:00','18:00','22:00','12:00','16:00'].find(x => !used.has(x)) || '12:00'; await saveReminder({times:[...S.reminder.times, t]}); render(); },
  remDel: async el => { await saveReminder({times:S.reminder.times.filter((_, i) => i !== +el.dataset.v)}); render(); },
  remReset: async () => { await saveReminder({times:[...DEFAULT_TIMES], enabled:true}); render(); toast('Recordatorios a las 9:00 a. m., 1:00 p. m. y 8:00 p. m.'); },
  schNew: () => schForm(null), schEdit: el => schForm(el.dataset.v), schOpen: el => schSheet(el.dataset.v),
  schSkip: async el => { const s = S.scheduled.find(x => x.id === el.dataset.v), nn = await schAdvance(s); closeSheet(); render(); toast(nn ? `Listo. El próximo es el ${dShort(nn)}` : 'Pago terminado'); },
  schToggle: async el => {
    const s = S.scheduled.find(x => x.id === el.dataset.v), row = {is_active:!s.active};
    if (!s.active && s.freq !== 'once'){ let n = s.next, k = 0; while (n < TODAY && k++ < 400) n = nextOcc(s, n); row.next_date = n; }
    await q(sb.from('scheduled_payments').update(row).eq('id', s.id)); s.active = row.is_active; if (row.next_date) s.next = row.next_date; sortSch();
    closeSheet(); render(); toast(s.active ? 'Pago reanudado' : 'Pago pausado: no te avisaremos');
  },
  schAskDel: el => { $('#schdel').innerHTML = `<div class="note" style="margin-bottom:8px">¿Eliminar este pago programado? Los movimientos ya registrados se conservan.</div><div class="row2"><button class="btn ghost" data-a="closeSheet">Cancelar</button><button class="btn danger" data-a="schDel" data-v="${el.dataset.v}">Sí, eliminar</button></div>`; },
  schDel: async el => { await q(sb.from('scheduled_payments').delete().eq('id', el.dataset.v)); S.scheduled = S.scheduled.filter(s => s.id !== el.dataset.v); closeSheet(); render(); toast('Pago programado eliminado'); },
  debtNew: () => debtForm(null), debtEdit: el => debtForm(el.dataset.v),
  debtOpen: el => { S.ui.debtId = el.dataset.v; go('debt', S.ui.screen === 'debt' ? 'debts' : S.ui.screen); },
  debtPayNew: el => debtPaySheet(el.dataset.v), debtSim: el => debtSimSheet(el.dataset.v),
  useEst: () => { if (S.form.est != null) $('#db-b').value = S.form.est; },
  simQuick: el => { $('#sim-x').value = el.dataset.v; simRender(); },
  debtPayDel: el => toast('¿Eliminar este pago? El gasto registrado en tu cuenta no se borra.', 'warn', {label:'Eliminar', run: async () => {
    const d = S.debts.find(x => x.id === el.dataset.d);
    await q(sb.from('debt_payments').delete().eq('id', el.dataset.v));
    d.pays = d.pays.filter(p => p.id !== el.dataset.v);
    if (d.status === 'paid' && debtBal(d) > 0){ await q(sb.from('debts').update({status:'active'}).eq('id', d.id)); d.status = 'active'; }
    render(); toast('Pago eliminado');
  }}),
  debtAskDel: el => { $('#debtdel').innerHTML = `<div class="note" style="margin-bottom:8px">Se borrará la deuda y su historial de pagos. Los gastos registrados en tus cuentas se conservan.</div><div class="row2"><button class="btn ghost" data-a="debtOpen" data-v="${el.dataset.v}">Cancelar</button><button class="btn danger" data-a="debtDel" data-v="${el.dataset.v}">Sí, eliminar</button></div>`; },
  debtDel: async el => { await q(sb.from('debts').delete().eq('id', el.dataset.v)); S.debts = S.debts.filter(d => d.id !== el.dataset.v); go('debts', 'more'); toast('Deuda eliminada'); },
  planGoal: el => goalSheet({name:'Mi fondo de ahorro', target:Math.round(+el.dataset.v * 12), date:addMonths(TODAY, 12), icon:'🐷'}),
  shareLevel: async () => {
    const st = moneyStats(), lv = levelFor(st.rate), sk = streak();
    await shareImage({emoji:lv.e, title:'Mi nivel de ahorrador', big:lv.n, sub:sk >= 2 ? `🔥 ${sk} días seguidos cuidando mis finanzas` : st.rate > 0 ? `Ahorro el ${Math.round(st.rate)}% de lo que gano` : 'Empecé a ordenar mis finanzas',
      text:`Soy ${lv.e} ${lv.n} en Kuenta. ¿Qué nivel de ahorrador eres tú? ${location.origin}`});
  },
  chNew: el => chNewSheet(el.dataset.v), chOpen: el => chSheet(el.dataset.v),
  chBase: el => { S.form.base = +el.dataset.v; $('#chbases').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); $('#chtotal').innerHTML = chTotalText(S.form.kind, S.form.base); },
  chCreate: async () => {
    const k = CH[S.form.kind], goal = $('#ch-g')?.value || null;
    const row = await q(sb.from('savings_challenges').insert({kind:S.form.kind, name:k.n, base_amount:S.form.base, slots:k.slots, goal_id:goal, start_date:TODAY}).select().single());
    S.challenges.push(mapCh(row)); render(); chSheet(row.id); toast('¡Reto aceptado! Tú puedes 🔥');
  },
  chToggle: async el => {
    const c = S.challenges.find(x => x.id === el.dataset.v), i = +el.dataset.i, k = CH[c.kind];
    const on = !c.done.includes(i), done = on ? [...c.done, i].sort((a, b) => a - b) : c.done.filter(x => x !== i);
    const complete = done.length >= k.slots, was = c.status;
    await q(sb.from('savings_challenges').update({done, status:complete ? 'completed' : 'active'}).eq('id', c.id));
    c.done = done; c.status = complete ? 'completed' : 'active';
    const g = c.goal && S.goals.find(x => x.id === c.goal && !x.linked);
    if (g){ try { const v = k.val(c, i); await q(sb.from('goal_contributions').insert({goal_id:g.id, amount:on ? v : -v, contributed_on:TODAY, created_by:me(), note:c.name.slice(0, 200)})); await loadGoals(); }
      catch (e) { toast('Se marcó en el reto, pero no se sumó a la meta: ' + errMsg(e), 'warn'); } }
    render(); chSheet(c.id);
    if (complete && was !== 'completed') toast(`¡Completaste el ${c.name}! 🎉 Ahorraste ${money(chSaved(c))}`);
    else if (on) toast(`+${money(k.val(c, i))} guardados 💪`);
  },
  chRandom: el => {
    const c = S.challenges.find(x => x.id === el.dataset.v), left = Array.from({length:100}, (_, n) => n + 1).filter(n => !c.done.includes(n));
    if (!left.length) return;
    const i = left[crypto.getRandomValues(new Uint32Array(1))[0] % left.length];
    $('#chpick').innerHTML = `<div class="note" style="text-align:center;margin-bottom:10px"><div style="font-size:40px">✉️</div>Te tocó el sobre <b>#${i}</b>: guarda <b>${money(CH.sobres.val(c, i))}</b> hoy.
      <button class="btn sm" data-a="chToggle" data-v="${c.id}" data-i="${i}" style="margin:10px auto 0">Ya lo guardé</button></div>`;
    document.querySelectorAll('.slots button').forEach(b => b.classList.toggle('pick', +b.dataset.n === i));
  },
  chShare: async el => {
    const c = S.challenges.find(x => x.id === el.dataset.v), k = CH[c.kind];
    const pct = k.slots ? Math.round(c.done.length / k.slots * 100) : null;
    await shareImage({emoji:k.e, title:c.name, big:c.status === 'completed' ? '¡Logrado!' : pct !== null ? `${pct}%` : '¡En marcha!',
      sub:k.slots ? `${c.done.length} de ${k.slots} ${k.unit} completados` : 'Ahorrando con cada compra',
      text:`${c.status === 'completed' ? `¡Completé el ${c.name}!` : `Voy por el ${pct ?? 0}% del ${c.name}`} en Kuenta 💪 ¿Te animas a ahorrar conmigo? ${location.origin}`});
  },
  chArchive: async el => { await q(sb.from('savings_challenges').update({status:'archived'}).eq('id', el.dataset.v)); S.challenges = S.challenges.filter(c => c.id !== el.dataset.v); closeSheet(); render(); toast('Reto archivado'); }
});

/* ---- formularios ---- */
Object.assign(F, {
  sched: async f => {
    const id = f.dataset.id, s0 = id ? S.scheduled.find(x => x.id === id) : null, err = $('#ferr'), name = $('#sp-n').value.trim(), amount = round2(parseAmt($('#sp-a').value));
    const a = acc($('#sp-ac').value), catId = $('#sp-c').value, next = $('#sp-d').value, end = $('#sp-e').value || null, freq = $('#sp-f').value;
    if (!name) return (err.textContent = 'Escribe un nombre.');
    if (!(amount > 0)) return (err.textContent = 'Escribe un monto mayor que cero.');
    if (!a) return (err.textContent = 'Elige la cuenta desde la que pagas.');
    if (!catId) return (err.textContent = 'Elige una categoría.');
    if (!next) return (err.textContent = 'Elige la fecha del pago.');
    if (end && end < next) return (err.textContent = 'La fecha final debe ser después de la próxima fecha.');
    const anchor = s0 && s0.next === next && s0.anchor ? s0.anchor : +next.slice(8);
    const row = {name, amount, frequency:freq, account_id:a.id, category_id:catId, next_date:next, end_date:end, anchor_day:anchor,
      remind_day_before:$('#sp-b').checked, remind_same_day:$('#sp-s').checked, owner_id:a.shared ? null : me(), family_id:a.shared ? a.family_id : null};
    if (id) await q(sb.from('scheduled_payments').update(row).eq('id', id));
    else await q(sb.from('scheduled_payments').insert(row));
    closeSheet(); await loadScheduled(); render(); toast(id ? 'Pago actualizado' : 'Pago programado. Te avisaremos antes de cada fecha.');
  },
  schPay: async f => {
    const s = S.scheduled.find(x => x.id === f.dataset.id), err = $('#ferr'), amount = round2(parseAmt($('#sp-pa').value)), date = $('#sp-pd').value;
    if (!(amount > 0)) return (err.textContent = 'Escribe un monto mayor que cero.');
    if (!date || date > TODAY) return (err.textContent = 'La fecha no puede ser futura.');
    const row = await q(sb.from('transactions').insert(withTime({account_id:s.acc, category_id:s.cat, type:'expense', amount, occurred_on:date,
      description:s.name.slice(0, 120), notes:'Pago programado', created_by:me()}, date === TODAY ? nowHM() : null)).select().single());
    S.tx.unshift(mapTx(row)); LS.set('lastTx.' + me(), Date.now()); markRemindersRead();
    const nn = await schAdvance(s);
    closeSheet(); await afterWrite(); render(); toast(nn ? `Pago registrado. El próximo es el ${dShort(nn)}` : 'Pago registrado');
  },
  debt: async f => {
    const id = f.dataset.id, d0 = id ? S.debts.find(x => x.id === id) : null, err = $('#ferr');
    const name = $('#db-n').value.trim(), kind = $('#db-k').value, cur = $('#db-c').value, orig = round2(parseAmt($('#db-o').value));
    const rate = parseAmt($('#db-r').value || 0), term = parseInt($('#db-t').value, 10) || null, instRaw = $('#db-i').value.trim(), inst = instRaw ? round2(parseAmt(instRaw)) : null;
    const flat = $('#db-rt').value === 'flat', old = $('#db-old').checked, payDay = parseInt($('#db-pd').value, 10) || null;
    if (!name) return (err.textContent = 'Escribe un nombre para la deuda.');
    if (!(orig > 0)) return (err.textContent = 'Escribe el monto prestado.');
    if (isNaN(rate) || rate < 0 || rate > 300) return (err.textContent = 'La tasa debe estar entre 0% y 300% anual.');
    if (term !== null && (term < 1 || term > 600)) return (err.textContent = 'El plazo debe estar entre 1 y 600 meses.');
    if (inst !== null && !(inst > 0)) return (err.textContent = 'La cuota debe ser un número mayor que cero.');
    if (!term && !inst) return (err.textContent = 'Escribe el plazo en meses o la cuota mensual.');
    const r = rate / 1200, calc = term ? round2(flat ? flatPay(orig, r, term) : annuity(orig, r, term)) : null;
    let start = d0 ? d0.from : TODAY, bal = orig;
    if (old){
      start = $('#db-sd').value;
      if (!start || start > TODAY) return (err.textContent = 'Elige la fecha en que recibiste el préstamo.');
      const b = $('#db-b').value.trim();
      bal = b ? round2(parseAmt(b)) : estBalance(orig, r, term, inst || calc, monthsBetween(start, TODAY), flat);
      if (!(bal >= 0) || bal > orig * 3) return (err.textContent = 'Revisa el saldo: debe ser un número entre 0 y el triple del monto prestado.');
    }
    const row = {name, lender:$('#db-l').value.trim().slice(0, 60) || null, kind, currency:cur, original_amount:orig, current_balance:bal, annual_rate:Math.round(rate * 1000) / 1000,
      rate_type:flat ? 'flat' : 'saldo', term_months:term, installment:inst || calc, payment_day:payDay, start_date:start, icon:(DEBT_KINDS[kind] || DEBT_KINDS.otro)[0], notes:$('#db-no').value.trim().slice(0, 300) || null};
    if (d0){
      const paidPr = d0.pays.reduce((s, p) => s + p.principal, 0);
      row.status = bal - paidPr > 0.005 ? 'active' : 'paid';
      await q(sb.from('debts').update(row).eq('id', id));
    } else {
      const ins = await q(sb.from('debts').insert({...row, tracking_from:TODAY, status:bal > 0 ? 'active' : 'paid'}).select().single());
      S.ui.debtId = ins.id;
    }
    closeSheet(); await loadDebts();
    if (!d0) go('debt', 'debts'); else render();
    toast(d0 ? 'Deuda actualizada' : 'Deuda agregada. Revisa tu plan y las sugerencias para pagarla antes.');
  },
  debtPay: async f => {
    const d = S.debts.find(x => x.id === f.dataset.id), err = $('#ferr'), amount = round2(parseAmt($('#dp-a').value)), date = $('#dp-d').value, extra = $('#dp-x').checked;
    const interest = extra ? 0 : round2(parseAmt($('#dp-i').value || 0));
    if (!(amount > 0)) return (err.textContent = 'Escribe el monto que pagaste.');
    if (!date || date > TODAY) return (err.textContent = 'La fecha no puede ser futura.');
    if (isNaN(interest) || interest < 0 || interest > amount) return (err.textContent = 'Los intereses no pueden ser mayores que el pago.');
    const B = debtBal(d), principal = round2(Math.min(B, amount - interest));
    let txId = null;
    if ($('#dp-tx').checked){
      const a = acc($('#dp-ac').value), c = $('#dp-c').value;
      if (!a) return (err.textContent = 'Elige la cuenta del pago.');
      if (!c) return (err.textContent = 'Elige una categoría para el gasto.');
      const row = await q(sb.from('transactions').insert(withTime({account_id:a.id, category_id:c, type:'expense', amount, occurred_on:date, description:('Pago ' + d.name).slice(0, 120),
        notes:extra ? 'Abono extra a capital' : `Capital ${money(principal, d.cur)} · intereses ${money(interest, d.cur)}`, created_by:me()}, date === TODAY ? nowHM() : null)).select().single());
      S.tx.unshift(mapTx(row)); txId = row.id; LS.set('lastTx.' + me(), Date.now());
      if (d.acc !== a.id || d.cat !== c) sb.from('debts').update({account_id:a.id, category_id:c}).eq('id', d.id).then(() => {}, () => {});
    }
    await q(sb.from('debt_payments').insert({debt_id:d.id, amount, principal, interest, is_extra:extra, paid_on:date, transaction_id:txId, created_by:me()}));
    const left = round2(B - principal);
    if (left <= 0.005) await q(sb.from('debts').update({status:'paid'}).eq('id', d.id));
    closeSheet(); await Promise.all([loadDebts(), txId ? afterWrite() : null]); render();
    toast(left <= 0.005 ? `¡Liquidaste ${d.name}! 🎉 Una deuda menos.` : `Pago registrado. Te falta ${money(left, d.cur)}`);
  }
});

/* ---- campos con cálculo en vivo ---- */
document.addEventListener('input', e => {
  const k = e.target.dataset.in;
  if (k === 'debtCalc') debtCalcHint();
  else if (k === 'dpCalc') dpPreview();
  else if (k === 'dpInt'){ S.form.iTouched = true; dpPreview(); }
  else if (k === 'simCalc') simRender();
});
document.addEventListener('change', e => {
  const el = e.target, k = el.dataset.in; if (!k) return;
  if (k === 'remOpt') guarded(el, async () => { await saveReminder({[el.dataset.k]:el.checked}); render(); });
  else if (k === 'remTime') guarded(el, async () => { const t = [...S.reminder.times]; t[+el.dataset.i] = el.value; await saveReminder({times:t}); render(); });
  else if (k === 'schAcc') $('#sp-c').innerHTML = schCatOpts(acc(el.value), $('#sp-c').value);
  else if (k === 'dpAcc'){ const d = S.debts.find(x => x.id === S.form.debt); $('#dp-c').innerHTML = debtCatOpts(acc(el.value), d); }
  else if (k === 'debtCalc') debtCalcHint();
  else if (k === 'debtExtra'){ S.ui.debtExtra = Math.max(0, parseAmt(el.value) || 0); render(); }
});

/* ============ eventos ============ */
async function guarded(el, fn){
  if (el.dataset.busy) return; el.dataset.busy = '1';
  try { await fn(); } catch (e) { const box = el.closest('form')?.querySelector('#ferr') || $('#derr'); const m = errMsg(e); if (box) box.textContent = m; else toast(m, 'over'); }
  finally { delete el.dataset.busy; }
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  const fn = A[el.dataset.a]; if (!fn) return;
  e.preventDefault(); guarded(el, () => fn(el, e));
});
document.addEventListener('submit', e => {
  e.preventDefault(); const f = e.target, fn = F[f.dataset.f]; if (!fn) return;
  const btn = f.querySelector('[type=submit]'); if (btn) btn.dataset.busy = '';
  const err = f.querySelector('#ferr'); if (err) err.textContent = '';
  guarded(f, () => fn(f)).finally(() => { if (btn) delete btn.dataset.busy; });
});
document.addEventListener('input', e => {
  const el = e.target, k = el.dataset.in; if (!k) return;
  if (k === 'txQuery'){ S.ui.txQuery = el.value; const pos = el.selectionStart; render(); const qi = $('#q'); qi.focus(); qi.setSelectionRange(pos, pos); }
  else if (['date','time','desc','note','toAmount'].includes(k) && S.draft) S.draft[k] = el.value;
  else if (k === 'color' && isHex(el.value)) setColor(el.value, el.closest('.swatches'));
  else if (k === 'accName'){ if (el.value !== S.form.autoName) S.form.autoName = ''; updAccPreview(); }
  else if (k === 'emoji'){
    const v = el.value.trim();
    if (v && /\p{Extended_Pictographic}/u.test(v) && !/[A-Za-z0-9]/.test(v)){
      S.form.icon = v; $('#emoprev').textContent = v; document.querySelectorAll('.emopick button.on').forEach(b => b.classList.remove('on'));
    }
  }
});
document.addEventListener('change', e => {
  const el = e.target, k = el.dataset.in;
  if (el.dataset.up){
    const file = el.files[0]; el.value = ''; if (!file || !validFile(file)) return;
    if (el.dataset.up === 'draft'){ S.draft.file = file; S.draft.preview = /^image\//.test(file.type) ? URL.createObjectURL(file) : null; renderAdd(); return; }
    guarded(el, async () => { toast('Subiendo comprobante…'); await uploadAttachment(el.dataset.up, file); render(); txDetail(el.dataset.up); toast('Comprobante adjuntado'); });
    return;
  }
  if (!k) return;
  if (['period_start_day','tithe_percent','default_currency'].includes(k)){
    const val = k === 'default_currency' ? el.value : Number(el.value);
    guarded(el, async () => { S.profile = await q(sb.from('profiles').update({[k]:val}).eq('id', me()).select().single()); S.ui.repFrom = ''; render();
      if (k === 'period_start_day') toast(`Tu mes financiero ahora inicia el día ${val}`); });
  } else if (k === 'bio'){
    guarded(el, async () => {
      if (!el.checked){ LS.del('bio.' + me()); toast('Huella desactivada'); }
      else if (!(await bioAvailable())){ el.checked = false; toast('Este dispositivo no tiene huella o Face ID disponible.', 'warn'); }
      else { try { await bioEnroll(); toast('Huella activada'); } catch { el.checked = false; toast('No se activó la huella.', 'warn'); } }
      render();
    });
  } else if (k === 'role'){
    guarded(el, async () => { await q(sb.rpc('change_member_role', {p_user:el.dataset.id, p_role:el.value})); await loadFamily(); render(); toast('Rol actualizado'); });
  } else if (k === 'repFrom' || k === 'repTo'){ S.ui[k] = el.value; render(); }
  else if (k === 'bank') pickBank(el.value);
  else if (k === 'acctype'){
    const bf = $('#bankf'); if (bf) bf.hidden = !BANK_TYPES.includes(el.value);
    const b = BANKS.find(x => x.id === $('#ac-b')?.value), n = $('#ac-n');
    if (b && (!n.value.trim() || n.value === S.form.autoName)){ n.value = S.form.autoName = bankName(b, el.value); }
    updAccPreview();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

let hiddenAt = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden){ hiddenAt = Date.now(); return; }
  TODAY = localISO(new Date());
  if (!S.user || !S.profile) return;
  const away = Date.now() - hiddenAt;
  if (hiddenAt && pinRec() && !S.locked && away > LOCK_MINUTES * 60000){ maybeLock(); closeSheet(); render(); }
  if (S.locked) autoBio();
  if (Date.now() - S.loadedAt > 60000 && $('#sheet').hidden){ try { await loadAll(); render(); } catch {} }
  localReminderTick();
});

/* ============ arranque ============ */
async function acceptPendingInvite(){
  const tok = pendingInvite(); if (!tok) return;
  LS.del(INVITE_KEY);
  try { await q(sb.rpc('accept_family_invitation', {p_token:tok})); await loadAll(); toast('¡Te uniste a la familia!'); }
  catch (e) { toast(errMsg(e), 'over'); }
}
async function boot(fresh){
  S.profile = null; render();
  try {
    await loadAll();
    if (!fresh) maybeLock();
    S.needPinSetup = !pinRec(); // el PIN es obligatorio
    render();
    await acceptPendingInvite(); render();
  } catch (e) {
    S.profile = null;
    $('#view').innerHTML = `<div class="lock">${brand}<div class="err" style="text-align:center;max-width:320px">${esc(errMsg(e))}</div><button class="btn sm" data-a="retry">Reintentar</button><button class="textbtn" data-a="signOut">Cerrar sesión</button></div>`;
  }
}
A.retry = () => boot(false);

function init(){
  applyTheme();
  const qs = new URLSearchParams(location.search), inv = qs.get('invite');
  if (inv && /^[0-9a-f-]{36}$/i.test(inv)){ LS.set(INVITE_KEY, {token:inv, exp:Date.now() + 7 * 864e5}); history.replaceState(null, '', location.pathname); }
  // Al tocar una notificación se abre ?go=pantalla&id=...
  if (/^[a-z]{2,12}$/.test(qs.get('go') || '')){ pendingGo = {screen:qs.get('go'), id:qs.get('id')}; history.replaceState(null, '', location.pathname); }
  if (!CONFIGURED){ render(); return; }
  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY'){ S.user = session?.user || null; S.auth = 'recovery'; S.profile = null; $('#view').className = 'full'; $('#view').innerHTML = vAuth(); $('#nav').hidden = true; return; }
      if (S.auth === 'recovery' && event !== 'SIGNED_OUT') return;
      if (session?.user && S.user?.id !== session.user.id){
        const msg = S.authMsg; resetState(); S.authMsg = msg; S.user = session.user;
        const fresh = justLoggedIn; justLoggedIn = false;
        boot(fresh);
      } else if (session?.user){ S.user = session.user; }
      else if (!session){ const msg = S.authMsg; resetState(); S.authMsg = msg; closeSheet(); render(); }
    }, 0);
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type !== 'kuenta-go') return;
    try { const u = new URL(e.data.url); pendingGo = {screen:u.searchParams.get('go'), id:u.searchParams.get('id')}; if (S.profile) render(); } catch {}
  });
  setInterval(localReminderTick, 60000);
}
init();
