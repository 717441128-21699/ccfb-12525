/**
 * Tile-level stability gate + page state machine.
 *
 * Design:
 *  - The board image is divided into a tile grid. A tile only commits a
 *    change after `stableFrames` consecutive frames where (a) it changed
 *    relative to the committed board and (b) the person mask is absent.
 *  - Add vs erase is decided by comparing mean ink level before/after.
 *  - Heavy erasing closes the current page and starts a new one ("擦掉重写算新页").
 *  - Short interruptions (write, leave, come back to add more) keep the same
 *    page; the snapshot always reflects the merged final state
 *    ("写一半又回来补的合成最终状态").
 */
import type { PageRecord, TileFrameStats, TileRect, InkLayerName } from '../types.js';
import { formatClock } from './timefmt.js';

export interface TileState {
  /** 0 = idle (matches board), 1 = candidate change pending stability. */
  mode: 0 | 1;
  stableCount: number;
  /** Mean ink level last time the tile committed (0..1). */
  committedInk: number;
  /** Observed ink level while the candidate has been stable. */
  candidateInk: number;
  /** Accumulated writing time for the current page (seconds). */
  writingSec: number;
  /** Timestamp of previous processed frame for integration (seconds). */
  lastT: number;
  /** Ink level at previous processed frame for delta integration. */
  prevInk: number;
  /** Hysteresis flag: once blocked, stays set until person clearly leaves. */
  blockedHeld: boolean;
  /** Cooldown frames after a commit, suppresses re-committing stale change. */
  cooldown: number;
}

export interface TileCommit {
  index: number;
  col: number;
  row: number;
  rect: TileRect;
  kind: 'add' | 'erase';
  inkBefore: number;
  inkAfter: number;
}

export class TileGate {
  readonly cols: number;
  readonly rows: number;
  readonly rects: TileRect[];
  private tiles: TileState[];
  private stableFrames: number;
  private personBlock: number;

  constructor(
    cols: number,
    rows: number,
    boardWidth: number,
    boardHeight: number,
    stableFrames: number,
    personBlockFrac = 0.25,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.stableFrames = stableFrames;
    this.personBlock = personBlockFrac;
    this.rects = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.rects.push({
          col: c,
          row: r,
          x: Math.round((c / cols) * boardWidth),
          y: Math.round((r / rows) * boardHeight),
          w: Math.round(((c + 1) / cols) * boardWidth) - Math.round((c / cols) * boardWidth),
          h: Math.round(((r + 1) / rows) * boardHeight) - Math.round((r / rows) * boardHeight),
        });
      }
    }
    this.tiles = this.rects.map(() => ({
      mode: 0,
      stableCount: 0,
      committedInk: 0,
      candidateInk: 0,
      writingSec: 0,
      lastT: -1,
      prevInk: 0,
      blockedHeld: false,
      cooldown: 0,
    }));
  }

  get count(): number {
    return this.tiles.length;
  }

  tileRect(index: number): TileRect {
    return this.rects[index];
  }

  writingSeconds(index: number): number {
    return this.tiles[index].writingSec;
  }

  /** Whether a tile accumulated genuine writing time in the current page. */
  hasWriting(index: number, minSec = 0.05): boolean {
    return this.tiles[index].writingSec > minSec;
  }

  /**
   * Feed one frame of per-tile statistics.
   * @param tSec frame timestamp in seconds
   * @param minChangeFrac tile is considered "changed" above this fraction
   * @returns commits that fired this frame
   */
  process(stats: TileFrameStats, tSec: number, minChangeFrac = 0.04): TileCommit[] {
    const commits: TileCommit[] = [];
    // Hysteresis thresholds: enter "blocked" at personBlock, only release
    // when coverage drops well below it, so a teacher straddling a tile edge
    // cannot flip the gate on/off frame after frame.
    const releaseFrac = this.personBlock * 0.4;
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      const changed = stats.changeFrac[i] >= minChangeFrac;
      const person = stats.personFrac[i];
      if (tile.blockedHeld) {
        if (person < releaseFrac) tile.blockedHeld = false;
      } else if (person >= this.personBlock) {
        tile.blockedHeld = true;
      }
      const blocked = tile.blockedHeld;
      const ink = stats.inkNow[i];

      // Integrate writing time: ink level moving (either direction) means
      // active writing; exclude frames blocked by the person (unobservable).
      if (tile.lastT >= 0 && !blocked) {
        const dt = tSec - tile.lastT;
        if (dt > 0 && Math.abs(ink - tile.prevInk) > 0.004) {
          tile.writingSec += dt;
        }
      }
      tile.lastT = tSec;
      tile.prevInk = ink;

      if (blocked) {
        // Cannot verify anything while the teacher covers the tile.
        tile.stableCount = 0;
        tile.mode = 0;
        continue;
      }

      // Cooldown after a commit: the just-merged content still reads as
      // "changed" for a frame or two; don't re-commit the same pixels.
      if (tile.cooldown > 0) {
        tile.cooldown--;
        tile.stableCount = 0;
        tile.mode = 0;
        continue;
      }

      if (!changed) {
        // Current frame agrees with the committed board.
        tile.stableCount = 0;
        tile.mode = 0;
        continue;
      }

      // A visible, changed tile. Require consecutive stability: ink level
      // must stay roughly constant (content has stopped moving).
      if (tile.mode === 1 && Math.abs(ink - tile.candidateInk) > 0.06) {
        tile.candidateInk = ink;
        tile.stableCount = 1;
      } else if (tile.mode === 0) {
        tile.mode = 1;
        tile.candidateInk = ink;
        tile.stableCount = 1;
      } else {
        tile.stableCount++;
      }

      if (tile.mode === 1 && tile.stableCount >= this.stableFrames) {
        // Reject no-op commits: the tile "changed" flag fired (often a person
        // edge or codec shimmer) but its ink level is indistinguishable from
        // what is already committed.
        const inkDelta = tile.candidateInk - tile.committedInk;
        if (Math.abs(inkDelta) < 0.006 && tile.committedInk > 0) {
          tile.mode = 0;
          tile.stableCount = 0;
          tile.cooldown = this.stableFrames + 2;
          continue;
        }
        let kind: TileCommit['kind'];
        // Stroke pixels are sparse inside a tile, so the mean-ink level is
        // small even when writing is present. Use a low floor and compare the
        // candidate against the last committed level directionally.
        if (inkDelta >= 0) {
          kind = 'add';
        } else if (tile.committedInk > 0.002 && tile.candidateInk < tile.committedInk * 0.75) {
          // Ink dropped by a clear relative margin -> genuine erase.
          kind = 'erase';
        } else {
          kind = 'add';
        }
        commits.push({
          index: i,
          col: this.rects[i].col,
          row: this.rects[i].row,
          rect: this.rects[i],
          kind,
          inkBefore: tile.committedInk,
          inkAfter: tile.candidateInk,
        });
        tile.committedInk = tile.candidateInk;
        tile.mode = 0;
        tile.stableCount = 0;
        tile.cooldown = this.stableFrames + 2;
      }
    }
    return commits;
  }

  /** Reset per-page accumulators (tile ink levels are global and untouched). */
  resetPageTiming() {
    for (const t of this.tiles) {
      t.writingSec = 0;
      t.lastT = -1;
    }
  }

  longestTile(): { rect: TileRect; seconds: number } {
    let best = 0;
    for (let i = 1; i < this.tiles.length; i++) {
      if (this.tiles[i].writingSec > this.tiles[best].writingSec) best = i;
    }
    return { rect: this.rects[best], seconds: this.tiles[best].writingSec };
  }
}

export interface PageManagerOptions {
  eraseNewPageRatio: number;
}

export interface BoundaryDecision {
  /** A new page must start; the old page needs a pre-erase snapshot. */
  closeBeforeApply: boolean;
}

/**
 * Owns the list of pages. Two-phase per frame:
 *   1. evaluate() -> whether a boundary must be crossed (caller snapshots
 *      the board BEFORE applying erase commits in that case)
 *   2. commit()  -> registers events, closes/starts pages, attaches snapshot
 */
export class PageManager {
  private gate: TileGate;
  private opts: PageManagerOptions;
  private pages: PageRecord[] = [];
  private pageStartSec: number | null = null;
  private addEvents = 0;
  /** Tiles that received at least one add commit during the current page. */
  private addedTiles = new Set<number>();
  private eraseEvents = 0;

  constructor(gate: TileGate, opts: PageManagerOptions) {
    this.gate = gate;
    this.opts = opts;
  }

  get hasActivePage(): boolean {
    return this.pageStartSec !== null;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  getRecords(): PageRecord[] {
    return this.pages;
  }

  /**
   * Objective page-break detector using the person-independent erase signal.
   * Counts tiles where a large fraction of previously-committed ink has
   * vanished and the current frame is blank. Spatial concentration (several
   * tiles at once) is what distinguishes a board wipe from a single corrected
   * stroke.
   */
  detectErase(frameStats: TileFrameStats, minEraseFrac = 0.3): number {
    let n = 0;
    for (let i = 0; i < frameStats.eraseFrac.length; i++) {
      // Only tiles this page actually received written content can be erased;
      // this excludes phantom erase readings on never-written background tiles.
      if (frameStats.eraseFrac[i] >= minEraseFrac && this.addedTiles.has(i)) n++;
    }
    return n;
  }

  /**
   * Force a page break driven by the objective erase signal. The caller is
   * responsible for snapshotting the board BEFORE applying any erase merge.
   */
  forceBreak(tSec: number, snapshot: ImageBitmap | null): PageRecord | null {
    if (this.pageStartSec === null) return null;
    const rec = this.buildRecord(tSec, snapshot);
    this.pages.push(rec);
    this.startPage(tSec);
    this.gate.resetPageTiming();
    return rec;
  }

  private startPage(tSec: number) {
    this.pageStartSec = tSec;
    this.addEvents = 0;
    this.eraseEvents = 0;
    this.addedTiles.clear();
    // Note: tile writing accumulators are NOT reset here. On the first commit
    // of a fresh page the gate has already been integrating time for the
    // in-progress strokes; resetting would discard that work. Timing resets
    // only when a page explicitly closes (resetPageTiming after buildRecord).
  }

  private buildRecord(endSec: number, snapshot: ImageBitmap | null): PageRecord {
    const { rect, seconds } = this.gate.longestTile();
    const tileWritingMs = new Float32Array(this.gate.count);
    let total = 0;
    for (let i = 0; i < this.gate.count; i++) {
      const ms = Math.round(this.gate.writingSeconds(i) * 1000);
      tileWritingMs[i] = ms;
      total += ms;
    }
    const layers: Partial<Record<InkLayerName, ImageBitmap>> = {};
    return {
      pageIndex: this.pages.length,
      startMs: Math.round((this.pageStartSec ?? endSec) * 1000),
      endMs: Math.round(endSec * 1000),
      totalWritingMs: Math.round(total),
      longestTile: rect,
      longestWritingMs: Math.round(seconds * 1000),
      tileWritingMs,
      snapshot,
      layers,
      addEvents: this.addEvents,
      eraseEvents: this.eraseEvents,
    };
  }

  /**
   * Decide whether these commits cross a page boundary. A real "rewrite the
   * page" event erases a substantial fraction of the board's tiles within one
   * frame burst; isolated single-tile erasures (corrections) never split.
   */
  evaluate(commits: TileCommit[]): BoundaryDecision {
    if (!commits.length || this.pageStartSec === null) {
      return { closeBeforeApply: false };
    }
    const erases = commits.filter((c) => c.kind === 'erase').length;
    // Require a sizable simultaneous erase burst covering several tiles.
    const minEraseTiles = Math.max(4, Math.round(this.gate.count * 0.12));
    const cross =
      erases >= minEraseTiles &&
      erases / commits.length >= this.opts.eraseNewPageRatio;
    return { closeBeforeApply: cross };
  }

  /**
   * Register frame commits. When `closeBeforeApply` was signalled, the caller
   * passes the pre-erase board snapshot; it is attached to the closed page.
   */
  commit(
    commits: TileCommit[],
    tSec: number,
    closeBeforeApply: boolean,
    preEraseSnapshot: ImageBitmap | null,
  ): PageRecord | null {
    if (!this.pageStartSec && commits.length) this.startPage(tSec);
    if (this.pageStartSec === null) return null;

    let closed: PageRecord | null = null;
    if (closeBeforeApply) {
      closed = this.buildRecord(tSec, preEraseSnapshot);
      this.pages.push(closed);
      this.startPage(tSec);
      // Fresh timing for the new page; the closed record already captured
      // the old page's accumulated tile times above.
      this.gate.resetPageTiming();
    }

    for (const c of commits) {
      if (c.kind === 'add') {
        this.addEvents++;
        this.addedTiles.add(c.index);
      } else {
        this.eraseEvents++;
      }
    }
    return closed;
  }

  /** Force-close at end of video. Returns all pages. */
  finalize(endSec: number, finalSnapshot: ImageBitmap | null): PageRecord[] {
    if (this.pageStartSec !== null) {
      const rec = this.buildRecord(endSec, finalSnapshot);
      // A page that never received any content is meaningless.
      if (rec.addEvents + rec.eraseEvents > 0 || rec.totalWritingMs > 0) {
        this.pages.push(rec);
      }
      this.pageStartSec = null;
    }
    return this.pages;
  }
}

export function pageFooterText(page: PageRecord): string {
  const tile = page.longestTile;
  return (
    `第 ${page.pageIndex + 1} 页 | ` +
    `书写 ${formatClock(page.startMs)}–${formatClock(page.endMs)} ` +
    `(共 ${(page.totalWritingMs / 1000).toFixed(1)}s) | ` +
    `最久区域: 第${tile.row + 1}行第${tile.col + 1}列 ` +
    `(${(page.longestWritingMs / 1000).toFixed(1)}s)`
  );
}
