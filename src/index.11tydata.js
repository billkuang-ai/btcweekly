// Pulls data from the latest issue into the homepage template,
// so base.njk can render with week, dateRange, title, and stories.
module.exports = {
  eleventyComputed: {
    title: data => data.collections?.issues?.[0]?.data?.title ?? "BTC Weekly",
    week: data => data.collections?.issues?.[0]?.data?.week ?? "",
    dateRange: data => data.collections?.issues?.[0]?.data?.dateRange ?? "",
    stories: data => data.collections?.issues?.[0]?.data?.stories ?? []
  }
};
