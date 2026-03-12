#!/usr/bin/env python3
from bs4 import BeautifulSoup
import requests

url = "https://uk-air.defra.gov.uk/data/flat_files?site_id=BRIS"
html = requests.get(url, timeout=60).text
soup = BeautifulSoup(html, "html.parser")

for a in soup.find_all("a", href=True):
    text = " ".join(a.get_text(" ", strip=True).split())
    href = a["href"]
    if "csv" in text.lower() or "csv" in href.lower() or "2005" in text:
        print(text, "->", href)