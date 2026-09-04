#!/bin/sh
set -eu

mkdir -p /data
chown -R node:node /data
chmod 700 /data

exec gosu node "$@"
