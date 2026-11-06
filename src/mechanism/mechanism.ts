import type { Song, ArrangedPin } from '../songs/types';

export const WIND_PER_KEY_TURN = 0.1;
export const TENSION_PER_REV = 0.3;
export const SLOWDOWN_TENSION = 0.15;
export const LID_SECONDS = 0.6;
export const MAX_STEP = 0.1;
// smoothstep tail decays ~1/t; snap to 0 once omega is imperceptible (~0.0008 rev/s)
const TENSION_EPS = 0.005;

export interface PluckEvent { tooth: number; pinIndex: number; time: number; velocity: number }
export interface MechanismState {
  tension: number;
  phase: number;
  omega: number;
  lidOpen: boolean;
  lidT: number;
  keyAngle: number;
  time: number;
}

export class Mechanism {
  private s: MechanismState = {
    tension: 0, phase: 0, omega: 0, lidOpen: false, lidT: 0, keyAngle: 0, time: 0,
  };
  private song: Song;
  private pins: readonly ArrangedPin[];
  private pinPhases: number[] = [];
  private omega0 = 0;
  /** true until the first real advance after construction/setSong: pluck window is [p0,p1] */
  private fresh = true;

  constructor(song: Song, pins: readonly ArrangedPin[]) {
    this.song = song;
    this.pins = pins;
    this.configure();
  }

  get state(): Readonly<MechanismState> { return this.s; }

  private configure(): void {
    const bpr = this.song.beatsPerRevolution;
    this.omega0 = this.song.bpm / (60 * bpr);
    this.pinPhases = this.pins.map((p) => ((p.beat / bpr) % 1 + 1) % 1);
  }

  setSong(song: Song, pins: readonly ArrangedPin[]): void {
    this.song = song;
    this.pins = pins;
    this.configure();
    this.s.phase = 0;
    this.s.omega = 0;
    this.s.lidOpen = false;
    this.s.lidT = 0;
    this.fresh = true;
  }

  wind(keyDeltaRadians: number): void {
    if (!(keyDeltaRadians > 0)) return;
    this.s.keyAngle += keyDeltaRadians;
    this.s.tension = Math.min(
      1, this.s.tension + (keyDeltaRadians / (Math.PI * 2)) * WIND_PER_KEY_TURN,
    );
  }

  setLid(open: boolean): void {
    this.s.lidOpen = open;
  }

  update(time: number): PluckEvent[] {
    const s = this.s;
    if (!(time > s.time)) return [];
    if (time - s.time > 1) s.time = time - MAX_STEP;
    const events: PluckEvent[] = [];
    while (s.time < time) {
      const dt = Math.min(MAX_STEP, time - s.time);
      const t0 = s.time;
      s.lidT = Math.min(1, Math.max(0, s.lidT + (s.lidOpen ? dt : -dt) / LID_SECONDS));
      if (s.lidOpen && s.tension > 0) {
        const u = Math.min(1, s.tension / SLOWDOWN_TENSION);
        s.omega = this.omega0 * u * u * (3 - 2 * u);
        let dPhase = s.omega * dt;
        const cost = dPhase * TENSION_PER_REV;
        if (cost >= s.tension) dPhase = s.tension / TENSION_PER_REV;
        const p0 = s.phase;
        const p1 = p0 + dPhase;
        if (dPhase > 0) {
          const vel = Math.min(1, Math.max(0.3, s.omega / this.omega0));
          const step: PluckEvent[] = [];
          this.pinPhases.forEach((pp, i) => {
            for (let k = Math.floor(p0 - pp); k + pp <= p1; k++) {
              const target = k + pp;
              if (this.fresh ? target >= p0 : target > p0) {
                step.push({
                  tooth: this.pins[i]!.tooth, pinIndex: i,
                  time: t0 + ((target - p0) / dPhase) * dt, velocity: vel,
                });
              }
            }
          });
          step.sort((a, b) => a.time - b.time);
          events.push(...step);
          this.fresh = false;
        }
        s.phase = p1;
        s.tension = Math.max(0, s.tension - dPhase * TENSION_PER_REV);
        if (s.tension < TENSION_EPS) s.tension = 0;
      } else {
        s.omega = 0;
      }
      s.time = t0 + dt;
    }
    return events;
  }
}

export function phaseAt(state: MechanismState, time: number): number {
  return state.phase + state.omega * (time - state.time);
}
