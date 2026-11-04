# Teams Collector

Browser-side component for the "automated calendar from Teams" plan: the extension captures selected Teams responses, and the local receiver saves them to disk as-is.

## Structure

```
extension/            extension (LibreWolf/Firefox, Chrome, Edge, Brave)
manifest.json
hook.js             in-page: fetch and XMLHttpRequest interception
bridge.js           bridge page -> extension
background.js       queue and sending to localhost
src/
capture_receiver.py receiver: writes snapshots to data/raw
har_sampler.py      stage 0: search in HAR and cleaned samples
tests/                Python tests (unittest) and extension tests (node:test)

```

## Running the Receiver

Requires Python 3.10+. No third-party dependencies.

1. `cp .env.example .env` and enter a long secret (generation command is provided in `.env.example`).
2. Load the environment variables and run:
* Linux/macOS: `set -a; source .env; set +a; python src/capture_receiver.py`
* PowerShell: set `$env:COLLECTOR_SECRET = "..."`, then `python src\capture_receiver.py`



The receiver listens only on `127.0.0.1:8765`. Snapshots are saved in `data/raw/snapshots/`, and the observation log is stored in `data/raw/observations.jsonl`.

## Extension Installation

1. LibreWolf/Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → `extension/manifest.json`. Chrome/Edge/Brave: `chrome://extensions` → Developer mode → "Load unpacked" → `extension/` folder.
2. Firefox/LibreWolf: in `about:addons` → extension → "Permissions", verify that access to Teams sites and `127.0.0.1` is enabled.
3. Secret setup (one-time): open the background script console (`about:debugging` → "Inspect", or in Chrome: service worker on the extension page) and execute:
`(globalThis.browser ?? chrome).storage.local.set({ collectorSecret: "<secret from .env>" })`.
4. After stage 0, specify the endpoints in `URL_PATTERNS` inside `extension/hook.js` (the only file to edit) and add embedded app domains to `matches` in the manifest. Do not add authentication domains (`login.microsoftonline.com`).

## Stage 0: Samples from HAR

```
python src/har_sampler.py session.har "Kolokwium 1" --save-dir samples/

```

The HAR file contains tokens and cookies: do not store it after running. Headers, cookies, and URL parameters are excluded from the samples, but response bodies may still contain personal data.

## Checks

```
PYTHONPATH=src python -m unittest discover -s tests   # Python
npm test                                              # extension (Node 20+)
npm install --save-dev --save-exact eslint @eslint/js prettier   # one-time, pins exact versions
npm run lint && npm run format:check                  # JS
pip install -r requirements-dev.txt && ruff check . && ruff format --check .   # Python

```

Complete the checklist in `CODING_RULES.md` before committing. Tests do not replace manual verification in a live browser (see Stage 1 criteria in the instructions).

# russian version

# Teams Collector

Сторона браузера для плана «автоматический календарь из Teams»: расширение забирает
выбранные ответы Teams, локальный приёмник кладёт их на диск как есть.

## Структура

```
extension/            расширение (LibreWolf/Firefox, Chrome, Edge, Brave)
  manifest.json
  hook.js             в странице: перехват fetch и XMLHttpRequest
  bridge.js           мост страница -> расширение
  background.js       очередь и отправка на localhost
src/
  capture_receiver.py приёмник: пишет снимки в data/raw
  har_sampler.py      этап 0: поиск в HAR и очищенные образцы
tests/                тесты Python (unittest) и расширения (node:test)
```

## Запуск приёмника

Нужен Python 3.10+. Сторонних библиотек нет.

1. `cp .env.example .env` и впишите длинный секрет (команда для генерации в `.env.example`).
2. Загрузите переменные и запустите:
   - Linux/macOS: `set -a; source .env; set +a; python src/capture_receiver.py`
   - PowerShell: задайте `$env:COLLECTOR_SECRET = "..."`, затем `python src\capture_receiver.py`

Приёмник слушает только `127.0.0.1:8765`. Снимки лежат в `data/raw/snapshots/`,
журнал наблюдений в `data/raw/observations.jsonl`.

## Установка расширения

1. LibreWolf/Firefox: `about:debugging#/runtime/this-firefox` → «Загрузить временное
   дополнение» → `extension/manifest.json`. Chrome/Edge/Brave: `chrome://extensions` →
   режим разработчика → «Загрузить распакованное» → папка `extension/`.
2. Firefox/LibreWolf: в `about:addons` → расширение → «Разрешения» проверьте, что доступ
   к сайтам Teams и `127.0.0.1` включён.
3. Секрет (один раз): откройте консоль фонового скрипта (`about:debugging` → «Исследовать»,
   в Chrome: service worker на странице расширения) и выполните
   `(globalThis.browser ?? chrome).storage.local.set({ collectorSecret: "<секрет из .env>" })`.
4. После этапа 0 впишите адреса в `URL_PATTERNS` в `extension/hook.js` (единственное место,
   которое редактируется) и добавьте домены встроенных приложений в `matches` манифеста.
   Домены входа (`login.microsoftonline.com`) не добавляйте.

## Этап 0: образцы из HAR

```
python src/har_sampler.py session.har "Kolokwium 1" --save-dir samples/
```

HAR содержит токены и cookie: не храните его после запуска. В образцы заголовки, cookie
и параметры адресов не попадают, но тела ответов могут содержать личные данные.

## Проверки

```
PYTHONPATH=src python -m unittest discover -s tests   # Python
npm test                                              # расширение (Node 20+)
npm install --save-dev --save-exact eslint @eslint/js prettier   # один раз, фиксирует версии
npm run lint && npm run format:check                  # JS
pip install -r requirements-dev.txt && ruff check . && ruff format --check .   # Python
```

Перед коммитом пройдите чек-лист из `CODING_RULES.md`. Тесты не заменяют ручную проверку
в живом браузере (критерии этапа 1 в инструкции).

