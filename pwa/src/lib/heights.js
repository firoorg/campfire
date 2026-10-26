// Block heights from dates and back, for the places that need a rough answer without asking a
// server: a new wallet's birthday (the block it was made at), "Restore from a date", and the date
// of a private payment the engine found while restoring (it knows only roughly which block).
//
// Firo makes a block about every 2.5 minutes since block 486,221 (16 June 2022, its stage 3), and
// made one about every 5 minutes before (public audit, P18: at 5 minutes throughout, a date before
// the anchor came out far too late, hundreds of thousands of blocks for 2024, so a restore from it
// could miss payments). Measured: 486,221 to 1,393,023, 16 June 2022 to 12 October 2026, is 150.4 s
// a block. The anchor is that measured point; the error grows by a block or two per day of drift,
// so every use leaves a margin on the safe side: a birthday a little EARLIER than the truth only
// reads a few more blocks, a later one could miss a payment.

export const BLOCK_SEC = 150;
/** Before stage 3: one block about every 5 minutes. */
export const BLOCK_SEC_BEFORE_STAGE3 = 300;
export const ANCHOR = Object.freeze({ height: 1393023, time: Date.UTC(2026, 9, 12) / 1000 });
/** Stage 3's first block (Firo Core consensus.stage3StartBlock / stage3StartTime): 2.5-minute blocks from here. */
export const STAGE3 = Object.freeze({ height: 486221, time: 1655380800 });
/** Spark's first block on mainnet: no Spark history before it. */
export const SPARK_START = 819300;

/** The block about `unixSec`. */
export function heightAt(unixSec, anchor = ANCHOR) {
  if (unixSec >= STAGE3.time) return Math.max(0, Math.round(anchor.height + (unixSec - anchor.time) / BLOCK_SEC));
  return Math.max(0, Math.round(STAGE3.height - (STAGE3.time - unixSec) / BLOCK_SEC_BEFORE_STAGE3));
}

/** About when block `height` was made, from a known block (the tip) or the anchor. */
export function timeOfHeight(height, ref = null) {
  const r = ref && Number.isFinite(ref.height) && Number.isFinite(ref.time) ? ref : ANCHOR;
  if (height >= STAGE3.height || r.height < STAGE3.height) return Math.round(r.time - (r.height - height) * BLOCK_SEC);
  // Before stage 3 from a block after it: 2.5 minutes back to stage 3, then 5.
  const atStage3 = r.time - (r.height - STAGE3.height) * BLOCK_SEC;
  return Math.round(atStage3 - (STAGE3.height - height) * BLOCK_SEC_BEFORE_STAGE3);
}

/** A day of blocks, as Firo makes them now. */
const DAY = Math.round(86400 / BLOCK_SEC);

/** A new wallet's birthday: the block about now, a day early (nothing can be missed). */
export function birthdayNow(nowSec = Date.now() / 1000) {
  return Math.max(0, heightAt(nowSec) - DAY);
}

/** "Restore from a date": the block about that day, two days early. */
export function heightForDate(dateText) {
  const t = Date.parse(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, heightAt(t / 1000) - 2 * DAY);
}
