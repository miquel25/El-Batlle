// Cloudflare Worker: comptes de jugador i partides desades al núvol.
// Cada compte és un Durable Object amb la seva pròpia base de dades SQLite (nom, contrasenya, correu opcional,
// sessions i fins a MAX_PARTIDES partides). Funciona amb el pla gratuït de Cloudflare i es desplega sol amb
// GitHub Actions (.github/workflows/comptes.yml).
//
// La contrasenya mai arriba aquí: el joc n'envia una clau derivada (PBKDF2, 100.000 voltes) i aquí se'n desa un
// altre hash amb sal pròpia. El correu tampoc es desa: només un hash, per comprovar-lo quan algú vol recuperar la
// contrasenya; el codi s'envia a l'adreça que s'escriu en aquell moment.
//
// Trofeus: cada compte guarda els que ha aconseguit i quan. Només s'accepten els noms de la llista TROFEUS, i un
// trofeu ja aconseguit no canvia de data. A més, un registre comú (el Durable Object Registre) apunta qui ha guanyat
// cada trofeu, que només pot consultar el compte ADMIN.
//
// Propostes de lleis: un jugador amb la sessió iniciada envia una proposta i aquí es crea l'issue a GitHub, signada
// amb el seu nom de jugador. Cal el secret GITHUB_TOKEN (token fine-grained amb Issues: write només a El-Batlle).
//
// Secrets opcionals (Settings → Variables and Secrets del Worker), només per recuperar la contrasenya per correu:
//   BREVO_API_KEY   la clau de l'API de Brevo (pla gratuït, 300 correus al dia)
//   CORREU_REMITENT l'adreça verificada a Brevo des de la qual s'envien els codis
import { DurableObject } from 'cloudflare:workers';

const ORIGENS = ['https://miquel25.github.io'];
const MAX_PARTIDES = 5, MAX_DADES = 1_900_000, MAX_SESSIONS = 10;
const REPO = 'miquel25/El-Batlle', MAX_TITOL = 120, MAX_TEXT = 4000, PROPOSTES_HORA = 5;
const NOM_AGAFAT = 'Aquest nom ja el fa servir un altre jugador (els noms no es poden repetir, encara que canviïn les majúscules). Tria\'n un altre.';
const TROFEUS = ['armageddon', 'mirava', 'completista', 'miler', 'nombrosa', 'endogamia', 'gilito', 'malvat', 'mansa', 'seixanta', 'palantir', 'milei', 'cabres',
  'camps', 'illustrada', 'tovarishch', 'oligopoli', 'cromatic', 'bigone', 'pax', 'robin', 'prodig', 'buro', 'rates', 'cacic', 'nieve'];
const ADMIN = 'miquel'; // l'únic compte que pot veure qui ha guanyat cada trofeu
const DIES_SESSIO = 180, MINUTS_CODI = 30, MAX_ERRORS = 10, MINUTS_BLOQUEIG = 15;

const permès = o => ORIGENS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const cors = o => ({
  'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin',
});
const json = (cos, estat, o) => new Response(JSON.stringify(cos), { status: estat, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(o) } });
const err = (estat, error) => ({ estat, error });

// el nom es mostra tal com s'escriu, però dos noms que només canvien de majúscules són el mateix compte
const netNom = n => String(n ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const nomValid = n => /^[\p{L}\p{N}_. -]{3,20}$/u.test(n);
const clauNom = n => n.toLocaleLowerCase('ca');
const correuValid = c => c.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c);
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const atzar = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async t => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
async function pbkdf2(clau, sal) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(clau), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(sal), iterations: 1000 }, k, 256));
}
// comparació que no diu, pel temps que tarda, quantes lletres coincideixen
function iguals(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

export default {
  async fetch(req, env) {
    const o = req.headers.get('Origin') || '';
    if (!permès(o)) return new Response('Origen no permès', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(o) });
    let r;
    try { r = await ruta(req, env); } catch (e) { console.log(e && e.stack || e); r = err(500, 'Hi ha hagut un error al servidor. Torna-ho a provar.'); }
    return json(r.estat ? { error: r.error } : r, r.estat || 200, o);
  },
};

async function ruta(req, env) {
  const camí = new URL(req.url).pathname, m = req.method;
  const ip = req.headers.get('CF-Connecting-IP') || 'desconeguda';
  const porta = (què, max, minuts) => env.PORTERS.get(env.PORTERS.idFromName(`${què}:${ip}`)).pas(max, minuts * 60000);
  let d = {};
  if (m === 'POST' || m === 'PUT') { try { d = await req.json(); } catch (e) { return err(400, 'Dades no vàlides.'); } if (!d || typeof d !== 'object') return err(400, 'Dades no vàlides.'); }
  const compte = n => env.COMPTES.get(env.COMPTES.idFromName(clauNom(n)));
  const registre = env.REGISTRE.get(env.REGISTRE.idFromName('tots'));

  // sense sessió: crear un compte, entrar i recuperar la contrasenya
  if (m === 'POST' && ['/registre', '/entra', '/recupera', '/nova-clau'].includes(camí)) {
    const nom = netNom(d.nom);
    if (!nomValid(nom)) return err(400, 'El nom ha de tenir de 3 a 20 lletres, xifres, espais, punts o guions.');
    if (camí === '/registre') {
      if (!(await porta('registre', 5, 60))) return err(429, 'S\'han creat massa comptes des d\'aquesta connexió. Torna-ho a provar d\'aquí una hora.');
      return compte(nom).registre(nom, String(d.clau ?? ''), d.correu ? String(d.correu).trim() : '');
    }
    if (camí === '/entra') {
      if (!(await porta('entra', 30, 10))) return err(429, 'Massa intents seguits. Espera uns minuts.');
      return compte(nom).entra(String(d.clau ?? ''));
    }
    if (camí === '/recupera') {
      if (!(await porta('recupera', 5, 60))) return err(429, 'Massa intents seguits. Torna-ho a provar d\'aquí una hora.');
      if (!env.BREVO_API_KEY || !env.CORREU_REMITENT) return err(503, 'Ara mateix no es poden enviar correus per recuperar la contrasenya.');
      return compte(nom).recupera(String(d.correu ?? '').trim());
    }
    if (!(await porta('codi', 20, 60))) return err(429, 'Massa intents seguits. Torna-ho a provar d\'aquí una hora.');
    return compte(nom).novaClau(String(d.codi ?? '').trim(), String(d.clau ?? ''));
  }

  // amb sessió: el testimoni porta el compte al final ("aleatori.nom")
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), punt = t.indexOf('.');
  if (punt < 1) return err(401, 'Cal entrar al compte.');
  let nom; try { nom = decodeURIComponent(t.slice(punt + 1)); } catch (e) { return err(401, 'Cal entrar al compte.'); }
  if (!nomValid(netNom(nom))) return err(401, 'Cal entrar al compte.');
  const c = compte(nom), tok = t.slice(0, punt);
  const p = camí.match(/^\/partides\/(\d)$/), slot = p ? +p[1] : 0;
  if (m === 'GET' && camí === '/partides') return c.llista(tok);
  if (p && m === 'GET') return c.carrega(tok, slot);
  if (p && m === 'PUT') return c.desa(tok, slot, d);
  if (p && m === 'DELETE') return c.esborra(tok, slot);
  if (m === 'POST' && camí === '/surt') return c.surt(tok);
  if (m === 'POST' && camí === '/correu') return c.canviaCorreu(tok, d.correu ? String(d.correu).trim() : '');
  if (m === 'POST' && camí === '/canvia-nom') {
    const nou = netNom(d.nom);
    if (!nomValid(nou)) return err(400, 'El nom ha de tenir de 3 a 20 lletres, xifres, espais, punts o guions.');
    if (clauNom(nou) === clauNom(nom)) { const r = await c.reanomena(tok, String(d.clau ?? ''), nou); if (!r.estat) await registre.reanomena(clauNom(nom), nou); return r; }
    if (!(await porta('nom', 10, 60))) return err(429, 'Massa canvis de nom seguits. Torna-ho a provar d\'aquí una hora.');
    const vell = await c.exporta(tok, String(d.clau ?? ''));
    if (vell.estat) return vell;
    const r = await compte(nou).importa(nou, String(d.clauNova ?? ''), vell);
    if (!r.estat) { await c.tanca(); await registre.reanomena(clauNom(nom), nou); } // el nom vell queda lliure
    return r;
  }
  // el registre comú s'omple també amb els trofeus que cada jugador ja tenia, cada vegada que els carrega
  if (m === 'GET' && camí === '/trofeus') { const r = await c.trofeus(tok); if (!r.estat) await registre.posa(r.nom, r.llista); return r.estat ? r : { trofeus: r.trofeus }; }
  if (m === 'POST' && camí === '/trofeus') {
    if (!TROFEUS.includes(d.id)) return err(400, 'Aquest trofeu no existeix.');
    const r = await c.trofeu(tok, d.id); if (!r.estat) await registre.posa(r.nom, [{ id: r.id, quan: r.quan }]);
    return r.estat ? r : { id: r.id, quan: r.quan };
  }
  if (m === 'GET' && camí === '/guanyadors') {
    const qui = await c.qui(tok); if (qui.estat) return qui;
    return clauNom(qui.nom) === ADMIN ? registre.llista() : err(403, 'Només ho pot veure l\'administrador.');
  }
  if (m === 'POST' && camí === '/proposta') return proposta(env, c, tok, d, porta);
  if (m === 'POST' && camí === '/esborra-compte') { const r = await c.esborraCompte(tok, String(d.clau ?? '')); if (!r.estat) await registre.esborra(clauNom(nom)); return r; }
  return err(404, 'No existeix.');
}

// la proposta queda signada amb el nom del compte que l'envia, que no es pot falsejar des del joc
async function proposta(env, c, tok, d, porta) {
  if (!env.GITHUB_TOKEN) return err(503, 'Ara mateix no es poden enviar propostes. Torna-ho a provar més tard.');
  const qui = await c.qui(tok);
  if (qui.estat) return qui;
  const net = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  const titol = net(d.titol, MAX_TITOL), text = net(d.text, MAX_TEXT);
  if (titol.length < 3 || text.length < 10) return err(400, 'Cal un títol i una descripció una mica més llargs.');
  const perCompte = env.PORTERS.get(env.PORTERS.idFromName(`proposta:${clauNom(qui.nom)}`));
  if (!(await perCompte.pas(PROPOSTES_HORA, 3600000)) || !(await porta('proposta', 10, 60))) return err(429, 'Massa propostes seguides. Torna-ho a provar d\'aquí una estona.');
  const gh = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'el-batlle-comptes', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `[Proposta] ${titol}`, body: `${text}\n\n---\nProposada per: **${qui.nom}**\n_Enviada des del joc per un jugador amb compte._`, labels: ['proposta'] }),
  }).catch(e => ({ ok: false, status: 0, text: async () => String(e) }));
  if (!gh.ok) { console.log('GitHub ha respost', gh.status, await gh.text()); return err(502, 'No s\'ha pogut desar la proposta. Torna-ho a provar més tard.'); }
  const issue = await gh.json();
  return { ok: true, numero: issue.number, url: issue.html_url };
}

// limita quantes vegades es pot fer una cosa des d'una mateixa connexió en un temps
export class Porter extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.taules(); }
  taules() { this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS c (n INTEGER, fins INTEGER)'); }
  pas(max, finestra) {
    const sql = this.ctx.storage.sql, ara = Date.now();
    let r = sql.exec('SELECT n, fins FROM c').toArray()[0];
    if (!r || r.fins < ara) { sql.exec('DELETE FROM c'); r = { n: 0, fins: ara + finestra }; sql.exec('INSERT INTO c VALUES (0, ?)', r.fins); }
    if (r.n >= max) return false;
    sql.exec('UPDATE c SET n = n + 1');
    this.ctx.storage.setAlarm(r.fins + 1000);
    return true;
  }
  async alarm() { await this.ctx.storage.deleteAll(); this.taules(); }
}

// qui ha guanyat cada trofeu, per a tots els comptes: una fila per compte (el nom en minúscules) i trofeu
export class Registre extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.sql = ctx.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS g (clau TEXT, nom TEXT, id TEXT, quan INTEGER, PRIMARY KEY (clau, id))'); }
  posa(nom, llista) {
    const clau = clauNom(nom);
    for (const t of llista) this.sql.exec('INSERT OR IGNORE INTO g VALUES (?, ?, ?, ?)', clau, nom, t.id, t.quan);
    this.sql.exec('UPDATE g SET nom = ? WHERE clau = ?', nom, clau);
    return { ok: true };
  }
  reanomena(vella, nom) {
    const clau = clauNom(nom);
    if (clau !== vella) this.sql.exec('DELETE FROM g WHERE clau = ?', clau); // restes d'un compte esborrat amb aquest nom
    this.sql.exec('UPDATE g SET clau = ?, nom = ? WHERE clau = ?', clau, nom, vella);
    return { ok: true };
  }
  esborra(clau) { this.sql.exec('DELETE FROM g WHERE clau = ?', clau); return { ok: true }; }
  llista() {
    const guanyadors = {};
    for (const r of this.sql.exec('SELECT nom, id, quan FROM g ORDER BY quan').toArray()) (guanyadors[r.id] ||= []).push({ nom: r.nom, quan: r.quan });
    return { guanyadors };
  }
}

export class Compte extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.taules();
  }
  taules() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS compte (nom TEXT, sal TEXT, hash TEXT, correu TEXT, creat INTEGER,
      errors INTEGER DEFAULT 0, bloc INTEGER DEFAULT 0, codi TEXT, codiFins INTEGER DEFAULT 0, codiErrors INTEGER DEFAULT 0)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (t TEXT PRIMARY KEY, creat INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS partides (slot INTEGER PRIMARY KEY, nom TEXT, desat INTEGER, meta TEXT, dades TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS trofeus (id TEXT PRIMARY KEY, quan INTEGER)');
  }
  get c() { return this.sql.exec('SELECT * FROM compte').toArray()[0]; }
  async nouTestimoni() {
    const t = atzar(24), ara = Date.now();
    this.sql.exec('DELETE FROM sessions WHERE creat < ?', ara - DIES_SESSIO * 864e5);
    this.sql.exec('DELETE FROM sessions WHERE t NOT IN (SELECT t FROM sessions ORDER BY creat DESC LIMIT ?)', MAX_SESSIONS - 1);
    this.sql.exec('INSERT INTO sessions VALUES (?, ?)', await sha(t), ara);
    return `${t}.${encodeURIComponent(clauNom(this.c.nom))}`;
  }
  async sessió(t) {
    if (!this.c || !/^[0-9a-f]{48}$/.test(t)) return false;
    return this.sql.exec('SELECT 1 FROM sessions WHERE t = ? AND creat > ?', await sha(t), Date.now() - DIES_SESSIO * 864e5).toArray().length > 0;
  }
  async qui(t) { return (await this.sessió(t)) ? { nom: this.c.nom } : err(401, 'La sessió ha caducat. Torna a entrar.'); }
  info() { const c = this.c; return { nom: c.nom, correu: !!c.correu, max: MAX_PARTIDES }; }

  // el nom és lliure si aquest objecte (un per nom, sense comptar majúscules) encara no té compte. Els càlculs es
  // fan abans de mirar-ho, perquè entre la comprovació i l'escriptura no s'hi pugui colar una altra petició
  async registre(nom, clau, correu) {
    if (!/^[0-9a-f]{64}$/.test(clau)) return err(400, 'Contrasenya no vàlida.');
    if (correu && !correuValid(correu)) return err(400, 'Aquest correu no sembla vàlid.');
    const sal = atzar(16), hash = await pbkdf2(clau, sal), hc = correu ? await sha(`${sal}:${correu.toLowerCase()}`) : null;
    if (this.c) return err(409, NOM_AGAFAT);
    this.sql.exec('INSERT INTO compte (nom, sal, hash, correu, creat) VALUES (?, ?, ?, ?, ?)', nom, sal, hash, hc, Date.now());
    return { testimoni: await this.nouTestimoni(), ...this.info() };
  }
  // canviar de nom: el compte vell s'exporta, el nou l'importa (si el nom és lliure) i el vell s'esborra.
  // La clau derivada depèn del nom, per això cal la contrasenya: la vella per comprovar-la i la nova (mateixa
  // contrasenya, nom nou) per desar-la
  async exporta(t, clau) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    const c = this.c;
    if (!/^[0-9a-f]{64}$/.test(clau) || !iguals(await pbkdf2(clau, c.sal), c.hash)) return err(403, 'La contrasenya no és correcta.');
    return { sal: c.sal, correu: c.correu, creat: c.creat, partides: this.sql.exec('SELECT * FROM partides').toArray(), trofeus: this.sql.exec('SELECT * FROM trofeus').toArray() };
  }
  async importa(nom, clau, d) {
    if (!/^[0-9a-f]{64}$/.test(clau)) return err(400, 'Contrasenya no vàlida.');
    const hash = await pbkdf2(clau, d.sal);
    if (this.c) return err(409, NOM_AGAFAT);
    this.sql.exec('INSERT INTO compte (nom, sal, hash, correu, creat) VALUES (?, ?, ?, ?, ?)', nom, d.sal, hash, d.correu, d.creat);
    for (const p of d.partides) this.sql.exec('INSERT INTO partides VALUES (?, ?, ?, ?, ?)', p.slot, p.nom, p.desat, p.meta, p.dades);
    for (const t of d.trofeus || []) this.sql.exec('INSERT INTO trofeus VALUES (?, ?)', t.id, t.quan);
    return { testimoni: await this.nouTestimoni(), ...this.info() };
  }
  async tanca() { await this.ctx.storage.deleteAll(); this.taules(); return { ok: true }; }
  // només canvien majúscules, accents no: és el mateix compte
  async reanomena(t, clau, nom) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    if (!/^[0-9a-f]{64}$/.test(clau) || !iguals(await pbkdf2(clau, this.c.sal), this.c.hash)) return err(403, 'La contrasenya no és correcta.');
    this.sql.exec('UPDATE compte SET nom = ?', nom);
    return { testimoni: `${t}.${encodeURIComponent(clauNom(nom))}`, ...this.info() };
  }
  async entra(clau) {
    const c = this.c, ara = Date.now();
    if (!c) return err(401, 'El nom o la contrasenya no són correctes.');
    if (c.bloc > ara) return err(429, `Massa intents fallits. Torna-ho a provar d'aquí ${Math.ceil((c.bloc - ara) / 60000)} minuts.`);
    if (!/^[0-9a-f]{64}$/.test(clau) || !iguals(await pbkdf2(clau, c.sal), c.hash)) {
      const n = c.errors + 1;
      this.sql.exec('UPDATE compte SET errors = ?, bloc = ?', n >= MAX_ERRORS ? 0 : n, n >= MAX_ERRORS ? ara + MINUTS_BLOQUEIG * 60000 : 0);
      return err(401, 'El nom o la contrasenya no són correctes.');
    }
    this.sql.exec('UPDATE compte SET errors = 0, bloc = 0');
    return { testimoni: await this.nouTestimoni(), ...this.info() };
  }
  async recupera(correu) {
    const c = this.c, ok = { ok: true }; // la mateixa resposta tant si el compte o el correu existeixen com si no
    if (!c || !c.correu || !correu || !iguals(await sha(`${c.sal}:${correu.toLowerCase()}`), c.correu)) return ok;
    const codi = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
    this.sql.exec('UPDATE compte SET codi = ?, codiFins = ?, codiErrors = 0', await sha(`${c.sal}:${codi}`), Date.now() + MINUTS_CODI * 60000);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'El batlle', email: this.env.CORREU_REMITENT }, to: [{ email: correu }],
        subject: `El batlle: codi per canviar la contrasenya (${codi})`,
        textContent: `Hola, ${c.nom}:\n\nEl teu codi per posar una contrasenya nova a El batlle és: ${codi}\n\nVal durant ${MINUTS_CODI} minuts. Si no l'has demanat tu, no cal que facis res: la contrasenya continua sent la mateixa.\n\nAquest correu només es fa servir per recuperar la contrasenya.`,
      }),
    }).catch(e => ({ ok: false, status: 0, text: async () => String(e) }));
    if (!r.ok) { console.log('Brevo ha respost', r.status, await r.text()); return err(502, 'No s\'ha pogut enviar el correu. Torna-ho a provar més tard.'); }
    return ok;
  }
  async novaClau(codi, clau) {
    const c = this.c, ara = Date.now(), mal = err(400, 'El codi no és correcte o ha caducat. Demana\'n un altre.');
    if (!c || !c.codi || c.codiFins < ara || c.codiErrors >= 5) return mal;
    if (!/^[0-9a-f]{64}$/.test(clau)) return err(400, 'Contrasenya no vàlida.');
    if (!iguals(await sha(`${c.sal}:${codi}`), c.codi)) { this.sql.exec('UPDATE compte SET codiErrors = codiErrors + 1'); return mal; }
    this.sql.exec('UPDATE compte SET hash = ?, codi = NULL, codiFins = 0, errors = 0, bloc = 0', await pbkdf2(clau, c.sal));
    this.sql.exec('DELETE FROM sessions'); // la contrasenya nova fa sortir tots els altres navegadors
    return { testimoni: await this.nouTestimoni(), ...this.info() };
  }

  async llista(t) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    const partides = this.sql.exec('SELECT slot, nom, desat, meta, length(dades) AS mida FROM partides ORDER BY slot').toArray()
      .map(p => ({ ...p, meta: JSON.parse(p.meta || '{}') }));
    return { ...this.info(), partides };
  }
  async carrega(t, slot) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    const p = this.sql.exec('SELECT dades FROM partides WHERE slot = ?', slot).toArray()[0];
    return p ? { dades: p.dades } : err(404, 'Aquesta partida ja no hi és.');
  }
  async desa(t, slot, d) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    if (slot < 1 || slot > MAX_PARTIDES) return err(400, `Només es poden desar ${MAX_PARTIDES} partides.`);
    const dades = typeof d.dades === 'string' ? d.dades : '', meta = JSON.stringify(d.meta && typeof d.meta === 'object' ? d.meta : {});
    if (!dades) return err(400, 'Dades no vàlides.');
    if (dades.length > MAX_DADES) return err(413, 'Aquesta partida és massa gran per desar-la.');
    if (meta.length > 600) return err(400, 'Dades no vàlides.');
    const nom = netNom(d.nom).slice(0, 40) || `Partida ${slot}`, ara = Date.now();
    this.sql.exec('INSERT OR REPLACE INTO partides VALUES (?, ?, ?, ?, ?)', slot, nom, ara, meta, dades);
    return { ok: true, desat: ara };
  }
  async esborra(t, slot) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    this.sql.exec('DELETE FROM partides WHERE slot = ?', slot);
    return { ok: true };
  }
  async trofeus(t) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    const llista = this.sql.exec('SELECT id, quan FROM trofeus').toArray();
    return { nom: this.c.nom, llista, trofeus: Object.fromEntries(llista.map(r => [r.id, r.quan])) };
  }
  // el primer cop queda la data; si ja el tenia, es torna la data de llavors
  async trofeu(t, id) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    this.sql.exec('INSERT OR IGNORE INTO trofeus VALUES (?, ?)', id, Date.now());
    return { nom: this.c.nom, id, quan: this.sql.exec('SELECT quan FROM trofeus WHERE id = ?', id).toArray()[0].quan };
  }
  async surt(t) {
    if (/^[0-9a-f]{48}$/.test(t)) this.sql.exec('DELETE FROM sessions WHERE t = ?', await sha(t));
    return { ok: true };
  }
  async canviaCorreu(t, correu) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    if (correu && !correuValid(correu)) return err(400, 'Aquest correu no sembla vàlid.');
    this.sql.exec('UPDATE compte SET correu = ?', correu ? await sha(`${this.c.sal}:${correu.toLowerCase()}`) : null);
    return { ok: true, correu: !!correu };
  }
  async esborraCompte(t, clau) {
    if (!(await this.sessió(t))) return err(401, 'La sessió ha caducat. Torna a entrar.');
    if (!/^[0-9a-f]{64}$/.test(clau) || !iguals(await pbkdf2(clau, this.c.sal), this.c.hash)) return err(403, 'La contrasenya no és correcta.');
    await this.ctx.storage.deleteAll();
    this.taules();
    return { ok: true };
  }
}
