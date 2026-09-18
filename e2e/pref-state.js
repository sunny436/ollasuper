// Capture and restore the QA account's theme + accent around a suite.
//
// These suites exercise the preference machinery on a REAL account, and the
// preference sync is last-write-wins by timestamp — so every run used to leave
// the account on whatever the final step happened to set. That is production
// data for a shared account being changed by tests, and a later suite starting
// from an unknown state.
//
// HOW CAPTURE WORKS. On a context with NO cached theme/accent, ThemeSync adopts
// the account's stored values into the DOM within a frame of the settings query
// landing. So: sign in on a clean context, wait, read `data-theme` and
// `data-accent`. That is what the account holds, as the user would see it.
//
// HOW RESTORE WORKS. Seed the cache with the captured values and a FRESH
// timestamp, reload: ThemeSync sees a newer local value and pushes it up. Then
// prove it landed the only way that is not circular — wipe the cache, reload,
// and watch the DOM adopt the account value again.
//
// ONE HONEST LIMIT. An account with NO stored preference resolves to the default
// (blue / OS), and restore writes that resolved value back EXPLICITLY. The user
// sees the same thing; the row goes from null to "blue". Writing null back
// would need a direct mutation call, which these suites deliberately do not
// have.

const SETTLE_MS = 3200;

async function readDom(page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme || null,
    accent: document.documentElement.dataset.accent || null,
  }));
}

/** Call right after sign-in on a context that has never seeded theme/accent. */
async function capturePrefs(page) {
  await page.waitForTimeout(SETTLE_MS);
  const prefs = await readDom(page);
  console.log(`      ↳ captured account prefs: theme=${prefs.theme} accent=${prefs.accent}`);
  return prefs;
}

/** Push the captured values back and PROVE they landed. Returns true on success. */
async function restorePrefs(page, prefs, base) {
  await page.evaluate(
    ([p, ts]) => {
      try {
        if (p.theme) {
          localStorage.setItem("theme", p.theme);
          localStorage.setItem("theme_ts", String(ts));
        }
        if (p.accent) {
          localStorage.setItem("accent", p.accent);
          localStorage.setItem("accent_ts", String(ts));
        }
      } catch {}
    },
    [prefs, Date.now()],
  );
  await page.goto(`${base}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS); // the upsert must land
  // The proof: with the cache gone, only the account can supply these.
  await page.evaluate(() => {
    try {
      for (const k of ["theme", "theme_ts", "accent", "accent_ts"]) localStorage.removeItem(k);
    } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  const after = await readDom(page);
  const ok = after.theme === prefs.theme && after.accent === prefs.accent;
  console.log(
    `      ↳ restored account prefs: theme=${after.theme} accent=${after.accent} ${ok ? "(verified)" : "(MISMATCH — wanted " + JSON.stringify(prefs) + ")"}`,
  );
  return ok;
}

module.exports = { capturePrefs, restorePrefs };
