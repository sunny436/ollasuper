import {
  AMBER_T,
  AMBIENCE_KEY,
  DARK_ON_LUM,
  DEFAULT_INTENSITY,
  ROOT_SURFACE,
  ROOT_TEXT,
  WS_SURFACE,
  WS_TEXT,
} from "./palette";

/**
 * Pre-hydration inline script — stamps the ambience vars + `.dark` + dataset on
 * <html> BEFORE first paint, so a reload shows the saved theme with no flash and
 * no hydration mismatch (<html> has suppressHydrationWarning).
 *
 * The RAMP DATA is embedded from palette.ts (one source of truth). The MATH is
 * hand-mirrored from interpolate.ts (a raw string can't import) — keep the two in
 * lock-step; the scratchpad parity check in verification proves byte-exact output.
 * Wrapped in try/catch so private-mode / absent localStorage never throws (the
 * zero-console-error e2e gate).
 */
const DATA = JSON.stringify({
  RS: ROOT_SURFACE,
  WS: WS_SURFACE,
  RT: ROOT_TEXT,
  WT: WS_TEXT,
  AT: AMBER_T,
  ON: DARK_ON_LUM,
  KEY: AMBIENCE_KEY,
  DEF: DEFAULT_INTENSITY,
});

const BODY = `(function(){try{
var D=${DATA},RS=D.RS,WS=D.WS,RT=D.RT,WT=D.WT,AT=D.AT;
function pt(t){var p=t.split(/\\s+/);return [parseFloat(p[0])||0,parseFloat((p[1]||'0').replace('%',''))||0,parseFloat((p[2]||'0').replace('%',''))||0];}
function h2r(h,s,l){s/=100;l/=100;var c=(1-Math.abs(2*l-1))*s,hp=(((h%360)+360)%360)/60,x=c*(1-Math.abs((hp%2)-1)),r=0,g=0,b=0;if(hp<1){r=c;g=x;}else if(hp<2){r=x;g=c;}else if(hp<3){g=c;b=x;}else if(hp<4){g=x;b=c;}else if(hp<5){r=x;b=c;}else{r=c;b=x;}var m=l-c/2;return [(r+m)*255,(g+m)*255,(b+m)*255];}
function r2t(a){var r=a[0]/255,g=a[1]/255,b=a[2]/255,mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn,l=(mx+mn)/2,h=0,s=0;if(d){s=d/(1-Math.abs(2*l-1));if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}function rd(n){return Math.round(n*10)/10;}return rd(h)+' '+rd(s*100)+'% '+rd(l*100)+'%';}
function rl(t){var c=h2r.apply(null,pt(t)).map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];}
function ct(a,b){var la=rl(a),lb=rl(b);return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05);}
function pos(n){if(n===4)return [0,0.5,0.75,1];if(n===2)return [0,1];var a=[];for(var k=0;k<n;k++)a.push(k/(n-1));return a;}
function lt(rp,t){if(t<=0)return rp[0];if(t>=1)return rp[rp.length-1];var p=pos(rp.length),i=0;while(i<p.length-2&&t>=p[i+1])i++;var lo=(t-p[i])/(p[i+1]-p[i]);if(lo<=0)return rp[i];var a=h2r.apply(null,pt(rp[i])),b=h2r.apply(null,pt(rp[i+1]));return r2t([a[0]+(b[0]-a[0])*lo,a[1]+(b[1]-a[1])*lo,a[2]+(b[2]-a[2])*lo]);}
function pk(sp,surf,t){var ol=lt(sp.onLight,Math.min(1,t/AT));return ct(ol,surf)>=ct(sp.onDark,surf)?ol:sp.onDark;}
function cv(t){var o={},k;for(k in RS)o['--amb-'+k]=lt(RS[k],t);for(k in WS)o['--amb-ws-'+k]=lt(WS[k],t);for(k in RT){var s=RT[k];o['--amb-'+k]=pk(s,o['--amb-'+s.surface],t);}for(k in WT){var s2=WT[k];o['--amb-ws-'+k]=pk(s2,o['--amb-ws-'+s2.surface],t);}return o;}
var i;try{i=localStorage.getItem(D.KEY);}catch(e){i=null;}
if(i==null){var th=null;try{th=localStorage.getItem('theme');}catch(e){}if(th==='dark')i=100;else if(th==='light')i=0;else i=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?85:D.DEF;}
i=Math.min(100,Math.max(0,Number(i)||0));
var t=i/100,el=document.documentElement,st=el.style,vars=cv(t),vk;
for(vk in vars)st.setProperty(vk,vars[vk]);
if(rl(lt(RS.background,t))<D.ON)el.classList.add('dark');else el.classList.remove('dark');
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
