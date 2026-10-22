"""Generate tokens.css from design-system/tokens.json (Experiment Roadmap design system).

Usage: python3 scripts/build-tokens.py   (run from experiment-roadmap/)
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
tokens = json.loads((ROOT / "design-system" / "tokens.json").read_text())

light, dark, plain = [], [], []


def themed(name, value):
    if isinstance(value, dict):
        light.append(f"  --{name}: {value['light']};")
        dark.append(f"  --{name}: {value.get('dark', value['light'])};")
    else:
        light.append(f"  --{name}: {value};")


for t in tokens["color"]["tokens"]:
    themed(t["name"], t["value"])
for t in tokens["shadow"]["tokens"]:
    themed(t["name"], t["value"])
for fam, stack in tokens["type"]["families"].items():
    plain.append(f"  --font-{fam}: {stack};")
for family in ("spacing", "radius", "size"):
    for t in tokens[family]["tokens"]:
        plain.append(f"  --{t['name']}: {t['value']};")

dark_body = "\n".join(dark)
css = f"""/* {tokens['name']} — generated from tokens.json by scripts/build-tokens.py */
:root {{
{chr(10).join(light)}
{chr(10).join(plain)}
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
{dark_body}
    color-scheme: dark;
  }}
}}
:root[data-theme="dark"] {{
{dark_body}
  color-scheme: dark;
}}
"""
(ROOT / "tokens.css").write_text(css)
print("wrote tokens.css")
