import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from '../shared';

test('Windows API renderer exposes both arti endpoints and no local installation controls', async () => {
  const directory=await mkdtemp(join(tmpdir(),'yanmo-arti-ui-'));
  const state={ page:'settings',stage:'idle',action:'dictation',apiOnly:true,platform:'windows',settings:defaultSettings('windows'),library:{manuscripts:[],lexicon:[]},selectedID:null,draft:'',original:'',asrResults:[],notice:'',seconds:0,level:0,destinationName:'',checking:false,modelsChecked:true,overlayVisible:false,models:{asr:false,llm:false,sensevoice:false,metal:false},native:{accessibility:true,eventTap:true,microphone:0,devices:[]},translation:{source:'',result:'',language:'en',loading:false,error:''},captureAction:null,shortcutNotice:'',launchAtLogin:false,onlineKeys:{asr:false,text:false},runtime:{status:'online-ready',issues:[],capabilities:{asr:'online',text:'online'}} };
  const fixture=join(directory,'main.cjs');
  await writeFile(fixture,`const {app,BrowserWindow,ipcMain}=require('electron'); app.setPath('userData',${JSON.stringify(directory)}); app.whenReady().then(async()=>{app.dock?.hide();const state=${JSON.stringify(state)};ipcMain.handle('yanmo:state',()=>state);ipcMain.handle('yanmo:action',(_event,action,args)=>{if(action==='page')state.page=args;for(const w of BrowserWindow.getAllWindows())w.webContents.send('yanmo:state',state);return {ok:true}});const w=new BrowserWindow({width:1120,height:800,show:false,webPreferences:{preload:${JSON.stringify(resolve('.electron/preload.cjs'))},contextIsolation:true,nodeIntegration:false}});await w.loadFile(${JSON.stringify(resolve('web/index.html'))});});`);
  const env: Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string')); delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[fixture],env});
  try {
    const page=await app.firstWindow();
    await expect(page.locator('.shortcut-row kbd')).toHaveText(['Control', 'Control + Shift', 'Control + 空格']);
    await expect(page.getByRole('heading',{name:'局域网 API',exact:true})).toBeVisible();
    for (const field of await page.getByRole('textbox',{name:'服务地址（Base URL）'}).all()) await expect(field).toHaveValue('https://arti.local/v1');
    await expect(page.getByRole('button',{name:'准备模型',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'改回本机处理',exact:true})).toHaveCount(0);
    await expect(page.getByText('录音与文字发送到 arti.local',{exact:true})).toBeVisible();
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.getByRole('heading',{name:'局域网 API',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:'/tmp/yanmo-arti-settings.png',animations:'disabled'});
  } finally { await app.close();await rm(directory,{recursive:true,force:true}); }
});
