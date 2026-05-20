# 日本株リサーチ支援Webアプリケーション

`investment_research_app_spec.md` に沿った初期MVP実装です。Next.js の画面、Node/TypeScript API、Python Research Backend、PostgreSQL + pgvector、Redis、MinIO、CUDA 版 llama.cpp server を Docker Compose で起動します。

## 起動

1. `.env.example` を `.env` にコピーします。
2. `./models/` 直下に GGUF モデルを置き、`.env` の `LLAMA_MODEL` をファイル名に合わせます。
3. J-Quantsの認証情報を `.env` に設定します。
4. NVIDIA Container Toolkit が有効な環境で起動します。

```bash
cp .env.example .env
docker compose --profile gpu --env-file .env up --build
```

画面は `http://localhost:3000`、API は `http://localhost:4000`、research backend は `http://localhost:8000`、llama.cpp は `http://localhost:8080` です。

フロントエンドだけを先に確認したい場合:

```bash
make web-up
```

この場合も `http://localhost:3000` で画面を確認できます。実データ取得にはAPIとPostgreSQLも起動してください。

## 実データ取得

初期データソースは J-Quants です。現在の J-Quants API v2 はダッシュボードで取得した API key / API Token を使います。`.env` には通常 `JQUANTS_API_KEY` または `JQUANTS_API_TOKEN` だけを設定します。

```bash
JQUANTS_BASE_URL=https://api.jquants.com/v2
JQUANTS_API_KEY=...
# または
JQUANTS_API_TOKEN=...
```

旧 v1 の refresh token / ID token 方式も移行用に残しています。v1 を使う場合だけ次のいずれかを設定してください。

```bash
JQUANTS_BASE_URL=https://api.jquants.com/v1
JQUANTS_REFRESH_TOKEN=...
# または
JQUANTS_EMAIL=...
JQUANTS_PASSWORD=...
```

v2 の API key / API Token は `x-api-key` ヘッダーで送信されます。`JQUANTS_ID_TOKEN` に v2 API Token を入れてしまっていた場合も、このアプリでは JWT 形式でない値は v2 API Token として扱いますが、新規設定では `JQUANTS_API_KEY` を使ってください。

PostgreSQLで `password authentication failed for user "research"` が出る場合は、J-QuantsではなくDBボリュームの認証情報不一致です。初期化済みのPostgreSQL volumeは、`.env` の `POSTGRES_PASSWORD` を後から変えてもDB内パスワードは変わりません。開発環境でDBを作り直してよい場合:

```bash
docker compose down -v
docker compose --profile gpu --env-file .env up -d --build
```

データを残したい場合は、DBに入れる既存パスワードへ `.env` の `POSTGRES_PASSWORD` と `DATABASE_URL` を合わせるか、PostgreSQL側でユーザーのパスワードを変更してください。

画面上では `http://localhost:3000/companies` から銘柄コードを入力できます。`基盤データ取得` は銘柄マスター、OHLCV、財務情報を取得し、DBへ保存します。`全上場銘柄を取得` は J-Quants v2 の `/equities/master` から上場銘柄一覧をDBへ取り込みます。既存DBに以前のサンプルデータが残っている場合は、画面の `サンプル削除` ボタン、または次のSQLを実行してください。

ホーム画面の `マクロ要因` では `取得` ボタンから主要指数とマクロニュースを取り込みます。指数は既定でStooqのCSV、ニュースはRSSのタイトル・URL・短い説明のみを保存します。差し替える場合は `.env` の `MACRO_INDEX_SYMBOLS` と `MACRO_NEWS_RSS_URLS` を設定してください。

```bash
docker compose exec -T postgres psql -U research -d stock_research < infra/db/migrations/001_purge_sample_data.sql
```

## Docker build中に名前解決で失敗する場合

`pip install` や `npm install` で `Temporary failure in name resolution` が出る環境向けに、Compose の build network は `host` にしています。それでも失敗する場合は Docker デーモン側の DNS を設定してください。

Linux/WSL の例:

```json
{
  "dns": ["8.8.8.8", "1.1.1.1"]
}
```

保存先は通常 `/etc/docker/daemon.json` です。Docker Desktop を使っている場合は Settings の Docker Engine へ同じ JSON を反映し、Docker を再起動してから再度 `docker compose --profile gpu --env-file .env up --build` を実行してください。

## モデルについて

`models/` は Compose で `/models` として llama.cpp コンテナへ read-only mount されます。`LLAMA_MODEL=your-model.gguf` の場合、llama.cpp は `/models/your-model.gguf` を読み込みます。

モデルがない場合、`llama` サービスは起動に失敗します。LLMなしで API/UI の形だけ確認したい場合は `.env` で `ALLOW_LLM_FALLBACK=true` にし、`research` と `api` と `web` を起動してください。

## サービス構成

- `apps/web`: Next.js / React。ホーム、銘柄詳細、仮説詳細、ローソク足チャート、仮説ボード。
- `apps/api`: Node.js / TypeScript API。仕様書の company / hypothesis / document / agent API を実装。
- `services/research`: Python / FastAPI。llama.cpp の OpenAI互換 `/v1/chat/completions` を使う要約・仮説・反証・最終判断。
- `infra/db/init`: pgvector 有効化、仕様書ベースのテーブル。
- `docker-compose.yml`: Postgres、Redis、MinIO、llama.cpp CUDA、API、research、web。

## 注意

本アプリケーションは情報整理・リサーチ支援用です。実データであっても投資助言ではありません。ニュース本文の保存や商用利用時は、各データソースの利用規約と再配布可否を確認してください。
