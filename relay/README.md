# LCAM 中継 relay（Oracle Cloud 配置）

LCAM (`lcam.aitech.ac.jp`) の WAF は Cloudflare の egress IP を拒否する（MIGRATION_NOTES §13.1）。
本番 Worker からの LCAM 宛リクエストのみ、この relay（非 Cloudflare の固定 IP = Oracle Cloud
Always Free VM）を経由させて到達させる。Moodle / シラバスは Worker から直接続のまま。

- 本体: [`relay.mjs`](relay.mjs)（Node 標準モジュールのみ・依存ゼロ）
- 配置先: 既存の Moodle サンドボックス VM（Oracle Cloud、cloudflared 稼働済み）に相乗り
- 公開: 既存 cloudflared トンネルに `relay.shiki-01.com` の ingress を 1 本追加

## 前提（確認済み）

- Oracle VM から `curl -i https://lcam.aitech.ac.jp/portalv2/` が **200**（egress 通過）。
- 既存 cloudflared: tunnel `9b4e9125-df3d-4166-a23d-b913748b6ee7`、
  config `/home/ubuntu/cloudflared/config.yml`。

## 1. relay を VM に配置

```sh
# ローカルから VM へ転送（例）
scp relay.mjs ubuntu@<oracle-vm>:/home/ubuntu/relay/relay.mjs
```

トークンを生成（ローカルでも VM でも可。Worker 側にも同じ値を入れる）:

```sh
openssl rand -hex 32   # 出力を RELAY_TOKEN として控える
```

## 2. relay を起動（Docker、既存の Docker をそのまま利用）

`--network host` の cloudflared から届くよう、`127.0.0.1:8090` にだけ公開する
（VM の公開インターフェースには晒さない）。

```sh
docker run -d --name aitapp-relay --restart unless-stopped \
  -p 127.0.0.1:8090:8090 \
  -e RELAY_TOKEN='<手順1で生成した値>' \
  -e PORT=8090 \
  -v /home/ubuntu/relay:/app:ro \
  node:22-alpine node /app/relay.mjs

docker logs aitapp-relay   # "lcam relay listening on :8090" を確認
```

> systemd で動かす場合（VM に Node があるなら）:
> `RELAY_TOKEN=... PORT=8090 node /home/ubuntu/relay/relay.mjs` を
> `ExecStart` にした unit を作り `systemctl enable --now aitapp-relay`。

## 3. cloudflared に ingress を追加

`/home/ubuntu/cloudflared/config.yml` を編集し、**catch-all（404）より前**に追記:

```yaml
tunnel: 9b4e9125-df3d-4166-a23d-b913748b6ee7
credentials-file: /etc/cloudflared/9b4e9125-df3d-4166-a23d-b913748b6ee7.json
ingress:
  - hostname: moodle.shiki-01.com
    service: http://localhost:8080
  - hostname: relay.shiki-01.com
    service: http://localhost:8090
  - service: http_status:404
```

## 4. DNS（CNAME）を作成

いずれか一方。

- Cloudflare ダッシュボード（確実）: `shiki-01.com` の DNS に
  `relay` CNAME `9b4e9125-df3d-4166-a23d-b913748b6ee7.cfargotunnel.com`（Proxied = オレンジ雲）を追加。
- CLI（cloudflared コンテナ経由）:
  ```sh
  docker exec <cloudflared-container> \
    cloudflared tunnel route dns 9b4e9125-df3d-4166-a23d-b913748b6ee7 relay.shiki-01.com
  ```

## 5. cloudflared を再起動（config 反映）

```sh
docker restart <cloudflared-container>
```

## 6. relay 単体で疎通確認

```sh
# 認証なし → 401
curl -s -o /dev/null -w '%{http_code}\n' https://relay.shiki-01.com/

# 正規リクエスト → 200 + L-Cam ログイン HTML + Set-Cookie: JSESSIONID
curl -i https://relay.shiki-01.com/ \
  -H "Authorization: Bearer <RELAY_TOKEN>" \
  -H "X-Aitapp-Target: https://lcam.aitech.ac.jp/portalv2/"

# 宛先外し → 403
curl -s -o /dev/null -w '%{http_code}\n' https://relay.shiki-01.com/ \
  -H "Authorization: Bearer <RELAY_TOKEN>" \
  -H "X-Aitapp-Target: https://example.com/"
```

`<title>L-Cam</title>` と `Set-Cookie: JSESSIONID=...` が返れば relay は正常。

## 7. Worker を relay に接続してデプロイ

`worker/wrangler.toml` の `[vars]` で `LCAM_RELAY_URL` のコメントを外す:

```toml
LCAM_RELAY_URL = "https://relay.shiki-01.com"
```

トークンを secret 投入してデプロイ:

```sh
cd worker
wrangler secret put LCAM_RELAY_TOKEN   # 手順1の値を貼る
wrangler deploy
```

## 8. エンドツーエンド検証

本番 `/mcp` で LCAM 系が通ること（§13.2 では 500 だった）を確認:

- `lcam_get_timetable` が実データを返す（= relay 経由で LCAM 到達・Cookie 透過・失効検知が機能）。
- 大きめ添付で `/api/file/:id` がストリームで最後まで取れる（body 透過）。

## 運用メモ

- relay コードは静的。上流仕様が変わっても Worker 側で対応し、relay は触らない。
- `RELAY_TOKEN` をローテートする場合は relay の env と Worker secret を同時に更新する。
- relay は body をログに残さない（ログイン POST に平文資格情報が通るため）。
- VM/relay が落ちると LCAM 系のみ従来のデプロイ版と同じくエラーになる（Moodle/シラバスは無影響）。
  自動復旧は設けない（要件 §11）。
