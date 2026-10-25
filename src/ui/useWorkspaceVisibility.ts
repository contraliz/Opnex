import { useEffect, useState, type RefObject } from 'react';

/** Tracks whether a retained workspace tab is currently rendered and visible. */
export function useWorkspaceVisibility<T extends HTMLElement>(ref:RefObject<T|null>,enabled=true){
  const [visible,setVisible]=useState(false);
  useEffect(()=>{
    const update=()=>{
      const element=ref.current;
      const hasLayout=!!element&&!element.closest('[hidden]');
      setVisible(enabled&&document.visibilityState!=='hidden'&&hasLayout);
    };
    const observer=new MutationObserver(update);
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['hidden'],subtree:true});
    const onVisibility=()=>update();
    window.addEventListener('focus',onVisibility);
    window.addEventListener('pageshow',onVisibility);
    document.addEventListener('visibilitychange',onVisibility);
    update();
    return()=>{
      observer.disconnect();
      window.removeEventListener('focus',onVisibility);
      window.removeEventListener('pageshow',onVisibility);
      document.removeEventListener('visibilitychange',onVisibility);
    };
  },[enabled,ref]);
  return visible;
}
