/* Just before a permission is signed: does the wallet still have what it, and the swap it is for, need?
 *
 * A permission (an "Allow" before a swap) is its own transaction with its own network fee. Signed for a
 * swap that can no longer happen (the token spent from another device while the sheet stood open, or
 * the coin for the fees gone), that fee is paid for nothing. So what the wallet can spend is read again
 * from its server right before each permission step is signed, after the password (release audit of
 * the BEAM web wallet's bridge and Allow sheet, SF1, ported).
 */
import { nativeFor } from './tokens.js';
import { chainOf } from './chains.js';
import { formatUnits } from './units.js';
import { SendError } from './send.js';
import { t } from '../i18n.js';

/**
 * What this wallet can spend on `chainKey` now (wallet.spendable), read again from its server first.
 * Throws SendError('server') when that read failed: never the figures from before it.
 */
export async function freeNow(w, chainKey) {
  const k = chainOf(chainKey).key;
  const c = await w.refreshChain(k, { fresh: true });
  if (c && c.error) throw new SendError('server', t('Couldn\'t read your balance just before signing: {error}. Try again in a moment.', { error: c.error.message || t('the server did not answer') }));
  return w.spendable(k);
}

/**
 * Words saying why the step must not be signed (to follow "Nothing was sent."), or null when enough is
 * there. asset: what the swap or payment takes; amount: how much of it; fees: the network fees, at
 * most, of this step and every step after it (a swap's own fee is checked when it is built).
 * forWhat / feeName: the words for what it is for ("this swap", "the permission's network fee").
 */
export async function shortNow(w, chainKey, { asset, amount, fees, forWhat = t('this swap'), feeName = t("the permission's network fee") }) {
  const k = chainOf(chainKey).key;
  const coin = nativeFor(k);
  const dec = coin.decimals ?? 18;
  let free;
  try {
    free = await freeNow(w, k);
  } catch (e) {
    return e.message;
  }
  const isCoin = asset.symbol === coin.symbol;
  const have = isCoin ? free.eth : free[asset.symbol];
  if (have == null) return t('Couldn\'t read your {symbol} balance just before signing. Try again in a moment.', { symbol: asset.symbol });
  const takes = isCoin ? amount + fees : amount;
  if (have < takes) return t('Not enough {symbol} for {forWhat}: {amount} can be used now, and it needs {amount2}. If you sent some from another device, it shows here once confirmed.', { symbol: asset.symbol, forWhat, amount: formatUnits(have, asset.decimals), amount2: formatUnits(takes, asset.decimals) });
  if (isCoin) return null;
  const gas = free.eth;
  if (gas == null) return t('Couldn\'t read your {symbol} balance just before signing. Try again in a moment.', { symbol: coin.symbol });
  if (gas < fees) return t('Not enough {symbol} for {feeName} (up to {amount} {symbol}): {amount2} can be used now. Add {symbol}, then try again.', { symbol: coin.symbol, feeName, amount: formatUnits(fees, dec), amount2: formatUnits(gas, dec) });
  return null;
}
