// screens/send_extras.js without contacts, the scanner or storage: the Send form's own fields only.
import { h } from '../../../../src/lib/dom.js';

export const recipientButtons = () => [];
export const contactLine = () => ({ el: h('div'), update() {} });
export const memoField = (draft) => ({ el: h('div'), value: () => draft.memo || '', setAllowed() {} });
export const scannedAmount = () => null;
