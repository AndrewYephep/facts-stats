import nodriver as uc
import asyncio
import argparse
import random
import logging

# --- CREDENTIALS (SIS only) ---
try:
    from config import DISTRICT_CODE
except Exception:
    DISTRICT_CODE = None

try:
    from config import SIS_USERNAME, SIS_PASSWORD
except Exception:
    SIS_USERNAME = None
    SIS_PASSWORD = None

from grades_config import (
    ACADEMIC_YEAR,
    CURRENT_TERM,
    GRADES_HISTORY_PATH,
    GRADES_JSON_PATH,
    SCRAPE_TERMS,
    should_skip_class,
)

# --- LOGGING ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)


def _write_new_grades_marker(changes):
    import datetime
    import json
    import os

    from grades_emailer import _assignment_key

    def _key(current):
        return _assignment_key(
            current['classid'],
            current['category'],
            {
                'name': current.get('assignment'),
                'due': current.get('due'),
                'max': current.get('max'),
            },
        )

    marker_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'data', 'new_grades.json'
    )
    os.makedirs(os.path.dirname(marker_path), exist_ok=True)
    payload = {
        'term': CURRENT_TERM,
        'academic_year': ACADEMIC_YEAR,
        'savedAt': datetime.datetime.now().isoformat(timespec='seconds'),
        'new': [{**g['current'], 'key': _key(g['current'])} for g in changes.get('new_grades', [])],
        'updated': [{**g['current'], 'key': _key(g['current'])} for g in changes.get('updated_grades', [])],
    }
    with open(marker_path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2)
    log.info(
        'Wrote %s new / %s updated grade markers to data/new_grades.json',
        len(payload['new']),
        len(payload['updated']),
    )


async def human_delay(min=0.5, max=2.0):
    delay = random.uniform(min, max)
    log.info(f"Waiting {delay:.2f}s")
    await asyncio.sleep(delay)


async def human_type(element, text):
    for char in text:
        await element.send_keys(char)
        await asyncio.sleep(random.uniform(0.05, 0.18))


async def human_mouse_wander(page, moves=3):
    for _ in range(moves):
        try:
            import random as _r
            x = _r.randint(100, 900)
            y = _r.randint(100, 600)
            await page.mouse_move(x, y)
        except Exception:
            pass
        await asyncio.sleep(random.uniform(0.2, 0.6))


async def human_click(element):
    try:
        await element.mouse_move()
    except Exception:
        pass
    await asyncio.sleep(random.uniform(0.2, 0.5))
    await element.click()


async def click_signin_simple(page, element):
    """Click the nbs-button, using JS click first to pierce shadow DOM."""
    try:
        await page.evaluate("el => el.click()", element)
        log.info("Sign In clicked via JS")
        return True
    except Exception as e:
        log.warning(f"JS click failed, trying direct click: {e}")
    try:
        await element.click()
        log.info("Sign In button clicked directly")
        return True
    except Exception as e:
        log.error(f"All click attempts failed: {e}")
        return False


async def find_input_by_placeholder(page, placeholder):
    await human_delay(1, 2)
    inputs = await page.select_all("input")
    for inp in inputs:
        try:
            ph = inp.attrs.get("placeholder", "")
            if ph and placeholder.lower() in ph.lower():
                return inp
        except Exception as e:
            log.debug(f"Skipping input: {e}")
            continue
    return None


async def find_button_by_text(page, text):
    # Generic search across clickable elements (include spans/divs for this site)
    candidates = await page.select_all("button, input[type=submit], a, span, div")
    for c in candidates:
        try:
            html = await c.get_html()
            if text.lower() in html.lower():
                return c
        except Exception:
            continue
    return None


async def find_signin_button(page):
    """Find the sign-in button via CSS attribute selectors."""
    for selector in [
        "nbs-button[arialabel*='Sign In']",
        "nbs-button[arialabel*='sign in']",
        "button[type='submit']",
        "nbs-button",
    ]:
        try:
            el = await page.select(selector)
            if el:
                log.info(f"Found sign-in button via selector: {selector}")
                return el
        except Exception as e:
            log.debug(f"Selector {selector!r} failed: {e}")
    return None


def is_placeholder_option(opt):
    if not str(opt.get('value', '')).strip():
        return True
    if 'select a class' in opt.get('text', '').lower():
        return True
    return False


def parse_select_options_from_html(html):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    select = soup.find('select')
    nodes = select.find_all('option') if select else soup.find_all('option')
    options = []
    for o in nodes:
        options.append({
            'value': o.get('value', ''),
            'text': o.get_text(strip=True),
            'dataset': {k: v for k, v in o.attrs.items() if k.startswith('data-')},
        })
    return options


async def get_select_html(select_el):
    try:
        return await select_el.get_html()
    except Exception:
        return str(select_el)


async def get_gradebook_context(page, browser):
    """Return (tab, select_el) for the gradebook class dropdown, searching iframes."""
    log.info("Looking for select.fclassid (including iframes)...")
    selects = []
    try:
        selects = await page.select_all("select.fclassid", timeout=30, include_frames=True) or []
    except Exception as e:
        log.info(f"select_all with include_frames failed: {e}")

    if selects:
        best = None
        best_count = 0
        for sel in selects:
            html = await get_select_html(sel)
            opts = parse_select_options_from_html(html)
            real = [o for o in opts if not is_placeholder_option(o)]
            if len(real) > best_count:
                best_count = len(real)
                best = sel
        if best:
            log.info(f"Found select.fclassid via include_frames ({best_count} classes)")
            return page, best

    log.info("Trying iframe-tab fallback for gradebook select...")
    try:
        iframes = await page.select_all("iframe") or []
        for iframe_el in iframes:
            try:
                frame_id = iframe_el.frame_id
                if not frame_id:
                    continue
                iframe_tab = next(
                    (t for t in browser.targets if str(t.target.target_id) == str(frame_id)),
                    None,
                )
                if iframe_tab is None:
                    continue
                if getattr(iframe_tab, 'websocket_url', None):
                    iframe_tab.websocket_url = iframe_tab.websocket_url.replace("iframe", "page")
                select_el = await iframe_tab.select("select.fclassid", timeout=10)
                if select_el:
                    log.info(f"Found select.fclassid in iframe tab (frame_id={frame_id})")
                    return iframe_tab, select_el
            except Exception as e:
                log.debug(f"iframe candidate failed: {e}")
    except Exception as e:
        log.info(f"iframe-tab fallback failed: {e}")

    return None, None


async def get_term_select(tab):
    try:
        selects = await tab.select_all("select.ftermid", timeout=15, include_frames=True) or []
        return selects[0] if selects else None
    except Exception as e:
        log.debug(f"get_term_select failed: {e}")
        return None


async def switch_term_option(tab, term_select, val):
    import json
    val_css = str(val).replace("'", "\\'")
    options = []
    try:
        options = await tab.select_all(
            f"select.ftermid option[value='{val_css}']",
            timeout=10,
            include_frames=True,
        ) or []
    except Exception as e:
        log.debug(f"term option select_all failed: {e}")

    if options:
        try:
            await options[0].select_option()
            log.info(f"select_option() term={val}")
            return True
        except Exception as e:
            log.warning(f"select_option() on option failed: {e}")

    # Log the select element HTML to help debugging (trimmed)
    try:
        html = await get_select_html(term_select)
        log.info(f"term_select HTML (trimmed): {str(html)[:1000]}")
    except Exception as e:
        log.debug(f"could not get term_select html: {e}")

    # Try setting value via JS and dispatching change, then verify
    try:
        val_js = json.dumps(str(val))
        await term_select.apply(
            f"(s) => {{ s.value = {val_js}; s.dispatchEvent(new Event('change', {{ bubbles: true }})); }}"
        )
        log.info(f"apply() set term value={val}")
        try:
            ok = await verify_select_value(term_select, val)
            if ok:
                return True
            log.warning("apply() did not set expected value; will try fallback search")
        except Exception:
            log.debug("verify_select_value failed after apply()")
    except Exception as e:
        log.warning(f"switch_term_option apply failed for value={val}: {e}")

    # Final fallback: search for option elements across frames and try selecting them directly
    try:
        opts = await tab.select_all("select.ftermid option", timeout=10, include_frames=True) or []
        for o in opts:
            try:
                v = await o.apply("(el) => el.value")
            except Exception:
                v = None
            if str(v) == str(val):
                try:
                    await o.select_option()
                    log.info("Fallback selected term option via option.select_option()")
                    return True
                except Exception as e:
                    log.warning(f"Fallback select_option failed: {e}")
    except Exception as e:
        log.debug(f"fallback option search failed: {e}")

    return False


async def switch_class_option(tab, select_el, val):
    """Select a class in the dropdown and fire change."""
    import json
    val_css = val.replace("'", "\\'")
    options = []
    try:
        options = await tab.select_all(
            f"select.fclassid option[value='{val_css}']",
            timeout=10,
            include_frames=True,
        ) or []
    except Exception as e:
        log.debug(f"option select_all failed: {e}")

    if options:
        await options[0].select_option()
        log.info(f"select_option() for value={val}")
        return True

    try:
        val_js = json.dumps(val)
        await select_el.apply(
            f"(s) => {{ s.value = {val_js}; "
            f"s.dispatchEvent(new Event('change', {{ bubbles: true }})); }}"
        )
        log.info(f"apply() set select value={val}")
        return True
    except Exception as e:
        log.warning(f"switch_class_option failed for value={val}: {e}")
        return False


async def verify_select_value(select_el, expected_val):
    try:
        result = await select_el.apply("(s) => s.value")
        if isinstance(result, (list, tuple)) and result:
            current = result[0]
        else:
            current = result
        ok = str(current) == str(expected_val)
        if not ok:
            log.warning(f"Select value is {current!r}, expected {expected_val!r}")
        return ok
    except Exception as e:
        log.debug(f"verify_select_value failed: {e}")
        return False


async def fetch_gradebook_html(tab, timeout=20):
    """Return full gradebook markup from div.gradebook_native (not just the h3 title)."""
    loop = asyncio.get_running_loop()
    start = loop.time()
    while loop.time() - start < timeout:
        containers = await tab.select_all(
            "div.gradebook_native", timeout=3, include_frames=True
        ) or []
        for container in containers:
            try:
                html = await container.get_html()
            except Exception:
                html = str(container)
            if html and len(html) > 500 and "grades_head" in html:
                return html
        await asyncio.sleep(0.5)
    log.warning("fetch_gradebook_html timed out")
    return None


async def wait_for_class_gradebook(tab, val, text, timeout=20):
    """After class select changes, wait until the visible gradebook reflects that class."""
    short_name = text.split('(')[-1].rstrip(')').strip() if '(' in text else text
    markers = [short_name[:12], f"gradebook_{val}_"]
    loop = asyncio.get_running_loop()
    start = loop.time()
    while loop.time() - start < timeout:
        html = await fetch_gradebook_html(tab, timeout=3)
        if not html:
            await asyncio.sleep(0.5)
            continue
        if "Term Grade" not in html:
            await asyncio.sleep(0.5)
            continue
        upper = html.upper()
        if any(m.upper() in upper for m in markers if m):
            return html
        await asyncio.sleep(0.5)
    return await fetch_gradebook_html(tab, timeout=5)


def _class_names(el):
    c = el.get('class') or []
    return c if isinstance(c, list) else [c]


async def open_sis_and_report(browser, terms=None, class_selector='all'):
    # --- PRE-CHECK: Already logged in? ---
    dashboard_url = "https://sis.factsmgt.com/family-portal/en-us/student/index?familyId=994036&schoolCode=&bypassFamilyDashboard=true"
    log.info(f"Checking if already logged in via {dashboard_url}")
    page = await browser.get(dashboard_url)

    # Poll until the URL settles - either stays on sis.factsmgt.com (logged in)
    # or redirects to /accounts/Account/Login (not logged in)
    current_url = ""
    for attempt in range(30):
        try:
            current_url = await page.evaluate("window.location.href")
            ready = await page.evaluate("document.readyState")
        except Exception:
            current_url = ""
            ready = None
        log.info(f"Login check attempt {attempt + 1}: url={current_url} readyState={ready}")
        if not current_url:
            await asyncio.sleep(0.5)
            continue
        # Settled on login page - not logged in
        if '/accounts/Account/Login' in current_url and ready == 'complete':
            log.info("Not logged in, proceeding with login flow...")
            break
        # Settled on a real SIS page - logged in
        if 'sis.factsmgt.com' in current_url and '/accounts/Account/Login' not in current_url and ready == 'complete':
            log.info(f"Already logged in! Landing URL: {current_url}")
            result = {"url": current_url, "already_logged_in": True}
            return await scrape_class_options(page, result, browser)
        await asyncio.sleep(0.5)
    else:
        log.warning("Login check timed out, assuming not logged in...")

    url = "https://sis.factsmgt.com/family-portal/en-us/school/index?familyId=994036&schoolCode="
    log.info(f"Opening {url}")
    page = await browser.get(url)
    await human_delay(2, 4)

    # Gentle scrolls to mimic a human
    try:
        await page.scroll_down(random.randint(30, 80))
        await human_delay(0.3, 1.0)
        await page.scroll_up(random.randint(10, 40))
    except Exception:
        pass

    # Wait for initial page load
    await human_delay(2, 3)

    # --- STEP 1: Enter District Code ---
    log.info("Looking for district code input (rw-district-code)...")
    district_input = await page.select("#rw-district-code")
    if not district_input:
        log.error("Could not find district code input!")
        return page, {"error": "District code input not found"}
    
    log.info(f"Entering district code: {DISTRICT_CODE}")
    await human_click(district_input)
    await human_delay(0.5, 1)
    await human_type(district_input, DISTRICT_CODE)
    await human_delay(1, 2)

    # --- STEP 2: Click Next Button ---
    log.info("Finding and clicking next button...")
    next_btn = await page.select("#next")
    if not next_btn:
        log.error("Could not find next button!")
        return page, {"error": "Next button not found"}
    
    await human_click(next_btn)
    await human_delay(3, 5)

    # --- STEP 3: Wait for login page to load ---
    log.info("Waiting for login page to load after district code submission...")
    initial_url = await page.evaluate("window.location.href")
    log.info(f"Initial URL after submit: {initial_url}")

    username = None
    password = None
    max_attempts = 30
    for attempt in range(max_attempts):
        try:
            current_url = await page.evaluate("window.location.href")
        except Exception:
            current_url = None
        try:
            ready = await page.evaluate("document.readyState")
        except Exception:
            ready = None
        log.info(f"Attempt {attempt + 1}/{max_attempts}: url={current_url} readyState={ready}")
        try:
            username_candidates = await page.select_all("input[type='text'], input[placeholder*='user'], input[placeholder*='email'], #mat-input-0")
            password_candidates = await page.select_all("input[type='password'], #mat-input-1")
        except Exception as e:
            log.debug(f"select_all failed on attempt {attempt + 1}: {e}")
            username_candidates = []
            password_candidates = []
        if username_candidates:
            username = username_candidates[0]
        if password_candidates:
            password = password_candidates[0]
        if username or password or (current_url and current_url != initial_url and ('login' in (current_url or '') or 'account' in (current_url or '') or 'signin' in (current_url or ''))):
            log.info(f"Detected navigation or inputs on attempt {attempt + 1}")
            break
        await asyncio.sleep(0.5 + min(attempt * 0.2, 2.0))

    try:
        current_url = await page.evaluate("window.location.href")
    except Exception:
        current_url = initial_url

    result = {
        "url": current_url,
        "district_code_submitted": True,
        "username_field_found": bool(username) if 'username' in locals() else False,
        "password_field_found": bool(password) if 'password' in locals() else False,
    }

    tried_autofill = False
    clicked_submit = False
    if (result['username_field_found'] or result['password_field_found']) and SIS_USERNAME and SIS_PASSWORD:
        tried_autofill = True
        try:
            user_el = await page.select('#mat-input-0') or await page.select("input[type='text']")
            pass_el = await page.select('#mat-input-1') or await page.select("input[type='password']")

            if user_el:
                log.info('Filling SIS username...')
                await human_click(user_el)
                await human_delay(0.3, 0.8)
                await human_type(user_el, SIS_USERNAME)
                await human_delay(0.5, 1.0)

            if pass_el:
                log.info('Filling SIS password...')
                await human_click(pass_el)
                await human_delay(0.3, 0.8)
                await human_type(pass_el, SIS_PASSWORD)
                await human_delay(0.5, 1.0)

            # Natural mouse movement before clicking submit
            await human_mouse_wander(page)

            # Target the real button rendered inside nbs-button by Angular
            submit_el = await page.select("button[aria-label='sign in'][type='submit']") or await page.select("button[type='submit']")
            if submit_el:
                log.info('Clicking submit button...')
                ok = await click_signin_simple(page, submit_el)
                clicked_submit = bool(ok)

                # Wait for full redirect back to sis.factsmgt.com
                # page.evaluate() doesn't work on this site so use find() to
                # detect a known SIS dashboard element instead
                log.info('Waiting for post-login redirect to complete...')
                try:
                    await page.find("School", timeout=60)
                    log.info("Successfully redirected to SIS after login.")
                    await human_delay(2, 3)
                except Exception:
                    log.warning("Post-login redirect timed out, proceeding anyway")
                await human_delay(2, 3)

        except Exception as e:
            log.debug(f'Autofill failed: {e}')

    result['autofill_attempted'] = tried_autofill
    result['submit_clicked'] = clicked_submit

    log.info(f"Page URL: {result['url']}")
    log.info(f"Username field found: {result['username_field_found']}")
    log.info(f"Password field found: {result['password_field_found']}")

    # --- STEP 5: Navigate to grades and scrape class options ---
    page, result = await scrape_class_options(page, result, browser, terms, class_selector)

    return page, result


async def scrape_class_options(page, result, browser, terms=None, class_selector='all'):
    grades_url = "https://sis.factsmgt.com/family-portal/en-us/student/grades"
    log.info(f"Navigating to grades page: {grades_url}")
    await asyncio.sleep(5)
    page = await page.get(grades_url)
    await human_delay(3, 5)

    import json

    # Wait for page and process events
    await asyncio.sleep(5)
    await page  # let nodriver process pending events

    tab, select_el = await get_gradebook_context(page, browser)
    if not select_el:
        log.error("Could not find class select element after all attempts")
        result['class_options'] = []
        return page, result

    tab = tab or page

    try:
        html = await get_select_html(select_el)
        options = parse_select_options_from_html(html)
        options = [o for o in options if not is_placeholder_option(o)]
        log.info(f"Class options ({len(options)} found):")
        for opt in options:
            log.info(json.dumps(opt))
        result['class_options'] = options
    except Exception as e:
        log.error(f"Failed to parse class options: {e}")
        result['class_options'] = []
        return page, result

    if not result['class_options']:
        log.error("No class options after filtering placeholders")
        return page, result

    from datetime import datetime

    term_select = await get_term_select(tab)
    if not term_select:
        log.warning("Term select (select.ftermid) not found; using default term only")

    tracked = [
        o for o in result['class_options']
        if o['dataset'].get('data-classid')
        and not should_skip_class(o['dataset']['data-classid'], o['text'])
    ]
    if class_selector and class_selector.lower() != 'all':
        requested = {part.strip().lower() for part in class_selector.split(',') if part.strip()}
        tracked = [o for o in tracked if o['dataset'].get('data-classid', '').lower() in requested or o['text'].lower() in requested]
        log.info('Targeted scrape: %s matching class(es)', len(tracked))
    skipped = len(result['class_options']) - len(tracked)
    log.info(f"Tracking {len(tracked)} classes ({skipped} skipped via config)")

    result['academic_year'] = ACADEMIC_YEAR
    result['current_term'] = CURRENT_TERM
    result['updated'] = datetime.now().isoformat(timespec='seconds')
    prior_live = {}
    try:
        with open(GRADES_JSON_PATH, encoding='utf-8') as lf:
            prior_live = json.load(lf)
        result['classes'] = prior_live.get('classes', {})
    except (FileNotFoundError, json.JSONDecodeError):
        result['classes'] = {}

    history = {}
    try:
        with open(GRADES_HISTORY_PATH, encoding='utf-8') as hf:
            history = json.load(hf)
    except FileNotFoundError:
        pass
    except Exception as e:
        log.warning(f"Could not load history: {e}")

    history.setdefault(ACADEMIC_YEAR, {})

    for term in (terms or SCRAPE_TERMS):
        term_key = str(term)
        log.info(f"=== Scraping Quarter {term} ===")
        if term_select:
            if not await switch_term_option(tab, term_select, term_key):
                log.warning(f"Could not switch to term {term}, skipping")
                continue
            await human_delay(2, 4)

        term_snapshot = {}
        prev_term_grade = None
        for opt in tracked:
            val = opt['value']
            text = opt['text']
            classid = opt['dataset'].get('data-classid', '')
            log.info(f"Q{term} — {text} (classid={classid})")
            try:
                switched = await switch_class_option(tab, select_el, val)
                if not switched:
                    log.warning(f"Could not switch to option value={val}")
                    continue
                await human_delay(2, 4)

                # Class changes can refresh the gradebook and reset the term select.
                # Re-acquire the term dropdown and re-apply the requested quarter.
                term_select = await get_term_select(tab) or term_select
                if term_select and not await verify_select_value(term_select, term_key):
                    log.info(f"Re-applying term {term_key} after class change")
                    if not await switch_term_option(tab, term_select, term_key):
                        log.warning(f"Term reset after class change; skipping {text}")
                        continue
                    await human_delay(1, 2)

                if term_select and not await verify_select_value(term_select, term_key):
                    log.warning(f"Term still not set to {term_key} after retry; skipping {text}")
                    continue

                if not await verify_select_value(select_el, val):
                    log.warning(f"Select did not stick at value={val}, skipping scrape")
                    continue

                gradebook_html = await wait_for_class_gradebook(tab, val, text, timeout=20)
                if not gradebook_html:
                    log.warning(f"Could not load gradebook HTML for {text}")
                    continue

                grades = parse_gradebook_html(gradebook_html, text)
                term_grade = grades.get('term_grade')
                if term_grade == prev_term_grade and prev_term_grade is not None:
                    log.warning(
                        f"term_grade unchanged ({term_grade}) — page may not have switched"
                    )
                prev_term_grade = term_grade
                block = {
                    'class_name': text,
                    'term_grade': grades.get('term_grade'),
                    'term_letter': grades.get('term_letter'),
                    'categories': grades.get('categories', []),
                }
                term_snapshot[classid] = block
                log.info(
                    f"  -> {len(block['categories'])} categories, term grade: {term_grade}"
                )
            except Exception as e:
                log.error(f"Failed to scrape {text}: {e}")
                continue
            await human_delay(1, 2)

        if term == CURRENT_TERM:
            for cid, block in term_snapshot.items():
                entry = result['classes'].setdefault(cid, {
                    'class_name': block['class_name'],
                    'quarters': {},
                })
                entry['class_name'] = block['class_name']
                entry['quarters'][term_key] = {
                    'term_grade': block['term_grade'],
                    'term_letter': block['term_letter'],
                    'categories': block['categories'],
                }
        else:
            history[ACADEMIC_YEAR].setdefault(term_key, {}).update(term_snapshot)
            log.info(f"Archived Q{term} to history ({len(term_snapshot)} classes)")

    with open(GRADES_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    log.info(f"Grades data saved to {GRADES_JSON_PATH}")

    with open(GRADES_HISTORY_PATH, 'w', encoding='utf-8') as f:
        json.dump(history, f, indent=2)
    log.info(f"Grades history saved to {GRADES_HISTORY_PATH}")

    try:
        from grades_analytics import build_dashboard_model
        from grades_emailer import build_grade_changes, send_grade_email

        changes = build_grade_changes(prior_live, result, CURRENT_TERM)
        try:
            _write_new_grades_marker(changes)
        except Exception as exc:
            log.warning('Could not persist new-grade markers: %s', exc)
        model = build_dashboard_model(GRADES_JSON_PATH, GRADES_HISTORY_PATH)
        watchlist = model.get('watchlist', [])
        if changes.get('new_grades') or changes.get('updated_grades'):
            try:
                from ai_insights import get_or_generate
                from compute_bridge import compute_derived_data, normalize_grades_data
                from grades_config import load_settings

                settings = load_settings()
                normalized = normalize_grades_data(result, history)
                computed = compute_derived_data(
                    normalized,
                    goal=int(settings.get('goal') or 90),
                    tracked_class_ids=set(settings.get('trackedClassIds') or []) or None,
                    per_class_goals=settings.get('perClassGoals') or {},
                )
                ai_result = get_or_generate(computed, settings)
                log.info('AI insight generation after grade update: %s', ai_result.get('status'))
            except Exception as exc:
                log.warning('AI insight generation failed: %s', exc)
        send_grade_email(
            changes,
            watchlist,
            {
                'updated': result.get('updated'),
                'academic_year': result.get('academic_year'),
                'term': result.get('current_term'),
            },
        )
    except Exception as e:
        log.warning(f"Email notification failed: {e}")

    result['grades_by_class'] = {
        cid: {
            **info['quarters'].get(str(CURRENT_TERM), {}),
            'class_name': info['class_name'],
        }
        for cid, info in result['classes'].items()
    }

    return page, result


def parse_gradebook_html(html, class_name):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    root = soup.find('div', class_='gradebook_native') or soup
    data = {'class_name': class_name, 'categories': [], 'term_grade': None, 'term_letter': None}

    for div in root.find_all('div', class_='grades_head'):
        left = div.find('div', class_='grades_left')
        mid = div.find('div', class_='grades_middle')
        if left and mid and 'Term Grade' in left.get_text():
            grade_text = mid.get_text(" ", strip=True)
            parts = grade_text.split()
            if parts:
                data['term_grade'] = parts[0]
            letter_span = mid.find('span')
            if letter_span:
                data['term_letter'] = letter_span.get_text(strip=True)
            elif len(parts) > 1:
                data['term_letter'] = parts[1]

    current_cat = None
    for el in root.find_all(['div', 'table']):
        classes = _class_names(el)
        if el.name == 'div' and 'grades_head' in classes and 'btop' in classes and 'bbottom' in classes:
            left = el.find('div', class_='grades_left')
            right = el.find('div', class_='grades_right')
            if left:
                cat_name = left.get_text(strip=True)
                weight = right.get_text(strip=True).replace('Weight = ', '') if right else ''
                current_cat = {'name': cat_name, 'weight': weight, 'assignments': [], 'average': None}
                data['categories'].append(current_cat)
        elif el.name == 'table' and 'grades' in classes and current_cat is not None:
            avg_row = el.find('tr', class_='cat_avg')
            if avg_row:
                tds = avg_row.find_all('td')
                if len(tds) > 1:
                    current_cat['average'] = tds[1].get_text(strip=True)
            for row in el.find_all('tr'):
                row_classes = _class_names(row)
                if 'cat_avg' in row_classes:
                    continue
                tds = row.find_all('td')
                if not tds or len(tds) < 6:
                    continue

                def cell(td):
                    for s in td.find_all('span'):
                        s.decompose()
                    return td.get_text(strip=True)

                assignment = {
                    'name': cell(tds[0]),
                    'pts': cell(tds[1]),
                    'max': cell(tds[2]),
                    'avg': cell(tds[3]),
                    'status': cell(tds[4]),
                    'due': cell(tds[5]) if len(tds) > 5 else '',
                }
                if assignment['name'] and not assignment['name'].startswith('Assignment'):
                    current_cat['assignments'].append(assignment)

    return data




HTML_OUTPUT_PATH = "/home/ahepworth/grades_dashboard.html"


def write_dashboard_html(result):
    import json
    from datetime import datetime

    class_options = result.get('class_options', [])
    updated = datetime.now().strftime("%B %d, %Y at %I:%M %p")

    options_html = ""
    cards_html = ""
    for opt in class_options:
        val = opt.get('value', '')
        text = opt.get('text', '')
        ds = opt.get('dataset', {})
        classid = ds.get('data-classid', '')
        termlist = ds.get('data-termlist', '')
        defaultterm = ds.get('data-defaultterm', '')
        options_html += f'<option value="{val}" data-classid="{classid}" data-termlist="{termlist}" data-defaultterm="{defaultterm}">{text}</option>\n'
        cards_html += f"""
        <div class="class-card" data-value="{val}" data-classid="{classid}">
            <div class="class-name">{text}</div>
            <div class="class-meta">{termlist.replace(",", " · ")}</div>
            <div class="class-badge">Q{defaultterm}</div>
        </div>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Grades Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}

  :root {{
    --bg: #0e0e0f;
    --surface: #16161a;
    --border: #2a2a30;
    --accent: #c8a96e;
    --accent2: #7eb8a4;
    --text: #e8e4da;
    --muted: #6b6760;
    --card-bg: #1c1c22;
  }}

  body {{
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Mono', monospace;
    min-height: 100vh;
    padding: 2rem;
  }}

  header {{
    border-bottom: 1px solid var(--border);
    padding-bottom: 1.5rem;
    margin-bottom: 2.5rem;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }}

  .header-left h1 {{
    font-family: 'Playfair Display', serif;
    font-size: 2.4rem;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.02em;
    line-height: 1;
  }}

  .header-left .subtitle {{
    font-size: 0.72rem;
    color: var(--muted);
    margin-top: 0.4rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }}

  .updated {{
    font-size: 0.65rem;
    color: var(--muted);
    text-align: right;
    letter-spacing: 0.08em;
  }}

  .updated span {{
    display: block;
    color: var(--accent2);
    font-size: 0.7rem;
  }}

  .selector-row {{
    display: flex;
    gap: 1rem;
    align-items: center;
    margin-bottom: 2rem;
    flex-wrap: wrap;
  }}

  .selector-label {{
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--muted);
  }}

  select {{
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 0.6rem 1rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
    flex: 1;
    min-width: 260px;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236b6760' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.8rem center;
    padding-right: 2.2rem;
  }}

  select:focus {{ outline: none; border-color: var(--accent); }}

  .grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }}

  .class-card {{
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1.2rem 1.4rem;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.15s;
    position: relative;
    overflow: hidden;
  }}

  .class-card::before {{
    content: '';
    position: absolute;
    top: 0; left: 0;
    width: 3px; height: 100%;
    background: var(--accent);
    opacity: 0;
    transition: opacity 0.15s;
  }}

  .class-card:hover {{ border-color: var(--accent); transform: translateY(-1px); }}
  .class-card:hover::before {{ opacity: 1; }}
  .class-card.active {{ border-color: var(--accent2); }}
  .class-card.active::before {{ background: var(--accent2); opacity: 1; }}

  .class-name {{
    font-family: 'Playfair Display', serif;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.3;
    margin-bottom: 0.5rem;
    padding-right: 2rem;
  }}

  .class-meta {{
    font-size: 0.62rem;
    color: var(--muted);
    letter-spacing: 0.06em;
  }}

  .class-badge {{
    position: absolute;
    top: 1rem; right: 1rem;
    background: var(--border);
    color: var(--accent);
    font-size: 0.6rem;
    padding: 0.2rem 0.45rem;
    border-radius: 3px;
    letter-spacing: 0.1em;
    font-weight: 500;
  }}

  .stats {{
    display: flex;
    gap: 2rem;
    margin-bottom: 2rem;
    padding: 1rem 1.4rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
  }}

  .stat {{ }}
  .stat-val {{
    font-family: 'Playfair Display', serif;
    font-size: 1.6rem;
    color: var(--accent);
    font-weight: 700;
    line-height: 1;
  }}
  .stat-label {{
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    margin-top: 0.2rem;
  }}

  footer {{
    margin-top: 3rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    font-size: 0.6rem;
    color: var(--muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }}
</style>
</head>
<body>

<header>
  <div class="header-left">
    <h1>Grades Dashboard</h1>
    <div class="subtitle">Colonial Christian School &mdash; Student Portal</div>
  </div>
  <div class="updated">
    Last updated<br>
    <span>{updated}</span>
  </div>
</header>

<div class="stats">
  <div class="stat">
    <div class="stat-val">{len(class_options)}</div>
    <div class="stat-label">Classes enrolled</div>
  </div>
  <div class="stat">
    <div class="stat-val">Q4</div>
    <div class="stat-label">Current quarter</div>
  </div>
  <div class="stat">
    <div class="stat-val">2025&ndash;26</div>
    <div class="stat-label">Academic year</div>
  </div>
</div>

<div class="selector-row">
  <span class="selector-label">Select class</span>
  <select id="class-select" onchange="handleSelect(this)">
    {options_html}
  </select>
</div>

<div class="grid" id="class-grid">
  {cards_html}
</div>

<footer>Data scraped from FACTS SIS &mdash; Grades detail coming soon</footer>

<script>
  const cards = document.querySelectorAll('.class-card');
  const sel = document.getElementById('class-select');

  cards.forEach(card => {{
    card.addEventListener('click', () => {{
      cards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      sel.value = card.dataset.value;
    }});
  }});

  function handleSelect(s) {{
    cards.forEach(c => c.classList.remove('active'));
    const match = document.querySelector(`.class-card[data-value="${{s.value}}"]`);
    if (match) match.classList.add('active');
  }}
</script>
</body>
</html>"""

    with open(HTML_OUTPUT_PATH, 'w') as f:
        f.write(html)
    import logging
    logging.getLogger(__name__).info(f"Dashboard written to {HTML_OUTPUT_PATH}")

def parse_scrape_args():
    parser = argparse.ArgumentParser(description='Scrape selected FACTS grade periods and classes.')
    parser.add_argument('--period', default='all', help='all, q1-q4, s1, s2, or year')
    parser.add_argument('--classes', default='all', help='all, one class ID, or comma-separated class IDs')
    args = parser.parse_args()
    aliases = {'q1': [1], 'q2': [2], 'q3': [3], 'q4': [4], 's1': [1, 2], 's2': [3, 4], 'year': [1, 2, 3, 4], 'all': SCRAPE_TERMS}
    period = args.period.lower().replace('semester', 's').replace('quarter', 'q').replace(' ', '')
    if period not in aliases:
        parser.error('--period must be all, q1-q4, s1, s2, or year')
    return aliases[period], args.classes


def _force_kill_chromium():
    """Send SIGTERM then SIGKILL to any Chromium still bound to the SIS profile.

    A hung/orphaned Chromium from a crashed run can ignore SIGTERM and keep the
    profile's singleton locks, which makes a fresh launch hand off to it and
    die (nodriver reports 'Failed to connect to browser', or the new instance
    crashes at the first navigation). SIGKILL guarantees the straggler is gone
    before we start a clean browser."""
    import subprocess
    import time

    try:
        subprocess.run(["pkill", "-f", r"\.sis-profile"], check=False)
    except Exception:
        pass
    time.sleep(2)
    try:
        subprocess.run(["pkill", "-9", "-f", r"\.sis-profile"], check=False)
    except Exception:
        pass
    time.sleep(1)


def _cleanup_stale_browser():
    """Kill any leftover Chromium still holding the SIS profile and clear its
    singleton locks. A hung/crashed prior run can orphan a Chromium process that
    keeps the profile lock; a fresh launch would then hand off to that stale
    instance and die, making nodriver report 'Failed to connect to browser'."""
    import os
    import time

    _force_kill_chromium()
    profile = "/home/ahepworth/.sis-profile"
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        try:
            os.remove(os.path.join(profile, name))
        except OSError:
            pass
    time.sleep(1.5)


async def _start_browser(attempts=3):
    for attempt in range(1, attempts + 1):
        try:
            return await uc.start(
                browser_executable_path="/usr/bin/chromium",
                no_sandbox=True,
                user_data_dir="/home/ahepworth/.sis-profile",
            )
        except Exception as exc:
            if attempt == attempts:
                raise
            log.warning(
                "Browser start failed (attempt %s/%s): %s — cleaning up and retrying…",
                attempt, attempts, exc,
            )
            _cleanup_stale_browser()
            await asyncio.sleep(5)
    raise RuntimeError("Browser could not be started")


def _is_browser_connection_error(exc):
    """True when an exception means the Chromium/DevTools connection dropped.

    This is the signature of a browser that died mid-run; retrying the whole
    scrape with a clean browser launch is the recovery path."""
    if isinstance(exc, (ConnectionError, OSError, asyncio.TimeoutError)):
        return True
    try:
        import websockets.exceptions
    except Exception:
        return False
    return isinstance(exc, websockets.exceptions.WebSocketException)


async def _scrape_attempt():
    """One full scrape run (cleanup + browser start + SIS login/report)."""
    _cleanup_stale_browser()
    log.info("Starting browser (stealth mode similar to existing script)...")
    browser = await _start_browser()
    try:
        await human_delay(1, 3)

        terms, class_selector = parse_scrape_args()
        log.info('Scrape request: periods=%s classes=%s', terms, class_selector)
        page, result = await open_sis_and_report(browser, terms, class_selector)
    except Exception:
        try:
            await browser.stop()
        except Exception:
            pass
        raise
    return browser, result


async def main():
    if not DISTRICT_CODE:
        log.error("DISTRICT_CODE not set in config.py, aborting.")
        return

    result = None
    browser = None
    last_exc = None
    attempts = 3
    for attempt in range(1, attempts + 1):
        try:
            browser, result = await _scrape_attempt()
            break
        except Exception as exc:
            if not _is_browser_connection_error(exc):
                raise
            last_exc = exc
            log.warning(
                "Scrape attempt %s/%s failed (browser/connection error): %s",
                attempt, attempts, exc,
            )
            _cleanup_stale_browser()
            await asyncio.sleep(5)
    if result is None:
        raise last_exc or RuntimeError("Scrape failed after %s attempts" % attempts)

    if result.get('classes') or result.get('grades_by_class'):
        try:
            import sys, os
            sys.path.insert(0, os.path.dirname(__file__))
            import build_dashboard
            build_dashboard.build()
        except Exception as e:
            log.error(f'Dashboard build failed: {e}')

    # Print a concise JSON-like single-line report
    print("\n=== SIS LOGIN REPORT ===")
    for key, value in result.items():
        print(f"{key}: {value}")

    # Keep the browser open briefly so a human can inspect if running interactively
    await asyncio.sleep(5)
    try:
        await browser.close()
    except Exception:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        import traceback

        log.exception("Scrape run failed")
        try:
            from grades_emailer import send_error_email

            send_error_email(
                "FACTS scrape failed",
                str(exc),
                traceback.format_exc(),
                "The morning scraper crashed before it could finish processing grades.",
            )
        except Exception as email_exc:
            log.error("Could not send error email: %s", email_exc)
        raise
