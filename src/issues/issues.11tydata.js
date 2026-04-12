module.exports = {
  eleventyComputed: {
    // Older issue (lower week/year) — shown as ← on the left
    prevIssue: (data) => {
      const all = data.collections && data.collections.issues;
      if (!all || all.length < 2) return null;
      // collections.issues is sorted newest-first
      // "prev" (older) = higher index in the sorted array
      const idx = all.findIndex(
        (p) => p.data.week === data.week && p.data.year === data.year
      );
      if (idx === -1) return null;
      const older = all[idx + 1];
      return older ? { url: older.url, week: older.data.week, year: older.data.year } : null;
    },
    // Newer issue (higher week/year) — shown as → on the right
    nextIssue: (data) => {
      const all = data.collections && data.collections.issues;
      if (!all || all.length < 2) return null;
      const idx = all.findIndex(
        (p) => p.data.week === data.week && p.data.year === data.year
      );
      if (idx === -1) return null;
      const newer = all[idx - 1];
      return newer ? { url: newer.url, week: newer.data.week, year: newer.data.year } : null;
    }
  }
};
