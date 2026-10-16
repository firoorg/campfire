// node:module resolve hooks for screen tests (helpers/redirect.mjs registers them): an import of
// `spec` made by a module whose URL ends with one of `parents` is served from `to`, a stand-in;
// every other import resolves as usual.
let rules = [];

export async function initialize(data) {
  rules = (data && data.rules) || [];
}

export async function resolve(spec, ctx, next) {
  const parent = ctx.parentURL || '';
  for (const r of rules) if (r.spec === spec && r.parents.some((p) => parent.endsWith(p))) return { url: r.to, shortCircuit: true };
  return next(spec, ctx);
}
