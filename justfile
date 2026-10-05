wr:
    watchexec -w ./wr.sh --clear -r "./wr.sh"

# Single-account legacy mode: no --fleet-file, exactly the pre-v4 bridge.
serve:
    TAB_BRIDGE_DEBUG=1 node dist/src/index.js serve --port 8789 \
      --api-key-env TAB_BRIDGE_KEY \
      --stateful=true --auto-create-tabs --managed-only \
      --ttl=30m --repair-rounds=1 --holdback-ceiling=65536 \
      --reset-on-seed=auto --max-tabs=4 --tab-idle-close=15m --warm-tabs=0

# Multi-account fleet: one Chrome profile per account, place-then-stick,
# per-account network identity + surface, staggered boot, fingerprint checkup.
# Recommended for any machine driving more than one DeepSeek account.
serve-fleet:
    TAB_BRIDGE_DEBUG=1 node dist/src/index.js serve --port 8789 \
      --api-key-env TAB_BRIDGE_KEY \
      --stateful=true --auto-create-tabs --managed-only \
      --ttl=30m --repair-rounds=1 --holdback-ceiling=65536 \
      --reset-on-seed=auto --max-tabs=4 --tab-idle-close=15m --warm-tabs=0 \
      --fleet-file=fleet.json --fleet-root=fleet-home \
      --fleet-launch=on-demand --fleet-relogin-window=auto \
      --per-account-turns=2 --max-sessions-per-account=8 \
      --bind-timeout-ms=20000 \
      --fleet-launch-stagger=45s \
      --fleet-proxy-required=false

# ---------------------------------------------------------------------------
# Fleet CLI — thin wrappers over the running bridge (server owns state).
# ---------------------------------------------------------------------------

# Enroll a new profile. Optional --label, --proxy, --surface.
#   just fleet-add personal --proxy 'socks5://127.0.0.1:1082'
#   just fleet-add work --surface 'locale=de-DE,tz=Europe/Berlin'
fleet-add *ARGS:
    node dist/src/index.js fleet add {{ARGS}}

# Enrolled accounts at a glance (state, cooldown, sessions, network).
fleet-list:
    node dist/src/index.js fleet list

# Isolation report: network paths (+ exit-IP probe), surfaces, boot phases,
# enrollment clustering, and every shared-path finding. --json for scripts.
fleet-doctor *ARGS:
    node dist/src/index.js fleet doctor {{ARGS}}

# Re-run the fingerprint probe in one profile and print the measured diff.
fleet-checkup id:
    node dist/src/index.js fleet checkup {{id}}

# Guided re-login for an account the bridge reports as needs-relogin.
fleet-login id:
    node dist/src/index.js fleet login {{id}}

# Open the account's window without touching enrollment.
fleet-open id:
    node dist/src/index.js fleet open {{id}}

# Set or clear the account's network identity.
#   just fleet-proxy work 'socks5://127.0.0.1:1081'
#   just fleet-proxy work off
fleet-proxy id value:
    node dist/src/index.js fleet proxy {{id}} {{value}}

# Set the account's presentation surface (locale/timezone/window/canvas).
# Requires --force to change a live account (C12: stable identity).
fleet-surface *ARGS:
    node dist/src/index.js fleet surface {{ARGS}}

# Move an account's sessions onto another account (priced, explicit,
# serialized). Use --dry-run first to see the plan without moving anything.
#   just fleet-drain backup --dry-run
#   just fleet-drain backup --to work
fleet-drain *ARGS:
    node dist/src/index.js fleet drain {{ARGS}}

# Unbind an account (profile dir kept on disk; use remove --purge via the
# CLI directly to delete files).
fleet-remove id:
    node dist/src/index.js fleet remove {{id}}
