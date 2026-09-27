#!/usr/bin/env python3
"""Вставляет в common.html блок «Все источники»: YouTube и Telegram под наблюдением.

Источник правды: ~/dev/yt-watch/channels.json и tg_channels.json. Запускать после
любой правки этих списков:  python3 money-tracker/gen_sources.py
Блок стоит между маркерами <!--SOURCES--> и <!--/SOURCES--> и в чек-лист не входит
(check_common.py считает только пункты SECTIONS).
"""
import html
import json
import os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
YT = os.path.expanduser("~/dev/yt-watch/channels.json")
TG = os.path.expanduser("~/dev/yt-watch/tg_channels.json")
A, B = "<!--SOURCES-->", "<!--/SOURCES-->"

yt = json.load(open(YT, encoding="utf-8"))
yt = yt if isinstance(yt, list) else list(yt.values())
tg = json.load(open(TG, encoding="utf-8"))

groups = defaultdict(list)
for c in tg:
    groups[c.get("topic") or "без темы"].append(c)

esc = html.escape
parts = [A, '<div class="sec"><h3>Все источники под наблюдением</h3>',
         f'<div class="hint">YouTube {len(yt)} · Telegram {len(tg)} '
         f'(ежедневно {sum(1 for c in tg if c.get("freq") != "week")}, по воскресеньям '
         f'{sum(1 for c in tg if c.get("freq") == "week")}). Обновляется gen_sources.py из ~/dev/yt-watch</div>',
         f'<details open><summary><b>YouTube, {len(yt)}</b>: пункты 12.3–12.5, выжимка по расшифровке</summary><ul>']
for c in yt:
    parts.append(f'<li>{esc(c.get("name", c.get("key", "")))}</li>')
parts.append("</ul></details>")
for topic in sorted(groups, key=lambda t: -len(groups[t])):
    cs = groups[topic]
    parts.append(f'<details><summary><b>TG · {esc(topic)}, {len(cs)}</b></summary><ul>')
    for c in sorted(cs, key=lambda c: c.get("freq") == "week"):
        wk = ' <span style="color:var(--muted)">(вс)</span>' if c.get("freq") == "week" else ""
        parts.append(f'<li>{esc(c.get("name", c["key"]))}{wk}</li>')
    parts.append("</ul></details>")
parts.append("</div>" + B)
block = "\n".join(parts)

p = os.path.join(HERE, "common.html")
s = open(p, encoding="utf-8").read()
if A in s:
    s = s[:s.index(A)] + block + s[s.index(B) + len(B):]
else:
    anchor = '      <div class="sec">\n        <h3>Что было в этот день</h3>'
    s = s.replace(anchor, block + "\n" + anchor, 1)
open(p, "w", encoding="utf-8").write(s)
print(f"ok: YouTube {len(yt)}, TG {len(tg)}, тем {len(groups)}")
