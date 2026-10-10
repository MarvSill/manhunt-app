// Richtet Supabase vollautomatisch ein (läuft in GitHub Actions, siehe .github/workflows/deploy.yml):
// Projekt anlegen (falls nötig), Migrationen einspielen, Anmeldung einstellen, öffentliche Zugangsdaten ausgeben.
// Braucht nur SUPABASE_ACCESS_TOKEN (supabase.com > Account > Access Tokens).
import { randomBytes } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';

const API = process.env.SUPABASE_API || 'https://api.supabase.com';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const NAME = process.env.SUPABASE_PROJECT_NAME || 'hunt-mode';
const REGION = process.env.SUPABASE_REGION || 'eu-central-1'; // Frankfurt
const SITE_URL = process.env.SITE_URL; // z. B. https://marvsill.github.io/manhunt-app/
const DIR = 'supabase/migrations';

if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN fehlt (GitHub > Settings > Secrets and variables > Actions).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${path}: ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function findOrCreateProject() {
  const projects = await api('GET', '/v1/projects');
  // Projekt "hunt-mode", sonst das einzige vorhandene Projekt (z. B. im Dashboard von Hand angelegt).
  const found = projects.find((p) => p.name.toLowerCase() === NAME) ?? (projects.length === 1 ? projects[0] : undefined);
  if (found) {
    console.log(`Projekt "${NAME}" gefunden (${found.id}, ${found.status}).`);
    if (found.status === 'INACTIVE' || found.status === 'PAUSED') {
      console.log('Projekt ist pausiert, wecke es auf ...');
      await api('POST', `/v1/projects/${found.id}/restore`, {}).catch((e) => console.log(`Aufwecken: ${e.message}`));
    }
    return found.id;
  }
  const orgs = await api('GET', '/v1/organizations');
  // Neues Supabase-Konto ohne Team (Organisation): eines anlegen.
  const org = orgs[0] ?? (await api('POST', '/v1/organizations', { name: 'Hunt Mode' }));
  if (!orgs.length) console.log(`Team "${org.name}" angelegt.`);
  const dbPass = randomBytes(24).toString('base64url'); // wird nie gebraucht, alles läuft über das Token
  const base = { name: NAME, db_pass: dbPass, region: REGION };
  console.log(`Lege Projekt "${NAME}" im Team "${org.name}" an (${REGION}) ...`);
  let created;
  try {
    created = await api('POST', '/v1/projects', { ...base, organization_slug: org.slug ?? org.id });
  } catch (e) {
    if (!(e.status >= 400 && e.status < 500)) throw e;
    console.log(`Erster Versuch: ${e.message}`);
    try {
      created = await api('POST', '/v1/projects', { ...base, organization_id: org.id });
    } catch (e2) {
      if (e2.status === 401 || e2.status === 403) {
        throw new Error('Supabase erlaubt das Anlegen per Token nicht. Bitte im Dashboard ein Projekt "hunt-mode" (Region Frankfurt) anlegen und neu starten.');
      }
      throw e2;
    }
  }
  return created.id ?? created.ref;
}

async function waitReady(ref) {
  for (let i = 0; i < 90; i++) {
    const p = await api('GET', `/v1/projects/${ref}`).catch(() => null);
    if (p?.status === 'ACTIVE_HEALTHY') {
      try {
        await query(ref, 'select 1');
        return;
      } catch { /* Datenbank startet noch */ }
    }
    if (i % 6 === 0) console.log(`Warte auf Projekt ... (${p?.status ?? '?'})`);
    await sleep(10_000);
  }
  throw new Error('Projekt ist nach 15 Minuten noch nicht bereit.');
}

function query(ref, sql) {
  return api('POST', `/v1/projects/${ref}/database/query`, { query: sql });
}

async function migrate(ref) {
  await query(ref, `
    create table if not exists public.hm_migrations (name text primary key, applied_at timestamptz not null default now());
    alter table public.hm_migrations enable row level security;
    revoke all on public.hm_migrations from anon, authenticated;`);
  let done = new Set((await query(ref, 'select name from public.hm_migrations')).map((r) => r.name));
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  // Datenbank wurde schon von Hand (alles_in_einem.sql) eingerichtet: nicht nochmals einspielen.
  if (!done.size) {
    const [{ exists }] = await query(ref, "select to_regclass('public.games') is not null as exists");
    const [{ v7 }] = await query(ref, "select to_regprocedure('public.engine_tick_all()') is not null as v7");
    if (exists && v7) {
      console.log('Datenbank war schon eingerichtet, markiere alle Migrationen als erledigt.');
      for (const f of files) await query(ref, `insert into public.hm_migrations(name) values ('${f}') on conflict do nothing`);
      done = new Set(files);
    }
  }
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`Spiele ${f} ein ...`);
    await query(ref, readFileSync(`${DIR}/${f}`, 'utf8'));
    await query(ref, `insert into public.hm_migrations(name) values ('${f}') on conflict do nothing`);
  }
  console.log('Datenbank ist aktuell.');
}

async function configureAuth(ref) {
  const cfg = {
    password_min_length: 10,
    // Der kostenlose Supabase-Mailversand erreicht nur Team-Mitglieder: Konten ohne Bestätigungsmail.
    mailer_autoconfirm: true,
  };
  if (SITE_URL) {
    cfg.site_url = SITE_URL;
    cfg.uri_allow_list = `${SITE_URL}**`;
  }
  await api('PATCH', `/v1/projects/${ref}/config/auth`, cfg);
  console.log('Anmeldung eingestellt.');
}

async function publicKey(ref) {
  const keys = await api('GET', `/v1/projects/${ref}/api-keys`);
  const k = keys.find((x) => x.type === 'publishable' && x.api_key) ?? keys.find((x) => x.name === 'anon' && x.api_key);
  if (!k) throw new Error('Kein öffentlicher Schlüssel (publishable/anon) gefunden.');
  return k.api_key;
}

const ref = await findOrCreateProject();
await waitReady(ref);
await migrate(ref);
await configureAuth(ref);
const url = `https://${ref}.supabase.co`;
const key = await publicKey(ref);
console.log(`Supabase bereit: ${url}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\nkey=${key}\n`);
}
