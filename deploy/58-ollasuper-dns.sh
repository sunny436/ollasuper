#!/usr/bin/env bash
# THE POINT OF NO RETURN. Publishes the three hostnames by pointing them at the VM's tunnel.
#
#   usage: CLOUDFLARE_API_TOKEN=cfat_... bash deploy/58-ollasuper-dns.sh [--apply]
#
# Runs as a DRY RUN by default and prints the exact diff it would make. Pass --apply
# to write. The token is read from the environment only — never a literal in this file,
# never logged (it lives in cf_tunnel_info.txt, which .gitignore now covers).
#
# WHAT THIS BREAKS, DELIBERATELY: app.ollasuper.com currently serves a DIFFERENT product
# through tunnel 8ad8b94d-14dd-4504-a2af-d4daf0f1d4f0. Repointing it takes that product
# offline. The original record is dumped to /opt/myos/.dns-rollback.json first and the
# one-line undo is printed on exit.
#
# WHAT THIS MUST NOT TOUCH: the apex and www (the live marketing site on Cloudflare
# Pages), tokens.ollasuper.com, and every mail record — MX x3, SPF, the Resend DKIM key,
# DMARC, and send.ollasuper.com. Mail is the easiest thing to break here and the hardest
# to notice, so the script operates on a strict ALLOWLIST of three names and diffs the
# full record set before and after to prove nothing else moved.
set -uo pipefail

ZONE=4c546d156558d24fdb71dfac79ca4af2   # ollasuper.com
API=https://api.cloudflare.com/client/v4
APP_HOST=app.ollasuper.com
CVX_HOST=convex.ollasuper.com
SITE_HOST=convex-site.ollasuper.com
ROLLBACK=/opt/myos/.dns-rollback.json
NODE=/usr/bin/node
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

die() { printf '\nFATAL: %s\n' "$1" >&2; exit 1; }
say() { printf '\n=== %s ===\n' "$1"; }
cf()  { curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" "$@"; }

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set.
  CLOUDFLARE_API_TOKEN=\$(grep -oE 'cfat_[A-Za-z0-9]+' cf_tunnel_info.txt) bash \$0 --apply"

# ------------------------------------------------------------------ tunnel id
say "resolve the VM's tunnel id"
TUNNEL_ID="${TUNNEL_ID:-}"
if [ -z "$TUNNEL_ID" ]; then
  for f in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml \
           /root/.cloudflared/config.yml /root/.cloudflared/config.yaml; do
    [ -f "$f" ] || continue
    TUNNEL_ID=$(grep -iE '^[[:space:]]*tunnel:' "$f" | head -1 | sed -E 's/.*:[[:space:]]*//' | tr -d '"'"'"' \r')
    [ -n "$TUNNEL_ID" ] && { echo "from $f"; break; }
  done
fi
if [ -z "$TUNNEL_ID" ]; then
  TUNNEL_ID=$(ls /root/.cloudflared/*.json "$HOME"/.cloudflared/*.json 2>/dev/null \
              | head -1 | xargs -r basename 2>/dev/null | sed 's/\.json$//')
  [ -n "$TUNNEL_ID" ] && echo "from credentials filename"
fi
[ -n "$TUNNEL_ID" ] || die "could not determine the tunnel id. Run 56-discover-tunnel.sh, then re-run with TUNNEL_ID=<uuid>."
echo "$TUNNEL_ID" | grep -qE '^[0-9a-f-]{36}$' || die "tunnel id '$TUNNEL_ID' is not a UUID"
TARGET="$TUNNEL_ID.cfargotunnel.com"
echo "tunnel : $TUNNEL_ID"
echo "target : $TARGET"
[ "$TUNNEL_ID" = "8ad8b94d-14dd-4504-a2af-d4daf0f1d4f0" ] && \
  echo "NOTE: this VM's tunnel IS the one already behind app.ollasuper.com — that record needs no change."

# ------------------------------------------------------------------ snapshot
say "snapshot every record in the zone (pre-change)"
cf "$API/zones/$ZONE/dns_records?per_page=200" > /tmp/dns-before.json
"$NODE" -e '
const j=JSON.parse(require("fs").readFileSync("/tmp/dns-before.json","utf8"));
if(!j.success) { console.error("API error:", JSON.stringify(j.errors)); process.exit(1); }
console.log("records:", j.result.length);
for(const r of j.result.sort((a,b)=>a.name.localeCompare(b.name)))
  console.log(" ", r.type.padEnd(5), r.name.padEnd(30), (r.content||"").slice(0,48), r.proxied?"PROXIED":"");
' || die "could not read the zone — is the token valid and scoped to ollasuper.com?"

# The record this script will overwrite, kept verbatim for rollback.
"$NODE" -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync("/tmp/dns-before.json","utf8"));
const rec=j.result.find(r=>r.name===process.argv[1]);
if(!rec){ console.log("no existing "+process.argv[1]+" record — nothing to roll back"); process.exit(0); }
fs.writeFileSync(process.argv[2], JSON.stringify(rec,null,2));
console.log("rollback saved:", process.argv[2], "->", rec.type, rec.content, rec.proxied?"PROXIED":"");
' "$APP_HOST" "$ROLLBACK"

# ------------------------------------------------------------------ plan
say "plan (ALLOWLIST — every other name is untouched by construction)"
"$NODE" -e '
const j=JSON.parse(require("fs").readFileSync("/tmp/dns-before.json","utf8"));
const want=process.argv[1].split(","), target=process.argv[2];
for(const name of want){
  const ex=j.result.find(r=>r.name===name);
  if(!ex)                       console.log("  CREATE", name, "-> CNAME", target, "(proxied)");
  else if(ex.content===target && ex.proxied) console.log("  OK    ", name, "already correct");
  else                          console.log("  UPDATE", name, ":", ex.type, ex.content, "->", "CNAME", target, "(proxied)");
}
const protectedNames=j.result.filter(r=>!want.includes(r.name)).map(r=>r.type+" "+r.name);
console.log("\n  untouched (" + protectedNames.length + "):");
for(const p of [...new Set(protectedNames)]) console.log("    ", p);
' "$APP_HOST,$CVX_HOST,$SITE_HOST" "$TARGET"

if [ "$APPLY" -ne 1 ]; then
  say "DRY RUN"
  echo "Nothing was changed. Re-run with --apply to write:"
  echo "  CLOUDFLARE_API_TOKEN=... bash \$0 --apply"
  exit 0
fi

# ------------------------------------------------------------------ apply
say "APPLYING"
for HOST in "$APP_HOST" "$CVX_HOST" "$SITE_HOST"; do
  ID=$("$NODE" -e '
    const j=JSON.parse(require("fs").readFileSync("/tmp/dns-before.json","utf8"));
    const r=j.result.find(x=>x.name===process.argv[1]); console.log(r?r.id:"");
  ' "$HOST")
  BODY=$(printf '{"type":"CNAME","name":"%s","content":"%s","proxied":true,"ttl":1}' "$HOST" "$TARGET")
  if [ -n "$ID" ]; then
    RES=$(cf -X PUT "$API/zones/$ZONE/dns_records/$ID" --data "$BODY")
    ACT="updated"
  else
    RES=$(cf -X POST "$API/zones/$ZONE/dns_records" --data "$BODY")
    ACT="created"
  fi
  OK=$(printf '%s' "$RES" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.success?"yes":"no:"+JSON.stringify(j.errors));}catch(e){console.log("no:unparseable");}})')
  printf '  %-28s %s -> %s\n' "$HOST" "$ACT" "$OK"
  case "$OK" in yes) ;; *) die "$HOST failed. Roll back with the command printed at the end." ;; esac
done

# ------------------------------------------------------------------ verify
say "verify: diff the whole zone against the snapshot"
cf "$API/zones/$ZONE/dns_records?per_page=200" > /tmp/dns-after.json
"$NODE" -e '
const fs=require("fs"), want=process.argv[1].split(",");
// Key on type|name but keep a SORTED MULTISET of contents per key. This zone has
// three MX and two TXT records all named ollasuper.com, so a plain
// Object.fromEntries would collapse them (last wins) and silently miss a
// clobbered SPF record — which is precisely the failure this check exists to catch.
const norm=rs=>{
  const m={};
  for(const r of rs){ const k=r.type+"|"+r.name; (m[k]=m[k]||[]).push(r.content+"|"+(r.proxied?"P":"-")); }
  for(const k in m) m[k].sort();
  return m;
};
const eq=(x,y)=>JSON.stringify(x||[])===JSON.stringify(y||[]);
const a=norm(JSON.parse(fs.readFileSync("/tmp/dns-before.json","utf8")).result);
const b=norm(JSON.parse(fs.readFileSync("/tmp/dns-after.json","utf8")).result);
let bad=0;
for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
  if(eq(a[k],b[k])) continue;
  const name=k.split("|")[1];
  const expected=want.includes(name);
  console.log((expected?"  CHANGED (intended) ":"  !! CHANGED (UNEXPECTED) ")+k+" : "+JSON.stringify(a[k]||"absent")+" => "+JSON.stringify(b[k]||"absent"));
  if(!expected) bad++;
}
const mail=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>/^(MX|TXT)\|/.test(k));
const mailOk=mail.every(k=>eq(a[k],b[k]));
console.log("\n  mail records (MX/SPF/DKIM/DMARC) byte-identical: "+(mailOk?"YES":"NO — INVESTIGATE"));
if(bad||!mailOk){ console.log("\n  UNEXPECTED CHANGES — roll back now."); process.exit(1); }
console.log("  only the three intended records changed.");
' "$APP_HOST,$CVX_HOST,$SITE_HOST" || die "zone diff found unintended changes"

say "edge check (allow ~30s for propagation)"
sleep 20
for H in "$APP_HOST" "$CVX_HOST" "$SITE_HOST"; do
  printf '  https://%-28s -> %s\n' "$H" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$H/" 2>/dev/null)"
done
echo "  (a 1016 means DNS is live but the tunnel is not serving that hostname — re-check 57)"
printf '  https://%-28s -> %s  (must stay 200)\n' "ollasuper.com" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://ollasuper.com/)"
printf '  https://%-28s -> %s  (must stay 200)\n' "tokens.ollasuper.com" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://tokens.ollasuper.com/)"

say "ROLLBACK (keep this)"
if [ -f "$ROLLBACK" ]; then
  echo "  restore app.ollasuper.com to its previous owner:"
  echo "  ID=\$($NODE -e 'console.log(require(\"$ROLLBACK\").id)'); \\"
  echo "  curl -s -X PUT $API/zones/$ZONE/dns_records/\$ID \\"
  echo "    -H \"Authorization: Bearer \$CLOUDFLARE_API_TOKEN\" -H 'content-type: application/json' \\"
  echo "    --data \"\$($NODE -e 'const r=require(\"$ROLLBACK\");console.log(JSON.stringify({type:r.type,name:r.name,content:r.content,proxied:r.proxied,ttl:r.ttl}))')\""
fi
echo
echo "NEXT: re-run 57-ollasuper-domain.sh once — its OIDC hairpin check can only pass now that DNS exists."
echo "OLLASUPER_DNS_DONE"
