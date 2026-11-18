import { describe, expect, it } from 'vitest';
import type { TileFrameStats } from '../../src/types.js';
import { PageManager, TileGate, type TileCommit } from '../../src/core/paging.js';

const COLS = 4;
const ROWS = 3;
const BW = 400;
const BH = 300;

function stats(change: number[], person: number[], ink: number[], erase?: number[]): TileFrameStats {
  return {
    changeFrac: Float32Array.from(change),
    personFrac: Float32Array.from(person),
    inkNow: Float32Array.from(ink),
    eraseFrac: Float32Array.from(erase ?? new Array(change.length).fill(0)),
  };
}

function zeroStats(n: number): TileFrameStats {
  return stats(new Array(n).fill(0), new Array(n).fill(0), new Array(n).fill(0));
}

describe('TileGate', () => {
  it('commits an add only after stableFrames consecutive visible changes', () => {
    const gate = new TileGate(COLS, ROWS, BW, BH, 3);
    const n = COLS * ROWS;
    const z = zeroStats(n);
    gate.process(z, 0.0);
    // Tile 0 changes, no person.
    const s1 = zeroStats(n);
    s1.changeFrac[0] = 0.5;
    s1.inkNow[0] = 0.8;
    expect(gate.process(s1, 0.1)).toHaveLength(0);
    expect(gate.process(s1, 0.2)).toHaveLength(0);
    const commits = gate.process(s1, 0.3);
    expect(commits).toHaveLength(1);
    expect(commits[0].kind).toBe('add');
  });

  it('never commits while the person mask covers the tile, then commits after they leave', () => {
    const gate = new TileGate(COLS, ROWS, BW, BH, 2);
    const n = COLS * ROWS;
    const blocked = zeroStats(n);
    blocked.changeFrac[0] = 0.6;
    blocked.personFrac[0] = 0.9;
    blocked.inkNow[0] = 0.7;
    for (let f = 1; f <= 5; f++) expect(gate.process(blocked, f * 0.1)).toHaveLength(0);

    const visible = zeroStats(n);
    visible.changeFrac[0] = 0.6;
    visible.inkNow[0] = 0.7;
    expect(gate.process(visible, 0.6)).toHaveLength(0);
    const commits = gate.process(visible, 0.7);
    expect(commits).toHaveLength(1);
    expect(commits[0].kind).toBe('add');
  });

  it('classifies a drop in ink as an erase commit', () => {
    const gate = new TileGate(COLS, ROWS, BW, BH, 1);
    const n = COLS * ROWS;
    // Prime committed ink via an add.
    const add = zeroStats(n);
    add.changeFrac[1] = 0.5;
    add.inkNow[1] = 0.9;
    gate.process(add, 0.1);
    // Idle frames let the post-commit cooldown expire.
    for (let k = 2; k <= 6; k++) gate.process(zeroStats(n), k * 0.1);
    // Erase: changed again, ink dropped well below the committed level.
    const erase = zeroStats(n);
    erase.changeFrac[1] = 0.5;
    erase.inkNow[1] = 0.05;
    const commits = gate.process(erase, 0.7);
    expect(commits).toHaveLength(1);
    expect(commits[0].kind).toBe('erase');
  });

  it('accumulates writing time on tiles with moving ink levels', () => {
    const gate = new TileGate(COLS, ROWS, BW, BH, 100);
    const n = COLS * ROWS;
    const before = gate.writingSeconds(2);
    const s = zeroStats(n);
    s.inkNow[2] = 0.1;
    gate.process(s, 0.0);
    const s2 = zeroStats(n);
    s2.inkNow[2] = 0.4;
    s2.changeFrac[2] = 0.5;
    gate.process(s2, 0.5);
    expect(gate.writingSeconds(2) - before).toBeCloseTo(0.5, 4);
    const { rect, seconds } = gate.longestTile();
    expect(rect.col).toBe(2 % COLS);
    expect(seconds).toBeGreaterThan(0);
  });
});

describe('PageManager', () => {
  function setup(ratio = 0.25) {
    const gate = new TileGate(COLS, ROWS, BW, BH, 1);
    const pm = new PageManager(gate, { eraseNewPageRatio: ratio });
    return { gate, pm };
  }

  function fakeCommits(indices: number[], kind: 'add' | 'erase'): TileCommit[] {
    return indices.map((index) => ({
      index,
      col: index % COLS,
      row: (index / COLS) | 0,
      rect: gate_rect(index),
      kind,
      inkBefore: kind === 'add' ? 0 : 0.8,
      inkAfter: kind === 'add' ? 0.8 : 0,
    }));
  }
  function gate_rect(index: number) {
    return {
      col: index % COLS,
      row: (index / COLS) | 0,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    };
  }

  it('keeps add-then-return-to-add in a single page', () => {
    const { pm } = setup();
    const c1 = fakeCommits([0, 1], 'add');
    expect(pm.evaluate(c1).closeBeforeApply).toBe(false);
    pm.commit(c1, 1.0, false, null);
    // Idle gap, then more adds.
    const c2 = fakeCommits([2], 'add');
    expect(pm.evaluate(c2).closeBeforeApply).toBe(false);
    pm.commit(c2, 5.0, false, null);
    const pages = pm.finalize(8.0, {} as ImageBitmap);
    expect(pages).toHaveLength(1);
    expect(pages[0].addEvents).toBe(3);
  });

  it('opens a new page when heavy erase commits arrive (擦掉重写)', () => {
    const { pm } = setup();
    const adds = fakeCommits([0, 1, 2, 3], 'add');
    pm.commit(adds, 1.0, false, null);
    const erases = fakeCommits([0, 1, 2, 3], 'erase');
    const decision = pm.evaluate(erases);
    expect(decision.closeBeforeApply).toBe(true);
    const preSnap = { tag: 'pre-erase' } as unknown as ImageBitmap;
    const closed = pm.commit(erases, 4.0, true, preSnap);
    expect(closed).not.toBeNull();
    expect(closed!.snapshot).toBe(preSnap);
    const newAdds = fakeCommits([0, 1], 'add');
    pm.commit(newAdds, 6.0, false, null);
    const pages = pm.finalize(9.0, { tag: 'final' } as unknown as ImageBitmap);
    expect(pages).toHaveLength(2);
    expect(pages[0].endMs).toBe(4000);
    expect(pages[1].startMs).toBe(4000);
  });

  it('does not split on isolated tiny erasures', () => {
    const { pm } = setup(0.25);
    pm.commit(fakeCommits([0, 1, 2, 3, 4, 5], 'add'), 1.0, false, null);
    const tiny = fakeCommits([0], 'erase');
    expect(pm.evaluate(tiny).closeBeforeApply).toBe(false);
    pm.commit(tiny, 2.0, false, null);
    const pages = pm.finalize(3.0, {} as ImageBitmap);
    expect(pages).toHaveLength(1);
  });

  it('records timing and the longest-written tile in the footer data', () => {
    const { gate, pm } = setup();
    const s = zeroStats(COLS * ROWS);
    s.inkNow[5] = 0.2;
    gate.process(s, 0.0);
    const s2 = zeroStats(COLS * ROWS);
    s2.inkNow[5] = 0.6;
    s2.changeFrac[5] = 0.5;
    gate.process(s2, 2.0);
    pm.commit(fakeCommits([5], 'add'), 2.0, false, null);
    const pages = pm.finalize(3.0, {} as ImageBitmap);
    expect(pages[0].longestTile.col).toBe(5 % COLS);
    expect(pages[0].longestWritingMs).toBeGreaterThan(0);
    expect(pages[0].startMs).toBe(2000);
  });
});
