"""Shared texts for the humanize-stage tests: one machine-shaped draft full of the
habits the detector names, and a faithful human rewrite that keeps every fact."""

DRAFT = (
    "# Introducing Pulse Analytics — Your New Dashboard\n\n"
    "In today's fast-paced digital landscape, data is not just information — it "
    "is a testament to what your team can achieve. That's why we're thrilled to "
    "unveil Pulse Analytics — a robust, seamless, and comprehensive dashboard "
    "that unlocks the full potential of your metrics.\n\n"
    "Pulse Analytics refreshes every 5 minutes, tracks 42 metrics out of the box, "
    "and cut reporting time by 38% for our beta teams — a game-changer for busy "
    "leaders. Additionally, it integrates seamlessly with your existing stack — "
    "no extra setup required. It's not just a dashboard — it's a whole new way "
    "to work.\n\n"
    "Starting March 3, 2026, every Pro plan includes Pulse Analytics at no extra "
    "cost. Explore it today at https://example.com/pulse and see how it transforms "
    "the way you work — because your data deserves better, your team deserves "
    "clarity, and your leaders deserve answers.\n\n"
    "Let that sink in.\n"
)

REWRITE = (
    "# Introducing Pulse Analytics: Your New Dashboard\n\n"
    "Your team already collects plenty of data. The hard part is seeing what it "
    "says while there is still time to act, so we built Pulse Analytics, a "
    "dashboard that puts the numbers you care about in one place.\n\n"
    "Pulse Analytics refreshes every 5 minutes and tracks 42 metrics out of the "
    "box. Our beta teams cut their reporting time by 38%, which gave busy leaders "
    "hours back each week. It works with the tools you already use, and there is "
    "nothing extra to set up.\n\n"
    "Starting March 3, 2026, every Pro plan includes Pulse Analytics at no extra "
    "cost. You can try it today at https://example.com/pulse and see whether it "
    "changes how your team works.\n"
)

#: Plain, human-sounding copy with no machine habits, long enough to judge.
CLEAN = (
    "# What we learned running analytics for thirty teams\n\n"
    "Most dashboards go stale within a month. We watched it happen at thirty "
    "companies last year, and the pattern was always the same: someone builds a "
    "board, three people look at it for a week, then it rots.\n\n"
    "The teams that kept theirs alive did one boring thing. They picked a single "
    "number that someone's job depended on and put it at the top. Everything else "
    "went below the fold or got deleted.\n\n"
    "That is why Pulse Analytics opens on one number you choose. It refreshes "
    "every 5 minutes, and you can add more charts later if the first one earns "
    "its place. Pro plans include it from March 3, 2026, and you can read how "
    "the setup works at https://example.com/pulse before you switch it on.\n"
)

BLOG_TAIL = (
    "\n## OllaSuper Blog Quality Score: 91/100\n\n"
    "| Category | Score |\n|---|---|\n| Content quality | 27/30 |\n| SEO | 23/25 |\n\n"
    "## Sources & evidence\n\n"
    "1. Beta cohort report, 2026 — https://example.com/beta-report\n"
)
