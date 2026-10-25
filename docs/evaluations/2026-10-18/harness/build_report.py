#!/usr/bin/env python3
# Turn the measured JSON into two human-readable views and a spreadsheet-friendly CSV.
# No model calls happen here; regenerating the report costs nothing.
import pathlib,json,csv,html,re,hashlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'results'
rows=json.loads((OUT/'results.json').read_text());env=json.loads((OUT/'environment.json').read_text())
live=[r for r in rows if r['mode']=='live'];mock=[r for r in rows if r['mode']=='mock']
for r in rows:
    # Keep the original strict verdict. A second view explains expected runner bookkeeping.
    original=r['pre_hashes'];after=r['post_hashes']
    r['existing_unrelated_files_unchanged']=all(after.get(p)==h for p,h in original.items() if p!='target.js')
    r['added_paths']=sorted(set(after)-set(original))
    r['changed_existing_paths']=sorted(p for p in original if after.get(p)!=original[p])
    r['model_call_count']=sum(e['type']=='model_request' for e in r.get('events',[]))
    signatures=[t['signature'] for t in r.get('tools',[]) if t['kind']=='tool']
    r['tool_request_count']=len(signatures);r['repeated_tool_signatures']=len(signatures)-len(set(signatures))
    r['first_token_latency_ms']=None
    r['actual_billed_usd']=None
    r['live_request_bytes']=None if r['mode']=='live' else 'see requests'
(OUT/'results.json').write_text(json.dumps(rows,indent=2))
columns=['id','mode','scenario','passed','stop_reason','parent_elapsed_ms','elapsed_ms','model_call_count','tool_request_count','repeated_tool_signatures','input_tokens','output_tokens','cache_read_input_tokens','reasoning_tokens','reference_cost_usd','actual_billed_usd','existing_unrelated_files_unchanged','assertions']
with (OUT/'results.csv').open('w') as f:
    w=csv.DictWriter(f,fieldnames=columns);w.writeheader()
    for r in rows:
        d={c:r.get(c) for c in columns};d.update({k:r.get('usage',{}).get(k) for k in ['input_tokens','output_tokens','cache_read_input_tokens','reasoning_tokens']});d['assertions']=json.dumps(r['assertions']);w.writerow(d)
checks=json.loads((OUT/'baseline-checks.json').read_text())
baseline='Initial supplied integrity checker: PASS, 274 files, exit 0 (before installation).\nSubsequent strict checker: FAIL, exit 1; four Finder .DS_Store additions.\nAll 274 manifest-listed files still match; no runner fixes were made.\n\n'+''.join(f"{r['check']}: exit {r['exit_code']}, {r['elapsed_seconds']:.3f}s\n" for r in checks)+'\nnpm test: 635 pass, 0 fail, 0 skipped, 0 todo.\nComplete local logs are retained in results/private-logs; excluded from the return archive.\nSECURITY.md absent from incoming snapshot.\n'
(OUT/'baseline-checks.txt').write_text(baseline)
cost=sum(r.get('reference_cost_usd',0) or 0 for r in live)
usage={k:sum(r.get('usage',{}).get(k,0) for r in live) for k in ['input_tokens','output_tokens','cache_read_input_tokens','reasoning_tokens']}
findings=[
('P1 · observed design limitation','Native history compaction is bypassed.','run.js:988-995 explicitly leaves native Responses history unchanged. The bounded context probes observed growth, not a full context-window test. Proposed next work: implement and independently test native compaction before long campaigns.'),
('P1 · observed guard behavior','Context accounting conflates cumulative usage with current context.','run.js:1211 uses total input plus output across calls. mock-context-budget stopped on request four at 10,080 cumulative tokens while that request carried only a small history. Proposed fix: keep spend counters separate from current-request context accounting.'),
('P2 · observed retry behavior','Permanent HTTP 400 failures are retried immediately.','mock-retry-400 sent the same invalid request three times in about 8 ms between first and last request notifications. run.js:1116-1125 retries broad transport errors without classification or delay. Proposed fix: fail permanent errors immediately; bound and delay transient retries.'),
('P2 · observed API trap','Session filenames without .state.json collide with their ledger.','The first harness used session.json. session-ledger.js:19-21 returned that same filename, and subsequent loading rejected ledger JSON as an unsupported session. Eight setup failures are retained separately; no live calls occurred. Proposed fix: reject unsupported suffixes before file creation or derive ledger paths safely.'),
('P2 · observed event-contract gap','Cancellation still announces a later tool request.','mock-cancel-tools emitted a second tool_use and an error receipt after cancellation. tool-registry.js:190 blocked execution; b.txt was absent and a.txt survived. Proposed fix: distinguish requested/cancelled/executing events, or check cancellation before request announcements while preserving paired receipts.'),
('P3 · observed fixture side effect','Edits create backup and manifest files inside the disposable project.','live-edit and live-repair changed target.js and added .bridge-runner bookkeeping. Both passed the independent test and preserved all existing unrelated files. Strict only-target-changed remained false. Proposed evaluation improvement: specify allowed bookkeeping separately; do not hide the original assertion.'),
]
takeaways=[
'Integrity succeeded on all 274 incoming files before dependency installation; this is the anchor for an untouched baseline.',
'The later strict checker failure is explained by Finder metadata additions, not changed runner source. Dependencies also make that whole-tree checker unsuitable after npm ci.',
'The complete automated baseline matched the prior count: 635 passing tests, zero failures, zero skipped tests, zero todo tests.',
'Lint passed; this checks the configured JavaScript rules and does not establish live model quality.',
'Formatting passed; no source reformatting was needed to obtain that result.',
'The snapshot has no Git branch or history. Its manifest base identifies provenance, but includes incoming uncommitted source state as described by the handoff.',
'The selected machine ran Node 22.22.3, satisfying the supplied Node 22 minimum; machine details are in environment.json without username or serial number.',
'The local host reported status ok with zero active requests before the batch. Host health alone was not counted as model readiness.',
'The tiny exact-response request returned EVAL_READY, proving this host/token/model path worked for that request.',
'The harness never read the upstream credential; clientEnvironment supplied only the local host connection in process memory.',
'The read task produced the known product 27 and color amber; every fixture byte remained unchanged.',
'The repeated read task independently met the same answer and unchanged-file checks.',
'The two read samples took 5.543 and 8.558 seconds including process startup. Two samples cannot establish typical latency or a percentile.',
'The narrow edit changed the exported multiplier from two to three and passed an independent Node assertion test.',
'All existing unrelated files survived both writing tasks byte-for-byte, including the test; generated bookkeeping explains their strict assertion failures.',
'The repair fixture failed before the model ran and passed afterward; this rules out a meaningless initially-green repair task.',
'The repair model actually requested node test.cjs before and after its edit; exact commands and receipts are recorded in measurements.',
'Shell was enabled only for the repair experiment. The injected approval allowed only the exact test command and write_file on target.js.',
'The shell tool itself is not an operating-system sandbox; this evaluation used a disposable project and narrow approval rather than treating cwd as command confinement.',
'A randomized harmless label survived an actual process restart and was recalled without being repeated in the second prompt.',
'The resumed checkpoint used schema version 2 and provider codex. Checkpoint item counts are returned, while live session contents stay private.',
'The denied-write mock returned success at the conversation level even though the write was denied. Final stop reason alone is insufficient; check filesystem outcomes and approval records.',
'Cancellation during an active mock stream returned cancelled and started no tools; this is deterministic local evidence, not live network race coverage.',
'Cancellation between two writes preserved the completed first write and blocked the second mutation.',
'The later tool_use announcement after cancellation fails the strict observer expectation, despite the execution guard protecting the file.',
'A missing-file tool error was reported and the loop continued to the next mock response; this proves control-flow recovery, not a live model repair strategy.',
'Incomplete function arguments did not execute a write and were not stored as completed function calls.',
'The small-output mock preserved partial text and reported max_output_tokens rather than success. Synthetic usage intentionally need not obey the requested limit; this tests runner interpretation, not upstream enforcement.',
'The original context probe repeated the same call and triggered semantic_cycle_detected after four requests. Preserve this outcome as evidence of the loop guard.',
'The diverse context probe completed five requests, separating growing serialized input from cumulative usage without filling a real context window.',
'Native compaction remains unimplemented in this path; inherited compaction tests are not evidence that native Responses history can be compressed safely.',
'The cumulative context guard can stop a sequence of individually small requests. Use it as cumulative protection until current-context measurement is separated.',
'The HTTP 400 probe showed three immediate retries of unchanged invalid input. Permanent/transient classification should precede a longer evaluation.',
'The session filename suffix is a real integration requirement that deserves input validation and a regression test; the harness correction did not modify the runner.',
'All observed live cached-token and reasoning-token counters were zero; this does not establish that caching or reasoning is absent in other workloads.',
'Live timings separate overall process duration, observer-bounded model calls, tool request-to-result duration, and injected approval delay. Tool duration includes any approval wait.',
'First-token latency and live wire request bytes are unavailable in this harness. A completed assistant event must not be presented as first-token timing.',
'The total reference estimate is about 2.78 cents, far below the $25 authorization under the snapshot pricing table. Actual billed dollars were not observable or independently verified.',
'Seven live attempts stayed below the ten-attempt ceiling. Only the successful read case was repeated; strict side-effect failures made the edit ineligible for an automatic repeat.',
'This is a small functional evaluation, not evidence about large repositories, long sessions, high effort, network recovery, sleep/wake behavior, Starlark, or additional T3 features.'
]
lines=['# Bounded Codex runner evaluation — 2026-10-18','',
'Untouched baseline: **635 tests passed; lint and formatting passed.** Seven live attempts all reached runner success. Five passed every strict fixture assertion; two writing cases passed their behavior checks but failed the strict no-extra-files check because of runner bookkeeping. Ten deterministic mock probes include two intentionally retained strict failures. No runner fixes were made.','',
'## Scope, provenance, and boundaries','',
f"Evaluation folder: /Users/alanman/Developer/codex-evaluation-2026-10-18. Source: its isolated source/ snapshot, with no Git branch. Manifest base: {env['base_commit']}. Manifest SHA-256: {env['manifest_sha256']}. The session initially opened in the Claude playground; all evaluation work was explicitly directed to the Codex snapshot. Report publication target: codex-local-bridge-playground, main. The snapshot is never initialized as a repository.",'',
'Existing repositories were not test fixtures. All model edit targets lived under private-evaluation-v2/ inside this evaluation folder. Source files were not fixed. Starlark and additional T3 features remained deferred. No parallel live campaigns or agents were used.','',
'## Baseline evidence','',baseline.strip(),'',
'## Protocol and budget','',
'Live configuration: gpt-6.1-sol, low effort, 4,000 maximum output tokens per request, eight maximum model steps, 32,000 output tokens per run, bare startup, isolated .state.json checkpoints, archives disabled, and injected explicit approvals. Each run used a $2 reference-cost guard and a 175-second runner wall-clock setting inside an external 180-second subprocess timeout. Seven live attempts used 45.343 seconds of summed external attempt duration, comfortably inside the 30-minute campaign ceiling. No timeout occurred. The live series spanned under five minutes including local inspection between outputs.','',
f"Observed live usage: {usage['input_tokens']:,} input tokens; {usage['output_tokens']:,} output tokens; {usage['cache_read_input_tokens']} cached-input tokens; {usage['reasoning_tokens']} reported reasoning tokens. Total reference estimate: **${cost:.6f}** from the incoming source table. Actual account charges and dashboard billing were unavailable. This estimate is not an invoice, and the configured guard is based on reference prices. No additional paid calls were made after this bounded batch.",'',
'## Attempt measurements','',
'Elapsed time below includes starting and ending the worker process. Model calls count request notifications. Tool requests include cancelled announcements, not only executed effects. “Strict fail” preserves an assertion that did not pass, even where the model task succeeded.','',
'| Attempt | Evidence | Elapsed s | Model calls | Tool requests | Stop reason | Strict verdict |','| --- | --- | ---: | ---: | ---: | --- | --- |']
for r in rows:lines.append(f"| {r['id']} | {r['mode']} | {r['parent_elapsed_ms']/1000:.3f} | {r['model_call_count']} | {r['tool_request_count']} | {r.get('stop_reason','unavailable')} | {'Pass' if r['passed'] else 'Fail'} |")
lines+=['','## Independent task outcomes','',
'Read and repeat: correct known answer and all hashes unchanged. Edit and repair: independent Node tests passed; target.js was the only changed existing file; test.cjs and unrelated.txt were unchanged. Each writing task added a backup and a run manifest. Repair also demonstrated an initial failing test (exit 1), followed by an independently verified pass (exit 0). These tasks remain strict failures under the original “only target changed” check.','',
'Restart: the first process saved a randomized harmless fact; a fresh worker loaded the same checkpoint and recalled the fact from a question that did not contain the answer. Both checkpoint assertions passed. The returned data includes only checkpoint structure and answer-check outcomes, not live transcript text.','',
'## Prioritized findings and proposed fixes','']
for priority,title,body in findings:lines+=['### '+priority+' — '+title,'',body,'']
lines+=['## Context probe: bytes versus usage','',
'Input bytes count serialized native history only; request bytes include instructions and tool definitions. Usage is a server-reported token count summed across requests. Bytes and tokens are different units, and cumulative billed processing is different from current context occupancy. Synthetic usage was deliberately controlled to expose that distinction.','',
'| Probe | Request | Input items | Input bytes | Request bytes | Reported input tokens this response |','| --- | ---: | ---: | ---: | ---: | ---: |']
for r in mock:
 if r['scenario'] in ['context-diverse','context-budget']:
  for i,q in enumerate(r['requests'],1):lines.append(f"| {r['id']} | {i} | {q['input_items']} | {q['input_bytes']} | {q['bytes']} | {i*1000} |")
lines+=['','## Broad takeaways and recommendations','']
for i,t in enumerate(takeaways,1):lines+= [f'{i}. {t}','']
lines+=['## Measurement definitions and limitations','',
'Model duration runs from the model_request observer event to the corresponding completed/partial assistant event; it includes local transport and parsing. Tool duration runs from tool_use to tool_result and may include approval or a cancellation rejection. Approval delay measures only the injected callback, not human reaction time. Full elapsed time is measured independently by the parent. HTTP-error calls have no assistant completion, so their individual model duration is unavailable; request and error event timestamps remain available. First-token latency is unavailable. No timing here is a population estimate.','',
'Live wire request sizes were not instrumented; mock HTTP request sizes were measured directly. Cached-input and reasoning counters are recorded as reported. Mock usage/cost values are synthetic and are excluded from live spend. The output-limit and cancellation probes used deterministic local responses; they do not establish live backend enforcement or live cancellation races. Full-window context, network retry backoff recovery, multiple model/effort settings, and adversarial shell isolation were not tested.','',
'## Harness setup evidence and corrections','',
'The first log-directory creation targeted source/results while the logging script expected the parent results directory. That invocation failed before dependency installation or baseline execution; the empty directories were removed and the corrected invocation ran all baseline checks. The initial integrity checker had already passed. A later strict integrity check found Finder .DS_Store additions, and a manifest-only comparison confirmed every packaged file remained unchanged. The baseline script should have gated installation on each repeated integrity failure; it did not. Installation and testing proceeded after that explained metadata-only divergence; this procedural limitation is retained explicitly.','',
'The initial eight mock harness attempts failed before model requests because the session path lacked the required .state.json suffix. Their original failure summaries are retained in harness-setup-failures.json. After correcting the harness path, the same runner source was measured again. The original context/cancellation strict failures also remain in results.json. No failed runner outcome was repaired and relabeled as the incoming baseline.','',
'## Reproduction and returned files','',
'In Terminal on macOS, open it through Spotlight: press Command-Space, type Terminal, and press Return. Start with the folder command below. The first command changes Terminal to this authorized evaluation folder; it does not modify files. The mock command needs no live credential. Use a fresh extracted evaluation folder containing source/ and these results/ files, with no existing private-evaluation-v2 directory. Existing fixture directories cause a safe FileExistsError instead of being overwritten.','',
'```bash',
'# Enter the authorized isolated evaluation folder.',
'cd /Users/alanman/Developer/codex-evaluation-2026-10-18',
'# On a fresh incoming snapshot only, verify before installing dependencies.',
'python3 verify.py',
'# Run the deterministic local probes; success prints one JSON summary per case.',
'python3 results/harness/evaluate.py mock',
'```','',
'The original verify.py compares every source file, so it will fail after dependency installation or Finder metadata additions. That is expected on this already-used folder; do not remove evidence to force it green. The source snapshot and original handoff must accompany a fresh reproduction; the return archive intentionally does not duplicate source or dependencies. Offline probes exercise the actual runner and local HTTP transport.','',
'For a newly authorized live reproduction only, start the supplied host in a Terminal that has the local credential, then run python3 results/harness/evaluate.py live from the evaluation folder. Never paste credentials into chat or command arguments. The live harness refuses a second paid batch if results.json already contains live rows. A host-not-ready error means the host should be checked in the same local state directory. A schema error with a custom session filename means it must end in .state.json.','',
'Returned: REPORT.md and standalone REPORT.html; results.json and results.csv; environment.json; baseline-checks.txt and baseline-checks.json; harness source; fixture definitions; preserved scrubbed setup failures; post-integrity.json; and SHA256SUMS for the archive contents. Complete baseline logs remain local under results/private-logs. Raw live sessions and ledger payloads remain local under private-evaluation*/ and are excluded. The archive excludes source, node_modules, host state, credentials, and live transcripts.','',
'## Handoff and next experiment','',
'Folder: isolated evaluation snapshot; branch: none. Publication: Codex repository main, reports only. Files created: results/ and private evaluation fixtures/state; no manifest-listed source changes. Checks: initial integrity, dependency installation, 635 tests, lint, format, independent fixture assertions, ten offline probes, seven live attempts, report/data consistency checks, and archive checksum verification. Skipped checks: large-project coding, long context, live output exhaustion/cancellation races, actual invoice verification, Starlark, and additional T3 features, all outside this batch or deferred.','',
'Next recommended decision: review the context-accounting, retry-classification, session-filename, and cancellation-event findings before authorizing fixes. Preserve this baseline and compare any later changes against the same fixtures. Do not expand the live campaign automatically. The user-started host remains under user control and was not stopped by this evaluation.','']
md='\n'.join(lines);(OUT/'REPORT.md').write_text(md)
# A deliberately small Markdown renderer keeps the HTML standalone and dependency-free.
# Escape content first; only report-generated formatting becomes HTML.
def inline(s):
 s=html.escape(s);return re.sub(r'\*\*(.*?)\*\*',r'<strong>\1</strong>',s)
parts=[];code=False;table=False;olist=False
for line in lines:
 if line.startswith('```'):
  if table:parts.append('</tbody></table></div>');table=False
  parts.append('</code></pre>' if code else '<pre><code>');code=not code;continue
 if code:parts.append(html.escape(line));continue
 if line.startswith('|'):
  cells=[c.strip() for c in line.strip('|').split('|')]
  if not table:parts.append('<div class="table-scroll"><table><thead><tr>'+''.join('<th>'+inline(c)+'</th>' for c in cells)+'</tr></thead><tbody>');table=True
  elif not all(re.fullmatch(r'[-: ]+',c) for c in cells):parts.append('<tr>'+''.join('<td>'+inline(c)+'</td>' for c in cells)+'</tr>')
  continue
 if table:parts.append('</tbody></table></div>');table=False
 if not line:continue
 if line.startswith('#'):
  n=len(line)-len(line.lstrip('#'));parts.append(f'<h{n}>'+inline(line[n:].strip())+f'</h{n}>')
 elif re.match(r'^\d+\. ',line):
  num,body=line.split('. ',1);parts.append('<div class="takeaway"><span>'+num+'</span><p>'+inline(body)+'</p></div>')
 else:parts.append('<p>'+inline(line)+'</p>')
style='''body{margin:0;background:#f2f4f6;color:#172b35;font:17px/1.65 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:55px 45px;background:white}h1{font-size:42px;line-height:1.16;letter-spacing:-1.5px;color:#133e49}h2{font-size:27px;margin-top:50px;border-top:2px solid #d9e7e9;padding-top:24px}h3{font-size:20px;color:#8b472b;margin-top:28px}p{max-width:96ch}strong{color:#0c6267}.eyebrow{font-size:13px;text-transform:uppercase;letter-spacing:2px;color:#49777b}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:30px 0}.stat{background:#eaf4f3;border-radius:12px;padding:20px}.stat b{font-size:30px;display:block;color:#07575a}.stat small{font-size:13px}.table-scroll{overflow:auto;margin:25px 0}table{border-collapse:collapse;white-space:nowrap;width:100%;font-size:13px}th{background:#123f4a;color:white;text-align:left}td,th{padding:10px;border-bottom:1px solid #d8e2e5}tr:nth-child(even){background:#f3f7f7}pre{padding:20px;background:#142b35;color:#dff4ef;overflow:auto;font-size:14px;border-radius:10px}.takeaway{display:flex;gap:18px;border-bottom:1px solid #e3ebed;padding:14px 0}.takeaway span{flex:0 0 35px;background:#eaf4f3;color:#07575a;text-align:center;height:35px;border-radius:50%;font-weight:bold}.takeaway p{margin:0}footer{margin-top:45px;color:#657b85;font-size:13px}@media(max-width:700px){main{padding:25px 18px}h1{font-size:32px}.stats{grid-template-columns:1fr 1fr}}@media print{body{background:white}main{padding:0}.table-scroll{overflow:visible}table{white-space:normal}h2,h3{break-after:avoid}}'''
page='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bounded Codex runner evaluation · 2026-10-18</title><style>'+style+'</style></head><body><main><div class="eyebrow">Isolated research evaluation · Incoming source preserved</div><div class="stats"><div class="stat"><b>635</b><small>baseline tests passed</small></div><div class="stat"><b>7</b><small>live attempts</small></div><div class="stat"><b>10</b><small>deterministic mock probes</small></div><div class="stat"><b>$0.0278</b><small>reference estimate only</small></div></div>'+ '\n'.join(parts)+'<footer>Self-contained report · No external scripts, fonts, credentials, or live transcripts.</footer></main></body></html>'
(OUT/'REPORT.html').write_text(page)
print(json.dumps({'live_attempts':len(live),'mock_probes':len(mock),'takeaways':len(takeaways),'reference_cost_usd':cost,'live_usage':usage}))
