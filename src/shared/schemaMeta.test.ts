import { describe, expect, it } from 'vitest';
import { configSections, optionLabel } from './schemaMeta';

describe('Schema-Metadaten', () => {
  const sections = configSections();
  const all = sections.flatMap((s) => s.fields);

  it('jedes Feld hat eine deutsche Beschriftung', () => {
    for (const f of all) expect(f.label, f.path).not.toBe(f.key);
    for (const s of sections) expect(s.label, s.section).not.toBe(s.section);
  });

  it('erkennt Zahlen mit Bereich', () => {
    const f = all.find((x) => x.path === 'ping.interval_minutes');
    expect(f).toMatchObject({ kind: 'number', min: 1, max: 720 });
  });

  it('erkennt Auswahl, Mehrfachauswahl und Zahlenlisten', () => {
    expect(all.find((x) => x.path === 'roles.gm_mode')?.kind).toBe('enum');
    expect(all.find((x) => x.path === 'catch.method')?.kind).toBe('enumList');
    expect(all.find((x) => x.path === 'speedhunt.quota_per_day')?.kind).toBe('numberList');
    expect(all.find((x) => x.path === 'ping.zone_overrides')?.kind).toBe('json');
  });

  it('macht Auswahlwerte lesbar', () => {
    expect(optionLabel('silent_zaehlt_als_abfrage')).toBe('Silent zählt als Abfrage');
    expect(optionLabel('zu_fuss')).toBe('Zu Fuss');
  });
});
