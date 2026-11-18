set -eu

commit=abefa6dbdb57fd2971c0d24ec563f24de57477ca
here=$(dirname "$0")
curl -fsSL "https://github.com/career-ops-hq/career-ops/archive/$commit.tar.gz" -o /tmp/career-ops.tar.gz
printf '%s\n' '9efa7573f248ca3b986ad4a01e14c8d65b068b01ab7296314ba280ab8133adf5  /tmp/career-ops.tar.gz' | sha256sum -c -
mkdir /opt/career-ops
tar -xzf /tmp/career-ops.tar.gz -C /opt/career-ops --strip-components=1 --no-same-owner
rm /tmp/career-ops.tar.gz
test "$(node -p "require('/opt/career-ops/package.json').version")" = 1.39.0
install -m 444 "$here/career-ops-lock.json" /opt/career-ops/package-lock.json
cd /opt/career-ops
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright node node_modules/playwright/cli.js install --with-deps --only-shell chromium
rm -rf /root/.npm /root/.cache /var/lib/apt/lists/*
chown -R root:root /opt/career-ops /opt/ms-playwright
chmod -R a+rX,go-w /opt/career-ops /opt/ms-playwright
install -m 555 "$here/career-ops" /usr/local/bin/career-ops
