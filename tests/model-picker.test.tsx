// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ModelPicker from '../src/ui/ModelPicker.js';

const heightDescriptor=Object.getOwnPropertyDescriptor(window,'innerHeight');
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();if(heightDescriptor)Object.defineProperty(window,'innerHeight',heightDescriptor);});

function rect(top:number,bottom:number,height:number){return {x:0,y:top,width:340,height,top,right:340,bottom,left:0,toJSON:()=>({})} as DOMRect;}

it('flips the model menu below its button when the viewport has more room below',()=>{
  Object.defineProperty(window,'innerHeight',{configurable:true,value:620});let triggerTop=80;
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    if(this.classList.contains('execution-model-trigger'))return rect(triggerTop,triggerTop+39,39);
    if(this.classList.contains('execution-model-menu'))return rect(-190,70,260);
    return rect(0,0,0);
  });
  const choices=[{providerKey:'codex',provider:'Codex · OpenAI',id:'gpt-6.1-terra',name:'GPT-6.1 Terra',efforts:['low'],available:true}];
  render(<ModelPicker label="Orchestrator model" providerKey="codex" model="gpt-6.1-terra" effort="low" choices={choices} disabled={false} onChange={()=>{}}/>);
  const trigger=screen.getByRole('button',{name:'Orchestrator model'});fireEvent.click(trigger);
  expect(screen.getByRole('dialog',{name:'Orchestrator model'})).toBeTruthy();expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('true');
  fireEvent.click(trigger);triggerTop=420;fireEvent.click(trigger);
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('false');
});

it('keeps a below-open menu anchored through its close animation',()=>{
  vi.useFakeTimers();Object.defineProperty(window,'innerHeight',{configurable:true,value:620});
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    if(this.classList.contains('execution-model-trigger'))return rect(80,119,39);
    if(this.classList.contains('execution-model-menu'))return rect(-190,70,260);
    return rect(0,0,0);
  });
  const choices=[{providerKey:'codex',provider:'Codex · OpenAI',id:'gpt-6.1-terra',name:'GPT-6.1 Terra',efforts:['low'],available:true}];
  render(<ModelPicker label="Orchestrator model" providerKey="codex" model="gpt-6.1-terra" effort="low" choices={choices} disabled={false} onChange={()=>{}}/>);
  const trigger=screen.getByRole('button',{name:'Orchestrator model'});fireEvent.click(trigger);
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('true');
  fireEvent.click(trigger);
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('true');
  act(()=>{vi.advanceTimersByTime(110);});
  expect(trigger.parentElement?.getAttribute('data-open-below')).toBe('false');
});
