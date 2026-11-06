import { describe, it, expect } from 'vitest';
import { Mechanism, phaseAt, type PluckEvent } from '../../src/mechanism/mechanism';
import type { Song, ArrangedPin } from '../../src/songs/types';
import { SONGS } from '../../src/songs/library';
import { arrange } from '../../src/songs/arrange';
import { SLOWDOWN_SECONDS } from '../../src/mechanism/mechanism';

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
    expect(m.update(0.5).map((e) => e.pinIndex)).toEqual([0]); // downbeat
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
    expect(ev).toHaveLength(2);
    expect(ev[0]!.time).toBeCloseTo(0, 6);
    expect(ev[1]!.time).toBeCloseTo(4.0, 6);
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
  it('every real song stops ~SLOWDOWN_SECONDS after tension crossing its slowdown threshold', () => {
    for (const song of SONGS) {
      const m = new Mechanism(song, arrange(song));
      m.wind((m.slowdownTension / 0.1) * Math.PI * 2); m.setLid(true);
      let stopped = -1;
      for (let t = 0.05; t <= 40; t += 0.05) {
        m.update(t);
        if (m.state.omega === 0) { stopped = t; break; }
      }
      expect(stopped, song.id).toBeGreaterThan(SLOWDOWN_SECONDS - 2);
      expect(stopped, song.id).toBeLessThanOrEqual(SLOWDOWN_SECONDS + 2);
    }
  });
  it('downbeat fires after setSong + open lid, not burned by idle updates', () => {
    const m = make(); m.setLid(true);
    run(m, 0, 1, 0.1);
    m.setSong(song, pins);
    m.update(1.1); // lid closed: must not burn the fresh flag
    m.wind(FULL); m.setLid(true);
    const ev = m.update(1.2);
    expect(ev.map((e) => e.pinIndex)).toEqual([0]);
  });
  it('governor follows sqrt(tension / slowdownTension) below the threshold (R13)', () => {
    for (const [frac, k] of [[0.5, Math.SQRT1_2], [0.25, 0.5]] as const) {
      const m = new Mechanism(song, pins);
      m.wind(((frac * m.slowdownTension) / 0.1) * Math.PI * 2); m.setLid(true);
      m.update(0.001);
      expect(m.state.omega / 0.25).toBeCloseTo(k, 3);
    }
  });
  it('tension survives a stop and a later wind restarts rotation', () => {
    const m = new Mechanism(song, pins);
    m.wind(0.2 * FULL); m.setLid(true);
    let t = 0;
    while (t < 60) { t += 0.1; m.update(t); }
    expect(m.state.omega).toBe(0);
    expect(m.state.tension).toBeCloseTo(0, 3);
    m.wind(0.5 * FULL);
    const ph = m.state.phase;
    m.update(t + 0.1);
    expect(m.state.omega).toBeGreaterThan(0);
    expect(m.state.phase).toBeGreaterThan(ph);
  });
  it('small winds accumulate with lid open and restart rotation', () => {
    const m = new Mechanism(song, pins);
    m.setLid(true);
    let time = 0;
    for (let i = 0; i < 20; i++) {
      m.wind(0.05);
      time += 0.01;
      m.update(time);
    }
    const wound = (20 * 0.05 / (Math.PI * 2)) * 0.1;
    expect(m.state.tension).toBeGreaterThan(wound * 0.7) // sqrt governor spends ~19% of a tiny wind during the 0.2 s;
    expect(m.state.tension).toBeLessThanOrEqual(wound);
    expect(m.state.omega).toBeGreaterThan(0);
    expect(m.state.phase).toBeGreaterThan(0);
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
    expect(m.state.omega).toBe(0);
    expect(m.state.lidT).toBeGreaterThan(0); // eases closed rather than snapping
    expect(run(m, 1, 5, 0.1)).toEqual([]);
    expect(m.state.lidT).toBe(0);
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
