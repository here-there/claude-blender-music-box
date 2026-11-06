import { describe, it, expect } from 'vitest';
import { Mechanism, phaseAt, type PluckEvent } from '../../src/mechanism/mechanism';
import type { Song, ArrangedPin } from '../../src/songs/types';

const song: Song = {
  id: 't', title: 't', bpm: 60, beatsPerRevolution: 4,
  notes: [0, 1, 2, 3].map((beat) => ({ beat, midi: 60 + beat })),
};
const pins: ArrangedPin[] = [0, 1, 2, 3].map((beat) => ({ tooth: beat, beat, midi: 60 + beat }));
const FULL = Math.PI * 2 * 10;

function make(tension = 1) {
  const m = new Mechanism(song, pins);
  m.wind(tension * FULL);
  return m;
}
function run(m: Mechanism, from: number, to: number, dt: number): PluckEvent[] {
  const ev: PluckEvent[] = [];
  for (let t = from + dt; t <= to + 1e-9; t += dt) ev.push(...m.update(t));
  return ev;
}

describe('Mechanism', () => {
  it('constant speed', () => {
    const m = make(); m.setLid(true);
    run(m, 0, 2, 0.2);
    expect(m.state.omega).toBeCloseTo(0.25, 6);
    expect(m.state.phase).toBeCloseTo(0.5, 6);
  });
  it('no pluck when lid closed', () => {
    const m = make();
    expect(run(m, 0, 5, 0.2)).toEqual([]);
    expect(m.state.phase).toBe(0);
  });
  it('pluck timing', () => {
    const m = make(); m.setLid(true);
    expect(m.update(0.5)).toEqual([]);
    const ev = m.update(1.1);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.pinIndex).toBe(1);
    expect(ev[0]!.tooth).toBe(1);
    expect(Math.abs(ev[0]!.time - 1.0)).toBeLessThan(1e-6);
    expect(ev[0]!.velocity).toBeCloseTo(1, 6);
  });
  it('wraps revolutions', () => {
    const m = make(); m.setLid(true);
    const ev = run(m, 0, 4.5, 0.1).filter((e) => e.pinIndex === 0);
    // phase 0 is not in (p0, p1], so the first beat-0 event is the wrap at phase 1.0
    expect(ev).toHaveLength(1);
    expect(ev[0]!.time).toBeCloseTo(4.0, 6);
  });
  it('slows then stops', () => {
    const m = new Mechanism(song, pins);
    m.wind(0.2 * FULL); m.setLid(true);
    let prev = Infinity; let last = 0; let lateEvents = 0;
    for (let t = 0.1; t <= 60; t += 0.1) {
      const ev = m.update(t);
      expect(m.state.omega).toBeLessThanOrEqual(prev + 1e-12);
      expect(m.state.tension).toBeGreaterThanOrEqual(0);
      prev = m.state.omega;
      if (ev.length) last = t;
      if (t > 50) lateEvents += ev.length;
    }
    expect(m.state.omega).toBe(0);
    expect(lateEvents).toBe(0);
    expect(last).toBeLessThan(50);
  });
  it('clamps huge dt', () => {
    const m = make(); m.setLid(true);
    m.update(0.5);
    expect(m.update(30).length).toBeLessThanOrEqual(1);
    expect(m.state.time).toBe(30);
  });
  it('setSong resets and stays silent', () => {
    const m = make(); m.setLid(true);
    run(m, 0, 1, 0.1);
    m.setSong(song, pins);
    expect(m.state.lidOpen).toBe(false);
    expect(m.state.phase).toBe(0);
    expect(run(m, 1, 5, 0.1)).toEqual([]);
  });
  it('wind clamps and ignores reverse', () => {
    const m = new Mechanism(song, pins);
    m.wind(Math.PI * 2 * 20);
    expect(m.state.tension).toBe(1);
    const k = m.state.keyAngle;
    m.wind(-1);
    expect(m.state.tension).toBe(1);
    expect(m.state.keyAngle).toBe(k);
  });
  it('lid anim', () => {
    const m = make(); m.setLid(true);
    run(m, 0, 0.3, 0.1);
    expect(m.state.lidT).toBeCloseTo(0.5, 6);
    m.setLid(false);
    expect(m.update(0.4).length).toBe(0);
    expect(m.state.omega).toBe(0);
  });
  it('phaseAt extrapolates back', () => {
    const m = make(); m.setLid(true);
    run(m, 0, 1, 0.1);
    const s = m.state;
    expect(phaseAt(s, s.time - 0.05)).toBeCloseTo(s.phase - s.omega * 0.05, 9);
  });
});
