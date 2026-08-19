import {
  AMBIENCE_KEY,
  DARK_ON_LUM,
  DEFAULT_INTENSITY,
  ROOT,
  WORKSPACE,
} from "./palette";

/**
 * Pre-hydration inline script — stamps the ambience vars + `.dark` + dataset on
 * <html> BEFORE first paint, so a reload shows the saved theme with no flash
 * and no hydration mismatch (<html> already has suppressHydrationWarning).
 *
 * The RAMP DATA is embedded from palette.ts (one source of truth). The MATH is
 * hand-mirrored from interpolate.ts (a raw string can't import) — keep the two
 * in lock-step; the scratchpad parity check in verification guards drift.
 * Wrapped in try/catch so private-mode / absent localStorage never throws (the
 * zero-console-error e2e gate). Not the artifact sandbox — inline scripts are
 * fine in the real Next app.
 */
const DATA = JSON.stringify({
  ROOT,
  WS: WORKSPACE,
  KEY: AMBIENCE_KEY,
  DEF: DEFAULT_INTENSITY,
  ON: DARK_ON_LUM,
});

const BODY = `(function(){try{
var D=${DATA},ROOT=D.ROOT,WS=D.WS;
function pt(t){var p=t.split(/\\s+/);return [parseFloat(p[0])||0,parseFloat((p[1]||'0').replace('%',''))||0,parseFloat((p[2]||'0').replace('%',''))||0];}
function h2r(h,s,l){s/=100;l/=100;var c=(1-Math.abs(2*l-1))*s,hp=(((h%360)+360)%360)/60,x=c*(1-Math.abs((hp%2)-1)),r=0,g=0,b=0;if(hp<1){r=c;g=x;}else if(hp<2){r=x;g=c;}else if(hp<3){g=c;b=x;}else if(hp<4){g=x;b=c;}else if(hp<5){r=x;b=c;}else{r=c;b=x;}var m=l-c/2;return [(r+m)*255,(g+m)*255,(b+m)*255];}
function r2t(a){var r=a[0]/255,g=a[1]/255,b=a[2]/255,mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn,l=(mx+mn)/2,h=0,s=0;if(d){s=d/(1-Math.abs(2*l-1));if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}function rd(n){return Math.round(n*10)/10;}return rd(h)+' '+rd(s*100)+'% '+rd(l*100)+'%';}
function lt(rp,t){if(t<=0)return rp[0];if(t>=1)return rp[2];var f,to,lo;if(t<0.5){f=rp[0];to=rp[1];lo=t/0.5;}else{f=rp[1];to=rp[2];lo=(t-0.5)/0.5;}var a=h2r.apply(null,pt(f)),b=h2r.apply(null,pt(to));return r2t([a[0]+(b[0]-a[0])*lo,a[1]+(b[1]-a[1])*lo,a[2]+(b[2]-a[2])*lo]);}
var i;try{i=localStorage.getItem(D.KEY);}catch(e){i=null;}
if(i==null){var th=null;try{th=localStorage.getItem('theme');}catch(e){}if(th==='dark')i=100;else if(th==='light')i=0;else i=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?85:D.DEF;}
i=Math.min(100,Math.max(0,Number(i)||0));
var t=i/100,el=document.documentElement,st=el.style;
for(var k in ROOT)st.setProperty('--amb-'+k,lt(ROOT[k],t));
for(var k2 in WS)st.setProperty('--amb-ws-'+k2,lt(WS[k2],t));
var bg=h2r.apply(null,pt(lt(ROOT.background,t))),lum=(0.2126*bg[0]+0.7152*bg[1]+0.0722*bg[2])/255;
if(lum<D.ON)el.classList.add('dark');else el.classList.remove('dark');
el.dataset.ambience=String(i);
try{localStorage.setItem(D.KEY,String(i));}catch(e){}
}catch(e){}})();`;

export function AmbienceScript() {
  if (process.env.NEXT_PUBLIC_AMBIENCE === "off") return null;
  return (
    <script
      suppressHydrationWarning
      // biome-ignore lint/security/noDangerouslySetInnerHtml: BODY is a build-time constant assembled from palette.ts + hand-written math, no user/model input — the standard pre-hydration no-flash theme script (as next-themes injects).
      dangerouslySetInnerHTML={{ __html: BODY }}
    />
  );
}
