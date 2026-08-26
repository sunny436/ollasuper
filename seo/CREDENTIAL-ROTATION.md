# Credential remediation (surfaced by Phase 0)

> No secret values were read or printed during Phase 0 — only token length was measured to confirm
> the exposure was real. This file names WHAT to rotate and HOW, without any values.

## Finding
A file named **`convex.txt`** was committed to git history and contained a **real Convex deploy key**:
a `name|token` line with a **56-character token** (the `prod:name|token` deploy-key shape), plus 2
Convex deployment URLs.

- Added in commit **`6f766c4`** (2026-08-17, "Enable Google sign-in: credentials + public OIDC issuer").
- Untracked the same day in **`48e4bbc`** ("Untrack convex.txt (operator scratch file)").
- **The blob is still present in `origin/main` history on GitHub** (a `git rm` does not remove it from
  history). The GitHub repo is **PRIVATE**, so exposure is limited to repo collaborators and anyone who
  has cloned it — not the public internet.
- No `.env` file and no other operator credential file was ever committed (all verified 0 commits).

## Why it still matters
A deploy key grants push/deploy access to the associated Convex deployment. Even in a private repo,
a key that has ever been committed should be treated as compromised — every collaborator and clone
retains it in history permanently.

## Remediation (owner action — I did not auto-perform this)
1. **Rotate the Convex deploy key** in the Convex dashboard (Settings → Deploy Keys → revoke the old
   key, generate a new one). Update wherever it is consumed (per CLAUDE.md the Cloud deploy key lives
   at `/root/.cvx-cloud-key` on the VM; the self-hosted admin key is derived from
   INSTANCE_NAME/INSTANCE_SECRET and is **not** affected).
2. The exposed key most likely targeted the **Convex Cloud** deployment (`benevolent-koala-651`), which
   CLAUDE.md records as the dormant "rollback of record." That lowers blast radius but not the need to
   rotate.
3. **History purge is optional and NOT recommended as minimum-safe** — the commit is an ancestor of
   ~90 branches and both remotes; a `git filter-repo`/BFG rewrite would force-push and invalidate every
   clone. Rotation is the definitive fix; purge only if policy requires removing the blob.

## Prevention already in place
`.gitignore` covers operator credential drops by exact name and by pattern (`*_key*.txt`,
`*_secret*.txt`, `*_token*.txt`, `*_auth*.txt`, `*.credentials.json`). `convex.txt` predates that rule.
Phase 0 also relocated the previously-un-ignored `seo_endpoint.txt` (no secrets) into this packet.
