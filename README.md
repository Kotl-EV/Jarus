# NestCP Web Host — яйцо + Docker-образ

Залейте **содержимое этой папки `egg/`** в GitHub-репозиторий (корень репо = Dockerfile, skel/, egg JSON).

При старте сервера Pterodactyl:

1. GitHub Actions собирает образ `ghcr.io/<ваш-логин>/nestcp-webhost:latest`
2. Installer яйца скачивает `skel/` из того же репозитория
3. Контейнер запускает `start.sh`

## 1. GitHub

1. Создайте репозиторий, например `nestcp-webhost` (**Public**, иначе нужен `GIT_TOKEN`).
2. Загрузите файлы из `egg/` в корень.
3. Settings → Actions → General → Workflow permissions → **Read and write**.
4. Settings → Packages → убедитесь, что пакет `nestcp-webhost` после первой сборки **Public** (Package settings → Change visibility).
5. Дождитесь зелёного workflow **Build NestCP image**.

Образ: `ghcr.io/pazitiv4ik/nestcp-webhost:latest`

## 2. Яйцо

Откройте `egg-jarus.json` и замените `OWNER` на GitHub-логин:

- `docker_images` → `ghcr.io/OWNER/nestcp-webhost:latest`
- переменная `GIT_REPO` → `https://github.com/OWNER/nestcp-webhost`

Pterodactyl → Nests → Import egg.

## 3. Сервер

Создайте сервер с этим яйцом. Переменные:

| Переменная   | Пример                                      |
|-------------|---------------------------------------------|
| `GIT_REPO`  | `https://github.com/OWNER/nestcp-webhost`   |
| `GIT_BRANCH`| `main`                                      |
| `GIT_TOKEN` | только для private-репо                     |
| `AUTO_UPDATE` | `0` или `1` — тянуть скрипты при каждом старте |

`www/` и `sites.json` GitHub не затирает. Каталог `yarus/pgdata` (кластер PostgreSQL) тоже не перезаписывается.

## Ярус

При старте `start.sh` сам поднимает весь Ярус:

1. Кладёт собранный сайт в `www/yarus/public_html`, если его ещё нет.
2. Поднимает PostgreSQL на `127.0.0.1`, ставит зависимости бэкенда и применяет схему Prisma.
3. Запускает API на `127.0.0.1:$YARUS_API_PORT` (в настройках яйца, по умолчанию 3001).
4. Nginx на порту сервера отдаёт сайт и проксирует `/api` на этот API.

База — только PostgreSQL внутри этого контейнера. Порт 5432 наружу не публикуется, данные лежат в `yarus/pgdata`, пароль в `yarus/pg.secret`. После первого старта база пустая: компанию создают на странице входа. Файл `yarus/data/yarus.db` больше не читается. Лог API: `logs/yarus.log`. Лог PostgreSQL: `logs/postgres.log`.

Для этой базы нужен новый образ: в старом нет сервера PostgreSQL. После публикации образа переустановите сервер. Скрипты с уже нового образа можно докинуть по SFTP и перезапустить сервер:

| Файл яйца | Куда на сервере |
|---|---|
| `skel/start.sh` | `/home/container/start.sh` |
| `skel/bin/yarus.sh` | `/home/container/bin/yarus.sh` |
| `skel/bin/render-nginx.php` | `/home/container/bin/render-nginx.php` |
| `skel/yarus/backend` | `/home/container/yarus/backend` |
| `skel/yarus/web` | `/home/container/www/yarus/public_html` |

Папку `node_modules` заливать не нужно: она появится на сервере при первом старте.

## Обновление

Пуш в GitHub → новый образ. Reinstall сервера (или `AUTO_UPDATE=1` + Restart) подтянет `start.sh` / nginx.

Локальная сборка на ноде больше не нужна, если GHCR-пакет публичный и Wings может его pull.
