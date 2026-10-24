// screens/review.js's words that other screens borrow, without Review itself (or the wallet it imports).
export const privacyLine = (from, kind) => (from === 'private' && kind === 'spark' ? 'Private.' : 'Public.');
