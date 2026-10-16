/* What the browser says about the connection. Only Chrome on Android reports the connection type;
 * iPhone and desktop browsers say nothing, and then nothing is assumed. */

/** True only when the browser reports mobile data, or that the person asked to save data. */
export function onMobileData(nav = globalThis.navigator) {
  const c = nav && nav.connection;
  return Boolean(c && (c.type === 'cellular' || c.saveData === true));
}
