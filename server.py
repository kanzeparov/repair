#!/usr/bin/env python3
"""Локальный трекер трат. Zero-deps: только стандартная библиотека.
Запуск: python3 server.py  →  http://localhost:8765
Данные: data.json рядом с этим файлом (внутри Obsidian vault → бэкапится)."""
import json, os, http.server, socketserver, webbrowser, threading, subprocess, datetime

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

def git_commit_tasks(msg):
    def w():
        enc_tasks()
        git_t(["add","-A"])
        r=git_t(["commit","-m",msg])
        if r and r.returncode==0 and os.path.exists(os.path.join(BASE,".push_enabled")):
            git_t(["push","origin","main"])
    threading.Thread(target=w, daemon=True).start()

def git_commit(msg):
    def w():
        enc_all()
        git(["add","-A"])
        r=git(["commit","-m",msg])
        if r and r.returncode==0 and os.path.exists(os.path.join(BASE,".push_enabled")):
            git(["push","--force-with-lease","origin","main"])
    threading.Thread(target=w, daemon=True).start()

PORT = 8765
DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(DIR, "data.json")
PLAN = os.path.join(DIR, "plan.json")

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

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def log_message(self, *a): pass

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
            if os.path.exists(PLAN):
                with open(PLAN, encoding="utf-8") as f:
                    return self._json(json.load(f))
            return self._json({})
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
        body = json.loads(self.rfile.read(n) or b"{}")
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
            tmp = PLAN + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False, indent=1)
            os.replace(tmp, PLAN)
            git_commit("finplan: change @ "+datetime.datetime.now().strftime("%H:%M:%S"))
            return self._json({"ok": True})
        if self.path == "/api/limits":        # update limits
            d["limits"].update(body)
            save(d); return self._json({"ok": True})
        return self._json({"error": "unknown"}, 404)

if __name__ == "__main__":
    git(["pull","--rebase","origin","main"])   # подтянуть внешние изменения как из БД
    dec_all()
    git_t(["pull","--rebase","origin","main"])  # задачи: репо taskers
    dec_tasks()                                   # расшифровать свежие *.enc локальным паролем
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as srv:
        print(f"💸 Трекер трат: http://localhost:{PORT}  (данные: {DATA})")
        threading.Timer(0.6, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nостановлен")
