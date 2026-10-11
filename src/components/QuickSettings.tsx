import type { ReactNode } from 'react';
import { CATCH_METHODS, JOKER_TYPES, type GameConfig } from '../shared/config';
import { SETTING_HELP } from '../shared/help';
import { optionLabel } from '../shared/schemaMeta';
import { timeLimits } from '../shared/timeRules';
import Info from './Info';

const JOKER_LABELS: Record<string, string> = {
  regeneration: 'Regeneration (keine Pings)',
  hunter_erfragen: 'Hunter-Standorte sehen (5 min)',
  catch_free: 'Catch-Free (nicht fangbar)',
};

/**
 * Die wichtigsten Regeln auf einen Blick, mit grossen Knöpfen statt Zahlenfeldern.
 * Alles Weitere steht im vollständigen Regel-Editor darunter.
 */
interface Props {
  config: GameConfig;
  onChange: (config: GameConfig) => void;
}

type Sections = Record<string, Record<string, unknown>>;

export default function QuickSettings({ config, onChange }: Props) {
  function set(section: keyof GameConfig, key: string, value: unknown) {
    const next = structuredClone(config) as unknown as Sections;
    next[section][key] = value;
    onChange(next as unknown as GameConfig);
  }

  const g = config.game;
  const multiDay = g.days > 1;
  const limits = timeLimits(config);
  /** Höchstwert: Schema-Grenze oder, falls kleiner, was die Spieldauer erlaubt. */
  const lim = (path: string, max: number) => Math.min(max, limits[path]?.max ?? max);
  const j = config.joker;
  function setJokerType(type: (typeof JOKER_TYPES)[number], on: boolean, minutes?: number) {
    const next = structuredClone(config);
    const list = next.joker.types.filter((t) => t.type !== type);
    if (on) list.push({ type, ...(type === 'hunter_erfragen' ? {} : { minutes: minutes ?? (type === 'regeneration' ? 60 : 30) }) });
    next.joker.types = JOKER_TYPES.flatMap((t) => list.filter((x) => x.type === t));
    if (on) next.joker.enabled = true;
    onChange(next);
  }

  function setDuration(min: number) {
    const next = structuredClone(config);
    next.game.duration_minutes = min;
    // Ein Spieltag: Tageslänge folgt der Spieldauer.
    if (next.game.days === 1) next.game.day_length_minutes = Math.min(1440, min);
    onChange(next);
  }

  function setDays(days: number) {
    const next = structuredClone(config);
    next.game.days = days;
    if (days === 1) {
      next.game.day_length_minutes = Math.min(1440, next.game.duration_minutes);
    } else if (next.game.duration_minutes < days * next.game.day_length_minutes) {
      next.game.day_length_minutes = Math.max(10, Math.floor(next.game.duration_minutes / days));
    }
    onChange(next);
  }

  return (
    <div className="stack">
      <Box title="Spieler und Hunter" info={SETTING_HELP.roles}>
        <Stepper label="Spieler" value={config.roles.players_max} min={1} max={100} onChange={(v) => set('roles', 'players_max', v)} />
        <Stepper label="Hunter" value={config.roles.hunters_max} min={1} max={50} onChange={(v) => set('roles', 'hunters_max', v)} />
        <Choice
          label="Wer bestimmt die Rollen?"
          value={config.roles.assignment}
          options={[['host', 'Ich als Host'], ['zufall', 'Zufall'], ['selbst', 'Jeder selbst']]}
          onChange={(v) => set('roles', 'assignment', v)}
        />
        <Choice
          label="Spielleitung"
          value={config.roles.gm_mode}
          options={[['auto', 'Automatisch'], ['mensch', 'Ein Mensch'], ['beides', 'Beides']]}
          onChange={(v) => set('roles', 'gm_mode', v)}
        />
        <Toggle label="Ich spiele selbst mit" value={g.host_can_play} onChange={(v) => set('game', 'host_can_play', v)} />
      </Box>

      <Box title="Zeiten" info={SETTING_HELP.times}>
        <Duration label="Spieldauer insgesamt" value={g.duration_minutes} min={15} max={20160} onChange={setDuration} />
        <Stepper label="Spieltage" value={g.days} min={1} max={lim('game.days', 14)} onChange={setDays} />
        {multiDay && (
          <Duration label="Länge eines Spieltags" value={g.day_length_minutes} min={10} max={lim('game.day_length_minutes', 1440)}
            onChange={(v) => set('game', 'day_length_minutes', v)} />
        )}
        <Duration label="Vorsprung der Spieler" value={config.start.head_start_minutes} min={0} max={600}
          onChange={(v) => set('start', 'head_start_minutes', v)} />
        <Toggle label="Hunter warten im HQ während des Vorsprungs" value={config.start.hunters_must_stay_in_hq}
          onChange={(v) => set('start', 'hunters_must_stay_in_hq', v)} />
        <QuietHours config={config} onChange={onChange} />
      </Box>

      <Box title="Pings (Standort der Spieler)" info={SETTING_HELP.pings}>
        <Duration label="Ping alle" value={config.ping.interval_minutes} min={1} max={lim('ping.interval_minutes', 720)}
          onChange={(v) => set('ping', 'interval_minutes', v)} />
        <Duration label="Im Kern-Gebiet alle" value={config.ping.zone_overrides.kern ?? config.ping.interval_minutes} min={1} max={Math.min(720, g.duration_minutes)}
          onChange={(v) => set('ping', 'zone_overrides', { ...config.ping.zone_overrides, kern: v })} />
        <Duration label="Erster Ping nach dem Vorsprung" value={config.ping.first_ping_delay_minutes} min={0} max={lim('ping.first_ping_delay_minutes', 600)}
          onChange={(v) => set('ping', 'first_ping_delay_minutes', v)} />
        <Stepper label="Ungenauigkeit (m)" value={config.ping.precision_blur_m} min={0} max={1000} step={25}
          onChange={(v) => set('ping', 'precision_blur_m', v)} />
        <Toggle label="Spieler merkt, wenn er gepingt wird" value={config.ping.notify_player} onChange={(v) => set('ping', 'notify_player', v)} />
        <Toggle label="Taskforce sieht, wann der nächste Ping kommt" value={config.ping.reveal_schedule_to_taskforce}
          onChange={(v) => set('ping', 'reveal_schedule_to_taskforce', v)} />
      </Box>

      <Box title="Speedhunt (Live-Jagd)" info={SETTING_HELP.speedhunt}>
        <Toggle label="Speedhunts erlaubt" value={config.speedhunt.enabled} onChange={(v) => set('speedhunt', 'enabled', v)} />
        {config.speedhunt.enabled && (
          <>
            <Stepper label="Speedhunts am ersten Tag" value={config.speedhunt.quota_per_day[0] ?? 0} min={0} max={20}
              onChange={(v) => set('speedhunt', 'quota_per_day', [v, ...config.speedhunt.quota_per_day.slice(1)])} />
            {multiDay && (
              <Stepper label="Speedhunts an Folgetagen" value={config.speedhunt.quota_default} min={0} max={20}
                onChange={(v) => set('speedhunt', 'quota_default', v)} />
            )}
            <Stepper label="Standort-Abfragen pro Speedhunt" value={config.speedhunt.queries} min={1} max={20}
              onChange={(v) => set('speedhunt', 'queries', v)} />
            <Duration label="Speedhunt dauert höchstens" value={config.speedhunt.max_duration_minutes} min={5} max={lim('speedhunt.max_duration_minutes', 480)}
              onChange={(v) => set('speedhunt', 'max_duration_minutes', v)} />
            <Choice
              label="Wer löst Speedhunts aus?"
              value={config.speedhunt.trigger_mode}
              options={[['taskforce', 'Taskforce'], ['random', 'Zufall'], ['gm', 'Spielleitung']]}
              onChange={(v) => set('speedhunt', 'trigger_mode', v)}
            />
          </>
        )}
      </Box>

      <Box title="Fangen und Gewinnen" info={SETTING_HELP.catch}>
        <div className="field">
          <span>Wie wird gefangen?</span>
          <div className="chips">
            {CATCH_METHODS.filter((m) => m === 'qr' || m === 'touch_confirm').map((m) => {
              const on = config.catch.method.includes(m);
              return (
                <button key={m} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on}
                  onClick={() => {
                    const list = on ? config.catch.method.filter((x) => x !== m) : [...config.catch.method, m];
                    if (list.length) set('catch', 'method', list);
                  }}>
                  {m === 'qr' ? 'QR-Code scannen' : 'Berühren + bestätigen'}
                </button>
              );
            })}
          </div>
        </div>
        <Toggle label="Exitpoint am Schluss (Spieler müssen hin)" value={config.exit.enabled} onChange={(v) => set('exit', 'enabled', v)} />
      </Box>

      <Box title="Joker für die Spieler" info={SETTING_HELP.joker}>
        <Toggle label="Joker im Spiel" value={j.enabled} onChange={(v) => set('joker', 'enabled', v)} />
        {j.enabled && (
          <>
            <div className="field">
              <span>Welche Joker gibt es?</span>
              {JOKER_TYPES.map((t) => {
                const cur = j.types.find((x) => x.type === t);
                return (
                  <div key={t} className="stack" style={{ gap: 4 }}>
                    <Toggle label={JOKER_LABELS[t]} value={!!cur} onChange={(v) => setJokerType(t, v, cur?.minutes)} />
                    {cur && t !== 'hunter_erfragen' && (
                      <Duration label="Wirkt so lange" value={cur.minutes ?? 60} min={5} max={Math.min(1440, g.duration_minutes)}
                        onChange={(v) => setJokerType(t, true, v)} />
                    )}
                  </div>
                );
              })}
            </div>
            <Stepper label="Joker pro Spieler und Spieltag" value={j.per_day} min={0} max={5} onChange={(v) => set('joker', 'per_day', v)} />
            <Stepper label="Höchstens gleichzeitig im Besitz" value={j.max_inventory} min={1} max={10} onChange={(v) => set('joker', 'max_inventory', v)} />
            <Duration label="Verfügbar ab (nach Jagdbeginn)" value={j.available_after_minutes} min={0} max={lim('joker.available_after_minutes', 20160)}
              onChange={(v) => set('joker', 'available_after_minutes', v)} />
            <Choice
              label="Welchen Joker bekommt man?"
              value={j.selection}
              options={[['zufall', 'Zufällig'], ['spieler_waehlt', 'Spieler wählt'], ['fest_pro_tag', 'Fest pro Tag']]}
              onChange={(v) => set('joker', 'selection', v)}
            />
            {multiDay && (
              <Choice
                label="Unbenutzte Joker"
                value={j.carry_over}
                options={[['nie', 'Verfallen am Tagesende'], ['einen_tag', 'Einen Tag behalten'], ['unbegrenzt', 'Behalten']]}
                onChange={(v) => set('joker', 'carry_over', v)}
              />
            )}
          </>
        )}
      </Box>

      <Box title="Extras" info={SETTING_HELP.extras}>
        <Toggle label="Budget für Spieler (Käufe verraten den Standort)" value={config.budget.enabled} onChange={(v) => set('budget', 'enabled', v)} />
        <Toggle label="Boni (z. B. Fake-Ping)" value={config.bonus.enabled} onChange={(v) => set('bonus', 'enabled', v)} />
        <Toggle label="Challenges" value={config.challenge.enabled} onChange={(v) => set('challenge', 'enabled', v)} />
        <Toggle label="Verschanzen-Regel (nicht zu lange am selben Ort)" value={config.hideout.enabled} onChange={(v) => set('hideout', 'enabled', v)} />
        <Toggle label="Alarm, wenn Spieler zusammen laufen" value={config.proximity.enabled} onChange={(v) => set('proximity', 'enabled', v)} />
        <Toggle label="Zuschauer erlaubt" value={config.spectator.enabled} onChange={(v) => set('spectator', 'enabled', v)} />
      </Box>
    </div>
  );
}

function Box({ title, info, children }: { title: string; info?: { title: string; text: string }; children: ReactNode }) {
  return (
    <div className="card stack" data-guide={`q-${title}`}>
      <h2 style={{ margin: 0 }}>{title} {info && <Info title={info.title} text={info.text} />}</h2>
      {children}
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function Stepper({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
}) {
  return (
    <div className="quick-row">
      <span className="spacer">{label}</span>
      <div className="stepper">
        <button type="button" aria-label={`${label} weniger`} disabled={value <= min} onClick={() => onChange(clamp(value - step, min, max))}>−</button>
        <input type="number" inputMode="numeric" aria-label={label} value={value} min={min} max={max}
          onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(clamp(Math.round(n), min, max)); }} />
        <button type="button" aria-label={`${label} mehr`} disabled={value >= max} onClick={() => onChange(clamp(value + step, min, max))}>+</button>
      </div>
    </div>
  );
}

/** Minuten als Stunden + Minuten eingeben. */
function Duration({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (v: number) => void;
}) {
  const h = Math.floor(value / 60);
  const m = value % 60;
  const put = (hh: number, mm: number) => onChange(clamp(hh * 60 + mm, min, max));
  return (
    <div className="quick-row">
      <span className="spacer">{label}</span>
      <div className="duration">
        <input type="number" inputMode="numeric" aria-label={`${label} Stunden`} min={0} value={h}
          onChange={(e) => put(Math.max(0, Math.round(Number(e.target.value) || 0)), m)} />
        <span>h</span>
        <input type="number" inputMode="numeric" aria-label={`${label} Minuten`} min={0} max={59} step={5} value={m}
          onChange={(e) => put(h, clamp(Math.round(Number(e.target.value) || 0), 0, 59))} />
        <span>min</span>
      </div>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Choice({ label, value, options, onChange }: {
  label: string; value: string; options: [string, string][]; onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="chips">
        {options.map(([v, text]) => (
          <button key={v} type="button" className={`chip${v === value ? ' on' : ''}`} aria-pressed={v === value} onClick={() => onChange(v)}>
            {text || optionLabel(v)}
          </button>
        ))}
      </div>
    </div>
  );
}

function QuietHours({ config, onChange }: Props) {
  const list = config.game.quiet_hours;
  function put(next: typeof list) {
    const c = structuredClone(config);
    c.game.quiet_hours = next;
    onChange(c);
  }
  return (
    <div className="field">
      <span>Jagdfreie Zeiten (z. B. nachts)</span>
      {list.map((q, i) => (
        <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
          <input type="time" aria-label="Von" style={{ width: 'auto', flex: 1 }} value={q.from} onChange={(e) => put(list.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
          <span>bis</span>
          <input type="time" aria-label="Bis" style={{ width: 'auto', flex: 1 }} value={q.to} onChange={(e) => put(list.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
          <button type="button" className="ghost small" aria-label="Zeit entfernen" onClick={() => put(list.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="small" onClick={() => put([...list, { from: '23:00', to: '07:00' }])}>+ Jagdfreie Zeit hinzufügen</button>
    </div>
  );
}
