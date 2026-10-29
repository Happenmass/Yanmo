/** Real synthetic API smoke test, using the same supervised backend and SSE path as the desktop. */
import { BackendClient } from '../desktop/processes.ts';
import { defaultSettings } from '../desktop/shared.ts';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
if (process.env.YANMO_API_ONLY !== '1' || !process.env.YANMO_PYTHON) throw new Error('Set YANMO_API_ONLY=1, YANMO_PYTHON and YANMO_CA_CERT before running.');
const audio=process.argv[2]; const output=process.argv[3];
if (!audio || !output) throw new Error('Usage: node --import tsx scripts/check-arti-api.mts <synthetic.wav> <report.json>');
const root=resolve(import.meta.dirname,'..');
const client=new BackendClient(process.env.YANMO_PYTHON,root);
const settings=defaultSettings('windows');
const online=Object.fromEntries(Object.entries(settings.online).map(([key, value])=>[key,{base_url:value.baseURL,model:value.model,api_key:''}]));
const report: any={ status:await client.status(settings), results:[] };
try {
  for (const operation of ['dictation','voiceTranslation','selectionTranslation']) {
    const events:any[]=[]; const started=Date.now();
    await client.run({task_id:randomUUID(),operation,online,polish:true,target_language:operation==='selectionTranslation'?'zh-Hans':'en',text:operation==='selectionTranslation'?'The review meeting has moved to Friday at 3 p.m.':'',context:{},models:{}},operation==='selectionTranslation'?undefined:resolve(audio),event=>events.push(event));
    const result=events.at(-1);
    if (result?.event!=='result' || !result.text) throw new Error(JSON.stringify(result));
    if (operation==='dictation' && !result.text.includes('周五')) throw new Error('Chinese result lost Friday');
    if (operation==='voiceTranslation' && !result.text.toLowerCase().includes('friday')) throw new Error('Voice translation lost Friday');
    if (operation==='selectionTranslation' && !/周五|星期五|礼拜五/.test(result.text)) throw new Error('Selection translation lost Friday');
    report.results.push({operation,seconds:(Date.now()-started)/1000,events:events.map(event=>event.event),text:result.text});
  }
  report.passed=true;
} finally {
  await client.stop();await writeFile(output,JSON.stringify(report,null,2));
  process.stdout.write(JSON.stringify(report)+'\n');
}
