#!/bin/bash
# Cortex MCP Proxmox LXC Installer
# Creates an LXC container on Proxmox VE with Cortex MCP
# MCP server for Cortex observable analysis

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Cortex MCP - Proxmox LXC Installer${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Reviewed source
# The operator supplies the exact reviewed commit. Branches and tags are rejected.
if [[ ! "${CORTEX_SOURCE_COMMIT:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
    printf '%s\n' 'Error: CORTEX_SOURCE_COMMIT must be a reviewed 40-character hexadecimal commit.' >&2
    exit 1
fi
CORTEX_SOURCE_COMMIT=${CORTEX_SOURCE_COMMIT,,}

# Reviewed Node artifact
# Supply the SHA-256 from an independently verified official release manifest.
# Node 22.12+ satisfies the runtime and the checked-in build tool requirements.
if [[ ! "${NODE_VERSION:-}" =~ ^22\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || (( BASH_REMATCH[1] < 12 )); then
    printf '%s\n' 'Error: NODE_VERSION must be an exact Node 22 version, at least 22.12.0.' >&2
    exit 1
fi
if [[ ! "${NODE_ARCH:-}" =~ ^(x64|arm64)$ ]]; then
    printf '%s\n' 'Error: NODE_ARCH must be x64 or arm64 for the reviewed archive.' >&2
    exit 1
fi
if [[ ! "${NODE_SHA256:-}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    printf '%s\n' 'Error: NODE_SHA256 must be the reviewed 64-character hexadecimal archive checksum.' >&2
    exit 1
fi
NODE_SHA256=${NODE_SHA256,,}

# Pre-flight
if [ ! -f /etc/pve/.version ]; then
    echo -e "${RED}Error: Must be run on a Proxmox VE host.${NC}"; exit 1
fi
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: Please run as root${NC}"; exit 1
fi

# Container settings
NEXT_CTID=$(pvesh get /cluster/nextid 2>/dev/null || echo "100")
echo -e "${CYAN}Press Enter for defaults.${NC}"
echo ""

read -p "Container ID [$NEXT_CTID]: " CTID; CTID=${CTID:-$NEXT_CTID}
if pct status "$CTID" &>/dev/null; then
    echo -e "${RED}Error: CT $CTID exists.${NC}"; exit 1
fi

read -p "Hostname [cortex-mcp]: " CT_HOSTNAME; CT_HOSTNAME=${CT_HOSTNAME:-cortex-mcp}
read -p "Memory MB [2048]: " CT_MEMORY; CT_MEMORY=${CT_MEMORY:-2048}
read -p "Disk GB [4]: " CT_DISK; CT_DISK=${CT_DISK:-4}
read -p "CPU cores [1]: " CT_CORES; CT_CORES=${CT_CORES:-1}

# Network
echo ""; echo -e "${YELLOW}Network${NC}"
read -p "Bridge [vmbr0]: " CT_BRIDGE; CT_BRIDGE=${CT_BRIDGE:-vmbr0}
read -p "DHCP? [Y/n]: " USE_DHCP; USE_DHCP=${USE_DHCP:-Y}
NET_CONFIG="name=eth0,bridge=$CT_BRIDGE"
if [[ "${USE_DHCP,,}" == "n" ]]; then
    read -p "IP (CIDR): " CT_IP; read -p "Gateway: " CT_GW
    NET_CONFIG="$NET_CONFIG,ip=$CT_IP,gw=$CT_GW"
else
    NET_CONFIG="$NET_CONFIG,ip=dhcp"
fi

read -p "Storage [local-lvm]: " CT_STORAGE; CT_STORAGE=${CT_STORAGE:-local-lvm}

# Service config
echo ""; echo -e "${YELLOW}Cortex MCP Configuration${NC}"
read -r -p "CORTEX_URL: " CORTEX_URL_VAL
read -r -s -p "CORTEX_API_KEY: " CORTEX_API_KEY_VAL
printf '\n'

# Template
echo -e "${YELLOW}Finding Ubuntu template...${NC}"
DOWNLOADED=$(pveam list local 2>/dev/null | grep -i ubuntu | grep -i "24.04\|22.04" | awk '{print $1}' | head -1)
if [ -n "$DOWNLOADED" ]; then
    TEMPLATE="$DOWNLOADED"
else
    TNAME=$(pveam available | grep -i "ubuntu-24.04-standard" | awk '{print $2}' | head -1)
    [ -z "$TNAME" ] && TNAME=$(pveam available | grep -i "ubuntu-22.04-standard" | awk '{print $2}' | head -1)
    [ -z "$TNAME" ] && { echo -e "${RED}No Ubuntu template found.${NC}"; exit 1; }
    pveam download local "$TNAME"
    TEMPLATE="local:vztmpl/$TNAME"
fi

# Create container
echo -e "${YELLOW}Creating container $CTID...${NC}"
CT_PASSWORD=$(openssl rand -base64 12)
pct create "$CTID" "$TEMPLATE" \
    --hostname "$CT_HOSTNAME" --memory "$CT_MEMORY" --cores "$CT_CORES" \
    --rootfs "$CT_STORAGE:$CT_DISK" --net0 "$NET_CONFIG" \
    --unprivileged 1 --features nesting=1 --password "$CT_PASSWORD" --start 0

# Start and wait for network
unset CT_PASSWORD
pct start "$CTID"; sleep 10
for i in {1..30}; do
    pct exec "$CTID" -- ping -c1 8.8.8.8 &>/dev/null && break; sleep 2
done

# Install deps
# Ubuntu packages are authenticated by Ubuntu apt, but are not snapshot-pinned.
echo -e "${YELLOW}Installing dependencies...${NC}"
pct exec "$CTID" -- bash -c "apt-get update && apt-get install -y curl git ca-certificates xz-utils libatomic1"
# Verify the exact official Node archive before extracting or executing its code.
pct exec "$CTID" -- env NODE_VERSION="$NODE_VERSION" NODE_ARCH="$NODE_ARCH" NODE_SHA256="$NODE_SHA256" bash -ceu '
case "$(dpkg --print-architecture)" in
    amd64) actual_arch=x64 ;;
    arm64) actual_arch=arm64 ;;
    *) printf "%s\n" "Unsupported guest architecture." >&2; exit 1 ;;
esac
if [ "$actual_arch" != "$NODE_ARCH" ]; then
    printf "%s\n" "NODE_ARCH does not match the guest architecture." >&2
    exit 1
fi
download_dir=$(mktemp -d)
trap "rm -f \"\$download_dir/node.tar.xz\"; rmdir \"\$download_dir\"" EXIT
curl --fail --silent --show-error --location --proto "=https" --proto-redir "=https" --tlsv1.2 \
    --output "$download_dir/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
printf "%s  %s\n" "$NODE_SHA256" "$download_dir/node.tar.xz" | sha256sum --check --status
tar -xJf "$download_dir/node.tar.xz" -C /usr/local --strip-components=1 --no-same-owner
'

# Clone, configure, build
# Fetch reviewed source
echo -e "${YELLOW}Setting up Cortex MCP...${NC}"
pct exec "$CTID" -- env SOURCE_COMMIT="$CORTEX_SOURCE_COMMIT" bash -ceu '
export PATH=/usr/local/bin:/usr/bin:/bin
git init /opt/cortex-mcp
cd /opt/cortex-mcp
git remote add origin https://github.com/lidless-labs/cortex-mcp.git
git fetch --depth 1 origin "$SOURCE_COMMIT"
git checkout --detach FETCH_HEAD
ACTUAL_COMMIT=$(git rev-parse --verify HEAD^{commit})
if [ "$ACTUAL_COMMIT" != "$SOURCE_COMMIT" ]; then
    printf "%s\n" "Source commit verification failed. Stopping before dependency installation." >&2
    exit 1
fi
npm ci --ignore-scripts
npm run build
npm prune --omit=dev --ignore-scripts
'

# Configure service
printf '%s' "$CORTEX_URL_VAL" | pct exec "$CTID" -- bash /opt/cortex-mcp/scripts/store-credential.sh /etc/cortex-mcp/cortex-url
printf '%s' "$CORTEX_API_KEY_VAL" | pct exec "$CTID" -- bash /opt/cortex-mcp/scripts/store-credential.sh /etc/cortex-mcp/cortex-api-key
unset CORTEX_API_KEY_VAL

# Keep the service identity separate from root-owned code and source credentials.
pct exec "$CTID" -- bash -c "getent passwd cortex-mcp >/dev/null || useradd --system --user-group --home-dir /var/lib/cortex-mcp --shell /usr/sbin/nologin cortex-mcp"
pct exec "$CTID" -- bash -c "chown -R root:root /opt/cortex-mcp && chmod -R u=rwX,go=rX /opt/cortex-mcp"

# Systemd service
pct exec "$CTID" -- tee /etc/systemd/system/cortex-mcp.service >/dev/null <<'SVCEOF'
[Unit]
Description=Cortex MCP
After=network.target

[Service]
Type=simple
User=cortex-mcp
Group=cortex-mcp
WorkingDirectory=/opt/cortex-mcp
ExecStart=/usr/local/bin/node dist/index.js
Restart=on-failure
RestartSec=10
LoadCredential=cortex-api-key:/etc/cortex-mcp/cortex-api-key
LoadCredential=cortex-url:/etc/cortex-mcp/cortex-url
Environment=CORTEX_MODE=read-only
StateDirectory=cortex-mcp
StateDirectoryMode=0700
RuntimeDirectory=cortex-mcp
RuntimeDirectoryMode=0700
Environment=HOME=/var/lib/cortex-mcp
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
CapabilityBoundingSet=
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
SVCEOF
pct exec "$CTID" -- bash -c "systemctl daemon-reload && systemctl enable cortex-mcp && systemctl start cortex-mcp"

CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  Cortex MCP installed successfully!${NC}"
echo -e "${GREEN}================================================${NC}"
echo -e "  CT ID:     $CTID"
echo -e "  Hostname:  $CT_HOSTNAME"
echo -e "  IP:        $CT_IP"
echo ""
echo -e "  ${YELLOW}pct enter $CTID${NC}"
echo -e "  ${YELLOW}pct exec $CTID -- journalctl -u cortex-mcp -f${NC}"
