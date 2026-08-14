# GradeTrack

GradeTrack is a local academic dashboard and automation stack for tracking grades, assignments, trends, and AI-generated insights. It combines a FastAPI dashboard server, a client-side single-page UI, a compute layer that normalizes grade data, a scrape runner that refreshes the underlying JSON files, an AI assistant that can answer questions from the current grade state, and a Blooket Quiz Builder that turns a class's latest Trilium chapter into a publishable Blooket question set.

The project is intentionally split into a few active surfaces:

- The dashboard shell and styling live in [gradetrack/index.html](gradetrack/index.html).
- The interactive dashboard logic lives in [gradetrack/js/app.js](gradetrack/js/app.js).
- The main API, authentication, computed-data endpoints, and scrape launcher live in [dashboard_server.py](dashboard_server.py).
- Grade normalization and derived analytics live in [compute_bridge.py](compute_bridge.py) and [grades_analytics.py](grades_analytics.py).
- AI insight generation and chat/tool handling live in [ai_insights.py](ai_insights.py).
- The scrape runner and data refresh job live in [sis_login.py](sis_login.py).
- Email notifications for grade-change and error workflows live in [grades_emailer.py](grades_emailer.py).
- Google Classroom intake support lives in [api_server.py](api_server.py) and [classroom_client.py](classroom_client.py).
- Blooket quiz generation and publishing live in [blooket_builder.py](blooket_builder.py) and the [blooket-bot/](../blooket-bot/) subproject.
- Trilium note-tree access (used as the quiz source material) lives in [trilium_client.py](trilium_client.py).

## What This System Offers

GradeTrack is more than a grade viewer. It is a small operating system for academic data:

- A dashboard that shows overall grades, class trends, assignments, calendar/planner views, goals, and insight panels.
- A reports view that compares classes over time and renders theme-aware charts.
- A settings area for API keys, goal thresholds, theme choice, auto-refresh, automatic scrapes, and scrape logs.
- A live AI chat surface that can inspect the current grade data, follow conversation history, and answer with Markdown.
- Current-quarter class context for AI questions, so the assistant sees the most relevant term before falling back to yearly data.
- Manual and automatic scrape execution so the data store can be refreshed on a schedule.
- Persistent scrape logs so failed or successful runs can be inspected later.
- Error email support for scrape failures and related operational issues.
- A Blooket Quiz Builder that generates a quiz from a class's latest Trilium chapter and publishes it to Blooket, returning a playable set link.

In practice, this makes GradeTrack a combination of:

- dashboard UI
- grade computation engine
- automation runner
- AI-assisted analysis tool
- lightweight operational console for the underlying student-data pipeline

## Important Project Layout Note

The service runs `dashboard_server.py` from the project root (`/home/ahepworth/facts-stats/`), so the Python files Python imports (`dashboard_server.py`, `blooket_builder.py`) **must live at the repo root**. The same two files also exist at `gradetrack/dashboard_server.py` and `gradetrack/blooket_builder.py` as synced copies for convenient in-editor browsing alongside `gradetrack/js/app.js` and `gradetrack/index.html`. **The root copies are the ones that actually execute** — the `gradetrack/` copies are never imported. Whenever you edit either Python file, edit the root copy first, then run:

```bash
cp dashboard_server.py gradetrack/dashboard_server.py
cp blooket_builder.py gradetrack/blooket_builder.py
sudo systemctl restart facts-dashboard.service
```

Skipping the root copy is the single most common cause of "I edited the file but nothing changed." The frontend assets (`gradetrack/js/app.js`, `gradetrack/index.html`) do not have this problem — they only live in `gradetrack/`.

## How The Pieces Fit Together

The active flow looks like this:

1. Raw grade data is stored in JSON files such as [grades_data.json](grades_data.json) and [grades_history.json](grades_history.json).
2. The compute layer in [grades_analytics.py](grades_analytics.py) and [compute_bridge.py](compute_bridge.py) merges current and historical data into the exact dashboard shape.
3. [dashboard_server.py](dashboard_server.py) exposes that computed payload through endpoints like `/api/computed`, `/api/computed/overview`, `/api/computed/classes`, and `/api/computed/assignments`.
4. The browser loads [gradetrack/index.html](gradetrack/index.html), which in turn loads [gradetrack/js/app.js](gradetrack/js/app.js).
5. The frontend fetches the computed endpoints, renders the overview, reports, goals, planner, calendar, insights, and settings views, and keeps the UI state synchronized.
6. The AI layer in [ai_insights.py](ai_insights.py) receives the current computed payload plus conversation history and can call tools to inspect classes or save insights.
7. The scrape runner in [sis_login.py](sis_login.py) refreshes the underlying JSON data, while [dashboard_server.py](dashboard_server.py) streams live logs to the UI.
8. Optional notifications can be sent through [grades_emailer.py](grades_emailer.py).

## Main User-Facing Features

### Dashboard Overview

The dashboard shows a high-level academic summary, including overall grade state, class-level trends, watchlist items, and assignment rollups. Most of the data comes from the `/api/computed` family of routes in [dashboard_server.py](dashboard_server.py), with the rendering handled by [gradetrack/js/app.js](gradetrack/js/app.js).

### Reports And Trends

The reports area compares multiple classes over time, shows trend direction, and renders the overall average line with theme-aware colors. This is the section that matters when you want to answer questions like:

- Which class is declining fastest?
- What is the current overall average across selected classes?
- How do category averages change over time?

The chart logic lives in [gradetrack/js/app.js](gradetrack/js/app.js), while the underlying period data is built by [compute_bridge.py](compute_bridge.py).

### Assignments, Calendar, Planner, And Goals

The frontend also provides assignment browsing, calendar navigation, a planner view, and a goals view. These are all rendered client-side in [gradetrack/js/app.js](gradetrack/js/app.js) using the normalized data from the backend.

### AI Coach And Insight Generation

The AI assistant is not a generic chat box. It is wired directly to grade facts:

- It receives the current grade snapshot and the active conversation.
- It can inspect class data through tool calls.
- It prefers the current quarter for each class, with the yearly summary as backup context.
- It can save user-requested insights back into the persisted insights file.

The AI logic lives in [ai_insights.py](ai_insights.py), while the chat UI and Markdown rendering live in [gradetrack/js/app.js](gradetrack/js/app.js) and [gradetrack/index.html](gradetrack/index.html).

### Settings, Refresh, And Logs

The settings view is an operational control panel. It includes:

- API key storage and masking
- goal configuration
- tracked class configuration
- theme selection
- auto-refresh interval controls
- automatic scrape scheduling
- scrape log output

The server side for settings is in [dashboard_server.py](dashboard_server.py), and the UI is in [gradetrack/js/app.js](gradetrack/js/app.js).

### Blooket Quiz Builder

The planner view shows a Blooket card for each class that has a linked Trilium note. Clicking the card opens a modal where an optional AI focus prompt can be entered (Enter submits, Esc/X closes). The pipeline then runs in three stages:

1. **Generate** — [blooket_builder.py](blooket_builder.py) resolves the class's linked note, picks its latest chapter via [trilium_client.py](trilium_client.py), and asks Ollama Cloud to turn the chapter content into multiple-choice questions in Blooket's exact 8-column CSV template.
2. **Publish** — [blooket-bot/test.py](../blooket-bot/test.py) drives a real Chromium (nodriver) session on the Pi over VNC: it logs into Blooket, opens the create page, fills the title/description via React-safe input injection, uploads the generated CSV, and captures the new set's ID.
3. **Result** — the frontend polls [blooket_builder.py](blooket_builder.py)'s job state every 2.5s and finally shows a green success card with the playable set link, or a red card with the failure reason from the live logs.

Classes are linked to notes in `data/settings.json` under `trilium.notes` (`class_id -> note info`). The pipeline is a single-job state machine (`idle | generating | publishing | done | failed`), and a `409` is returned if a job is already running.

## Active Files Reference

### Dashboard Shell

- [gradetrack/index.html](gradetrack/index.html) sets up the page shell, theme CSS variables, AI markdown styling, and the responsive layout.

### Frontend Logic

- [gradetrack/js/app.js](gradetrack/js/app.js) handles rendering, navigation, theme switching, AI chat, chart drawing, scrape polling, settings editing, and state management.

### Main Backend

- [dashboard_server.py](dashboard_server.py) serves the dashboard, handles authentication, exposes settings and computed-data endpoints, starts scrapes, publishes scrape logs, and hosts the `/api/blooket/*` and `/api/trilium/*` routes.

### Compute And Analytics

- [compute_bridge.py](compute_bridge.py) produces the derived dashboard payload.
- [grades_analytics.py](grades_analytics.py) normalizes raw grade data, merges history, and builds watchlists and summary stats.
- [build_dashboard_v2.py](build_dashboard_v2.py) is the older HTML/dashboard builder that still exists in the repository as a generator for the standalone dashboard output.

### AI

- [ai_insights.py](ai_insights.py) handles insight storage, chat requests, tool calls, current-quarter payload shaping, and AI response validation.

### Scraping And Notifications

- [sis_login.py](sis_login.py) runs the scrape job that refreshes the grade data.
- [grades_emailer.py](grades_emailer.py) formats and sends email notifications.

### Classroom Ingestion

- [api_server.py](api_server.py) is a small Flask service that accepts Google Classroom homework payloads.
- [classroom_client.py](classroom_client.py) is the local client-side helper that reads the stored classroom payload.

### Blooket And Trilium

- [blooket_builder.py](blooket_builder.py) generates Blooket CSVs from Trilium chapter content via Ollama Cloud, runs the single-job pipeline, launches the browser bot, and parses the resulting set URL.
- [trilium_client.py](trilium_client.py) talks to the Trilium ETAPI for class-note mapping, note/content lookups, and `latest_chapter` selection; it also backs the `/api/trilium/*` routes.
- [../blooket-bot/test.py](../blooket-bot/test.py) is the publish bot: Blooket login, set creation, CSV upload via JS file-input interception, and set-ID capture. Credentials come from [../blooket-bot/config.py](../blooket-bot/config.py), and it runs under the project's own venv (nodriver + Chromium) with `DISPLAY=:1` for the Pi's VNC session.

### Frontend (Blooket)

- The planner renders Blooket cards, the modal (optional AI prompt, Enter submits), and the 2.5s job-status polling with success/failure cards in [gradetrack/js/app.js](gradetrack/js/app.js).

### Blooket Set Edit & Levels Backend

- [blooket_builder.py](blooket_builder.py) also owns `load_saved_sets`, `find_set_by_url`, `update_set`, and `delete_set`, which read and write [data/blooket_sets.json](data/blooket_sets.json). These power the edit/delete/review-mode flows below.
- [dashboard_server.py](dashboard_server.py) exposes them via `GET /api/blooket/set?setUrl=…`, `PATCH /api/blooket/set`, `DELETE /api/blooket/set`. PATCH/DELETE also invalidate the `_blooket_classes_cache` mtime key so the next `/api/blooket/classes` read is fresh.

## Blooket Quiz Builder (Full)

The planner's review surface is more than a quiz launcher — it is the editor and the levels engine.

### Review Grid And The Set Card

- Each set card displays the AI-generated title (falling back to `chapterTitle`), the chapter count, the "in Blooket" count, the date, the per-set accuracy ring (color from `accRingColor`), and — once a levels run has started — a level tag with the level name, the level ring percentage, and a "needs review" count.
- Clicking the card body opens the set detail screen. Clicking the split-button's "Play" half (after hovering) starts the quiz. The "Blooket" half opens the set on blooket.com.
- A "+ New set" button on the planner launches the custom-paste/upload flow.

### Set Detail Screen

- The set detail screen takes over `#view-container` as a `#set-detail-screen` (same pattern as the quiz), with `max-w-5xl` so it fills the available width.
- Header row: back chevron button (Esc returns to the review grid), "Set details" + chapter subtitle, Delete button (with confirm).
- Editable AI name (`<input>`, blur-saves via `saveSetField`).
- Editable description (`<textarea>`, blur-saves).
- A small "From chapter note" callout when `sourceNoteId` is present.
- "Expand all" checkbox toggles `state.expandAllQuestions` and re-renders.
- Question accordion: each question row is collapsed by default. Click anywhere on the row to toggle. The chevron rotates 90° when open.
- Per-question controls: editable question text, editable option inputs (blur-saves), letter badges that mark the correct answer (green), add-option "+" button (max 6), remove-option "×" button (min 2), delete-question "×" button.
- "Add new question" button at the bottom appends a new 4-option empty question and auto-opens it.
- `saveQuestionField`, `saveOptionText`, `setCorrectAnswer`, `addQuestionOption`, `removeQuestionOption`, `addNewQuestion`, `deleteQuestion` all hit `PATCH /api/blooket/set` with the updated `questions` array.

### Levels Engine

- Lives entirely in [gradetrack/js/app.js](gradetrack/js/app.js). Constants: `LEVELS` (unknown/familiar/proficient/mastered colors), `LEVELS_STORE = 'gradetrack-levels-v1'` (localStorage).
- Toggleable in Settings → Review & AI ("Levels-based review"). The toggle updates `state.levelsEnabled`, immediately calls `updateToggleUI(cb)`, and persists via `POST /api/settings`.
- A classic quiz call goes through `startQuiz` → `startLevelsQuiz` when the flag is on. Otherwise it stays classic.
- Per-card state: `{ lvl: 0..3, nr: bool, done3: bool }`. Cards start at `lvl: 0` (unknown).
- Rounds 0..3 each show only cards at or below the current round's level. Correct answers splice the card out and bump its level. Wrong answers call `requeueLevelsCard` which re-inserts at `pos + 4..8` (gap random) and pads with "above-round" fillers if needed. `applyLevelsAnswer` saves after every answer.
- `roundComplete` flips to `pendingLevelUp` → `renderLevelUp` shows the level-up screen with "Continue to '{next level}'" or "Complete mastery".
- After round 3 is fully mastered, `st.round = 4` and `showLevelsMastered` renders. The user can choose **Continue reviewing** (enters `reviewMode` — every card eligible, correct splices, wrong requeues at +4..8, queue auto-restarts when drained) or **Back to Review** (returns to the planner).
- Per-set progress is visible on the review cards: the level tag chip with a level ring, the level name, and a "·N" needs-review badge.
- Per-quiz accuracy persists per answer via `recordQuizAnswer` so quitting mid-set doesn't lose the session.

### AI Generation Output Format

- [blooket_builder.py](blooket_builder.py)'s `BLOOKET_SYSTEM_PROMPT` asks Ollama to output two header lines before the CSV:
  1. `TITLE: <short review title drawn from the material>`
  2. `DESCRIPTION: <one sentence describing what this quiz covers>`
- The parser splits these out into `ai_title` and `ai_description` and saves both into [data/blooket_sets.json](data/blooket_sets.json) alongside the questions. Existing sets without descriptions still load (description defaults to empty string).

### Set Detail API Endpoints

| Method | Path | Body | Effect |
| ------ | ---- | ---- | ------ |
| `GET`    | `/api/blooket/set?setUrl=…`        | —                                         | Returns `{ set, classId, key }` or 404. |
| `PATCH`  | `/api/blooket/set`                  | `{ setUrl, title?, description?, questions? }` | Updates matching fields in `data/blooket_sets.json`, invalidates the classes cache. 404 if `setUrl` not found. |
| `DELETE` | `/api/blooket/set`                  | `{ setUrl }`                              | Removes the entry from `data/blooket_sets.json`, invalidates the classes cache. 404 if not found. |

All three endpoints require a valid `setUrl`. `PATCH` and `DELETE` both invalidate `_blooket_classes_cache["mtime"]` so the next `/api/blooket/classes` reads from disk.

## Runtime Data

The repository uses a mix of JSON files and generated output:

- [grades_data.json](grades_data.json) stores the current scraped grade snapshot.
- [grades_history.json](grades_history.json) stores historical grade data.
- [classroom_latest.json](classroom_latest.json) stores the most recent classroom payload.
- [data/ai_insights.json](data/ai_insights.json) stores saved AI insights and manual insights.
- [data/settings.json](data/settings.json) stores dashboard settings.
- [data/classroom_latest.json](data/classroom_latest.json) is an alternate classroom cache used by the frontend/tooling.
- [blooket-bot/sets/](../blooket-bot/sets/) holds the generated Blooket CSVs from pipeline runs.
- [data/blooket_sets.json](data/blooket_sets.json) stores the per-class and "custom" set records: `{ setUrl, sourceNoteId, title, description, questionCount, chapterTitle, createdAt, questions: [...] }`. Edited through the set detail screen; cleared from cache via the PATCH/DELETE routes.
- `localStorage['gradetrack-levels-v1']` stores per-set levels progress in the browser (round, done, queue, cards). Lives only client-side; the server is not aware of levels state.

## Running The System

The project is designed to run locally on the machine that has access to the grade source and the JSON files.

Typical startup patterns are:

```bash
python3 dashboard_server.py
```

The dashboard server serves the UI, exposes the API, and starts the background scrape scheduler.

If you only need the Classroom intake endpoint:

```bash
python3 api_server.py
```

The lightweight proxy helper in [dev_server.py](dev_server.py) can be used when you want a simple static server that forwards `/api/*` requests to the API target.

## Configuration

The code reads from `.env` when present. Common settings include:

- `REQUIRE_CF_ACCESS`
- `CF_ACCESS_EMAILS` or `CF_ACCESS_EMAIL`
- `DASHBOARD_ACCESS_TOKEN_HASH`
- `DASHBOARD_SESSION_SECRET`
- `DASHBOARD_COOKIE_SECURE`
- `CLASSROOM_API_KEY`
- SMTP-related variables used by [grades_emailer.py](grades_emailer.py)
- Ollama Cloud settings used by [ai_insights.py](ai_insights.py)
- `REQUIRE_CF_ACCESS=false` to run a throwaway no-auth instance (used for Blooket pipeline tests)

The settings object exposed through the dashboard API also stores:

- `goal`
- `perClassGoals`
- `trackedClassIds`
- `apiKeys`
- `autoScrape`
- theme and refresh preferences
- `ollamaModel` — the model used for quiz generation (default `gpt-oss:120b`)
- `apiKeys.ollama` — the Ollama Cloud bearer token used for both chat and quiz generation
- `trilium` — Trilium ETAPI `url`/`token` plus the `notes` mapping that links each class ID to a note for quiz source material

## Why The Project Is Structured This Way

The repository separates concerns so that each layer is easy to reason about:

- The browser handles presentation and interaction.
- The FastAPI server handles security, route orchestration, and job management.
- The compute layer keeps the dashboard data shape stable.
- The AI layer is isolated so chat/tool behavior can evolve without disturbing the UI.
- The scrape and email jobs stay independent so automation can run even when the frontend is closed.

That separation also makes it easier to add new surfaces later, such as classroom caching, additional report charts, or richer insight-generation logic.

## Legacy And Archive Material

The repository includes older HTML examples and prior dashboard prototypes in [old_frontend/](old_frontend/). Those files are useful as references, but they are not the main active application surface.

## Short Version

If you only want the one-sentence description:

GradeTrack is a local, AI-assisted academic dashboard that computes grade trends, displays reports and assignments, runs scrapes, stores logs and settings, exposes the current grade state to a conversational assistant, and generates ready-to-play Blooket quizzes from each class's latest chapter.