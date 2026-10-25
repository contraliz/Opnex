import { useEffect, useState, type RefObject } from 'react';

/** Tracks whether a retained workspace tab is currently rendered and visible. */
export function useWorkspaceVisibility<T extends HTMLElement>(ref:RefObject<T|null>){
  const [visible,setVisible]=useState(false);
  useEffect(()=>{
    const update=()=>{
      const element=ref.current;
      const hasLayout=!!element&&!element.closest('[hidden]');
      setVisible(document.visibilityState!=='hidden'&&hasLayout);
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
  },[ref]);
  return visible;
}
