import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Globe, LogOut, LoaderCircle, MessageSquare, Plus, RotateCw, X } from 'lucide-react';
import type { BrowserAnnotation, BrowserWorkspaceBounds, EmbeddedBrowserTab, Task } from '../types';
import { browserAddressSuggestions, normalizeBrowserAddress } from './browser-address';
import './EmbeddedWorkspace.css';

const LocalGitWorkspace=lazy(()=>import('./LocalGitWorkspace').then(module=>({default:module.LocalGitWorkspace})));
const DEFAULT_BROWSER_URL='https://www.google.com/';

type Props={mode:'browser'|'github';task:Task|null;placement:'full'|'side';docked:boolean;workspaceId?:string;active?:boolean;initialUrl?:string;projectRoot?:string;onOpenBrowserTab?:(url?:string)=>void;onSummary?:()=>void;onAnnotation?:(annotation:BrowserAnnotation,comment:string)=>void};

export function EmbeddedWorkspace({mode,task,placement,docked,workspaceId,active=true,initialUrl,projectRoot,onOpenBrowserTab,onAnnotation}:Props){
  const bridge=window.pseudoharnessDesktop?.browser;
  const hostId=workspaceId||`browser:${task?.id||'legacy'}`;
  const [page,setPage]=useState<EmbeddedBrowserTab|null>(null);
  const [address,setAddress]=useState(initialUrl||DEFAULT_BROWSER_URL);
  const [addressFocused,setAddressFocused]=useState(false);
  const [suggestionsOpen,setSuggestionsOpen]=useState(false);
  const [suggestionIndex,setSuggestionIndex]=useState(-1);
  const [error,setError]=useState('');
  const [annotation,setAnnotation]=useState<BrowserAnnotation|null>(null);
  const [annotationComment,setAnnotationComment]=useState('');
  const [annotationTaskId,setAnnotationTaskId]=useState<string|null>(task?.id||null);
  const [browserDataMessage,setBrowserDataMessage]=useState('');
  const rootRef=useRef<HTMLElement>(null);
  const hostRef=useRef<HTMLDivElement>(null);
  const inputRef=useRef<HTMLInputElement>(null);
  const pageRef=useRef<EmbeddedBrowserTab|null>(null);
  const openingRef=useRef<Promise<EmbeddedBrowserTab>|null>(null);
  const focusedRef=useRef(false);
  const openBrowserTabRef=useRef(onOpenBrowserTab);
  const annotationTaskRef=useRef(task?.id||null);
  const boundsKeyRef=useRef('');
  const isVisible=mode==='browser'&&active&&(placement==='full'||docked);
  const isVisibleRef=useRef(isVisible);
  openBrowserTabRef.current=onOpenBrowserTab;
  annotationTaskRef.current=task?.id||null;
  isVisibleRef.current=isVisible;

  const suggestions=useMemo(()=>browserAddressSuggestions(address).slice(0,5),[address]);
  const currentPage=(value:EmbeddedBrowserTab|null)=>{pageRef.current=value;setPage(value);if(value&&!focusedRef.current)setAddress(value.url);};
  const setErrorFrom=(value:unknown)=>setError(value instanceof Error?value.message:String(value));
  const closeAnnotation=()=>{setAnnotation(null);setAnnotationComment('');setAnnotationTaskId(null);if(mode==='browser')void bridge?.workspaceAnnotationOverlay(hostId,false).catch(()=>{});};

  useEffect(()=>{
    if(mode!=='browser'||!bridge)return;
    let alive=true;
    setError('');
    boundsKeyRef.current='';
    let url:string;
    try{url=normalizeBrowserAddress(initialUrl||DEFAULT_BROWSER_URL);setAddress(url);}catch(value){setErrorFrom(value);return()=>{alive=false;};}
    const unsubscribe=bridge.onEvent(event=>{
      const ownsEvent=event.workspaceId===hostId||event.tab?.workspaceId===hostId;
      if(!ownsEvent)return;
      const updated=event.tabs.find(item=>item.workspaceId===hostId);
      if(updated)currentPage(updated);
      if(event.type==='open-request'&&event.workspaceId===hostId&&event.url){
        const open=openBrowserTabRef.current;
        if(open)open(event.url);else setError('This link needs a new Browser workspace.');
      }
      if(event.type==='annotation'&&event.tab?.workspaceId===hostId&&event.annotation){
        if(isVisibleRef.current&&annotationTaskRef.current){setAnnotation(event.annotation);setAnnotationComment('');setAnnotationTaskId(annotationTaskRef.current);}
        else void bridge.workspaceAnnotationOverlay(hostId,false).catch(()=>{});
      }
    });
    const opening=bridge.workspaceOpen(hostId,url);
    openingRef.current=opening;
    void opening.then(value=>{if(alive)currentPage(value);}).catch(value=>{if(alive)setErrorFrom(value);});
    return()=>{
      alive=false;
      unsubscribe();
      openingRef.current=null;
      void bridge.workspaceRelease(hostId).catch(()=>{});
    };
  },[bridge,hostId,mode,initialUrl]);

  useEffect(()=>{
    if(annotationTaskId!==task?.id){setAnnotation(null);setAnnotationComment('');setAnnotationTaskId(task?.id||null);if(mode==='browser')void bridge?.workspaceAnnotationOverlay(hostId,false).catch(()=>{});}
  },[annotationTaskId,bridge,hostId,mode,task?.id]);

  useEffect(()=>{
    if(!isVisible&&annotation){setAnnotation(null);setAnnotationComment('');setAnnotationTaskId(null);if(mode==='browser')void bridge?.workspaceAnnotationOverlay(hostId,false).catch(()=>{});}
  },[active,annotation,bridge,docked,hostId,mode,placement]);

  useLayoutEffect(()=>{
    if(mode!=='browser'||!bridge)return;
    let raf=0;
    let last:{x:number;y:number;width:number;height:number}|null=null;
    let stable=0;
    let frames=0;
    const visible=isVisible;
    const measure=()=>{
      const rect=hostRef.current?.getBoundingClientRect();
      const measured=rect&&rect.width>0&&rect.height>0?{x:rect.left,y:rect.top,width:rect.width,height:rect.height}:null;
      const next=measured?{x:Math.round(measured.x),y:Math.round(measured.y),width:Math.round(measured.width),height:Math.round(measured.height)}:null;
      const overlayHeight=annotation?Math.max(270,Math.ceil(rootRef.current?.querySelector('.browser-annotation')?.getBoundingClientRect().height||270)+20):270;
      const key=`${visible}:${next?`${next.x},${next.y},${next.width},${next.height}`:'hidden'}:${annotation?overlayHeight:0}`;
      if(key!==boundsKeyRef.current){boundsKeyRef.current=key;const bounds:BrowserWorkspaceBounds=next?{...next,annotationHeight:overlayHeight}:null;void bridge.workspaceSetBounds(hostId,bounds,visible).catch(setErrorFrom);}
      if(next&&last&&next.x===last.x&&next.y===last.y&&next.width===last.width&&next.height===last.height)stable++;else stable=0;
      last=next;frames++;
      if(frames<40&&stable<3)raf=requestAnimationFrame(measure);
    };
    const schedule=()=>{cancelAnimationFrame(raf);last=null;stable=0;frames=0;measure();};
    schedule();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(schedule);
    if(rootRef.current)observer?.observe(rootRef.current);
    if(hostRef.current)observer?.observe(hostRef.current);
    window.addEventListener('resize',schedule);
    rootRef.current?.addEventListener('transitionend',schedule);
    rootRef.current?.addEventListener('animationend',schedule);
    return()=>{observer?.disconnect();window.removeEventListener('resize',schedule);rootRef.current?.removeEventListener('transitionend',schedule);rootRef.current?.removeEventListener('animationend',schedule);cancelAnimationFrame(raf);};
  },[active,annotation,bridge,docked,hostId,mode,placement]);

  const navigate=async(value=address)=>{
    if(!bridge){setError('The embedded browser needs the Electron desktop shell.');return;}
    let url:string;
    try{url=normalizeBrowserAddress(value);}catch(problem){setErrorFrom(problem);return;}
    setAddress(url);setError('');setSuggestionsOpen(false);setSuggestionIndex(-1);
    try{
      if(!pageRef.current&&openingRef.current)await openingRef.current;
      currentPage(await bridge.workspaceNavigate(hostId,{url}));
    }catch(problem){setErrorFrom(problem);}
  };
  const newBrowserWorkspace=()=>{
    let url:string;
    try{url=normalizeBrowserAddress(address);}catch(problem){setErrorFrom(problem);return;}
    const open=openBrowserTabRef.current;
    if(!open){setError('Open a new Browser workspace from the app tabs to continue.');return;}
    setError('');open(url);
  };
  const selectSuggestion=(url:string)=>{focusedRef.current=true;setAddress(url);setSuggestionsOpen(false);setSuggestionIndex(-1);inputRef.current?.focus();void navigate(url);};
  const onAddressKeyDown=(event:KeyboardEvent<HTMLInputElement>)=>{
    if(event.key==='ArrowDown'&&suggestions.length){event.preventDefault();setSuggestionsOpen(true);setSuggestionIndex(current=>(current+1)%suggestions.length);}
    else if(event.key==='ArrowUp'&&suggestions.length){event.preventDefault();setSuggestionsOpen(true);setSuggestionIndex(current=>current<=0?suggestions.length-1:current-1);}
    else if(event.key==='Escape'){setSuggestionsOpen(false);setSuggestionIndex(-1);}
    else if(event.key==='Enter'&&suggestionsOpen&&suggestionIndex>=0&&suggestions[suggestionIndex]){event.preventDefault();selectSuggestion(suggestions[suggestionIndex].url);}
  };
  const navigateAction=async(action:'back'|'forward'|'reload')=>{
    if(!bridge)return;
    try{setError('');currentPage(await bridge.workspaceNavigate(hostId,action));}
    catch(problem){setErrorFrom(problem);}
  };
  const toggleCommenting=async()=>{
    if(!bridge||!page)return;
    const next=!page.commenting;
    try{await bridge.workspaceSetCommenting(hostId,next);const updated={...page,commenting:next};currentPage(updated);setError('');}
    catch(problem){setErrorFrom(problem);}
  };
  const clearLocalData=async()=>{
    if(!bridge||!window.confirm('Clear locally saved website logins, cookies, and browser data?'))return;
    try{await bridge.clearData();setBrowserDataMessage('Saved website logins and browser data were cleared on this device.');}
    catch(problem){setErrorFrom(problem);}
  };
  const annotationSubmit=(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    if(annotation&&annotationComment.trim()&&annotationTaskId===task?.id){onAnnotation?.(annotation,annotationComment.trim());closeAnnotation();void bridge?.workspaceSetCommenting(hostId,false).catch(()=>{});currentPage(page?{...page,commenting:false}:page);}
  };

  if(mode==='github')return <Suspense fallback={<div className="git-empty"><LoaderCircle className="spinning" size={22}/><span>Loading local Git workspace…</span></div>}><LocalGitWorkspace taskId={task?.id} projectRoot={projectRoot} focusUrl={task?.workspaceCommand?.mode==='github'?task.workspaceCommand.url:undefined} onOpenBrowserTab={onOpenBrowserTab}/></Suspense>;

  return <section ref={rootRef} className={`embedded-workspace native-browser-workspace ${placement==='side'?'chat-docked-workspace':'full-workspace'} ${placement==='side'&&!docked?'is-hidden':''}`} aria-label="Browser workspace" aria-hidden={placement==='side'&&!docked}>
    <header className={`native-browser-toolbar ${addressFocused&&suggestionsOpen&&suggestions.length?'has-address-suggestions':''}`}>
      <div className="native-browser-title"><Globe size={15}/><span>{page?.title&&page.title!==page.url?page.title:'Browser'}</span>{page?.loading&&<LoaderCircle className="spinning" size={13}/>}</div>
      <form className="native-browser-address" role="search" onSubmit={event=>{event.preventDefault();void navigate();}}>
        <div className="native-browser-nav"><button type="button" aria-label="Back" title="Back" disabled={!page?.canGoBack} onClick={()=>void navigateAction('back')}><ArrowLeft size={14}/></button><button type="button" aria-label="Forward" title="Forward" disabled={!page?.canGoForward} onClick={()=>void navigateAction('forward')}><ArrowRight size={14}/></button><button type="button" aria-label="Reload" title="Reload" disabled={!page} onClick={()=>void navigateAction('reload')}><RotateCw size={14}/></button></div>
        <div className="native-browser-address-wrap">
          <input ref={inputRef} role="combobox" aria-label="Website address" aria-autocomplete="list" aria-controls="browser-address-suggestions" aria-expanded={addressFocused&&suggestionsOpen&&suggestions.length>0} value={address} onFocus={()=>{focusedRef.current=true;setAddressFocused(true);setSuggestionsOpen(true);}} onBlur={()=>{focusedRef.current=false;setAddressFocused(false);setTimeout(()=>setSuggestionsOpen(false),120);if(pageRef.current)setAddress(pageRef.current.url);}} onChange={event=>{setAddress(event.currentTarget.value);setSuggestionsOpen(true);setSuggestionIndex(-1);setError('');}} onKeyDown={onAddressKeyDown} placeholder="Search or enter a website address" autoComplete="off" spellCheck={false}/>
          {addressFocused&&suggestionsOpen&&suggestions.length>0&&<div id="browser-address-suggestions" className="native-browser-suggestions" role="listbox" aria-label="Common website addresses">{suggestions.map((item,index)=><button key={item.url} type="button" role="option" aria-selected={index===suggestionIndex} onMouseDown={event=>event.preventDefault()} onClick={()=>selectSuggestion(item.url)}><span>{item.label}</span><small>{item.url}</small></button>)}</div>}
        </div>
        <button className="native-browser-go" type="submit">Go</button>
      </form>
      <button className="native-browser-action" type="button" aria-label="Commenting" aria-pressed={!!page?.commenting} disabled={!page} onClick={()=>void toggleCommenting()}><MessageSquare size={14}/><span>Commenting</span></button>
      <button className="native-browser-action native-browser-new-tab" type="button" aria-label="Open new Browser workspace tab" title="Open new Browser tab" onClick={newBrowserWorkspace}><Plus size={15}/></button>
      <button className="native-browser-action native-browser-clear-data" type="button" aria-label="Clear local browser data" title="Clear local browser data" onClick={()=>void clearLocalData()}><LogOut size={14}/></button>
    </header>
    {error&&<div className="native-browser-feedback" role="alert">{error}</div>}
    {browserDataMessage&&<div className="native-browser-feedback" role="status">{browserDataMessage}<button type="button" aria-label="Dismiss browser data message" onClick={()=>setBrowserDataMessage('')}><X size={13}/></button></div>}
    {!bridge&&<div className="native-browser-unavailable"><Globe size={24}/><strong>Embedded browser is available in the desktop app.</strong><span>Run <code>npm run desktop</code> to open native web pages with a persistent local browser profile.</span></div>}
    <div className="native-browser-page" ref={hostRef} aria-label={page?.title||'Browser page content'}>
      {page?.failure&&<div className="native-browser-load-error" role="alert"><div><strong>This page did not load</strong><span>{page.failure.description} (error {page.failure.code})</span></div><button type="button" onClick={()=>void navigateAction('reload')}>Retry</button></div>}
      {!page&&bridge&&<div className="native-browser-loading" role="status"><LoaderCircle className="spinning" size={22}/><span>Opening browser workspace…</span></div>}
      {annotation&&annotationTaskId===task?.id&&<form className="browser-annotation" onSubmit={annotationSubmit}><div><strong>Page annotation</strong><button type="button" aria-label="Dismiss page annotation" onClick={closeAnnotation}><X size={14}/></button></div><p title={annotation.url}>{annotation.title||annotation.url}</p><blockquote>{annotation.selectedText||annotation.target||'Selected page target'}</blockquote><label>Add a comment<textarea autoFocus value={annotationComment} onChange={event=>setAnnotationComment(event.currentTarget.value)} maxLength={1200} placeholder="What should the agent notice about this page?"/></label><footer><span>Only this selected text and target will be included in your message.</span><button type="submit" disabled={!annotationComment.trim()}>Add to message</button></footer></form>}
    </div>
  </section>;
}
