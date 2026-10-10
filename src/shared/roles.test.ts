import { describe, expect, it } from 'vitest';
import { distributeRoles, lobbyIssues } from './roles';

function seeded(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const count = (r: Record<string, string>, role: string) => Object.values(r).filter((x) => x === role).length;

describe('Rollenverteilung', () => {
  it('NY-Verhältnis 9:7 mit 16 Personen', () => {
    const r = distributeRoles(ids(16), { players_max: 9, hunters_max: 7 }, seeded(1));
    expect(count(r, 'hunter')).toBe(7);
    expect(count(r, 'spieler')).toBe(9);
  });

  it('mindestens ein Hunter und ein Spieler ab zwei Personen', () => {
    const r = distributeRoles(ids(2), { players_max: 9, hunters_max: 1 }, seeded(2));
    expect(count(r, 'hunter')).toBe(1);
    expect(count(r, 'spieler')).toBe(1);
  });

  it('Überzählige werden Zuschauer', () => {
    const r = distributeRoles(ids(6), { players_max: 3, hunters_max: 1 }, seeded(3));
    expect(count(r, 'hunter')).toBe(1);
    expect(count(r, 'spieler')).toBe(3);
    expect(count(r, 'zuschauer')).toBe(2);
  });

  it('füllt Hunter auf, wenn die Spielerplätze voll sind', () => {
    const r = distributeRoles(ids(6), { players_max: 3, hunters_max: 3 }, seeded(4));
    expect(count(r, 'hunter')).toBe(3);
    expect(count(r, 'spieler')).toBe(3);
  });
});

describe('Lobby-Prüfungen', () => {
  it('meldet fehlende Rollen und zu viele Spieler', () => {
    const issues = lobbyIssues({ players: 5, hunters: 1, unassigned: 1 }, { players_max: 4, hunters_max: 2 }, 0);
    expect(issues.map((i) => i.code)).toEqual(['unassigned', 'too_many_players']);
  });
});
