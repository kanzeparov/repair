#!/usr/bin/env python3
"""Двойная проверка прогона /_common.

Берёт список пунктов прямо из common.html (единственный источник правды) и сверяет
с отметками дня в /api/common. Печатает, что из ежедневных [к] не закрыто, какие
ключи отмечены, но в чек-листе их нет, и у каких незакрытых пунктов нет заметки.

    python3 money-tracker/check_common.py            # сегодня
    python3 money-tracker/check_common.py 2026-09-23

Код выхода 0, только если закрыты все ежедневные пункты.
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
day = sys.argv[1] if len(sys.argv) > 1 else dt.date.today().isoformat()

html = open(os.path.join(HERE, "common.html"), encoding="utf-8").read()
items = re.findall(r'\["(\d+\.\d+)","([^"]*)","([^"]*)"\]', html)
daily = [(i, t) for i, t, tag in items if tag == "к"]
known = {i for i, _, _ in items}

try:
    data = json.load(urllib.request.urlopen("http://localhost:8765/api/common", timeout=10))
except Exception:
    data = json.load(open(os.path.join(HERE, "common.json"), encoding="utf-8"))

d = data.get("days", {}).get(day)
if not d:
    print(f"{day}: прогона нет вообще, 0 из {len(daily)}")
    sys.exit(1)

marks, notes = d.get("items", {}), d.get("notes", {})
missing = [(i, t) for i, t in daily if not marks.get(i)]
done = len(daily) - len(missing)
print(f"{day}: закрыто {done} из {len(daily)} ежедневных, прогонов {len(d.get('runs', []))}")
for i, t in missing:
    print(f"  ✗ {i} {t}" + ("" if i in notes else "   ⚠️ нет заметки, почему"))
extra = sorted(k for k in marks if k not in known)
if extra:
    print("  ⚠️ отмечены ключи, которых нет в чек-листе:", ", ".join(extra))
sys.exit(0 if not missing and not extra else 1)
