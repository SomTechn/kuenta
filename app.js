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
  logout:'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11'
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
    budgets:[], goals:[], notifs:[], ui:freshUI(), auth:'login', authMsg:'', locked:false, pinEntry:'', needPinSetup:false,
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
const mapTx = r => ({id:r.id, acc:r.account_id, cat:r.category_id, type:r.type, amount:+r.amount, date:r.occurred_on, desc:r.description || '', note:r.notes || '', by:r.created_by, tg:r.transfer_group});
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
  const [rows, atts] = await Promise.all([
    fetchAll(() => sb.from('transactions').select('id,account_id,category_id,type,amount,occurred_on,description,notes,created_by,transfer_group')
      .gte('occurred_on', S.txFrom).order('occurred_on', {ascending:false}).order('created_at', {ascending:false})),
    fetchAll(() => sb.from('attachments').select('id,transaction_id,storage_path,mime_type,uploaded_by'))
  ]);
  S.tx = rows.map(mapTx);
  S.atts = {};
  atts.forEach(a => (S.atts[a.transaction_id] ||= []).push(a));
}
async function loadNotifs(){
  S.notifs = await q(sb.from('notifications').select('id,type,title,body,read_at,created_at').order('created_at', {ascending:false}).limit(100));
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
  await Promise.all([loadSubscription(), loadFamily(), loadAccounts(), loadCategories(), loadBudgets(), loadGoals(), loadTx(), loadNotifs()]);
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
  if (S.locked){ v.className = 'full'; v.innerHTML = vLock(); n.hidden = true; return; }
  if (S.needPinSetup){ v.className = 'full'; v.innerHTML = vPinSetup(); n.hidden = true; return; }
  v.className = '';
  const views = {home:vHome, tx:vTx, stats:vStats, more:vMore, budgets:vBudgets, goals:vGoals, family:vFamily,
    categories:vCategories, reports:vReports, alerts:vAlerts, settings:vSettings, accounts:vAccounts};
  v.innerHTML = (views[S.ui.screen] || vHome)();
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
      <div class="field"><label for="su-p">Contraseña</label><input class="inp" id="su-p" type="password" required minlength="8" autocomplete="new-password" placeholder="Mínimo 8 caracteres, con letras y números"></div>
      <div class="field"><label for="su-p2">Repite la contraseña</label><input class="inp" id="su-p2" type="password" required autocomplete="new-password"></div>
      <div class="err" id="ferr"></div>${m}
      <p class="muted" style="font-size:12.5px;margin:0;text-align:center">Al crear tu cuenta aceptas los <a class="link" href="terminos.html" target="_blank" rel="noopener">Términos de uso</a> y la <a class="link" href="privacidad.html" target="_blank" rel="noopener">Política de privacidad</a>.</p>
      <button class="btn" type="submit">Crear cuenta</button>
      <button type="button" class="textbtn" data-a="authMode" data-v="login">Ya tengo cuenta</button></form></div>`;
  if (S.auth === 'forgot') return `<div class="lock">${brand}<h1 style="font-size:20px">Recupera tu acceso</h1>
    <form class="form" data-f="forgot" novalidate><p class="muted" style="margin:0;text-align:center">Te enviaremos un enlace para crear una contraseña nueva.</p>
      <div class="field"><label for="fg-e">Correo</label><input class="inp" id="fg-e" type="email" required autocomplete="email"></div>
      <div class="err" id="ferr"></div>${m}
      <button class="btn" type="submit">Enviar enlace</button>
      <button type="button" class="textbtn" data-a="authMode" data-v="login">Volver</button></form></div>`;
  if (S.auth === 'recovery') return `<div class="lock">${brand}<h1 style="font-size:20px">Nueva contraseña</h1>
    <form class="form" data-f="recovery" novalidate>
      <div class="field"><label for="rc-p">Contraseña nueva</label><input class="inp" id="rc-p" type="password" required minlength="8" autocomplete="new-password"></div>
      <div class="field"><label for="rc-p2">Repítela</label><input class="inp" id="rc-p2" type="password" required autocomplete="new-password"></div>
      <div class="err" id="ferr"></div><button class="btn" type="submit">Guardar contraseña</button></form></div>`;
  return `<div class="lock">${brand}${pending}
    <form class="form" data-f="login" novalidate>
      <div class="field"><label for="lg-e">Correo</label><input class="inp" id="lg-e" type="email" required autocomplete="username" inputmode="email"></div>
      <div class="field"><label for="lg-p">Contraseña</label><input class="inp" id="lg-p" type="password" required autocomplete="current-password"></div>
      <div class="err" id="ferr"></div>${m}
      <button class="btn" type="submit">Entrar</button>
      <button type="button" class="textbtn" data-a="authMode" data-v="forgot">Olvidé mi contraseña</button>
      <div class="muted" style="text-align:center;font-size:14px">¿Nuevo en Kuenta? <button type="button" class="textbtn" data-a="authMode" data-v="signup">Crear cuenta</button></div></form></div>`;
}
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
    <div style="text-align:center"><b style="font-size:17px">Hola, ${esc(firstName(S.profile.full_name))}</b><div class="muted" style="font-size:13.5px">Ingresa tu PIN para continuar</div></div>
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
function maybeLock(){ if (pinRec()){ S.locked = true; S.pinEntry = ''; } }

/* ============ inicio ============ */
function txRow(t){
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
    ${by}<span class="amt"><b class="${cls}">${sign > 0 ? '+' : '−'}${money(t.amount, a.cur).replace('−','')}</b><small>${dShort(t.date)}</small></span></button>`;
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
  const recent = [...S.tx].sort((x, y) => y.date.localeCompare(x.date)).slice(0, 6);
  const name = firstName(S.profile.full_name);
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
  <div class="section"><div class="sec-h"><h2>Este mes</h2><button class="link" data-a="tab" data-v="stats">Estadísticas</button></div>
    ${monthCard(sm)}</div>
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
  list = [...list].sort((a, b) => b.date.localeCompare(a.date));
  const lim = S.ui.txLimit || 150;
  let html = '', day = '';
  for (const t of list.slice(0, lim)){ if (t.date !== day){ day = t.date; html += `<div class="dayh">${dLong(day)}</div>`; } html += txRow(t); }
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
      <tr><td class="muted">Fecha</td><td class="r" style="text-transform:capitalize">${dLong(t.date)}</td></tr>
      <tr><td class="muted">Registrado por</td><td class="r">${esc(uname(t.by))}</td></tr>
      ${t.note ? `<tr><td class="muted">Nota</td><td class="r" style="white-space:normal">${esc(t.note)}</td></tr>` : ''}
    </table></div>
    ${t.tg ? '' : `<div class="section" style="margin-top:16px"><div class="sec-h"><h2>Comprobante</h2></div><div id="attbox">
      ${atts.length ? '<div class="spin" style="margin:10px auto"></div>' : editable ? `<label class="upload">${ic('camera')} Adjuntar foto o PDF<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-up="${t.id}"></label>` : '<div class="empty">Sin comprobante</div>'}
    </div></div>`}
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
      ${editable ? `<div id="delbox"><button class="btn danger" data-a="askDel" data-v="${t.id}">${ic('trash','sm')} Eliminar ${t.tg ? 'transferencia' : 'movimiento'}</button></div>`
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
  S.draft = {type, amount:'0', acc:first.id, cat:null, date:TODAY, desc:'', note:'', file:null, preview:null, step:1,
    from:first.id, to:(accs.find(a => a.id !== first.id) || first).id, toAmount:''};
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
  const seg = `<div class="seg" style="margin-bottom:12px">${[['expense','Gasto'],['income','Ingreso'],['transfer','Transferir']].map(([k, l]) =>
    `<button class="${d.type === k ? 'on' : ''}" data-a="dType" data-v="${k}">${l}</button>`).join('')}</div>`;
  const accChips = (key, label) => `<div class="eyebrow" style="margin:12px 0 6px">${label}</div><div class="accsel">${(key === 'from' ? fromAccs : accs).map(a =>
    `<button class="${d[key] === a.id ? 'on' : ''}" data-a="dAcc" data-k="${key}" data-v="${a.id}"><span style="font-size:18px">${esc(a.icon)}</span><span>${esc(a.name)}<small class="num">${money(balance(a), a.cur)}</small></span></button>`).join('')}</div>`;
  const keypad = `<div class="keys">${['1','2','3','4','5','6','7','8','9','.','0','del'].map(k =>
    `<button data-a="key" data-v="${k}" ${k === 'del' ? 'aria-label="Borrar"' : ''}>${k === 'del' ? '⌫' : k}</button>`).join('')}</div>`;
  const amt = `<div class="amount"><span class="num" id="amt">${amountText(d)}</span></div>`;
  if (d.type === 'transfer'){
    if (!fromAccs.length){
      openSheet(`${sheetHead('Nuevo movimiento')}${seg}<div class="empty">Para transferir necesitas una cuenta personal. Solo el dueño de la familia puede sacar dinero de las cuentas compartidas.</div>`);
      return;
    }
    if (!fromAccs.some(a => a.id === d.from)) d.from = fromAccs[0].id;
    if (d.to === d.from) d.to = (accs.find(a => a.id !== d.from) || accs[0]).id;
    const fa = acc(d.from), ta = acc(d.to), diff = fa.cur !== ta.cur;
    openSheet(`${sheetHead('Nuevo movimiento')}${seg}${amt}${accChips('from','Desde')}${accChips('to','Hacia')}
      ${diff ? `<div class="field" style="margin-top:12px"><label for="toAmt">Monto que recibe ${esc(ta.name)} (${ta.cur})</label><input class="inp" id="toAmt" inputmode="decimal" placeholder="Monedas distintas: indica el monto recibido" value="${esc(d.toAmount)}" data-in="toAmount"></div>` : ''}
      <div class="field" style="margin-top:12px"><label for="trDesc">Descripción (opcional)</label><input class="inp" id="trDesc" maxlength="120" value="${esc(d.desc)}" data-in="desc" placeholder="Ej: Aporte a la casa"></div>
      <div class="err" id="derr" style="margin-top:8px"></div>${keypad}
      <button class="btn" style="margin-top:12px" data-a="saveTransfer">${ic('swap','sm')} Transferir</button>`);
    return;
  }
  if (d.step === 1){
    openSheet(`${sheetHead('Nuevo movimiento')}${seg}${amt}${accChips('acc','Cuenta')}${keypad}
      <div class="err" id="derr" style="margin-top:8px"></div>
      <button class="btn" style="margin-top:6px" data-a="dNext">Elegir categoría ${ic('right','sm')}</button>`);
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
      <div class="row2"><div class="field"><label for="dDate">Fecha</label><input class="inp" id="dDate" type="date" value="${d.date}" max="${TODAY}" data-in="date"></div>
      <div class="field"><label for="dDesc">Descripción</label><input class="inp" id="dDesc" maxlength="120" placeholder="Ej: La Colonia" value="${esc(d.desc)}" data-in="desc"></div></div>
      <div class="field"><label for="dNote">Nota (opcional)</label><input class="inp" id="dNote" maxlength="500" value="${esc(d.note)}" data-in="note"></div>
      ${d.file ? `<div class="receipt">${d.preview ? `<img src="${d.preview}" alt="Comprobante adjunto">` : `<div class="note">${ic('file','sm')} ${esc(d.file.name)}</div>`}</div><button type="button" class="textbtn" data-a="dRmFile">Quitar comprobante</button>`
        : `<label class="upload">${ic('camera')} Adjuntar comprobante (opcional)<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-up="draft"></label>`}
      <div class="err" id="derr"></div>
      <button class="btn" data-a="saveTx" ${d.cat ? '' : 'disabled'}>${ic('check','sm')} Guardar ${d.type === 'income' ? 'ingreso' : 'gasto'}</button>
    </div>`);
}
async function saveTx(){
  const d = S.draft, amount = round2(Number(d.amount)), c = cat(d.cat), a = acc(d.acc);
  if (!(amount > 0)) return ($('#derr').textContent = 'Escribe un monto mayor que cero.');
  if (!d.date || d.date > TODAY) return ($('#derr').textContent = 'La fecha no puede ser futura.');
  const row = await q(sb.from('transactions').insert({account_id:d.acc, category_id:d.cat, type:d.type, amount, occurred_on:d.date,
    description:d.desc.trim().slice(0, 120) || null, notes:d.note.trim().slice(0, 500) || null, created_by:me()}).select().single());
  const t = mapTx(row); S.tx.unshift(t);
  LS.set('lastAcc.' + me(), d.acc);
  const file = d.file; closeSheet(); S.draft = null; render();
  if (file){ try { await uploadAttachment(t.id, file); render(); } catch (e) { toast('El movimiento se guardó, pero el comprobante no: ' + errMsg(e), 'over'); } }
  if (t.type === 'expense') toast(`${c.kind === 'generosity' ? 'Generosidad' : 'Gasto'} guardado`);
  else {
    const pct = +S.profile.tithe_percent;
    const tithe = S.categories.find(x => x.scope === 'p' && x.kind === 'generosity' && /^diezmo$/i.test(x.name) && !x.archived);
    if (!a.shared && pct > 0 && tithe && a.cur === 'HNL'){
      const amt = round2(t.amount * pct / 100);
      toast(`Ingreso guardado. ¿Registrar diezmo de ${money(amt)}?`, 'ok', {label:'Registrar', run: async () => {
        const r = await q(sb.from('transactions').insert({account_id:t.acc, category_id:tithe.id, type:'expense', amount:amt, occurred_on:t.date,
          description:('Diezmo de ' + (t.desc || c.name)).slice(0, 120), created_by:me()}).select().single());
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
  await q(sb.rpc('create_transfer', {p_from:fa.id, p_to:ta.id, p_amount:amount, p_date:TODAY,
    p_description:(d.desc.trim() || `${fa.name} → ${ta.name}`).slice(0, 120), p_to_amount:toAmt}));
  closeSheet(); S.draft = null;
  await Promise.all([loadTx(), afterWrite()]); render(); toast('Transferencia realizada');
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
    ['goals','target','Metas de ahorro',`${S.goals.length} metas`],['family','users','Familia',S.family ? S.family.name : 'Crea o únete a una'],
    ['categories','tag','Categorías','Personaliza las tuyas'],['reports','file','Informes','PDF y Excel por fechas'],
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
function goalSheet(){
  S.form = {icon:'🎯'};
  const scopes = `<option value="p">Personal</option>${hasFamily() && canEditScope('f') ? '<option value="f">Familia</option>' : ''}`;
  const linkable = visAccounts().filter(a => a.type === 'ahorro' && a.cur === 'HNL' && canWriteAcc(a));
  openSheet(`${sheetHead('Nueva meta')}<form class="form" data-f="goal" novalidate>
    <div class="field"><label for="go-n">Nombre</label><input class="inp" id="go-n" required maxlength="60" placeholder="Ej: Fondo de emergencia"></div>
    <div class="row2"><div class="field"><label for="go-t">Meta (L)</label><input class="inp" id="go-t" inputmode="decimal" required placeholder="25000"></div>
    <div class="field"><label for="go-d">Fecha objetivo</label><input class="inp" id="go-d" type="date" required min="${addDays(TODAY, 1)}" value="${addMonths(TODAY, 12)}"></div></div>
    <div class="row2"><div class="field"><label for="go-s">De quién es</label><select class="inp" id="go-s">${scopes}</select></div>
    <div class="field"><label for="go-a">Medir con</label><select class="inp" id="go-a"><option value="">Mis aportes</option>${linkable.map(a => `<option value="${a.id}" data-sc="${a.shared ? 'f' : 'p'}">Saldo de ${esc(a.name)}</option>`).join('')}</select></div></div>
    <div class="field"><label>Ícono</label><div class="emojis">${GOAL_EMOJIS.map(e => `<button type="button" class="${e === '🎯' ? 'on' : ''}" data-a="pickIcon" data-v="${e}">${e}</button>`).join('')}</div></div>
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
    .sort((a, b) => a.date.localeCompare(b.date));
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
  const rows = [['Fecha','Tipo','Categoría','Subcategoría','Descripción','Nota','Cuenta','Moneda','Monto','Registrado por']];
  repTx().forEach(t => { const c = cat(t.cat), a = acc(t.acc), r = rootOf(c);
    rows.push([t.date, t.type === 'income' ? 'Ingreso' : c.kind === 'generosity' ? 'Generosidad' : 'Gasto', r.name, c.parent ? c.name : '', t.desc, t.note, a.name, a.cur, (t.type === 'income' ? '' : '-') + t.amount.toFixed(2), uname(t.by)]); });
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
  table(y, ['Fecha', 'Detalle', 'Categoría', 'Cuenta', 'Monto'], tx.map(t => [t.date, plain(t.desc || cat(t.cat).name), plain(cat(t.cat).name), plain(acc(t.acc).name),
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
  const iconFor = {budget:['gauge','var(--warn)'], goal:['target','var(--pos)'], family:['users','var(--brand)'], system:['bell','var(--muted)']};
  return `${subhead('Alertas', S.notifs.some(n => !n.read_at) ? '<button class="link" data-a="readAll">Marcar leídas</button>' : '')}
  <div class="list">${S.notifs.map(n => { const [i, c] = iconFor[n.type] || iconFor.system; return `<button class="tx" data-a="readOne" data-v="${n.id}" style="${n.read_at ? 'opacity:.65' : ''}">
    <span class="tile" style="background:${soft(c)};color:${c}">${ic(i,'sm')}</span>
    <span class="mid"><b style="white-space:normal">${esc(n.title)}</b><small>${esc(n.body || '')}</small></span>
    <span class="amt"><small>${dShort(n.created_at.slice(0, 10))}</small>${n.read_at ? '' : '<b style="color:var(--brand);font-size:18px" aria-label="Sin leer">•</b>'}</span></button>`; }).join('') || '<div class="empty">Sin alertas por ahora.</div>'}</div>
  <div class="note" style="margin-top:14px">Te avisamos cuando un presupuesto llega a su límite de aviso o al 100%, cuando cumples una meta y cuando alguien se une a tu familia.</div>`;
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
    <div class="field"><label for="pw-1">Contraseña nueva</label><input class="inp" id="pw-1" type="password" minlength="8" autocomplete="new-password"></div>
    <div class="field"><label for="pw-2">Repítela</label><input class="inp" id="pw-2" type="password" autocomplete="new-password"></div>
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
  signOut: async () => { await sb.auth.signOut(); },
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
    if (ok){ LS.set('tries.' + me(), 0); S.locked = false; render(); return; }
    const tries = LS.get('tries.' + me(), 0) + 1; LS.set('tries.' + me(), tries);
    if (tries >= 5){ LS.del('pin.' + me()); LS.del('bio.' + me()); LS.set('tries.' + me(), 0); S.authMsg = '!Por seguridad cerramos tu sesión tras 5 intentos de PIN. Entra con tu correo y contraseña.'; await sb.auth.signOut(); return; }
    render(); $('#dots').classList.add('shake');
  },
  bio: async () => { try { if (await bioVerify()){ LS.set('tries.' + me(), 0); S.locked = false; render(); } } catch { toast('No se pudo verificar tu huella. Usa tu PIN.', 'warn'); } },
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
  lockNow: () => { S.locked = true; S.pinEntry = ''; closeSheet(); render(); },
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
  dType: el => { S.draft.type = el.dataset.v; S.draft.step = 1; S.draft.cat = null; renderAdd(); },
  dAcc: el => { S.draft[el.dataset.k] = el.dataset.v; if (el.dataset.k === 'acc') S.draft.cat = null; renderAdd(); },
  key: el => {
    const d = S.draft, k = el.dataset.v; let a = d.amount;
    if (k === 'del') a = a.length > 1 ? a.slice(0, -1) : '0';
    else if (k === '.') { if (!a.includes('.')) a += '.'; }
    else { if (a.includes('.') && a.split('.')[1].length >= 2) return; if (a.replace('.', '').length >= 10) return; a = a === '0' ? k : a + k; }
    d.amount = a; $('#amt').textContent = amountText(d);
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
  newGoal: goalSheet,
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
  readOne: async el => { const n = S.notifs.find(x => x.id === el.dataset.v); if (n.read_at) return; const now = new Date().toISOString();
    await q(sb.from('notifications').update({read_at:now}).eq('id', n.id)); n.read_at = now; render(); },
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
    await q(sb.auth.signInWithPassword({email, password}));
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
    if (!data.session){ S.auth = 'login'; S.authMsg = 'Te enviamos un correo para confirmar tu cuenta. Si no lo ves en unos minutos, revisa Spam o Promociones. Ábrelo y luego entra aquí.'; render(); }
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
    ['pin.', 'bio.', 'tries.', 'lastAcc.'].forEach(k => LS.del(k + uid));
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
  else if (['date','desc','note','toAmount'].includes(k) && S.draft) S.draft[k] = el.value;
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
  if (hiddenAt && pinRec() && !S.locked && away > LOCK_MINUTES * 60000){ S.locked = true; S.pinEntry = ''; closeSheet(); render(); }
  if (Date.now() - S.loadedAt > 60000 && $('#sheet').hidden){ try { await loadAll(); render(); } catch {} }
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
  const inv = new URLSearchParams(location.search).get('invite');
  if (inv && /^[0-9a-f-]{36}$/i.test(inv)){ LS.set(INVITE_KEY, {token:inv, exp:Date.now() + 7 * 864e5}); history.replaceState(null, '', location.pathname); }
  if (!CONFIGURED){ render(); return; }
  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY'){ S.user = session?.user || null; S.auth = 'recovery'; S.profile = null; $('#view').className = 'full'; $('#view').innerHTML = vAuth(); $('#nav').hidden = true; return; }
      if (S.auth === 'recovery' && event !== 'SIGNED_OUT') return;
      if (session?.user && S.user?.id !== session.user.id){
        const msg = S.authMsg; resetState(); S.authMsg = msg; S.user = session.user;
        boot(event === 'SIGNED_IN');
      } else if (session?.user){ S.user = session.user; }
      else if (!session){ const msg = S.authMsg; resetState(); S.authMsg = msg; closeSheet(); render(); }
    }, 0);
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
