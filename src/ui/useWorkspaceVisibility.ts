import { useEffect, useState, type RefObject } from 'react';

/** Tracks whether a retained workspace tab is currently rendered and visible. */
export function useWorkspaceVisibility<T extends HTMLElement>(ref:RefObject<T|null>,enabled=true){
  const [visible,setVisible]=useState(()=>enabled&&document.visibilityState!=='hidden');
  useEffect(()=>{
    const update=()=>{
      const element=ref.current;
      const hasLayout=!!element&&!element.closest('[hidden]');
      setVisible(enabled&&document.visibilityState!=='hidden'&&hasLayout);
    };
    const onVisibility=()=>update();
    window.addEventListener('focus',onVisibility);
    window.addEventListener('pageshow',onVisibility);
    document.addEventListener('visibilitychange',onVisibility);
    update();
    return()=>{
      window.removeEventListener('focus',onVisibility);
      window.removeEventListener('pageshow',onVisibility);
      document.removeEventListener('visibilitychange',onVisibility);
    };
  },[enabled,ref]);
  return visible;
}
