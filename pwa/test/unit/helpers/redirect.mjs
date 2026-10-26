// Screens import the wallet, the password sheet and the like by relative path; a screen test serves
// stand-ins for them instead (helpers/stand_ins/), before the screen is imported:
//   redirect([{ parents: ['/src/screens/review.js'], spec: '../lib/auth_ui.js', to: standIn('auth_ui') }])
import { register } from 'node:module';

export const standIn = (name) => new URL(`./stand_ins/${name}.mjs`, import.meta.url).href;

export function redirect(rules) {
  register(new URL('./redirect_hooks.mjs', import.meta.url).href, { data: { rules } });
}
