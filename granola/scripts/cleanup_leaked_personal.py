"""Cleanup any Notion pages whose Granola note has been moved INTO an excluded
folder (Personal, BeTema, Default) since ingestion.

The worker doesn't auto-archive pages when a note's folder changes in Granola.
If you notice a personal note leaked into Notion, move it to the Personal folder
in Granola, then run this script — it'll archive the corresponding Notion page.

Run periodically (e.g. monthly) or after a bulk-filing pass in Granola.
"""

import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request


ENV_PATH = "/Users/alfalfa/Documents/GitHub/Hackathon-Cerebro/.env"
DS = "362a4866-2b25-801c-9ce5-000b30156f9b"
EXCLUDED = {"personal", "betema", "default"}


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def fetch(req, retries=6):
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = float(e.headers.get("Retry-After", "0")) or (2 ** i)
                print(f"  ! 429, sleeping {wait:.1f}s", flush=True)
                time.sleep(wait + 0.5)
                continue
            if i == retries - 1:
                raise
            time.sleep(1.5 ** i)
        except (urllib.error.URLError, ConnectionResetError, ssl.SSLError, TimeoutError, OSError):
            if i == retries - 1:
                raise
            time.sleep(1.5 ** i)
    raise RuntimeError("retries exhausted")


def main():
    env = load_env(ENV_PATH)
    notion_token = env.get("NOTION_API_TOKEN") or os.environ.get("NOTION_API_TOKEN")
    granola_token = env.get("GRANOLA_API_KEY") or os.environ.get("GRANOLA_API_KEY")
    if not notion_token or not granola_token:
        print("Missing NOTION_API_TOKEN or GRANOLA_API_KEY", file=sys.stderr)
        sys.exit(1)
    nh = {
        "Authorization": f"Bearer {notion_token}",
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
    }
    gh = {"Authorization": f"Bearer {granola_token}"}

    # 1) Collect all active Granola Meeting pages
    pages = []
    cursor = None
    while True:
        body = {
            "filter": {"property": "Data Type", "select": {"equals": "Granola Meeting"}},
            "page_size": 100,
        }
        if cursor:
            body["start_cursor"] = cursor
        req = urllib.request.Request(
            f"https://api.notion.com/v1/data_sources/{DS}/query",
            data=json.dumps(body).encode(),
            headers=nh,
            method="POST",
        )
        d = fetch(req)
        pages.extend(d["results"])
        if not d.get("has_more"):
            break
        cursor = d.get("next_cursor")
    print(f"Active Granola Meeting pages: {len(pages)}", flush=True)

    def find_gid(pid):
        blocks = []
        cursor = None
        while True:
            url = f"https://api.notion.com/v1/blocks/{pid}/children?page_size=100"
            if cursor:
                url += f"&start_cursor={cursor}"
            d = fetch(urllib.request.Request(url, headers=nh))
            blocks.extend(d["results"])
            if not d.get("has_more"):
                break
            cursor = d.get("next_cursor")
        for b in reversed(blocks[-15:]):
            bt = b.get("type", "")
            rt = b.get(bt, {}).get("rich_text", [])
            if not rt:
                continue
            text = "".join(seg.get("plain_text", "") for seg in rt)
            m = re.search(r"Granola ID:\s*([A-Za-z0-9_-]+)", text)
            if m:
                return m.group(1)
        return None

    archived = kept = errors = 0
    archive_examples = []
    for i, p in enumerate(pages):
        pid = p["id"]
        title_prop = p["properties"]["Name"]["title"]
        title = title_prop[0]["plain_text"] if title_prop else "(untitled)"
        try:
            gid = find_gid(pid)
        except Exception as e:
            errors += 1
            time.sleep(2)
            continue
        if not gid:
            continue
        try:
            d = fetch(urllib.request.Request(f"https://public-api.granola.ai/v1/notes/{gid}", headers=gh))
        except Exception:
            errors += 1
            continue
        folder_names = [(f.get("name") or "") for f in (d.get("folder_membership") or [])]
        if any(n.lower() in EXCLUDED for n in folder_names):
            if len(archive_examples) < 15:
                archive_examples.append((title, folder_names))
            try:
                req = urllib.request.Request(
                    f"https://api.notion.com/v1/pages/{pid}",
                    data=json.dumps({"archived": True}).encode(),
                    headers=nh,
                    method="PATCH",
                )
                fetch(req)
                archived += 1
            except Exception as e:
                errors += 1
        else:
            kept += 1
        time.sleep(0.4)
        if (i + 1) % 25 == 0:
            print(
                f"  [{i+1}/{len(pages)}] archived={archived} kept={kept} err={errors}",
                flush=True,
            )

    print(f"\nDONE. archived={archived} kept={kept} errors={errors}")
    print("\nArchived (moved to excluded folder since ingestion):")
    for t, fns in archive_examples:
        print(f"  - {t[:55]:55s}  folders={fns}")


if __name__ == "__main__":
    main()
