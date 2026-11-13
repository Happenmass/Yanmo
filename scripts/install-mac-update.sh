#!/bin/bash
set -u
parent_pid="$1"
installed="$2"
replacement="$3"
staging="$4"
backup="$staging/previous.app"

fail() {
    /usr/bin/osascript -e 'display alert "言墨更新未完成" message "请从言墨的「检查更新」重新尝试，或到 GitHub 下载安装包。"' >/dev/null 2>&1
    exit 1
}

# The updater runs outside the installed bundle. Wait for the main process
# and any remaining bridge, backend, or Electron helpers from this exact path.
for ((attempt=0; attempt<150; attempt++)); do
    processes=$(/bin/ps -axo comm=) || fail
    if ! kill -0 "$parent_pid" 2>/dev/null &&
       ! /usr/bin/awk -v prefix="$installed/Contents/" 'index($0, prefix) == 1 { found = 1 } END { exit !found }' <<< "$processes"; then
        break
    fi
    /bin/sleep 0.2
done
if ((attempt == 150)); then
    /bin/rm -rf "$staging"
    fail
fi

if ! /bin/mv "$installed" "$backup"; then
    /bin/rm -rf "$staging"
    fail
fi
if ! /bin/mv "$replacement" "$installed"; then
    if /bin/mv "$backup" "$installed"; then
        /bin/rm -rf "$staging"
        /usr/bin/open -a "$installed"
    fi
    fail
fi

# Launch through Launch Services so macOS handles permissions normally.
if /usr/bin/open -a "$installed"; then
    /bin/rm -rf "$staging"
else
    # A launch request failed. Only restore if the new bundle has no live process.
    processes=$(/bin/ps -axo comm=) || fail
    if ! /usr/bin/awk -v prefix="$installed/Contents/" 'index($0, prefix) == 1 { found = 1 } END { exit !found }' <<< "$processes"; then
        if /bin/mv "$installed" "$staging/failed.app" && /bin/mv "$backup" "$installed"; then
            /bin/rm -rf "$staging"
            /usr/bin/open -a "$installed"
        fi
    fi
    fail
fi
