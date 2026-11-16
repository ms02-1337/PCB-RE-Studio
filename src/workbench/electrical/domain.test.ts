import { describe,it,expect } from 'vitest';
import { padCopperContains,padContours } from './padGeometry';
import { createInstance,ensureSchematic,terminalNumbers } from './domain';
import { connected,mergeNets } from '../visual/copper';
import type { ComponentDefinition,KPad } from '../../bridge/kicad';
import type { VisualPcb } from '../visual/model';
const pad:KPad={number:'1',x:0,y:0,width:4,height:2,rotation:0,shape:'oval',plated:false,layers:['F.Cu']};
const definition:ComponentDefinition={id:'def',name:'test',partName:'',value:'',referencePrefix:'U',footprint:{id:'fp',name:'fp',source:'test',raw:'',pads:[pad,{...pad,number:'2',x:10}],graphics:[],diagnostics:[]},pinMap:{'1':'1','2':'2'}};
const board=():VisualPcb=>({id:'pcb',name:'pcb',layers:['front','back'],images:[],pxPerMm:1,nets:[{id:'a',name:'A',color:'#ff0000'},{id:'b',name:'B',color:'#00ff00'}]});
describe('electrical components',()=>{
 it('uses true oval copper rather than a bounding rectangle',()=>{expect(padCopperContains(pad,{x:1.9,y:.9})).toBe(false);expect(padCopperContains(pad,{x:1,y:.9})).toBe(true);expect(padContours(pad)[0].length).toBeGreaterThan(30);});
 it('excludes slotted holes from copper and excludes NPTH terminals',()=>{const hole={...pad,plated:true,drill:{width:2,height:1,x:0,y:0}};expect(padCopperContains(hole,{x:0,y:0})).toBe(false);expect(padCopperContains(hole,{x:1.7,y:0})).toBe(true);const d=structuredClone(definition);d.footprint.pads.push({...hole,number:'3',plated:false,type:'np_thru_hole'});expect(terminalNumbers(d)).toEqual(['1','2']);});
 it('keeps unrelated component terminals as independent connected groups',()=>{const p=board(),c=createInstance(p,definition,{x:0,y:0},'front');c.terminals[0].netId='a';c.terminals[1].netId='b';p.components=[c];expect(new Set(connected(p,[c.id+':1']).map(e=>e.netId))).toEqual(new Set(['a']));});
 it('joins a contacting trace to a pad and preserves cross-layer separation',()=>{const p=board(),c=createInstance(p,definition,{x:0,y:0},'front');c.terminals[0].netId='a';p.components=[c];p.traces=[{id:'trace',layerId:'front',points:[{x:-3,y:0},{x:0,y:0}],width:.3},{id:'backtrace',layerId:'back',points:[{x:-3,y:0},{x:0,y:0}],width:.3}];const group=connected(p,['trace']);expect(group.some(e=>'padTerminal'in e)).toBe(true);expect(group.some(e=>e.id==='backtrace')).toBe(false);mergeNets(p,['a','b'],'a');expect(c.terminals[0].netId).toBe('a');});
 it('creates all schematic units exactly once',()=>{const p=board(),d=structuredClone(definition);d.symbol={id:'s',name:'s',source:'s',raw:'',reference:'U',diagnostics:[],units:[{unit:1,bodyStyle:1,pins:[],graphics:[]},{unit:2,bodyStyle:1,pins:[],graphics:[]},{unit:1,bodyStyle:2,pins:[],graphics:[]}]};p.components=[createInstance(p,d,{x:0,y:0},'front')];ensureSchematic(p);ensureSchematic(p);expect(p.schematic!.units.map(u=>u.unit)).toEqual([1,2]);});
});
