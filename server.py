#!/usr/bin/env python3
"""Локальный трекер трат. Zero-deps: только стандартная библиотека.
Запуск: python3 server.py  →  http://localhost:8765
Данные: data.json рядом с этим файлом (внутри Obsidian vault → бэкапится)."""
import json, os, re, http.server, socketserver, webbrowser, threading, subprocess, datetime, time

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

CRYPTO_FILE = os.path.join(DIR, "crypto.json")

# ---- портфель крипты: DeBank Pro + floor с CoinGecko ------------------------
# Пересчёт стоит денег (DeBank списывает units), поэтому руками и с подтверждением.
PORT_FILE    = os.path.join(DIR, "portfolio.json")
DEBANK_KEY_F = os.path.join(DIR, ".debank")          # ключ вне репозитория
WALLETS_MD   = os.path.join(DIR, "..", "Финансы", "Крипта", "Кошельки.md")
CG_PLATFORM  = {"eth": "ethereum", "matic": "polygon-pos", "arb": "arbitrum-one", "era": "zksync",
                "op": "optimistic-ethereum", "base": "base", "bsc": "binance-smart-chain",
                "avax": "avalanche", "ftm": "fantom", "xdai": "xdai"}
CG_MAX       = 25            # столько контрактов проверяем на CoinGecko за один пересчёт

def debank_key():
    k = os.environ.get("DEBANK_KEY", "").strip()
    if k:
        return k
    try:
        with open(DEBANK_KEY_F, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""

def wallets():
    """Адреса берём из заметки в vault — в публичный репозиторий они не попадают."""
    try:
        with open(WALLETS_MD, encoding="utf-8") as f:
            txt = f.read()
    except Exception:
        return []
    seen, out = set(), []
    for a in re.findall(r"0x[0-9a-fA-F]{40}", txt):
        low = a.lower()
        if low not in seen:
            seen.add(low); out.append(a)
    return out

def _debank(path, key, **params):
    import urllib.parse, urllib.request
    url = "https://pro-openapi.debank.com" + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"AccessKey": key, "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def read_portfolio():
    try:
        with open(PORT_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def recount_portfolio():
    """Полный пересчёт: токены по всем адресам + NFT по минимальному floor CoinGecko."""
    import concurrent.futures, time as _t
    key = debank_key()
    if not key:
        return {"error": "нет ключа DeBank — положи его в money-tracker/.debank"}
    addrs = wallets()
    if not addrs:
        return {"error": "не нашёл адреса в Финансы/Крипта/Кошельки.md"}

    tokens, per_addr, nfts, errors = 0.0, {}, [], []

    def one(a):
        tot = _debank("/v1/user/total_balance", key, id=a).get("total_usd_value") or 0
        lst = []
        try:
            lst = _debank("/v1/user/all_nft_list", key, id=a, is_all="true") or []
        except Exception as e:
            errors.append("nft %s: %s" % (a[:10], e))
        return a, float(tot), lst

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        for fut in concurrent.futures.as_completed([ex.submit(one, a) for a in addrs]):
            try:
                a, tot, lst = fut.result()
            except Exception as e:
                errors.append(str(e)); continue
            tokens += tot; per_addr[a] = round(tot, 2); nfts.extend(lst)

    # группируем NFT по контракту, дороже по оценке DeBank — проверяем раньше
    groups = {}
    for n in nfts:
        cid, chain = n.get("contract_id"), n.get("chain")
        if not cid:
            continue
        # DeBank отдаёт цену в usd_price (не usd_value — там всегда 0) и человеческое
        # имя в collection_name. Раньше группы ранжировались нулями, и до настоящих
        # коллекций очередь просто не доходила.
        g = groups.setdefault((chain, cid), {"n": 0, "est": 0.0,
                              "name": n.get("collection_name") or n.get("contract_name") or cid})
        g["n"] += int(n.get("amount") or 1)
        g["est"] = max(g["est"], float(n.get("usd_price") or 0))
    order = sorted(groups.items(), key=lambda kv: -(kv[1]["est"] * kv[1]["n"]))

    nft_usd, confirmed, checked = 0.0, [], 0
    for (chain, cid), g in order[:CG_MAX]:
        plat = CG_PLATFORM.get(chain)
        if not plat:
            continue
        checked += 1
        try:
            import urllib.request
            u = "https://api.coingecko.com/api/v3/nfts/%s/contract/%s" % (plat, cid)
            with urllib.request.urlopen(u, timeout=20) as r:
                j = json.loads(r.read().decode())
            fl = ((j.get("floor_price") or {}).get("usd")) or 0
            if fl:
                nft_usd += float(fl) * g["n"]
                confirmed.append({"name": j.get("name") or g["name"], "n": g["n"], "floor": round(float(fl), 2)})
        except Exception:
            pass                       # коллекцию не знают — считаем нулём, как и раньше
        _t.sleep(1.5)                  # CoinGecko лимитирует бесплатный доступ

    out = {"day": datetime.date.today().isoformat(),
           "ts": datetime.datetime.now().isoformat(timespec="seconds"),
           "tokens": round(tokens, 2), "nft": round(nft_usd, 2),
           "total": round(tokens + nft_usd, 2),
           "addrs": len(addrs), "nft_count": len(nfts),
           "collections": len(groups), "checked": checked,
           "skipped": max(0, len(groups) - checked),   # без тихих усечений
           "confirmed": confirmed, "per_addr": per_addr,
           "errors": errors[:10]}
    _write_json(PORT_FILE, out)
    return out

def cbr_usd():
    """Курсы ЦБ (доллар и тенге), кэш на сутки. Тянет сервер, а не браузер: у cbr.ru нет CORS.
    Ключи cbr/rate оставлены на верхнем уровне для совместимости — это доллар."""
    today = datetime.date.today().isoformat()
    cached = None
    try:
        with open(RATE_FILE, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("day") == today and "kzt" in cached and "gbp" in cached:
            return cached
    except Exception:
        pass
    try:
        import urllib.request, xml.etree.ElementTree as ET
        with urllib.request.urlopen("https://www.cbr.ru/scripts/XML_daily.asp", timeout=10) as r:
            root = ET.fromstring(r.read().decode("windows-1251"))
        got = {}
        for v in root.findall("Valute"):
            code = v.findtext("CharCode")
            if code in ("USD", "KZT", "GBP"):
                nom = float(v.findtext("Nominal").replace(",", "."))
                val = float(v.findtext("Value").replace(",", "."))
                got[code] = val / nom
        if "USD" in got:
            out = {"day": today, "cbrDate": root.get("Date"),
                   "cbr": round(got["USD"], 4),
                   "rate": round(got["USD"] * (1 - RATE_DISCOUNT), 6),
                   "discount": RATE_DISCOUNT}
            for code, key in (("KZT", "kzt"), ("GBP", "gbp")):
                if code in got:
                    out[key] = {"cbr": round(got[code], 6),
                                "rate": round(got[code] * (1 - RATE_DISCOUNT), 6)}
            _write_json(RATE_FILE, out)
            return out
    except Exception:
        pass
    if cached:                           # нет сети — отдаём вчерашний, но помечаем
        cached = dict(cached); cached["stale"] = True
        return cached
    return {"error": "курс ЦБ недоступен"}

def crypto_price():
    """Цена токена MEGA (MegaETH) в долларах, кэш на сутки."""
    today = datetime.date.today().isoformat()
    cached = None
    try:
        with open(CRYPTO_FILE, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("day") == today:
            return cached
    except Exception:
        pass
    try:
        import urllib.request
        url = ("https://api.coingecko.com/api/v3/simple/price"
               "?ids=megaeth&vs_currencies=usd&include_last_updated_at=true")
        with urllib.request.urlopen(url, timeout=12) as r:
            j = json.loads(r.read().decode())
        p = j.get("megaeth", {}).get("usd")
        if p:
            out = {"day": today, "mega": {"usd": p}, "src": "coingecko/megaeth",
                   "updated": j["megaeth"].get("last_updated_at")}
            _write_json(CRYPTO_FILE, out)
            return out
    except Exception:
        pass
    if cached:
        cached = dict(cached); cached["stale"] = True
        return cached
    return {"error": "цена MEGA недоступна"}


STOCK_FILE = os.path.join(DIR, "stocks.json")
TICKERS = ["PLZL"]                   # что тянем с Мосбиржи

def stock_px():
    """Цены акций с MOEX ISS, кэш на сутки. Берём LAST, если торги идут, иначе PREVPRICE."""
    today = datetime.date.today().isoformat()
    cached = None
    try:
        with open(STOCK_FILE, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("day") == today:
            return cached
    except Exception:
        pass
    out = {"day": today, "px": {}, "src": "moex/iss"}
    try:
        import urllib.request
        for t in TICKERS:
            u = ("https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/"
                 + t + ".json?iss.meta=off&iss.only=marketdata,securities"
                 "&securities.columns=SECID,PREVPRICE&marketdata.columns=SECID,LAST")
            with urllib.request.urlopen(u, timeout=12) as r:
                j = json.loads(r.read().decode())
            last = (j.get("marketdata", {}).get("data") or [[None, None]])[0][1]
            prev = (j.get("securities", {}).get("data") or [[None, None]])[0][1]
            px = last or prev
            if px:
                out["px"][t] = float(px)
        if out["px"]:
            _write_json(STOCK_FILE, out)
            return out
    except Exception:
        pass
    if cached:
        cached = dict(cached); cached["stale"] = True
        return cached
    return {"error": "цены MOEX недоступны"}

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
        if self.path == "/api/crypto":
            return self._json(crypto_price())
        if self.path == "/api/stocks":
            return self._json(stock_px())
        if self.path == "/api/portfolio":
            return self._json(read_portfolio())
        if self.path == "/api/facts":          # факты из выписок, вне репозитория
            try:
                with open(os.path.join(DIR, "facts.json"), encoding="utf-8") as fh:
                    return self._json(json.load(fh))
            except Exception:
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
        if self.path == "/api/portfolio/recount":   # платная операция — только по кнопке
            return self._json(recount_portfolio())
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

def _term(sig, frm):
    # pkill шлёт TERM: без обработчика finally не выполняется и накопленный
    # за QUIET-окно коммит терялся до следующего сохранения
    git_commit.flush(); git_commit_tasks.flush()
    raise SystemExit(0)

if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGTERM, _term)
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
