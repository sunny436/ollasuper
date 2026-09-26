#!/usr/bin/env bash
# Off-host encrypted backup copy (audit D-04): set it up, then PROVE it.
#
# deploy/backup.sh already encrypts every artifact to a PUBLIC key and rsyncs
# the ciphertext off this host when /etc/myos/backup.env names both halves. Only
# the operator can supply those halves — nothing here invents a destination or
# a key:
#   1. an ASCII-armoured PUBLIC gpg key whose private half lives OFF this VM
#      -> saved as /etc/myos/backup-recipient.asc
#   2. an SSH rsync destination that accepts this VM's backup key
#      -> BACKUP_OFFHOST_TARGET=user@host:/path/  in /etc/myos/backup.env
#
#   --setup    create the dedicated SSH identity (/etc/myos/backup_ed25519) and
#              a backup.env template; print the public key to authorize on the
#              destination. Idempotent; never overwrites an existing value.
#   --verify   run a REAL backup, pull every encrypted copy it sent back from the
#              destination, compare ciphertext checksums, confirm each is a
#              gpg message to the configured key, and print the decrypt + restore
#              commands for the private-key holder. Exit 0 = OFFHOST_VERIFIED.
set -euo pipefail

CONF_DIR=/etc/myos
ENV_FILE=${BACKUP_ENV_FILE:-$CONF_DIR/backup.env}
KEY=$CONF_DIR/backup_ed25519
KNOWN=$CONF_DIR/backup_known_hosts
RECIPIENT=$CONF_DIR/backup-recipient.asc
DEST=${BACKUP_DIR:-/opt/backups}
HERE=$(cd "$(dirname "$0")" && pwd)

setup() {
  install -d -o root -g root -m 0700 "$CONF_DIR"
  if [ ! -f "$KEY" ]; then
    ssh-keygen -q -t ed25519 -N "" -C "myos-backup@$(hostname)" -f "$KEY"
    echo "created the dedicated backup identity $KEY"
  fi
  chmod 0600 "$KEY"
  touch "$KNOWN" && chmod 0600 "$KNOWN"
  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<EOF
# Off-host encrypted backup copy (audit D-04) — read by deploy/backup.sh.
# Uncomment BOTH lines once the operator has supplied them; one without the
# other makes the nightly backup fail loudly rather than silently skip the copy.
#BACKUP_GPG_RECIPIENT_FILE=$RECIPIENT
#BACKUP_OFFHOST_TARGET=user@host:/path/to/myos-backups/
BACKUP_SSH_KEY=$KEY
EOF
    chmod 0600 "$ENV_FILE"
    echo "wrote the template $ENV_FILE"
  fi
  echo
  echo "Authorize THIS public key on the destination (~/.ssh/authorized_keys of the target user):"
  cat "$KEY.pub"
  echo
  echo "Then: save the PUBLIC gpg key as $RECIPIENT, set BACKUP_OFFHOST_TARGET in"
  echo "$ENV_FILE, uncomment both lines, and run: bash $0 --verify"
}

verify() {
  [ -f "$ENV_FILE" ] || { echo "FATAL: no $ENV_FILE — run --setup first" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  : "${BACKUP_GPG_RECIPIENT_FILE:?not set in $ENV_FILE (the operator's PUBLIC gpg key)}"
  : "${BACKUP_OFFHOST_TARGET:?not set in $ENV_FILE (the operator's rsync destination)}"
  [ -s "$BACKUP_GPG_RECIPIENT_FILE" ] || { echo "FATAL: $BACKUP_GPG_RECIPIENT_FILE is empty or missing" >&2; exit 1; }
  if grep -q "PRIVATE KEY" "$BACKUP_GPG_RECIPIENT_FILE"; then
    echo "FATAL: $BACKUP_GPG_RECIPIENT_FILE holds a PRIVATE key — the private half must never be on this host" >&2
    exit 1
  fi
  local keyids
  keyids=$(gpg --batch --with-colons --import-options show-only --import "$BACKUP_GPG_RECIPIENT_FILE" 2>/dev/null |
    awk -F: '$1=="pub"||$1=="sub"{print $5}')
  [ -n "$keyids" ] || { echo "FATAL: $BACKUP_GPG_RECIPIENT_FILE is not a readable public key" >&2; exit 1; }

  echo "=== 1/3 a real backup, encrypted and sent off-host ==="
  bash "$HERE/backup.sh"
  [ -s "$DEST/offhost-last.sha256" ] || { echo "FATAL: backup.sh recorded no off-host copy" >&2; exit 1; }

  echo "=== 2/3 pull every copy back from $BACKUP_OFFHOST_TARGET and compare ==="
  local ok=1
  back=$(mktemp -d)
  trap 'rm -rf "${back:-}"' EXIT
  local ssh_cmd="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN"
  [ -n "${BACKUP_SSH_KEY:-}" ] && ssh_cmd="$ssh_cmd -o IdentitiesOnly=yes -i $BACKUP_SSH_KEY"
  while read -r sum name; do
    rsync -a -e "$ssh_cmd" "${BACKUP_OFFHOST_TARGET%/}/$name" "$back/$name" < /dev/null
    local got
    got=$(sha256sum "$back/$name" | cut -d' ' -f1)
    if [ "$got" != "$sum" ]; then
      echo "  FAIL: $name — the off-host copy differs from what was sent"
      ok=0
      continue
    fi
    # Encrypted to the operator's key, and to nothing else. Without the private
    # key gpg lists the packets and then exits non-zero — that failure is the
    # point, so it must not end the script.
    local packets to
    packets=$(gpg --batch --list-packets "$back/$name" 2>&1 < /dev/null || true)
    to=$(awk '/pubkey enc packet/{for(i=1;i<=NF;i++) if($i=="keyid") print $(i+1)}' <<< "$packets")
    local stranger="" id
    for id in $to; do grep -qx -F "$id" <<< "$keyids" || stranger="$stranger $id"; done
    if [ -z "$to" ] || [ -n "$stranger" ]; then
      echo "  FAIL: $name — not encrypted to the configured key alone (to: ${to:-none})"
      ok=0
      continue
    fi
    if grep -q "^:literal data packet" <<< "$packets"; then
      echo "  FAIL: $name — readable without the private key"
      ok=0
      continue
    fi
    echo "  ok: $name — off-host copy byte-identical, encrypted to $to"
  done < "$DEST/offhost-last.sha256"
  [ "$ok" = 1 ] || { echo "OFFHOST VERIFICATION FAILED"; exit 1; }

  echo "=== 3/3 restore check — ON THE MACHINE THAT HOLDS THE PRIVATE KEY ==="
  local man
  man=$(awk '{print $2}' "$DEST/offhost-last.sha256" | grep '^manifest-' | head -1)
  echo "  cd <the destination directory>"
  echo "  gpg --decrypt $man > ${man%.gpg}"
  echo "  grep -v '^[a-z_]*=' ${man%.gpg} | while read -r _ f; do gpg --decrypt \"\$f.gpg\" > \"\$f\"; done"
  echo "  grep -v '^[a-z_]*=' ${man%.gpg} | sha256sum -c   # every line must say OK"
  echo OFFHOST_VERIFIED
}

case "${1:-}" in
  --setup) setup ;;
  --verify) verify ;;
  *)
    echo "usage: $0 --setup | --verify" >&2
    exit 2
    ;;
esac
