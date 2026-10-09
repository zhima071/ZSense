#!/bin/sh
set -eu

parent_pid=$1
package_path=$2
target_app=$3
expected_version=$4
log_path=$5
exec >> "$log_path" 2>&1

attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 180 ]; then
    echo '等待旧版 ZSense 退出超时；安装包保留在更新目录。'
    exit 1
  fi
  sleep 1
done

mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/zsense-update.XXXXXX")
mounted=0
cleanup() {
  if [ "$mounted" -eq 1 ]; then hdiutil detach "$mount_dir" -quiet || true; fi
  rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup EXIT
hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$package_path" >/dev/null
mounted=1
source_app="$mount_dir/ZSense.app"
info_plist="$source_app/Contents/Info.plist"
if [ ! -d "$source_app" ] || [ ! -f "$info_plist" ]; then
  echo 'DMG 内没有 ZSense.app。'
  open "$package_path" || true
  exit 1
fi
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")
bundle_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist")
if [ "$bundle_id" != 'ai.zsense.studio' ] || [ "$bundle_version" != "$expected_version" ]; then
  echo 'DMG 内的应用身份或版本不匹配。'
  exit 1
fi

stage_app="${target_app}.update-stage-$$"
backup_app="${target_app}.previous-$$"
if ! ditto "$source_app" "$stage_app"; then
  rm -rf "$stage_app"
  echo '无法复制新版应用；旧版未更改。'
  exit 1
fi
if ! mv "$target_app" "$backup_app"; then
  rm -rf "$stage_app"
  echo '无法移动旧版应用；安装包保留在更新目录。'
  open "$package_path" || true
  exit 1
fi
if ! mv "$stage_app" "$target_app"; then
  mv "$backup_app" "$target_app" || true
  rm -rf "$stage_app"
  echo '无法安装新版应用，已尝试恢复旧版。'
  exit 1
fi
if ! open "$target_app"; then
  mv "$target_app" "$stage_app" || true
  mv "$backup_app" "$target_app" || true
  rm -rf "$stage_app"
  echo '无法打开新版应用，已尝试恢复旧版。'
  exit 1
fi
rm -rf "$backup_app"
cleanup
trap - EXIT
rm -f "$package_path"
echo "ZSense $expected_version 已安装并重新打开。"
