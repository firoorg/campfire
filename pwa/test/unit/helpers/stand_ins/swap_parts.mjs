// screens/eth_swap_parts.js for a test of the Uniswap screen: the words are plain, and each Allow or
// review sheet opened is recorded in globalThis.__swapSheets, answered when the test says (resolve).
import { h } from '../../../../src/lib/dom.js';

const s = () => '';
export const amtShown = (v) => String(v);
export const short = (v) => String(v);
export const ethAbout = (v) => `${v} wei`;
export const bipsText = s;
export const rateText = s;
export const routeText = s;
export const routeNote = s;
export const kv = () => h('div');
export const tokenBadge = () => h('span');
export const loadPools = async () => [];
export const poolsList = () => [];
export const pickSlippage = async () => null;
export const impactBlock = () => [];

function sheet(kind) {
  return new Promise((resolve) => (globalThis.__swapSheets ||= []).push({ kind, resolve }));
}
export const openAllowSheet = () => sheet('allow');
export const openReviewSheet = () => sheet('review');
