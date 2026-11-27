'use strict';
// Footer links. A link with an empty URL is hidden from the footer (the Discord link is halted for now: set it here to bring it back).
// Only http(s) URLs are allowed (they are opened through the openExternal IPC, which enforces this too).
var NODEGSM_LINKS = Object.freeze({
  website: 'https://nodegsm.ohmcodes.com',
  discord: '',   // halted: no Discord community link yet (hidden while empty)
  patreon: 'https://www.patreon.com/cw/ohmcodes',
  paypal: 'https://www.paypal.com/donate/?business=8389QZ23QRDPE&no_recurring=0&item_name=Game+Server%2FTools+Community+Donations&currency_code=CAD',
  buymeacoffee: 'https://www.buymeacoffee.com/ohmcodes',
});
if (typeof module !== 'undefined' && module.exports) module.exports = NODEGSM_LINKS;
