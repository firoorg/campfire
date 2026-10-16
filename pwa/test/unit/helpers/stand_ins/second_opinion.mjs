// lib/eth/second_opinion.js for a screen test: a second server that agreed (globalThis.__second, when set, instead).
export const secondOpinion = async () => globalThis.__second ?? { status: 'agree', host: { name: 'Second' } };
export const secondOpinionWords = () => ({ kind: 'ok', text: 'Price checked with a second server.' });
export const priceAckNeeded = (check) => !check || check.status !== 'agree';
