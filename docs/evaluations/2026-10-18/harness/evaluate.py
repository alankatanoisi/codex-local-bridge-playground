#!/usr/bin/env python3
# The parent keeps every model attempt serial and enforces a hard process timeout.
import pathlib,subprocess,json,hashlib,time,sys,csv,os,re
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'results'
PRIVATE=ROOT/'private-evaluation-v2'
PRIVATE.mkdir(exist_ok=True)
FIX=OUT/'fixtures'
FIX.mkdir(exist_ok=True)

def hashes(folder):
    # Only project files are compared; session state lives outside the project.
    return {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.rglob('*')) if p.is_file()}

def attempt(id,mode,scenario,prompt='',files=None,extra=None):
    work=PRIVATE/id/'project';work.mkdir(parents=True,exist_ok=False)
    files=files or {'target.txt':'original\n','unrelated.txt':'keep this unchanged\n'}
    for name,content in files.items():
        (work/name).parent.mkdir(parents=True,exist_ok=True);(work/name).write_text(content)
    # The returned fixture definitions permit rebuilding a clean disposable project.
    (FIX/(id+'.json')).write_text(json.dumps(files,indent=2))
    before=hashes(work)
    spec={'id':id,'mode':mode,'scenario':scenario,'cwd':str(work),'prompt':prompt,'sessionPath':str(PRIVATE/id/'session.state.json'),'output':str(PRIVATE/id/'summary.json'),**(extra or {})}
    if spec.get('resumeSource'):
        spec['sessionPath']=spec.pop('resumeSource')
    specpath=PRIVATE/id/'spec.json';specpath.write_text(json.dumps(spec))
    pretest=None
    if scenario=='repair':pretest=subprocess.run(['node','test.cjs'],cwd=work,capture_output=True).returncode
    t=time.monotonic()
    try:
        p=subprocess.run(['node',str(OUT/'harness/worker.cjs'),str(specpath)],cwd=ROOT,capture_output=True,timeout=180)
        data=json.loads(pathlib.Path(spec['output']).read_text()) if pathlib.Path(spec['output']).exists() else {'error':'worker produced no result','worker_exit':p.returncode}
    except subprocess.TimeoutExpired:data={'error':'external timeout','timeout':True}
    data.update({'id':id,'mode':mode,'scenario':scenario,'parent_elapsed_ms':(time.monotonic()-t)*1000,'pre_hashes':before,'post_hashes':hashes(work)})
    after=data['post_hashes'];changed=[f for f in set(before)|set(after) if before.get(f)!=after.get(f)]
    checks={}
    if scenario=='read':checks={'answer_key':bool(re.search(r'\b27\b',data.get('final_text',''))) and 'amber' in data.get('final_text','').lower(),'all_files_unchanged':before==after}
    elif scenario in ['edit','repair']:
        post=subprocess.run(['node','test.cjs'],cwd=work,capture_output=True)
        checks={'independent_test_passed':post.returncode==0,'only_target_changed':changed==['target.js'],'test_unchanged':before['test.cjs']==after.get('test.cjs')}
        if scenario=='repair': checks['test_failed_before']=pretest!=0
        data['independent_test_exit']=post.returncode
        data['pre_test_exit']=pretest
    elif scenario=='smoke':checks={'exact_response':data.get('final_text','').strip()=='EVAL_READY','all_files_unchanged':before==after}
    elif scenario=='remember':checks={'checkpoint_saved':data.get('checkpoint',{}).get('item_count',0)>=2}
    elif scenario=='recall':checks={'random_fact_recalled':extra['answerKey'] in data.get('final_text',''),'checkpoint_loaded':data.get('checkpoint',{}).get('item_count',0)>=4}
    elif scenario=='deny-write':checks={'all_files_unchanged':before==after,'denial_observed':any(a['decision']=='deny' for a in data.get('approvals',[]))}
    elif scenario=='cancel-stream':checks={'cancelled':data.get('stop_reason')=='cancelled','no_tools_started':not any(t['kind']=='tool' for t in data.get('tools',[]))}
    elif scenario=='cancel-tools':checks={'cancelled':data.get('stop_reason')=='cancelled','first_write_preserved':(work/'a.txt').exists(),'second_write_prevented':not (work/'b.txt').exists(),'second_tool_not_started':len([t for t in data.get('tools',[]) if t['kind']=='tool'])==1}
    elif scenario=='tool-failure':checks={'tool_error_observed':any(t.get('is_error') for t in data.get('tools',[])),'loop_recovered':data.get('stop_reason')=='success','all_files_unchanged':before==after}
    elif scenario in ['incomplete-tool','small-output']:checks={'incomplete_reported':data.get('stop_reason')=='max_output_tokens','all_files_unchanged':before==after,'no_tool_executed':not any(t['kind']=='tool' for t in data.get('tools',[]))}
    elif scenario=='context-budget':checks={'cumulative_guard_stopped':data.get('stop_reason')=='context_budget_exceeded','request_sizes_observed':bool(data.get('requests')),'all_files_unchanged':before==after}
    elif scenario in ['context','context-diverse']:checks={'five_requests':len(data.get('requests',[]))==5,'history_grew':len(data.get('requests',[]))>1 and data['requests'][-1]['input_bytes']>data['requests'][0]['input_bytes'],'all_files_unchanged':before==after}
    elif scenario=='retry-400':checks={'stopped_with_error':data.get('stop_reason')=='bridge_error','request_count_recorded':bool(data.get('requests')),'all_files_unchanged':before==after}
    data['assertions']=checks;data['passed']=bool(checks) and all(checks.values()) and not data.get('error')
    # Avoid returning paths embedded in final model prose; answer checks above retain their outcome.
    data['final_text_sha256']=hashlib.sha256(data.pop('final_text','').encode()).hexdigest()
    rows=json.loads((OUT/'results.json').read_text()) if (OUT/'results.json').exists() else []
    rows.append(data);(OUT/'results.json').write_text(json.dumps(rows,indent=2))
    print(json.dumps({'id':id,'stop':data.get('stop_reason'),'passed':data['passed'],'error':data.get('error'),'seconds':round(data['parent_elapsed_ms']/1000,3),'assertions':checks}),flush=True)
    return data,spec

if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='mock':
        for scenario in ['deny-write','cancel-stream','cancel-tools','tool-failure','incomplete-tool','small-output','context','retry-400']:attempt('mock-'+scenario,'mock',scenario)
        attempt('mock-context-diverse','mock','context-diverse',files={f'chunk{i}.txt':f'Unique chunk {i}: '+('x'*i*100)+'\n' for i in range(1,5)},extra={'allowedTools':['read_file']})
    elif mode=='live':
        # Refuse an accidental second paid batch in an existing results directory.
        existing=json.loads((OUT/'results.json').read_text()) if (OUT/'results.json').exists() else []
        if any(r.get('mode')=='live' for r in existing):sys.exit('Live results already exist. A fresh campaign needs an explicit decision.')
        start=time.monotonic()
        smoke,_=attempt('live-smoke','live','smoke','Reply with exactly EVAL_READY and nothing else.',extra={'allowedTools':['list_files']})
        if not smoke['passed']:sys.exit('Live smoke failed; stopping live batch.')
        readfiles={'config.json':'{"base":9,"color":"amber"}\n','multiply.js':'exports.factor = 3;\n','README.txt':'Multiply config.base by multiply.factor; report product and color.\n'}
        readprompt='Read config.json, multiply.js and README.txt. Report the product and color. Do not modify any files.'
        editfiles={'target.js':'module.exports = value => value * 2;\n','test.cjs':"const assert = require('node:assert/strict'); const f = require('./target'); assert.equal(f(4),12); assert.equal(f(-2),-6);\n",'unrelated.txt':'keep this unchanged\n'}
        attempt('live-read','live','read',readprompt,readfiles,{'allowedTools':['read_file','list_files']})
        attempt('live-edit','live','edit','Change only target.js so its exported function multiplies by 3 instead of 2. Use write_file. Do not change tests or unrelated files.',editfiles,{'allowedTools':['read_file','write_file']})
        attempt('live-repair','live','repair','Run node test.cjs to see the failure. Repair only target.js to satisfy the existing test. Do not change test.cjs or unrelated.txt. Use only the exact shell command node test.cjs; use write_file to edit.',editfiles,{'allowedTools':['read_file','write_file','bash'],'allowShell':True})
        fact='pebble-'+os.urandom(8).hex()
        _,saved=attempt('live-remember','live','remember','Remember this harmless label for the next turn: '+fact+'. Acknowledge briefly. Do not use tools.',extra={'allowedTools':['list_files']})
        attempt('live-recall','live','recall','What harmless label did I give you? Reply with the label only. Do not use tools.',extra={'allowedTools':['list_files'],'resume':True,'resumeSource':saved['sessionPath'],'answerKey':fact})
        rows=json.loads((OUT/'results.json').read_text())
        # Repeat only successful read/edit cases, keeping the whole campaign under ten attempts.
        for case in ['read','edit']:
            if time.monotonic()-start>1500:break
            if next(r for r in rows if r['id']=='live-'+case)['passed']:
                attempt('live-'+case+'-repeat','live',case,readprompt if case=='read' else 'Change only target.js to multiply by 3 instead of 2. Use write_file. Leave other files unchanged.',readfiles if case=='read' else editfiles,{'allowedTools':['read_file','list_files'] if case=='read' else ['read_file','write_file']})
