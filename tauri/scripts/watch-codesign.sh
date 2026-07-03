#!/bin/sh
# 開発用(macOSのみ): `cargo tauri dev` がRustコード変更を検知して再ビルドする度に
# デバッグバイナリを監視し、安定した自己署名IDで再署名する。
#
# 背景: macOSのデバッグビルドはリンカが自動でad-hoc署名するが、その識別子は
# バイナリのハッシュ値そのもののため再ビルドの度に変わり、Keychainの
# 「常に許可」が保持されず、restore_sessionのキーチェーン読み取りで毎回
# 許可プロンプトが出る。安定した証明書IDで署名し直すことでこれを防ぐ。
#
# 事前準備: Keychain Accessで証明書アシスタント→コード署名用の自己署名証明書を
# 作成しておくこと(README参照)。証明書名は環境変数 AITAPP_CODESIGN_IDENTITY で
# 指定(未指定時は "aitapp-desktop-dev")。
#
# 使い方: `cargo tauri dev` と並行して別ターミナルでこのスクリプトを実行する。
set -eu

IDENTITY="${AITAPP_CODESIGN_IDENTITY:-aitapp-desktop-dev}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SCRIPT_DIR/../src-tauri/target/debug/aitapp-desktop"
LAST_MTIME=""

echo "watching $BIN (identity: $IDENTITY)"

while true; do
  if [ -f "$BIN" ]; then
    MTIME="$(stat -f %m "$BIN" 2>/dev/null || echo "")"
    if [ -n "$MTIME" ] && [ "$MTIME" != "$LAST_MTIME" ]; then
      LAST_MTIME="$MTIME"
      if codesign --force --deep --sign "$IDENTITY" --identifier com.aitapp.desktop "$BIN" 2>/dev/null; then
        echo "re-signed (mtime=$MTIME)"
      else
        echo "codesign failed: 証明書 '$IDENTITY' が見つからないか、まだビルドが完了していません"
      fi
    fi
  fi
  sleep 1
done
