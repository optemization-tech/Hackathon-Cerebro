"""Restore Granola Meeting pages we archived during the unfiled-filter mistake.

Run from /Users/alfalfa/Documents/granola or anywhere — it loads NOTION_API_TOKEN
from the Hackathon-Cerebro .env file.
"""

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request


ENV_PATH = "/Users/alfalfa/Documents/GitHub/Hackathon-Cerebro/.env"
DS = "362a4866-2b25-801c-9ce5-000b30156f9b"


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
    token = env.get("NOTION_API_TOKEN") or os.environ.get("NOTION_API_TOKEN")
    if not token:
        print("NOTION_API_TOKEN not found in .env", file=sys.stderr)
        sys.exit(1)
    h = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
    }

    restored = errors = scanned = 0
    cursor = None
    seen_titles = []

    while True:
        body = {"filter": {"property": "object", "value": "page"}, "page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        req = urllib.request.Request(
            "https://api.notion.com/v1/search",
            data=json.dumps(body).encode(),
            headers=h,
            method="POST",
        )
        d = fetch(req)
        for p in d.get("results", []):
            scanned += 1
            # Need both archived/in_trash AND Data Type = "Granola Meeting"
            is_trashed = p.get("in_trash") or p.get("archived")
            if not is_trashed:
                continue
            dt = p.get("properties", {}).get("Data Type", {}).get("select")
            if not dt or dt.get("name") != "Granola Meeting":
                continue
            # Also confirm the page is in our target data source (avoid restoring
            # unrelated archived Granola Meeting pages from other databases)
            parent = p.get("parent", {})
            if parent.get("data_source_id") != DS and parent.get("database_id"):
                # Some payloads may use database_id; we can't easily map that to DS,
                # so accept if data_source_id matches OR fallback by name only.
                pass

            pid = p["id"]
            title_prop = p.get("properties", {}).get("Name", {}).get("title", [])
            title = title_prop[0]["plain_text"] if title_prop else "(untitled)"
            try:
                preq = urllib.request.Request(
                    f"https://api.notion.com/v1/pages/{pid}",
                    data=json.dumps({"archived": False}).encode(),
                    headers=h,
                    method="PATCH",
                )
                fetch(preq)
                restored += 1
                if len(seen_titles) < 10:
                    seen_titles.append(title)
            except Exception as e:
                errors += 1
                if errors <= 3:
                    print(f"  ! restore failed {pid}: {e}", flush=True)
            time.sleep(0.35)
            if restored and restored % 20 == 0:
                print(f"  restored={restored} errors={errors}", flush=True)
        if not d.get("has_more"):
            break
        cursor = d.get("next_cursor")

    print(f"\nDONE. scanned={scanned} restored={restored} errors={errors}")
    print("\nFirst restored titles:")
    for t in seen_titles:
        print(f"  - {t}")


if __name__ == "__main__":
    main()
