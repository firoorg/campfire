// lib/eth/permission.js for a screen test: the allowance is globalThis.__allowance (default: plenty).
export const walletPermissionFloor = () => 0;
export async function decidePermission(_rpc, { need = 0n } = {}) {
  const current = globalThis.__allowance ?? 10n ** 30n;
  return current >= need ? { kind: 'none', current } : { kind: 'approve', current };
}
