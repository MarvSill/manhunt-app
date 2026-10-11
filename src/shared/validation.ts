/**
 * Konfigurations-Validierung (Spezifikation Kapitel 25).
 * Fehler blockieren den Start, Warnungen nicht. Manche Fehler werden
 * automatisch korrigiert (autoFixes) und dem Host als Hinweis gezeigt.
 */
import type { GameConfig } from './config';
import { fitTimes } from './timeRules';

export type IssueLevel = 'error' | 'warning' | 'autofix';

export interface ConfigIssue {
  level: IssueLevel;
  code: string;
  message: string;
  /** Betroffene Parameter, z. B. "ping.interval_minutes". */
  paths: string[];
}

/** Angaben, die nicht in der Konfiguration stehen (Teilnehmende, Karte). */
export interface ValidationContext {
  players?: number;
  hunters?: number;
  /** Mindestens eine teilnehmende Person ist unter 18. */
  hasMinors?: boolean;
  /** Anzahl gezeichneter Sektionen (Karte, ab Schritt 2). */
  sections?: number;
  /** Breite des Spielfelds in Metern (Karte, ab Schritt 2). */
  fieldWidthM?: number;
}

export interface ValidationResult {
  /** Konfiguration nach automatischen Korrekturen. */
  config: GameConfig;
  issues: ConfigIssue[];
  /** true, wenn kein Fehler den Start blockiert. */
  canStart: boolean;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Summe der jagdfreien Minuten pro 24 h (Fenster über Mitternacht erlaubt). */
export function quietMinutesPerDay(config: GameConfig): number {
  return config.game.quiet_hours.reduce((sum, q) => {
    const from = minutesOfDay(q.from);
    const to = minutesOfDay(q.to);
    return sum + (to >= from ? to - from : 1440 - from + to);
  }, 0);
}

export function validateConfig(input: GameConfig, ctx: ValidationContext = {}): ValidationResult {
  // Zeiten zuerst stimmig machen: nichts darf ausserhalb der Spieldauer liegen.
  const fit = fitTimes(input);
  const config = fit.config;
  const issues: ConfigIssue[] = [];
  const add = (level: IssueLevel, code: string, message: string, ...paths: string[]) =>
    issues.push({ level, code, message, paths });
  fit.fixes.forEach((f, n) => add('autofix', `time:${f.path}:${n}`, f.message, f.path));

  const duration = config.game.duration_minutes;
  const dayLength = config.game.day_length_minutes;

  if (ctx.players !== undefined && ctx.hunters !== undefined && (ctx.players < 1 || ctx.hunters < 1)) {
    add('error', 'min_participants', 'Es braucht mindestens einen Spieler und einen Hunter.');
  }

  if (config.ping.interval_minutes >= duration) {
    add('error', 'no_ping', 'Bei diesem Intervall gibt es keinen einzigen Ping.', 'ping.interval_minutes', 'game.duration_minutes');
  } else if (config.ping.interval_minutes > dayLength) {
    add('warning', 'few_pings', 'Weniger als ein Ping pro Spieltag.', 'ping.interval_minutes', 'game.day_length_minutes');
  }

  if (config.speedhunt.enabled && config.speedhunt.max_duration_minutes > dayLength) {
    add(
      'error',
      'speedhunt_longer_than_day',
      'Ein Speedhunt darf nicht länger dauern als ein Spieltag.',
      'speedhunt.max_duration_minutes',
      'game.day_length_minutes',
    );
  }

  const jokerTooLong = config.joker.enabled && config.joker.types.some((j) => (j.minutes ?? 0) >= duration);
  const hotelTooLong = config.bonus.enabled && config.bonus.hotel_minutes >= duration;
  if (jokerTooLong || hotelTooLong) {
    add('warning', 'joker_whole_game', 'Joker gilt das ganze Spiel.', 'joker.types', 'bonus.hotel_minutes');
  }

  if (config.hideout.enabled && config.hideout.max_minutes >= duration) {
    add('warning', 'hideout_unlimited', 'Verschanzen ist praktisch unbegrenzt.', 'hideout.max_minutes');
  }

  if (config.out_of_bounds.max_minutes >= duration) {
    add('warning', 'out_of_bounds_unlimited', 'Ausserhalb-Limit ist länger als das Spiel.', 'out_of_bounds.max_minutes');
  }

  if (config.exit.enabled && config.exit.reveal_minutes_before_end > duration) {
    add(
      'error',
      'exit_reveal_before_start',
      'Der Exitpoint würde vor Spielbeginn bekanntgegeben.',
      'exit.reveal_minutes_before_end',
    );
  }

  if (config.time.align_to_full_hour && dayLength < 120) {
    add('warning', 'align_short_days', 'Bei kurzen Spieltagen besser ab Spielstart zählen.', 'time.align_to_full_hour');
  }

  const hunters = ctx.hunters ?? config.roles.hunters_max;
  if (config.taskforce.hq_required && hunters <= 1) {
    config.taskforce.hq_required = false;
    add(
      'autofix',
      'hq_single_hunter',
      'Mit nur einem Hunter kann die Zentrale nicht dauernd besetzt sein. "Zentrale muss besetzt sein" wurde ausgeschaltet.',
      'taskforce.hq_required',
    );
  }

  if (config.speedhunt.enabled && config.speedhunt.trigger_mode === 'gm' && config.roles.gm_mode === 'auto') {
    add(
      'error',
      'gm_trigger_without_gm',
      'Ohne menschliche Spielleitung kann niemand Speedhunts auslösen.',
      'speedhunt.trigger_mode',
      'roles.gm_mode',
    );
  }

  if (config.speedhunt.enabled) {
    const players = Math.max(ctx.players ?? config.roles.players_max, 1);
    const quotas = [...config.speedhunt.quota_per_day, config.speedhunt.quota_default];
    if (Math.max(...quotas) > players) {
      add(
        'warning',
        'taskforce_advantage',
        'Die Taskforce ist stark im Vorteil (mehr als 1 Speedhunt pro Spieler und Spieltag).',
        'speedhunt.quota_per_day',
        'speedhunt.quota_default',
      );
    }
  }

  if (ctx.hasMinors && config.catch.method.includes('handcuffs')) {
    add('error', 'handcuffs_minors', 'Fangmethode Handschellen ist mit Teilnehmenden unter 18 nicht erlaubt.', 'catch.method');
  }

  if (config.budget.enabled && (!config.budget.currency || config.budget.daily_amount + config.budget.start_amount <= 0)) {
    add('error', 'budget_incomplete', 'Budget ist aktiv, aber Währung oder Betrag fehlen.', 'budget.currency', 'budget.daily_amount');
  }

  if (config.proximity.enabled && ctx.fieldWidthM !== undefined && config.proximity.distance_m > ctx.fieldWidthM / 2) {
    add('warning', 'proximity_always', 'Alarm wird fast dauernd ausgelöst.', 'proximity.distance_m');
  }

  const quietPerDay = quietMinutesPerDay(config);
  if (quietPerDay > 0 && (quietPerDay / 1440) * duration > duration * 0.5) {
    add('warning', 'quiet_hours_long', 'Ruhezeiten sind länger als die Hälfte der Spieldauer.', 'game.quiet_hours');
  }

  if (config.zone.sections_per_player && ctx.sections !== undefined && ctx.sections < (ctx.players ?? 1)) {
    add('error', 'sections_missing', 'Sektionen pro Spieler sind aktiv, aber es fehlen Sektionen auf der Karte.', 'zone.sections_per_player');
  }

  if (config.win.mode === 'letzter_ueberlebender' && config.exit.enabled) {
    add('warning', 'exit_ignored', 'Exitpoint wird ignoriert.', 'win.mode', 'exit.enabled');
  }

  return { config, issues, canStart: !issues.some((i) => i.level === 'error') };
}
