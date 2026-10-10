// Fügt alle Migrationen zu einer Datei zusammen, die man im Supabase SQL Editor in einem Mal ausführt.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = 'supabase/migrations';
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const parts = files.map((f) => `-- ===== ${f} =====\n\n${readFileSync(`${dir}/${f}`, 'utf8').trim()}\n`);
writeFileSync('supabase/alles_in_einem.sql',
  `-- Hunt Mode: komplette Datenbank (erzeugt mit "npm run sql", nicht von Hand ändern).\n-- In einem leeren Supabase-Projekt im SQL Editor einfügen und ausführen.\n\n${parts.join('\n')}`);
console.log(`supabase/alles_in_einem.sql aus ${files.length} Dateien`);
