#!/usr/bin/env python3
"""Classify Breathe London station scenarios from Dropbox R2 v2 core backups."""
from __future__ import annotations
import argparse, sys, zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape
import blondon_identity_timeline as b

SHEAD=("Network","connector_id","station_id","site_ref","station_name","device_ref","first_seen_at","removed_at","active","InstallationCode","SensorContract","PM2.5 ref","PM2.5 last_value_at","NO2 ref","NO2 last_value_at","latest value_at","latitude","longitude")
LHEAD=("relationship","Communities station_id","Communities site_ref","Communities name","Communities device_ref","Communities first_seen_at","Communities removed_at","Communities active","Communities PM2.5 ref","Communities PM2.5 last","Communities NO2 ref","Communities NO2 last","Communities latest","Nodes station_id","Nodes site_ref","Nodes name","Nodes device_ref","Nodes first_seen_at","Nodes removed_at","Nodes active","Nodes current InstallationCode","Nodes current SensorContract","Nodes PM2.5 ref","Nodes PM2.5 last","Nodes NO2 ref","Nodes NO2 last","Nodes latest","link record location","link DeviceCode","link InstallationCode","link StartDate","link EndDate","link SensorContract","same current device_ref","overlap start","overlap end","overlap hours","gap days","Communities latitude","Communities longitude","Nodes latitude","Nodes longitude")

def dt(v): return b.parse_source_datetime(v)
def f(v): return v.strftime("%d/%m/%Y %H:%M") if v else ""
def yn(v): return "yes" if v else "no"
def latest(snaps,name):
    s=b.latest_snapshot_with_table(snaps,name)
    if not s: raise RuntimeError(f"No v2 core snapshot containing {name}")
    p=b.table_path(s[1],s[2],name)
    if not p: raise RuntimeError(f"No readable {name} table")
    return s[0],p

def load_stations(snaps):
    day,p=latest(snaps,"stations"); out={}; byid={}
    for r in b.iter_ndjson_gz(p):
        cid=int(r.get("connector_id") or 0)
        if cid not in b.TARGET_CONNECTOR_IDS: continue
        ref=b.clean_text(r.get("station_ref"))
        if not ref: continue
        k=b.StationKey(cid,ref)
        s={"key":k,"id":int(r.get("id")),"name":b.clean_text(r.get("station_name") or r.get("label")),"device":b.clean_text(r.get("station_device_ref")),"first":dt(r.get("first_seen_at")),"removed":dt(r.get("removed_at")),"lat":r.get("latitude"),"lon":r.get("longitude")}
        out[k]=s; byid[s["id"]]=k
    return out,byid,day

def load_meta_links(snaps,stations,byid):
    day,p=latest(snaps,"station_initial_metadata"); meta={}
    for r in b.iter_ndjson_gz(p):
        k=byid.get(int(r.get("station_id") or 0)); a=r.get("attributes")
        if k and isinstance(a,dict): meta[k]=a
    communities=defaultdict(list)
    for k in stations:
        if k.connector_id==3: communities[k.normalised_ref].append(k)
    links=[]; seen=set()
    for nk,a in meta.items():
        if nk.connector_id!=2: continue
        for loc,r in b.metadata_records(a):
            inst=b.clean_text(r.get("InstallationCode"))
            for ck in communities.get(b.normalise_ref(inst),[]):
                sig=(nk,ck,loc,b.clean_text(r.get("StartDate")),b.clean_text(r.get("EndDate")))
                if sig in seen: continue
                seen.add(sig); links.append({"n":nk,"c":ck,"loc":loc,"device":b.clean_text(r.get("DeviceCode")),"inst":inst,"start":b.clean_text(r.get("StartDate")),"end":b.clean_text(r.get("EndDate")),"contract":b.clean_text(r.get("SensorContract"))})
    return meta,links,day

def load_series(snaps,stations):
    _,pp=latest(snaps,"observed_properties"); _,tp=latest(snaps,"timeseries"); props={}
    for r in b.iter_ndjson_gz(pp):
        try: props[int(r.get("id"))]=b.clean_text(r.get("code")).lower()
        except: pass
    byid={s["id"]:k for k,s in stations.items()}; vals=defaultdict(dict); z=datetime.min.replace(tzinfo=timezone.utc)
    for r in b.iter_ndjson_gz(tp):
        try: k=byid.get(int(r.get("station_id"))); pol=props.get(int(r.get("observed_property_id")),"")
        except: continue
        if not k or pol not in ("pm25","no2"): continue
        cand=(b.clean_text(r.get("timeseries_ref")),dt(r.get("last_value_at"))); old=vals[k].get(pol)
        if old is None or (cand[1] or z)>(old[1] or z): vals[k][pol]=cand
    return vals

def overlap(a,c):
    if not a["first"] or not c["first"]: return None,None,None
    far=datetime.max.replace(tzinfo=timezone.utc); start=max(a["first"],c["first"]); end=min(a["removed"] or far,c["removed"] or far)
    if start>=end: return None,None,None
    return start,(None if end==far else end),(None if end==far else (end-start).total_seconds()/3600)

def scenario(n,c,e):
    ov,_,_=overlap(n,c); locs={x["loc"] for x in e}
    if ov is None and any(x.startswith("source_history[") for x in locs): return "Communities → Nodes succession"
    if "attributes" in locs and n["first"] and n["first"].year<2025: return "Legacy dual-connector representation"
    if ov is not None and n["first"] and n["first"].year>=2025: return "Concurrent co-location"
    return "Other linked relationship"

def sr(s,series,meta):
    v=series.get(s["key"],{}); pm=v.get("pm25",("",None)); no=v.get("no2",("",None)); latestv=max([x for x in (pm[1],no[1]) if x],default=None); m=meta.get(s["key"],{})
    return [b.CONNECTOR_LABELS[s["key"].connector_id],s["key"].connector_id,s["id"],s["key"].site_ref,s["name"],s["device"],f(s["first"]),f(s["removed"]),yn(s["removed"] is None),b.clean_text(m.get("InstallationCode")),b.clean_text(m.get("SensorContract")),pm[0],f(pm[1]),no[0],f(no[1]),f(latestv),s["lat"] or "",s["lon"] or ""]

def lr(n,c,e,rel,series,meta):
    def sv(s,pol): return series.get(s["key"],{}).get(pol,("",None))
    cp,cn=sv(c,"pm25"),sv(c,"no2"); np,nn=sv(n,"pm25"),sv(n,"no2"); cl=max([x for x in (cp[1],cn[1]) if x],default=None); nl=max([x for x in (np[1],nn[1]) if x],default=None); ov1,ov2,ovh=overlap(n,c); gap=(n["first"]-c["removed"]).total_seconds()/86400 if n["first"] and c["removed"] else None; nm=meta.get(n["key"],{})
    def j(field):
        out=[]
        for x in e:
            v=b.clean_text(x[field])
            if v and v not in out: out.append(v)
        return "; ".join(out)
    return [rel,c["id"],c["key"].site_ref,c["name"],c["device"],f(c["first"]),f(c["removed"]),yn(c["removed"] is None),cp[0],f(cp[1]),cn[0],f(cn[1]),f(cl),n["id"],n["key"].site_ref,n["name"],n["device"],f(n["first"]),f(n["removed"]),yn(n["removed"] is None),b.clean_text(nm.get("InstallationCode")),b.clean_text(nm.get("SensorContract")),np[0],f(np[1]),nn[0],f(nn[1]),f(nl),j("loc"),j("device"),j("inst"),j("start"),j("end"),j("contract"),yn(bool(n["device"] and c["device"] and n["device"]==c["device"])),f(ov1),f(ov2),round(ovh,2) if ovh is not None else "",round(gap,2) if gap is not None else "",c["lat"] or "",c["lon"] or "",n["lat"] or "",n["lon"] or ""]

def info_xml(rows):
    xr=['<row r="1">'+b.inline_string_cell(1,1,"Breathe London Scenario Report",style=1)+'</row>']
    for i,(a,v) in enumerate(rows,3): xr.append(f'<row r="{i}">'+b.inline_string_cell(i,1,a,style=4)+b.inline_string_cell(i,2,v)+'</row>')
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="38" customWidth="1"/><col min="2" max="2" width="110" customWidth="1"/></cols><sheetData>'+''.join(xr)+'</sheetData></worksheet>'

def write(output,sheets):
    n=len(sheets); ct=['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']+[f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1,n+1)]+['</Types>']; wb='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+''.join(f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>' for i,(name,_) in enumerate(sheets,1))+'</sheets></workbook>'; rel=['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']+[f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1,n+1)]+[f'<Relationship Id="rId{n+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>']; rr='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'; output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,"w",zipfile.ZIP_DEFLATED) as z: z.writestr("[Content_Types].xml",''.join(ct)); z.writestr("_rels/.rels",rr); z.writestr("xl/workbook.xml",wb); z.writestr("xl/_rels/workbook.xml.rels",''.join(rel)); z.writestr("xl/styles.xml",b.styles_xml()); [z.writestr(f"xl/worksheets/sheet{i}.xml",x) for i,(_,x) in enumerate(sheets,1)]

def main(argv=None):
    p=argparse.ArgumentParser(); p.add_argument("--root",default=""); p.add_argument("--output",default="BreatheLondon_scenarios.xlsx"); a=p.parse_args(argv); root=b.resolve_backup_root(a.root); snaps=b.discover_core_snapshots(root); stations,byid,day=load_stations(snaps); meta,links,mday=load_meta_links(snaps,stations,byid); series=load_series(snaps,stations); groups=defaultdict(list)
    for x in links: groups[(x["n"],x["c"])].append(x)
    linked={k for pair in groups for k in pair}; stand={"Communities Active":[],"Communities Retired":[],"Nodes Active":[],"Nodes Retired":[]}
    for k,s in sorted(stations.items(),key=lambda x:(x[0].connector_id,x[0].normalised_ref)):
        if k in linked: continue
        name=("Communities " if k.connector_id==3 else "Nodes ")+("Active" if s["removed"] is None else "Retired"); stand[name].append(sr(s,series,meta))
    rels=defaultdict(list)
    for (nk,ck),e in groups.items(): rel=scenario(stations[nk],stations[ck],e); rels[rel].append(lr(stations[nk],stations[ck],e,rel,series,meta))
    summary=[["Communities only active",len(stand["Communities Active"]),"Standalone connector 3; no authoritative Nodes link"],["Communities only retired",len(stand["Communities Retired"]),"Retired standalone connector 3"],["Nodes only active",len(stand["Nodes Active"]),"Standalone connector 2; no authoritative Communities link"],["Nodes only retired",len(stand["Nodes Retired"]),"Retired standalone connector 2"],["Communities → Nodes succession",len(rels["Communities → Nodes succession"]),"source_history link; no actual active-period overlap"],["Concurrent co-location",len(rels["Concurrent co-location"]),"post-2024 Nodes station overlaps linked Communities station"],["Legacy dual-connector representation",len(rels["Legacy dual-connector representation"]),"pre-2025 top-level InstallationCode relationship"],["Other linked relationship",len(rels["Other linked relationship"]),"authoritative link outside defined scenarios"]]
    sw=(26,12,14,16,38,18,20,20,9,22,18,25,20,25,20,20,14,14); lw=(34,18,18,38,20,20,20,10,24,20,24,20,20,16,16,38,18,20,20,10,22,18,24,20,24,20,20,22,20,22,24,24,18,18,20,20,18,14,14,14,14,14)
    sheets=[("Summary",b.build_table_sheet_xml(("Scenario","Rows","Definition"),summary,(38,12,100))),("Communities Active",b.build_table_sheet_xml(SHEAD,stand["Communities Active"],sw)),("Communities Retired",b.build_table_sheet_xml(SHEAD,stand["Communities Retired"],sw)),("Nodes Active",b.build_table_sheet_xml(SHEAD,stand["Nodes Active"],sw)),("Nodes Retired",b.build_table_sheet_xml(SHEAD,stand["Nodes Retired"],sw)),("Succession",b.build_table_sheet_xml(LHEAD,rels["Communities → Nodes succession"],lw)),("Concurrent Co-location",b.build_table_sheet_xml(LHEAD,rels["Concurrent co-location"],lw)),("Legacy Dual Connector",b.build_table_sheet_xml(LHEAD,rels["Legacy dual-connector representation"],lw)),("Other Linked",b.build_table_sheet_xml(LHEAD,rels["Other linked relationship"],lw))]
    sheets.append(("Report Info",info_xml([("Latest core snapshot",day.isoformat()),("station_initial_metadata snapshot",mday.isoformat()),("Dropbox R2 root",str(root)),("Relationship authority","Nodes InstallationCode == Communities station_ref in attributes/source_history"),("Never used to create relationships","DeviceCode, names, coordinates"),("Active definition","stations.removed_at is null in latest core"),("Data recency","PM2.5/NO2 last_value_at is shown separately from active state"),("Row contract","standalone sheets: one row per station; relationship sheets: one row per Communities/Nodes pair")])) )
    out=Path(a.output).expanduser().resolve(); write(out,sheets); print(out); return 0
if __name__=="__main__": raise SystemExit(main(sys.argv[1:]))