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
 * Kept deliberately tiny and dependency-free: it is inlined into the document and
 * blocks paint.
 */

const BODY = `(function(){try{
var m=null;try{m=localStorage.getItem('theme');}catch(e){}
if(m!=='light'&&m!=='dark'){m=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}
var r=document.documentElement;
if(m==='dark'){r.classList.add('dark');}else{r.classList.remove('dark');}
r.dataset.theme=m;
}catch(e){}})();`;

export function ThemeScript() {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constant string, no user or model input — the standard no-flash theme script, as next-themes injects.
    <script dangerouslySetInnerHTML={{ __html: BODY }} suppressHydrationWarning />
  );
}
