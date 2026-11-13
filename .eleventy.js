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

  // Week ribbon: "November 8–14, 2026" -> { dates: "Nov 8–14", year: "2026" }
  // (cross-month: "September 27–October 3, 2026" -> "Sep 27–Oct 3")
  eleventyConfig.addFilter("weekRibbon", function(dateRange) {
    const m = String(dateRange || "").match(/^(.*),\s*(\d{4})$/);
    if (!m) return { dates: dateRange || "", year: "" };
    const dates = m[1].replace(/([A-Za-z]+)/g, w => w.slice(0, 3));
    return { dates, year: m[2] };
  });

  // Older/newer neighbours of an issue in collections.issues (sorted newest first)
  eleventyConfig.addFilter("issueNeighbors", function(issues, week, year) {
    const all = issues || [];
    const i = all.findIndex(p => p.data.week == week && p.data.year == year);
    if (i === -1) return { prev: null, next: null };
    return { prev: all[i + 1] || null, next: all[i - 1] || null };
  });

  // Self-hosted fonts from @fontsource packages
  eleventyConfig.addPassthroughCopy({
    "node_modules/@fontsource/inter/files": "fonts/inter",
    "node_modules/@fontsource/black-han-sans/files": "fonts/black-han-sans"
  });

  // Static images and root-level assets
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy({ "src/og.png": "og.png" });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes"
    }
  };
};
