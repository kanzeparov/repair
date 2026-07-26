#!/usr/bin/env python3
"""Локальный трекер трат. Zero-deps: только стандартная библиотека.
Запуск: python3 server.py  →  http://localhost:8765
Данные: data.json рядом с этим файлом (внутри Obsidian vault → бэкапится)."""
import json, os, http.server, socketserver, webbrowser, threading, subprocess, datetime, time

def git(args):
    try:
        return subprocess.run(["git"]+args, cwd=os.path.dirname(os.path.abspath(__file__)),
                              capture_output=True, text=True, timeout=30)
    except Exception:
        return None

BASE = os.path.dirname(os.path.abspath(__file__))
SECRET = os.path.join(BASE, ".secret")
ENC_FILES = ["data.json", "plan.json", "tasks.json"]

def _ossl(args):
    try:
        return subprocess.run(["openssl"]+args, cwd=BASE, capture_output=True, timeout=30).returncode == 0
    except Exception:
        return False

def enc_all():
    for fn in ENC_FILES:
        p = os.path.join(BASE, fn)
        if os.path.exists(p):
            _ossl(["enc","-aes-256-cbc","-pbkdf2","-iter","100000","-salt",
                   "-in",fn,"-out",fn+".enc","-pass","file:.secret"])

def dec_all():
    for fn in ENC_FILES:
        p, e = os.path.join(BASE, fn), os.path.join(BASE, fn+".enc")
        if os.path.exists(e) and (not os.path.exists(p) or os.path.getmtime(e) > os.path.getmtime(p)+1):
            _ossl(["enc","-d","-aes-256-cbc","-pbkdf2","-iter","100000",
                   "-in",fn+".enc","-out",fn,"-pass","file:.secret"])

TDIR = os.path.join(BASE, "tasks_repo")
TASKS = os.path.join(TDIR, "tasks.json")

def git_t(args):
    try:
        return subprocess.run(["git"]+args, cwd=TDIR, capture_output=True, text=True, timeout=60)
    except Exception:
        return None

def enc_tasks():
    if os.path.exists(TASKS):
        try:
            subprocess.run(["openssl","enc","-aes-256-cbc","-pbkdf2","-iter","100000","-salt",
                "-in","tasks.json","-out","tasks.json.enc","-pass","file:"+SECRET],
                cwd=TDIR, capture_output=True, timeout=30)
        except Exception: pass

def dec_tasks():
    e=TASKS+".enc"
    if os.path.exists(e) and (not os.path.exists(TASKS) or os.path.getmtime(e)>os.path.getmtime(TASKS)+1):
        try:
            subprocess.run(["openssl","enc","-d","-aes-256-cbc","-pbkdf2","-iter","100000",
                "-in","tasks.json.enc","-out","tasks.json","-pass","file:"+SECRET],
                cwd=TDIR, capture_output=True, timeout=30)
        except Exception: pass

# Коммиты сериализованы: раньше каждое сохранение стартовало свой поток, и параллельные
# `git add` дрались за index.lock — часть коммитов молча терялась. Теперь на репозиторий
# работает один воркер, а правки за QUIET секунд схлопываются в один коммит (иначе на
# каждое нажатие клавиши уезжал коммит с полной копией зашифрованных данных).
QUIET = 60

class _Committer:
    def __init__(self, work, quiet=QUIET):
        self.work = work                  # work(msg) — что сделать для одного коммита
        self.quiet = quiet
        self.lock = threading.Lock()
        self.pending = None
        self.running = False

    def __call__(self, msg):
        with self.lock:
            self.pending = msg
            if self.running:
                return                     # воркер уже бежит и подхватит наше сообщение
            self.running = True
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            with self.lock:
                if self.pending is None:
                    self.running = False
                    return
            time.sleep(self.quiet)        # копим правки, коммитим одним куском
            with self.lock:
                msg, self.pending = self.pending, None
            try:
                self.work(msg)
            except Exception:
                pass

    def flush(self):
        """Досохранить накопленное — вызывается при остановке сервера."""
        with self.lock:
            msg, self.pending = self.pending, None
        if msg:
            try: self.work(msg)
            except Exception: pass

def _commit_tasks(msg):
    enc_tasks()
    git_t(["add","-A"])
    r=git_t(["commit","-m",msg])
    if r and r.returncode==0 and os.path.exists(os.path.join(BASE,".push_enabled")):
        git_t(["push","origin","main"])

def _commit_base(msg):
    enc_all()
    git(["add","-A"])
    r=git(["commit","-m",msg])
    if r and r.returncode==0 and os.path.exists(os.path.join(BASE,".push_enabled")):
        git(["push","--force-with-lease","origin","main"])

git_commit_tasks = _Committer(_commit_tasks)
git_commit       = _Committer(_commit_base)

PORT = 8765
DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(DIR, "data.json")
PLAN = os.path.join(DIR, "plan.json")
# Журнал правок (94% веса plan.json) живёт отдельно и не попадает в git: иначе каждое
# сохранение клало в историю новую полную копию шифртекста на сотню килобайт.
PLAN_LOG = os.path.join(DIR, "plan-log.json")

def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)

RATE_FILE = os.path.join(DIR, "rate.json")
RATE_DISCOUNT = 0.05          # курс ЦБ минус 5%

def cbr_usd():
    """Курс доллара ЦБ, кэш на сутки. Тянет сервер, а не браузер: у cbr.ru нет CORS."""
    today = datetime.date.today().isoformat()
    cached = None
    try:
        with open(RATE_FILE, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("day") == today:
            return cached
    except Exception:
        pass
    try:
        import urllib.request, xml.etree.ElementTree as ET
        with urllib.request.urlopen("https://www.cbr.ru/scripts/XML_daily.asp", timeout=10) as r:
            root = ET.fromstring(r.read().decode("windows-1251"))
        for v in root.findall("Valute"):
            if v.findtext("CharCode") == "USD":
                nom = float(v.findtext("Nominal").replace(",", "."))
                val = float(v.findtext("Value").replace(",", "."))
                usd = val / nom
                out = {"day": today, "cbrDate": root.get("Date"), "cbr": round(usd, 4),
                       "rate": round(usd * (1 - RATE_DISCOUNT), 4), "discount": RATE_DISCOUNT}
                _write_json(RATE_FILE, out)
                return out
    except Exception as e:
        if cached:                       # нет сети — отдаём вчерашний, но помечаем
            cached = dict(cached); cached["stale"] = True
            return cached
        return {"error": str(e)[:120]}
    return cached or {"error": "USD не найден в ответе ЦБ"}

def read_plan():
    """plan.json + подшитый обратно журнал — клиент видит единый объект, как раньше."""
    d = {}
    if os.path.exists(PLAN):
        with open(PLAN, encoding="utf-8") as f:
            d = json.load(f)
    if not d.get("log") and os.path.exists(PLAN_LOG):
        try:
            with open(PLAN_LOG, encoding="utf-8") as f:
                d["log"] = json.load(f)
        except Exception:
            pass
    return d

def write_plan(body):
    log = body.pop("log", None)
    # пустым журналом не затираем: вкладка, не успевшая подтянуть его с сервера,
    # иначе снесла бы всю историю правок первым же сохранением
    if isinstance(log, list) and log:
        _write_json(PLAN_LOG, log)
    _write_json(PLAN, body)

def load():
    if os.path.exists(DATA):
        with open(DATA, encoding="utf-8") as f:
            return json.load(f)
    return {"tx": [], "limits": {
        "Продукты": 40000, "Кафе/ресты": 25000, "Такси": 10000,
        "Транспорт": 3000, "Маркетплейсы": 8000, "ЖКХ/связь": 20000,
        "Здоровье": 8000, "Спорт": 6000, "Подписки": 2000,
        "Родителям": 41000, "Путешествия": 0, "Прочее": 15000}}

def save(d):
    tmp = DATA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA)

# сервер многопоточный: без этого две быстрые записи подряд читают один и тот же файл
# и вторая затирает первую (потерянная транзакция / проскочивший rev-конфликт)
WLOCK = threading.Lock()

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def log_message(self, *a): pass

    def end_headers(self):
        # страницы правятся руками — не отдавать браузеру закешированную версию.
        # getattr: при битом запросе send_error() зовёт end_headers ещё до разбора пути
        p = getattr(self, "path", "") or ""
        if p.endswith(".html") or p.endswith("/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    ALIASES = {
        "/Финплан — карточки.html": "/cards.html",
        "/✅ ЗАДАЧИ — неделя.html": "/tasks.html",
        "/Интерактивный финплан (таблица).html": "/plan.html",
        "/🗂 ГЛАВНАЯ.html": "/index.html",
    }

    def do_GET(self):
        from urllib.parse import unquote
        decoded = unquote(self.path.split("?")[0])
        # .secret (пароль шифрования), .git/, .push_enabled лежат в раздаваемой папке —
        # наружу их не отдаём
        if any(seg.startswith(".") for seg in decoded.split("/") if seg):
            return self._json({"error": "forbidden"}, 403)
        if decoded in self.ALIASES:
            self.path = self.ALIASES[decoded]
        if self.path == "/api/data":
            return self._json(load())
        if self.path == "/api/tasks":
            if os.path.exists(TASKS):
                with open(TASKS, encoding="utf-8") as fh:
                    return self._json(json.load(fh))
            return self._json({})
        if self.path == "/api/plan":
            return self._json(read_plan())
        if self.path == "/api/rate":
            return self._json(cbr_usd())
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def _rev_ok(self, path_file, body):
        """Анти-перезапись: отклоняем POST от устаревших вкладок (rev меньше серверного)."""
        try:
            cur = 0
            if os.path.exists(path_file):
                with open(path_file, encoding="utf-8") as f:
                    cur = json.load(f).get("rev", 0)
        except Exception:
            cur = 0
        return body.get("rev", -1) >= cur

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json({"error": "bad json"}, 400)
        with WLOCK:
            return self._post(body)

    def _post(self, body):
        d = load()
        if self.path == "/api/tx":            # add transaction
            d["tx"].append(body)
            save(d); git_commit("tracker: +"+str(body.get("amount",""))+" "+str(body.get("cat","")))
            return self._json({"ok": True, "count": len(d["tx"])})
        if self.path == "/api/del":           # delete by id
            d["tx"] = [t for t in d["tx"] if t.get("id") != body.get("id")]
            save(d); git_commit("tracker: delete tx")
            return self._json({"ok": True})
        if self.path == "/api/tasks":
            if not self._rev_ok(TASKS, body):
                return self._json({"error": "stale rev — обнови вкладку"}, 409)
            with open(TASKS + ".tmp", "w", encoding="utf-8") as fh:
                json.dump(body, fh, ensure_ascii=False, indent=1)
            os.replace(TASKS + ".tmp", TASKS)
            git_commit_tasks("tasks: change")
            return self._json({"ok": True})
        if self.path == "/api/plan":
            if not self._rev_ok(PLAN, body):
                return self._json({"error": "stale rev — обнови вкладку"}, 409)
            write_plan(body)
            git_commit("finplan: change @ "+datetime.datetime.now().strftime("%H:%M:%S"))
            return self._json({"ok": True})
        if self.path == "/api/limits":        # update limits
            d["limits"].update(body)
            save(d); git_commit("tracker: limits")
            return self._json({"ok": True, "limits": d["limits"]})
        return self._json({"error": "unknown"}, 404)

def port_busy():
    import socket
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", PORT)) == 0

if __name__ == "__main__":
    # трекер уже поднят (например, руками из терминала) — не падать с трейсбеком
    # «Address already in use», а просто открыть работающий
    if port_busy():
        print(f"💸 Трекер уже запущен: http://localhost:{PORT}")
        if not os.environ.get("LAUNCHD_RUN"):
            webbrowser.open(f"http://localhost:{PORT}")
        raise SystemExit(0)
    git(["pull","--rebase","origin","main"])   # подтянуть внешние изменения как из БД
    dec_all()
    git_t(["pull","--rebase","origin","main"])  # задачи: репо taskers
    dec_tasks()                                   # расшифровать свежие *.enc локальным паролем
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as srv:
        print(f"💸 Трекер трат: http://localhost:{PORT}  (данные: {DATA})")
        if not os.environ.get("LAUNCHD_RUN"):
            threading.Timer(0.6, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            # коммиты копятся до минуты — не потерять накопленное при остановке
            git_commit.flush(); git_commit_tasks.flush()
            print("\nостановлен")
