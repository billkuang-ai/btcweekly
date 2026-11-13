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

  // Archive: group issues (newest first) by the month of their issue date
  eleventyConfig.addFilter("groupByMonth", function(issues) {
    const groups = [];
    for (const it of issues || []) {
      const label = new Date(it.date).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(it); else groups.push({ label, items: [it] });
    }
    return groups;
  });

  // Unique story categories of an issue, in story order (either schema)
  eleventyConfig.addFilter("issueCategories", function(data) {
    const list = (data && (data.top_stories || data.stories)) || [];
    return [...new Set(list.map(s => s.category).filter(Boolean))];
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
