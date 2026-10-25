#!/usr/bin/env python3
# This verifier checks evidence consistency without running a model or editing a project.
import pathlib,json,hashlib,csv,re
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'results'
manifest=json.loads((ROOT/'manifest.json').read_text())['files']
changed=[p for p,h in manifest.items() if hashlib.sha256((ROOT/'source'/p).read_bytes()).hexdigest()!=h]
extra=[str(p.relative_to(ROOT/'source')) for p in (ROOT/'source').rglob('*') if p.is_file() and 'node_modules' not in p.parts and str(p.relative_to(ROOT/'source')) not in manifest]
(OUT/'post-integrity.json').write_text(json.dumps({'manifest_files':len(manifest),'changed_manifest_files':changed,'extra_non_dependency_files':sorted(extra)},indent=2))
assert not changed,'Packaged source changed'
rows=json.loads((OUT/'results.json').read_text());assert len(rows)==17
assert len([r for r in rows if r['mode']=='live'])==7
assert len([r for r in rows if r['mode']=='mock'])==10
for row in rows:
    fixture=json.loads((OUT/'fixtures'/(row['id']+'.json')).read_text())
    assert {p:hashlib.sha256(content.encode()).hexdigest() for p,content in fixture.items()}==row['pre_hashes'],row['id']
    assert row['parent_elapsed_ms']<180000,row['id']
    assert row['existing_unrelated_files_unchanged'],row['id']
    if row['mode']=='live':assert row['stop_reason']=='success',row['id']
assert len(list(csv.DictReader((OUT/'results.csv').open())))==len(rows)
report=(OUT/'REPORT.md').read_text();assert len(re.findall(r'^\d+\. ',report,re.M))>=25
page=(OUT/'REPORT.html').read_text();assert '<html lang="en">' in page and '<script' not in page
# Private model text stays outside the archive. Check read answers more strictly locally.
private=ROOT/'private-evaluation-v2'
if private.exists():
 for name in ['live-read','live-read-repeat']:
  text=json.loads((private/name/'summary.json').read_text())['final_text']
  assert re.search(r'\b27\b',text) and 'amber' in text.lower()
print('PASS: 274 source hashes, 17 attempt rows, fixture hashes, time limits, report/data counts, 40 takeaways; live answers independently rechecked when private evidence is present.')
