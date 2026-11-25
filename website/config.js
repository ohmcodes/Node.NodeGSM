// Site configuration.
window.NODEGSM_SITE = {
  // Where the plugin catalog (index.json + zips/ + icons/) is read from. A relative path (built by `npm run site`)
  // or an absolute URL of the published catalog, e.g. 'https://<org>.github.io/NodeGSM-Plugins'.
  CATALOG_URL: 'catalog',
  // Community backend (ratings, comments, editable info, download counts), see website/server/.
  //   'auto'  -> use ./api on the same origin if the NodeGSM site server answers there, else local-only mode
  //   '<url>' -> a backend on another origin, e.g. 'https://api.nodegsm.example/api'
  //   ''      -> force local-only mode (data stays in the visitor's browser)
  API_URL: 'auto',
  REPO: 'https://github.com/ohmcodes/Node.WGSM2026',
  DISCORD: '',   // invite link, shows up in the footer when set
  DOMAIN: '',    // e.g. https://nodegsm.example
};
