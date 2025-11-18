import { App, Plugin, Notice, PluginSettingTab, Setting, TFile, WorkspaceLeaf, ItemView, Modal } from 'obsidian';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

interface GitPublisherSettings { repoUri: string; githubToken: string; autoPublishEnabled: boolean; inactivityDelaySec: number; maxIntervalMin: number; defaultBranch: string; debounceMs: number; batchCommitMessage: string; maxFileSizeKB: number; }

export default class GitPublisherPlugin extends Plugin {
	public settings: GitPublisherSettings;
	public pendingChanges: Map<string, boolean> = new Map();
	public inactivityHandle: number | null = null;
	public sessionHandle: number | null = null;
	public sessionStart: number | null = null;
	public lastActivityTime: number | null = null;
	public publishingInProgress = false;
	public publishQueue: Set<string> = new Set();
	private shaMap: Record<string, string> = {};
	private publishedStatusEl: HTMLElement | null = null;
	private publishedCheckbox: HTMLInputElement | null = null;
	private publishedTrack: HTMLElement | null = null;
	private debounceHandle: number | null = null;
	private logPath: string | null = null;
	private lastScanSummary: { total: number; outOfSync: number; missing: number; ts: number } | null = null;

	async loadSettings() {
		const raw: any = await this.loadData();
		const defaults: GitPublisherSettings = { repoUri: '', githubToken: '', autoPublishEnabled: true, inactivityDelaySec: 30, maxIntervalMin: 5, defaultBranch: 'main', debounceMs: 1500, batchCommitMessage: 'Publish', maxFileSizeKB: 1024 };
		if (raw && raw.settings) { this.settings = Object.assign({}, defaults, raw.settings); this.shaMap = raw.shaMap || {}; } else { this.settings = Object.assign({}, defaults, raw || {}); this.shaMap = {}; }
		this.sanitizeSettings();
	}
	async saveSettings() { await this.saveData({ settings: this.settings, shaMap: this.shaMap }); }

	public sanitizeSettings() {
		if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(this.settings.repoUri || '')) { this.settings.repoUri = ''; this.settings.autoPublishEnabled = false; }
		if (!/^[A-Za-z0-9._\/-]+$/.test(this.settings.defaultBranch)) this.settings.defaultBranch = 'main';
		if (this.settings.inactivityDelaySec < 5) this.settings.inactivityDelaySec = 5;
		if (this.settings.maxIntervalMin < 1) this.settings.maxIntervalMin = 1;
		if (this.settings.debounceMs < 250) this.settings.debounceMs = 250;
		if (this.settings.maxFileSizeKB < 50) this.settings.maxFileSizeKB = 50;
		this.settings.batchCommitMessage = this.settings.batchCommitMessage.replace(/[\r\n]/g, ' ').slice(0, 100) || 'Publish';
	}

	private toBase64(str: string): string { return Buffer.from(str, 'utf8').toString('base64'); }

	private async githubReq(method: 'get'|'post'|'patch'|'delete'|'put', url: string, data?: any): Promise<any> {
		try { const r = await axios.request({ method, url, data, headers: { Authorization: `Bearer ${this.settings.githubToken}`, Accept: 'application/vnd.github.v3+json' } }); this.log('github_ok', { method, url, status: r.status }); return r.data; }
		catch(e:any){ const s=e.response?.status; this.log('github_err',{ method,url,status:s, body: e.response?.data }, s===409?'WARN':'ERROR'); if(s===409) new Notice('GitHub 409 Konflikt'); else new Notice(`GitHub Fehler ${s||''}`); return null; }
	}
	private githubGet(url:string){ return this.githubReq('get',url); }
	private githubPost(url:string,data:any){ return this.githubReq('post',url,data); }
	private githubPatch(url:string,data:any){ return this.githubReq('patch',url,data); }
	private githubDelete(url:string,data:any){ return this.githubReq('delete',url,data); }
	private githubPut(url:string,data:any){ return this.githubReq('put',url,data); }

	public ensureGitHubConfig(): boolean { return !!(this.settings.repoUri && this.settings.githubToken); }

	async onload() {
		await this.loadSettings();
		this.initLogging();
		this.registerView('gitpublish-pending-view', leaf => new PendingView(leaf, this));
		this.addRibbonIcon('upload-cloud', 'Git Publish', () => this.activateView());
		this.createPublishedToggle();
		this.addCommands();
		this.registerEvents();
		this.addSettingTab(new GitPublisherSettingTab(this.app, this));
		this.refreshPublishedStatus();
		await this.initialRepoScan();
	}

	onunload() { this.clearTimers(); this.app.workspace.getLeavesOfType('gitpublish-pending-view').forEach(l => l.detach()); }

	private addCommands() {
		this.addCommand({ id: 'gitpub-toggle-published', name: 'Toggle published flag', checkCallback: c => { const f=this.app.workspace.getActiveFile(); if(!f) return false; if(!c) this.togglePublished(f); return true; } });
		this.addCommand({ id: 'gitpub-publish-current', name: 'Publish current file now', checkCallback: c => { const f=this.app.workspace.getActiveFile(); if(!f) return false; if(!c) this.queueFileForPublish(f); return true; } });
		this.addCommand({ id: 'gitpub-publish-all', name: 'Publish all pending now', callback: async ()=>{ await this.publishAllPending(); } });
		this.addCommand({ id: 'gitpub-rescan', name: 'Rescan published files', callback: async ()=>{ const p=this.parseRepo(); if(!p){ new Notice('Repo ungültig'); return;} await this.scanPublishedFiles(p.owner,p.repo); this.updatePendingView(); new Notice('Rescan fertig'); } });
		this.addCommand({ id: 'gitpub-show-help', name: 'Show Git Publisher Hilfe', callback: ()=> new HelpModal(this.app).open() });
		this.addCommand({ id: 'gitpub-add-published-property', name: 'Add published property to current file', checkCallback: c => { const f=this.app.workspace.getActiveFile(); if(!f) return false; if(!c) this.ensurePublishedProperty(f,false); return true; } });
	}

	private registerEvents() {
		this.registerEvent(this.app.workspace.on('active-leaf-change', ()=>{ this.refreshPublishedStatus(); this.updatePendingView(); }));
		this.registerEvent(this.app.metadataCache.on('changed', file=>{ const a=this.app.workspace.getActiveFile(); if(a && file.path===a.path) this.refreshPublishedStatus(); this.updatePendingView(); }));
		this.registerEvent(this.app.workspace.on('editor-change', ()=>{ const f=this.app.workspace.getActiveFile(); if(f) this.handleEditorActivity(f); }));
		this.registerEvent(this.app.vault.on('modify', file=>{ if(!(file instanceof TFile) || file.extension!=='md') return; const c=this.app.metadataCache.getFileCache(file); if(c?.frontmatter?.published===true){ this.pendingChanges.set(file.path,true); this.refreshPublishedStatus(); this.updatePendingView(); } }));
	}

	private activateView() { const leaves=this.app.workspace.getLeavesOfType('gitpublish-pending-view'); if(leaves.length===0){ const rl=this.app.workspace.getRightLeaf(false); if(rl) rl.setViewState({ type:'gitpublish-pending-view', active:true }); } else this.app.workspace.revealLeaf(leaves[0]); }

	public clearTimers(){ if(this.inactivityHandle) clearTimeout(this.inactivityHandle); if(this.sessionHandle) clearTimeout(this.sessionHandle); if(this.debounceHandle) clearTimeout(this.debounceHandle); this.inactivityHandle=this.sessionHandle=this.sessionStart=this.debounceHandle=null; }

	private createPublishedToggle(){ this.publishedStatusEl=this.addStatusBarItem(); this.publishedStatusEl.addClass('gitpublish-status'); this.publishedStatusEl.createSpan({ text:'Published' }).addClass('gitpublish-status-label'); const w=this.publishedStatusEl.createSpan({ cls:'gitpublish-toggle-wrapper' }); const input=document.createElement('input'); input.type='checkbox'; input.className='gitpublish-toggle-input'; w.appendChild(input); this.publishedCheckbox=input; const track=document.createElement('span'); track.className='gitpublish-toggle-track'; track.tabIndex=0; const knob=document.createElement('span'); knob.className='gitpublish-toggle-knob'; track.appendChild(knob); w.appendChild(track); this.publishedTrack=track; const act=async()=>{ if(input.disabled) return; const f=this.app.workspace.getActiveFile(); if(!f) return; await this.setPublished(f,!input.checked); }; track.addEventListener('click',act); track.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); act(); } }); }

	private handleEditorActivity(file:TFile){ if(!this.settings.autoPublishEnabled) return; this.lastActivityTime=Date.now(); if(!this.sessionStart){ this.sessionStart=Date.now(); this.resetSessionTimer(); } this.resetInactivityTimer(file); this.resetDebounce(); }
	private resetDebounce(){ if(this.debounceHandle) clearTimeout(this.debounceHandle); this.debounceHandle=window.setTimeout(()=>{}, this.settings.debounceMs); }
	private resetInactivityTimer(file:TFile){ if(this.inactivityHandle) clearTimeout(this.inactivityHandle); this.inactivityHandle=window.setTimeout(async()=>{ await this.publishFileIfPending(file); this.refreshPublishedStatus(); }, this.settings.inactivityDelaySec*1000); }
	private resetSessionTimer(){ if(this.sessionHandle) clearTimeout(this.sessionHandle); this.sessionHandle=window.setTimeout(async()=>{ await this.publishAllPending(); this.clearTimers(); this.refreshPublishedStatus(); }, this.settings.maxIntervalMin*60*1000); }

	private async publishFileIfPending(file:TFile){ if(!this.settings.autoPublishEnabled) return; const c=this.app.metadataCache.getFileCache(file); if(c?.frontmatter?.published!==true) return; if(!this.pendingChanges.get(file.path)) return; await this.queueFileForPublish(file); }
	public async publishAllPending(){ if(!this.settings.autoPublishEnabled) return; for(const [p,pen] of this.pendingChanges.entries()){ if(!pen) continue; const f=this.app.vault.getAbstractFileByPath(p); if(f instanceof TFile) await this.queueFileForPublish(f); } }
	public async queueFileForPublish(file:TFile){ if(!this.isSafePath(file.path)) return; if(await this.isTooLarge(file)) { this.log('skip_large',{ path:file.path }); return; } this.publishQueue.add(file.path); await this.processPublishQueue(); }
	private async isTooLarge(file:TFile){ const stat = (this.app.vault.adapter as any).stat?.(file.path); if(stat?.size) return stat.size > this.settings.maxFileSizeKB*1024; const content=await this.app.vault.read(file); return content.length > this.settings.maxFileSizeKB*1024; }
	private isSafePath(p:string){ return !p.startsWith('.') && !p.includes('..'); }

	private async processPublishQueue(){ if(this.publishingInProgress) return; if(!this.ensureGitHubConfig()) return; this.publishingInProgress=true; try{ const paths=[...this.publishQueue]; if(paths.length===0) return; await this.publishBatch(paths); paths.forEach(p=>this.publishQueue.delete(p)); } finally { this.publishingInProgress=false; this.refreshPublishedStatus(); this.updatePendingView(); } }

	private parseRepo(): { owner:string; repo:string } | null { const u=this.settings.repoUri; if(!u) return null; const m=u.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\.git)?$/); return m?{ owner:m[1], repo:m[2] }:null; }
	private async fetchContentsSha(owner:string, repo:string, p:string){ const r=await this.githubGet(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}?ref=${this.settings.defaultBranch}`); return r?.sha||null; }
	private async ensureBranchExists(owner:string, repo:string){ const refUrl=`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${this.settings.defaultBranch}`; const ref=await this.githubGet(refUrl); if(ref?.object?.sha) return ref.object.sha; const ok=await this.initializeBranch(owner,repo); if(!ok) return null; const ref2=await this.githubGet(refUrl); return ref2?.object?.sha||null; }
	private async initializeBranch(owner:string, repo:string){ try{ const pathName='.gitkeep'; const res=await this.githubPut(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(pathName)}`, { message:'Initialize branch', content:this.toBase64('init'), branch:this.settings.defaultBranch }); return !!res?.content?.sha; } catch{ return false; } }

	private async publishBatch(paths:string[]){ this.log('batch_start',{ count:paths.length }); const pr=this.parseRepo(); if(!pr){ this.log('batch_abort_parse'); return; } const { owner, repo }=pr; const baseSha=await this.ensureBranchExists(owner,repo); if(!baseSha){ this.log('batch_abort_branch'); return; } const blobs:{ path:string; mode:string; type:string; sha:string }[]=[]; for(const p of paths){ const f=this.app.vault.getAbstractFileByPath(p); if(!(f instanceof TFile)){ this.log('skip_not_file',{ path:p }); continue; } const content=await this.app.vault.read(f); const blob=await this.githubPost(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, { content, encoding:'utf-8' }); if(blob?.sha) blobs.push({ path:p, mode:'100644', type:'blob', sha:blob.sha }); else this.log('blob_fail',{ path:p }); } if(!blobs.length){ this.log('batch_no_blobs'); return; } const tree=await this.githubPost(`https://api.github.com/repos/${owner}/${repo}/git/trees`, { base_tree:baseSha, tree:blobs }); if(!tree?.sha){ this.log('tree_fail'); return; } const msg=`${this.settings.batchCommitMessage} (${new Date().toISOString()})`; const commit=await this.githubPost(`https://api.github.com/repos/${owner}/${repo}/git/commits`, { message:msg, tree:tree.sha, parents:[baseSha] }); if(!commit?.sha){ this.log('commit_fail'); return; } const updated=await this.githubPatch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${this.settings.defaultBranch}`, { sha:commit.sha, force:false }); if(updated){ for(const p of paths) this.pendingChanges.set(p,false); await this.saveSettings(); this.log('batch_ok',{ commit:commit.sha, files:paths.length }); new Notice(`Published ${paths.length} Dateien`); } else this.log('ref_fail'); }

	private async deleteFileFromRepo(file:TFile){ const pr=this.parseRepo(); if(!pr) return; const { owner, repo }=pr; const sha=await this.fetchContentsSha(owner,repo,file.path); if(!sha){ this.log('delete_missing_remote',{ path:file.path }); return; } const res=await this.githubDelete(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}`, { message:`Unpublish ${file.path}`, branch:this.settings.defaultBranch, sha }); if(res){ this.pendingChanges.delete(file.path); this.log('deleted',{ path:file.path }); } }

	private async togglePublished(file:TFile){ const cur=await this.getPublished(file); await this.setPublished(file,!cur); }
	private async setPublished(file:TFile, value:boolean){ await this.app.fileManager.processFrontMatter(file,fm=>{ fm.published=value; }); if(value){ new Notice(`${file.basename} published`); this.pendingChanges.set(file.path,true); this.log('flag_on',{ path:file.path }); } else { new Notice(`${file.basename} unpublished`); await this.deleteFileFromRepo(file); this.log('flag_off',{ path:file.path }); } setTimeout(()=>{ this.refreshPublishedStatus(); this.updatePendingView(); },150); }
	private async ensurePublishedProperty(file:TFile,silent:boolean=false){ const c=this.app.metadataCache.getFileCache(file); const has=c?.frontmatter && Object.prototype.hasOwnProperty.call(c.frontmatter,'published'); if(has){ if(!silent) new Notice('published existiert'); return false; } await this.app.fileManager.processFrontMatter(file,fm=>{ fm.published=false; }); if(!silent) new Notice('published hinzugefügt'); setTimeout(()=>{ this.refreshPublishedStatus(); this.updatePendingView(); },120); return true; }
	private async getPublished(file:TFile){ const c=this.app.metadataCache.getFileCache(file); return c?.frontmatter?.published===true; }

	private refreshPublishedStatus(){ if(!this.publishedCheckbox||!this.publishedTrack) return; const f=this.app.workspace.getActiveFile(); if(!f){ this.publishedCheckbox.checked=false; this.publishedCheckbox.disabled=true; this.publishedTrack.classList.remove('is-on'); this.publishedTrack.classList.add('is-disabled'); this.publishedTrack.classList.remove('has-pending'); return; } this.publishedCheckbox.disabled=false; const c=this.app.metadataCache.getFileCache(f); const val=c?.frontmatter?.published===true; this.publishedCheckbox.checked=val; this.publishedTrack.classList.toggle('is-on',val); this.publishedTrack.classList.remove('is-disabled'); const pen=this.pendingChanges.get(f.path); this.publishedTrack.classList.toggle('has-pending', !!pen && val); }
	private updatePendingView(){ for(const leaf of this.app.workspace.getLeavesOfType('gitpublish-pending-view')){ const v=leaf.view; if(v instanceof PendingView) v.render(); } }

	private initLogging(){ try{ const base=(this.app.vault as any).adapter?.getBasePath?.()||''; if(base){ this.logPath=path.join(base,'.obsidian','plugins','obsidian-gitpublish','gitpublish-log.ndjson'); this.ensureLogFile(); this.log('logger_init', { path:this.logPath }); } } catch { this.logPath=null; } }
	private ensureLogFile(){ if(!this.logPath) return; try{ if(!fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath,''); const s=fs.statSync(this.logPath); if(s.size>1_000_000){ const rot=this.logPath+'.1'; try{ fs.renameSync(this.logPath,rot); }catch{} fs.writeFileSync(this.logPath,''); this.log('log_rotate',{ old:rot }); } } catch{} }
	private log(msg:string, meta:any={}, level:'INFO'|'WARN'|'ERROR'='INFO'){ if(!this.logPath) return; const entry={ ts:new Date().toISOString(), level, msg, ...meta }; try{ fs.appendFileSync(this.logPath, JSON.stringify(entry)+'\n'); } catch{} }

	private async initialRepoScan(){ if(!this.ensureGitHubConfig()) return; const pr=this.parseRepo(); if(!pr) return; const repoInfo=await this.githubGet(`https://api.github.com/repos/${pr.owner}/${pr.repo}`); if(!repoInfo) return; const baseSha=await this.ensureBranchExists(pr.owner,pr.repo); if(!baseSha) return; await this.scanPublishedFiles(pr.owner,pr.repo); this.updatePendingView(); }
	private async scanPublishedFiles(owner:string, repo:string){ const files=this.app.vault.getMarkdownFiles(); let total=0,outOfSync=0,missing=0; for(const f of files){ const c=this.app.metadataCache.getFileCache(f); if(c?.frontmatter?.published!==true) continue; total++; const remote=await this.githubGet(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${this.settings.defaultBranch}`); if(!remote||!remote.content){ this.pendingChanges.set(f.path,true); missing++; continue; } const local=await this.app.vault.read(f); const localB64=this.toBase64(local); const remoteB64=(remote.content as string).replace(/\n/g,''); if(localB64!==remoteB64){ this.pendingChanges.set(f.path,true); outOfSync++; } else { this.pendingChanges.set(f.path,false); this.shaMap[f.path]=remote.sha; } } this.lastScanSummary={ total,outOfSync,missing, ts:Date.now() }; this.log('scan_done', this.lastScanSummary); }
}

class GitPublisherSettingTab extends PluginSettingTab {
	constructor(app:App, private plugin:GitPublisherPlugin){ super(app, plugin); }
	display(){ const { containerEl }=this; containerEl.empty(); containerEl.createEl('h2',{ text:'Git Publisher Einstellungen' }); containerEl.createEl('p',{ text:'Dieses Plugin veröffentlicht Markdown-Dateien mit Frontmatter published:true automatisiert auf ein GitHub Repository.' }); containerEl.createEl('p',{ text:'Ablauf: Wenn du tippst starten Timer. Inaktivität löst Einzel-Publish aus, spätestens nach Session-Intervall werden alle pending Dateien im Batch übertragen.' }); containerEl.createEl('p',{ text:'Toggle unten rechts zeigt Status (grün=published, blau=pending Änderungen). Unpublished entfernt Datei aus Repo.' });
		new Setting(containerEl).setName('GitHub Repo URL').setDesc('Format: https://github.com/OWNER/REPO oder mit .git').addText(t=>t.setPlaceholder('https://github.com/user/repo').setValue(this.plugin.settings.repoUri).onChange(async v=>{ this.plugin.settings.repoUri=v.trim(); this.plugin.sanitizeSettings(); await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('GitHub Token').setDesc('Fine-grained Token: Contents Read/Write').addText(t=>{ t.inputEl.type='password'; t.setPlaceholder('ghp_...').setValue(this.plugin.settings.githubToken).onChange(async v=>{ this.plugin.settings.githubToken=v.trim(); await this.plugin.saveSettings(); }); });
		new Setting(containerEl).setName('Auto Publish').setDesc('Schaltet den automatischen Mechanismus an/aus').addToggle(t=>t.setValue(this.plugin.settings.autoPublishEnabled).onChange(async v=>{ this.plugin.settings.autoPublishEnabled=v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Inaktivitäts-Sekunden').setDesc('Zeit ohne Tipp bis Einzel-Publish').addText(t=>t.setValue(String(this.plugin.settings.inactivityDelaySec)).onChange(async v=>{ const n=parseInt(v,10); if(!isNaN(n)&&n>=5) this.plugin.settings.inactivityDelaySec=n; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Session-Minuten').setDesc('Max Zeit bis Batch-Publish').addText(t=>t.setValue(String(this.plugin.settings.maxIntervalMin)).onChange(async v=>{ const n=parseInt(v,10); if(!isNaN(n)&&n>=1) this.plugin.settings.maxIntervalMin=n; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Debounce (ms)').setDesc('Eingabe-Entprellung').addText(t=>t.setValue(String(this.plugin.settings.debounceMs)).onChange(async v=>{ const n=parseInt(v,10); if(!isNaN(n)&&n>=250) this.plugin.settings.debounceMs=n; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Batch Commit Message').setDesc('Prefix für Commits').addText(t=>t.setValue(this.plugin.settings.batchCommitMessage).onChange(async v=>{ this.plugin.settings.batchCommitMessage=v.trim(); this.plugin.sanitizeSettings(); await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Branch').setDesc('Zielbranch').addText(t=>t.setValue(this.plugin.settings.defaultBranch).onChange(async v=>{ if(v.trim()) this.plugin.settings.defaultBranch=v.trim(); this.plugin.sanitizeSettings(); await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Max Dateigröße (KB)').setDesc('Überschreitet eine Datei diesen Wert wird sie nicht veröffentlicht').addText(t=>t.setValue(String(this.plugin.settings.maxFileSizeKB)).onChange(async v=>{ const n=parseInt(v,10); if(!isNaN(n)&&n>=50) this.plugin.settings.maxFileSizeKB=n; await this.plugin.saveSettings(); }));
		containerEl.createEl('h3',{ text:'Sicherheit' });
		containerEl.createEl('ul',{ text:'' }).appendChild(this.buildBullet('Token wird nie geloggt.')); containerEl.createEl('ul',{ text:'' }).appendChild(this.buildBullet('Pfadvalidierung verhindert ../ Traversal.')); containerEl.createEl('ul',{ text:'' }).appendChild(this.buildBullet('Größenlimit schützt vor großen Commits.'));
		containerEl.createEl('h3',{ text:'Nutzungsschritte' });
		containerEl.createEl('ol',{ text:'' }).appendChild(this.buildBullet('Repo URL & Token setzen.')); containerEl.createEl('ol',{ text:'' }).appendChild(this.buildBullet('In Frontmatter published:true hinzufügen.')); containerEl.createEl('ol',{ text:'' }).appendChild(this.buildBullet('Schreiben – Timer veröffentlichen automatisch.')); containerEl.createEl('ol',{ text:'' }).appendChild(this.buildBullet('View nutzen für Überblick & manuellen Publish.'));
	}
	private buildBullet(text:string){ const li=document.createElement('li'); li.textContent=text; return li; }
}

class PendingView extends ItemView {
	constructor(leaf:WorkspaceLeaf, private plugin:GitPublisherPlugin){ super(leaf); }
	getViewType(){ return 'gitpublish-pending-view'; }
	getDisplayText(){ return 'Git Publish'; }
	getIcon(){ return 'upload-cloud'; }
	async onOpen(){ this.render(); }
	async onClose(){}
	render(){ const el=this.containerEl; el.empty(); el.addClass('gitpublish-view'); el.createEl('h3',{ text:'Pending Changes' }); if(!this.plugin.ensureGitHubConfig()){ el.createEl('div',{ text:'Konfiguration fehlt (Repo / Token).' }); return; } const list=el.createDiv({ cls:'gitpublish-pending-list' }); let count=0; for(const [p,pen] of this.plugin.pendingChanges.entries()){ if(!pen) continue; count++; const row=list.createDiv({ cls:'gitpublish-row' }); row.createSpan({ text:p }); const btn=row.createEl('button',{ text:'Publish' }); btn.onclick=async()=>{ const f=this.plugin.app.vault.getAbstractFileByPath(p); if(f instanceof TFile){ await this.plugin.queueFileForPublish(f); this.render(); } }; } if(count===0) list.createDiv({ text:'Keine pending Dateien.' }); const actions=el.createDiv({ cls:'gitpublish-actions' }); const allBtn=actions.createEl('button',{ text:'Alle publishen' }); allBtn.onclick=async()=>{ await this.plugin.publishAllPending(); this.render(); }; const timers=el.createDiv({ cls:'gitpublish-timers' }); const now=Date.now(); let inactLeft=0; if(this.plugin.inactivityHandle && this.plugin.lastActivityTime){ const elapsed=now-this.plugin.lastActivityTime; inactLeft=Math.max(0, Math.round((this.plugin.settings.inactivityDelaySec*1000 - elapsed)/1000)); } let sessLeft=0; if(this.plugin.sessionHandle && this.plugin.sessionStart){ const elapsedS=now-this.plugin.sessionStart; sessLeft=Math.max(0, Math.round((this.plugin.settings.maxIntervalMin*60*1000 - elapsedS)/1000)); } const stat=timers.createDiv({ cls:'gitpublish-timers-line' }); stat.createDiv({ text:`Session Rest: ${sessLeft}s` }); stat.createDiv({ text:`Inaktivität Rest: ${inactLeft}s` }); if(this.plugin['lastScanSummary']){ const s=this.plugin['lastScanSummary']; el.createDiv({ cls:'gitpublish-scan-summary', text:`Scan: ${s.total} published, ${s.missing} fehlen, ${s.outOfSync} abweichend (${new Date(s.ts).toLocaleTimeString()})` }); } }
}

class HelpModal extends Modal { onOpen(){ const { contentEl }=this; contentEl.empty(); contentEl.createEl('h2',{ text:'Git Publisher Hilfe' }); contentEl.createEl('p',{ text:'Markiere Dateien mit Frontmatter published:true um sie automatisch zu veröffentlichen.' }); contentEl.createEl('p',{ text:'Timers: Inaktivität veröffentlicht ein einzelnes File, Session veröffentlicht alle pending Dateien im Batch.' }); contentEl.createEl('p',{ text:'Toggle unten rechts: Grün = synchron, Blau = pending Änderungen, Rot = deaktiviert.' }); contentEl.createEl('p',{ text:'Unpublish (published:false) löscht Datei aus dem Repo.' }); } }
