import { useEffect, useState, type RefObject } from 'react';

/** Tracks whether a retained workspace tab is currently rendered and visible. */
export function useWorkspaceVisibility<T extends HTMLElement>(ref:RefObject<T|null>){
  const [visible,setVisible]=useState(false);
  useEffect(()=>{
    let intersecting=false;
    const update=()=>{
      const element=ref.current;
      const hasLayout=!!element&&!element.closest('[hidden]');
      setVisible(document.visibilityState==='visible'&&hasLayout&&(typeof IntersectionObserver==='undefined'||intersecting));
    };
    const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{
      intersecting=entries.some(entry=>entry.target===ref.current&&entry.isIntersecting&&entry.intersectionRect.width>0&&entry.intersectionRect.height>0);
      update();
    });
    if(ref.current)observer?.observe(ref.current);
    const onVisibility=()=>update();
    window.addEventListener('focus',onVisibility);
    window.addEventListener('pageshow',onVisibility);
    document.addEventListener('visibilitychange',onVisibility);
    update();
    return()=>{
      observer?.disconnect();
      window.removeEventListener('focus',onVisibility);
      window.removeEventListener('pageshow',onVisibility);
      document.removeEventListener('visibilitychange',onVisibility);
    };
  },[ref]);
  return visible;
}
