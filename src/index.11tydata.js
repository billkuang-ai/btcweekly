// Pulls data from the latest issue into the homepage template,
// so base.njk can render with week, dateRange, title, intro, and stories
// (or, for format-2 issues, headline, top_stories, brief and quiet).
module.exports = {
  eleventyComputed: {
    title: data => data.collections?.issues?.[0]?.data?.title ?? "BTC Weekly",
    week: data => data.collections?.issues?.[0]?.data?.week ?? "",
    year: data => data.collections?.issues?.[0]?.data?.year ?? "",
    dateRange: data => data.collections?.issues?.[0]?.data?.dateRange ?? "",
    intro: data => data.collections?.issues?.[0]?.data?.intro ?? "",
    stories: data => data.collections?.issues?.[0]?.data?.stories ?? [],
    // Format 2 fields (empty for older issues, so the template falls back to `stories`)
    format: data => data.collections?.issues?.[0]?.data?.format ?? 1,
    headline: data => data.collections?.issues?.[0]?.data?.headline ?? "",
    top_stories: data => data.collections?.issues?.[0]?.data?.top_stories ?? null,
    brief: data => data.collections?.issues?.[0]?.data?.brief ?? [],
    quiet: data => data.collections?.issues?.[0]?.data?.quiet ?? []
  }
};
