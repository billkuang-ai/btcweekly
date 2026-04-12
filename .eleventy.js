const pluginRss = require("@11ty/eleventy-plugin-rss");

module.exports = function(eleventyConfig) {
  // RSS/Atom feed support
  eleventyConfig.addPlugin(pluginRss);

  // Issues collection: all files in src/issues/, newest first
  eleventyConfig.addCollection("issues", function(collectionApi) {
    return collectionApi
      .getFilteredByGlob("src/issues/*.md")
      .sort((a, b) => b.date - a.date);
  });

  // Self-hosted fonts from @fontsource packages
  eleventyConfig.addPassthroughCopy({
    "node_modules/@fontsource/inter/files": "fonts/inter",
    "node_modules/@fontsource/black-han-sans/files": "fonts/black-han-sans"
  });

  // Static OG image
  eleventyConfig.addPassthroughCopy("src/og.png");

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes"
    }
  };
};
