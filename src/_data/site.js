// Single source of truth for the canonical origin.
// Must match the `cname:` in .github/workflows/deploy.yml — GitHub Pages
// 301-redirects the apex to this host, so any absolute URL that omits the
// "www." resolves to a redirect and cannot be indexed at the declared address.
module.exports = {
  url: "https://www.btcweekly.org"
};
