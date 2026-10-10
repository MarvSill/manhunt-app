/**
 * Liest aus dem Zod-Schema, welche Felder es gibt, mit Beschriftung, Typ und
 * Bereich. Daraus baut der Regel-Editor seine Eingabefelder.
 */
import { z } from 'zod';
import { gameConfigSchema, type ConfigSection } from './config';

export type FieldKind = 'number' | 'boolean' | 'enum' | 'text' | 'enumList' | 'numberList' | 'json';

export interface FieldMeta {
  section: ConfigSection;
  key: string;
  path: string;
  label: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  options?: string[];
}

export interface SectionMeta {
  section: ConfigSection;
  label: string;
  fields: FieldMeta[];
}

function unwrap(t: z.ZodTypeAny): z.ZodTypeAny {
  let cur = t;
  while (cur instanceof z.ZodDefault || cur instanceof z.ZodOptional) {
    cur = cur instanceof z.ZodDefault ? cur._def.innerType : cur._def.innerType;
  }
  return cur;
}

function fieldMeta(section: ConfigSection, key: string, t: z.ZodTypeAny): FieldMeta {
  const base = { section, key, path: `${section}.${key}`, label: t.description ?? key };
  const inner = unwrap(t);
  if (inner instanceof z.ZodNumber) {
    return { ...base, kind: 'number', min: inner.minValue ?? undefined, max: inner.maxValue ?? undefined };
  }
  if (inner instanceof z.ZodBoolean) return { ...base, kind: 'boolean' };
  if (inner instanceof z.ZodEnum) return { ...base, kind: 'enum', options: [...inner.options] };
  if (inner instanceof z.ZodString) return { ...base, kind: 'text' };
  if (inner instanceof z.ZodArray) {
    const el = unwrap(inner.element);
    if (el instanceof z.ZodEnum) return { ...base, kind: 'enumList', options: [...el.options] };
    if (el instanceof z.ZodNumber) {
      return { ...base, kind: 'numberList', min: el.minValue ?? undefined, max: el.maxValue ?? undefined };
    }
  }
  return { ...base, kind: 'json' };
}

export function configSections(): SectionMeta[] {
  return (Object.entries(gameConfigSchema.shape) as [ConfigSection, z.ZodTypeAny][]).map(([section, t]) => {
    const obj = unwrap(t) as z.ZodObject<z.ZodRawShape>;
    return {
      section,
      label: t.description ?? section,
      fields: Object.entries(obj.shape).map(([key, f]) => fieldMeta(section, key, f as z.ZodTypeAny)),
    };
  });
}

const WORDS: Record<string, string> = {
  zaehlt: 'zählt',
  waehlt: 'wählt',
  ueberlebenden: 'Überlebenden',
  ueberlebender: 'Überlebender',
  verzoegert: 'verzögert',
  fuss: 'Fuss',
  oev: 'ÖV',
  faehre: 'Fähre',
  naechste: 'nächste',
  qr: 'QR-Code',
  gm: 'Spielleitung',
  touch: 'Berühren',
  confirm: '+ bestätigen',
  nfc: 'NFC',
  handcuffs: 'Handschellen',
  bluetooth: 'Bluetooth',
  catch: 'Fang',
  disqualify: 'Disqualifikation',
  penalty: 'Strafe',
  random: 'Zufall',
  auto: 'automatisch',
  taskforce: 'Taskforce',
  regeneration: 'Regeneration',
  hunter: 'Hunter',
  erfragen: 'erfragen',
  free: 'Free',
  abfrage: 'Abfrage',
  ende: 'Ende',
  stunde: 'Stunde',
  tag: 'Tag',
  ausflug: 'Ausflug',
  dauer: 'Dauer',
  exit: 'Exit',
  helfer: 'Helfer',
  zuschauer: 'Zuschauer',
  spieler: 'Spieler',
  spielleitung: 'Spielleitung',
  person: 'Person',
  bus: 'Bus',
  bahn: 'Bahn',
  tram: 'Tram',
  taxi: 'Taxi',
  fahrrad: 'Fahrrad',
  scooter: 'Scooter',
  fahrzeug: 'Fahrzeug',
  punkte: 'Punkte',
};

/** Lesbarer Name eines Auswahlwerts, z. B. "silent_zaehlt_als_abfrage" -> "Silent zählt als Abfrage". */
export function optionLabel(value: string): string {
  const text = value
    .split('_')
    .map((w) => WORDS[w] ?? w)
    .join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
