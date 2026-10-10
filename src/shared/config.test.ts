import { describe, expect, it } from 'vitest';
import { defaultConfig, gameConfigSchema, mergeConfig, parseConfig } from './config';
import { PRESETS, configFromPreset } from './presets';
import { validateConfig } from './validation';

describe('Konfiguration', () => {
  it('Standardwerte entsprechen Original New York', () => {
    const c = defaultConfig();
    expect(c.game.duration_minutes).toBe(5760);
    expect(c.ping.interval_minutes).toBe(120);
    expect(c.ping.zone_overrides).toEqual({ kern: 60 });
    expect(c.speedhunt.quota_per_day).toEqual([3]);
    expect(c.speedhunt.queries).toBe(4);
    expect(c.budget.daily_amount).toBe(30);
    expect(c.transport.allowed_modes).not.toContain('eigenes_fahrzeug');
  });

  it('ergänzt fehlende Felder einer gespeicherten Konfiguration', () => {
    const c = parseConfig({ ping: { interval_minutes: 30 } });
    expect(c.ping.interval_minutes).toBe(30);
    expect(c.ping.max_age_seconds).toBe(60);
    expect(c.exit.enabled).toBe(true);
  });

  it('lehnt Werte ausserhalb des Bereichs ab', () => {
    expect(gameConfigSchema.safeParse({ ping: { interval_minutes: 0 } }).success).toBe(false);
    expect(gameConfigSchema.safeParse({ roles: { players_max: 101 } }).success).toBe(false);
  });

  it('mergeConfig ersetzt Listen statt sie zu mischen', () => {
    const c = mergeConfig(defaultConfig(), { ping: { zone_overrides: {} }, speedhunt: { quota_per_day: [1] } });
    expect(c.ping.zone_overrides).toEqual({});
    expect(c.speedhunt.quota_per_day).toEqual([1]);
    expect(c.ping.interval_minutes).toBe(120);
  });
});

describe('Presets', () => {
  it('bietet die sechs Pflicht-Presets an', () => {
    expect(PRESETS.map((p) => p.id)).toEqual([
      'original_new_york',
      'original_wien',
      'original_bangkok',
      'wochenende_24h',
      'stadtabend_3h',
      'schnell_90min',
    ]);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))('%s ist gültig und startbar', (_id, preset) => {
    const config = configFromPreset(preset.id);
    const result = validateConfig(config, preset.suggested);
    const blocking = result.issues.filter((i) => i.level === 'error');
    expect(blocking).toEqual([]);
    expect(result.config.roles.players_max).toBe(preset.suggested.players);
    expect(result.config.roles.hunters_max).toBe(preset.suggested.hunters);
  });

  it('Spieltage x Länge ergeben die Spieldauer', () => {
    for (const p of PRESETS) {
      const c = configFromPreset(p.id);
      expect(c.game.days * c.game.day_length_minutes).toBe(c.game.duration_minutes);
    }
  });

  it('Wien: 45-Minuten-Regel, LEO, Silent-Pings im Speedhunt ausgesetzt', () => {
    const c = configFromPreset('original_wien');
    expect(c.speedhunt.min_minutes_after_silent_ping).toBe(45);
    expect(c.leo.enabled).toBe(true);
    expect(c.ping.during_speedhunt).toBe('aussetzen');
    expect(c.speedhunt.queries).toBe(5);
    expect(c.zone.sections_per_player).toBe(true);
  });

  it('kurze Presets zählen ab Spielstart statt auf volle Stunden', () => {
    for (const id of ['wochenende_24h', 'stadtabend_3h', 'schnell_90min']) {
      expect(configFromPreset(id).time.align_to_full_hour).toBe(false);
    }
  });

  it('Schnell 90 min: 3 Spieltage à 30 min, Pings alle 10 min (Akzeptanztest 22)', () => {
    const c = configFromPreset('schnell_90min');
    expect(c.game.days).toBe(3);
    expect(c.game.day_length_minutes).toBe(30);
    expect(c.ping.interval_minutes).toBe(10);
  });
});

describe('Validierung (Kapitel 25)', () => {
  it('Akzeptanztest 40: Intervall 240 bei Spieldauer 180 blockiert', () => {
    const c = mergeConfig(defaultConfig(), { game: { duration_minutes: 180 }, ping: { interval_minutes: 240 } });
    const r = validateConfig(c);
    expect(r.canStart).toBe(false);
    expect(r.issues.find((i) => i.code === 'no_ping')?.message).toBe('Bei diesem Intervall gibt es keinen einzigen Ping.');
  });

  it('braucht mindestens einen Spieler und einen Hunter', () => {
    expect(validateConfig(defaultConfig(), { players: 3, hunters: 0 }).canStart).toBe(false);
    expect(validateConfig(defaultConfig(), { players: 3, hunters: 2 }).canStart).toBe(true);
  });

  it('Speedhunt länger als Spieltag ist ein Fehler', () => {
    const c = mergeConfig(defaultConfig(), { game: { day_length_minutes: 60 }, speedhunt: { max_duration_minutes: 90 } });
    expect(validateConfig(c).issues.some((i) => i.code === 'speedhunt_longer_than_day' && i.level === 'error')).toBe(true);
  });

  it('Speedhunt durch Spielleitung ohne menschliche Spielleitung ist ein Fehler', () => {
    const c = mergeConfig(defaultConfig(), { speedhunt: { trigger_mode: 'gm' }, roles: { gm_mode: 'auto' } });
    expect(validateConfig(c).canStart).toBe(false);
  });

  it('schaltet "Zentrale besetzt" bei nur einem Hunter automatisch aus', () => {
    const r = validateConfig(defaultConfig(), { players: 3, hunters: 1 });
    expect(r.config.taskforce.hq_required).toBe(false);
    expect(r.issues.some((i) => i.level === 'autofix')).toBe(true);
    expect(r.canStart).toBe(true);
  });

  it('Handschellen mit Minderjährigen sind verboten', () => {
    const c = mergeConfig(defaultConfig(), { catch: { method: ['qr', 'handcuffs'] } });
    expect(validateConfig(c, { hasMinors: true }).canStart).toBe(false);
    expect(validateConfig(c, { hasMinors: false }).canStart).toBe(true);
  });

  it('Exit-Bekanntgabe vor Spielbeginn ist ein Fehler', () => {
    const c = mergeConfig(defaultConfig(), { game: { duration_minutes: 60 }, ping: { interval_minutes: 10 }, exit: { reveal_minutes_before_end: 120 } });
    expect(validateConfig(c).issues.some((i) => i.code === 'exit_reveal_before_start')).toBe(true);
  });

  it('warnt bei kurzen Spieltagen mit Ausrichtung auf volle Stunden', () => {
    const c = mergeConfig(defaultConfig(), { game: { day_length_minutes: 60 }, speedhunt: { max_duration_minutes: 30 } });
    const issue = validateConfig(c).issues.find((i) => i.code === 'align_short_days');
    expect(issue?.level).toBe('warning');
  });

  it('warnt bei Ruhezeiten über der Hälfte der Spieldauer', () => {
    const c = mergeConfig(defaultConfig(), { game: { quiet_hours: [{ from: '20:00', to: '09:00' }] } });
    expect(validateConfig(c).issues.some((i) => i.code === 'quiet_hours_long')).toBe(true);
  });

  it('warnt: letzter Überlebender ignoriert den Exitpoint', () => {
    const c = mergeConfig(defaultConfig(), { win: { mode: 'letzter_ueberlebender' } });
    expect(validateConfig(c).issues.some((i) => i.code === 'exit_ignored')).toBe(true);
  });
});
