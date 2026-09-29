wr:
    watchexec -w ./wr.sh --clear -r "./wr.sh"

serve:
    TAB_BRIDGE_DEBUG=1 node dist/src/index.js serve --port 8789 \
      --api-key-env TAB_BRIDGE_KEY \
      --stateful=true --auto-create-tabs --managed-only \
      --ttl=30m --repair-rounds=1 --holdback-ceiling=65536 \
      --reset-on-seed=auto --max-tabs=4 --tab-idle-close=15m --warm-tabs=0
