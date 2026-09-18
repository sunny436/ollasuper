/**
 * Pre-hydration theme stamp.
 *
 * Runs before first paint and writes `.dark` + `data-theme` on <html> from the
 * localStorage cache, falling back to the OS. Without it a dark-mode user gets a
 * white flash on every navigation, because the server cannot know the choice.
 *
 * React hydrates from the SAME two sources (see theme-provider), so the class the
 * script writes and the class React would compute are identical — no mismatch,
 * no second paint.
 *
 * ACCENT RIDES THE SAME SCRIPT, deliberately. A second inline script would be a
 * second thing that can be forgotten, ordered wrongly, or shipped to only some
 * routes; accent and mode land in the SAME paint because they are written by the
 * same four lines.
 *
 * The accent list is duplicated here as literals rather than imported, because
 * this string is inlined before any module graph exists. accent.test.ts asserts
 * it matches ACCENTS, so the duplication cannot rot silently. The check is also
 * the validation: anything not in the list becomes 'blue', so a hostile stored
 * value can never reach the attribute.
 *
 * Kept deliberately tiny and dependency-free: it is inlined into the document and
 * blocks paint.
 */

const BODY = `(function(){try{
var m=null,a=null;
try{m=localStorage.getItem('theme');a=localStorage.getItem('accent');}catch(e){}
if(m!=='light'&&m!=='dark'){m=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}
if(['blue','green','yellow','pink','orange','purple','neutral'].indexOf(a)<0){a='blue';}
var r=document.documentElement;
if(m==='dark'){r.classList.add('dark');}else{r.classList.remove('dark');}
r.dataset.theme=m;
r.dataset.accent=a;
}catch(e){}})();`;

export function ThemeScript() {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constant string, no user or model input — the standard no-flash theme script, as next-themes injects.
    <script dangerouslySetInnerHTML={{ __html: BODY }} suppressHydrationWarning />
  );
}
