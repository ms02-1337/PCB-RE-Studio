import type { ComponentDefinition, KGraphic, KPoint } from "../../bridge/kicad";
import { terminalNumbers } from "./domain";
import { padContours, padHole } from "./padGeometry";

export interface PreviewBounds { left: number; top: number; right: number; bottom: number }
export interface PreviewView { scale: number; x: number; y: number }

/** Bounds of the geometry actually drawn, including label and stroke margins. */
export function libraryPreviewBounds(d: ComponentDefinition | undefined, symbol: boolean): PreviewBounds {
  const points: KPoint[] = [];
  const text = (value: string, x: number, y: number) => {
    points.push({x:x-0.25,y:y-1.25},{x:x+Math.max(1,value.length)+0.25,y:y+0.5});
  };
  const graphics = (values: KGraphic[], flipY: boolean) => {
    for (const g of values) {
      const a=g.points[0], b=g.points[1];
      if (!a) continue;
      const convert=(p:KPoint)=>({x:p.x,y:flipY?-p.y:p.y});
      if(g.kind === "text") { const p=convert(a); text(g.text??"",p.x,p.y); continue; }
      const pad=Math.max(0.15,g.width)/2;
      const pts=g.kind === "circle" && b ? (()=>{const r=Math.hypot(b.x-a.x,b.y-a.y);return [{x:a.x-r,y:a.y-r},{x:a.x+r,y:a.y+r}];})() : g.points;
      for(const p of pts) {const q=convert(p);points.push({x:q.x-pad,y:q.y-pad},{x:q.x+pad,y:q.y+pad});}
    }
  };
  if(d) {
    if(!symbol) {
      graphics(d.footprint.graphics,false);
      for(const p of d.footprint.pads) {
        for(const contour of padContours(p)) points.push(...contour);
        points.push(...padHole(p));
        text(p.number,p.x,p.y-p.height/2-0.25);
      }
      text(d.referencePrefix,0,-2);
    } else if(d.symbol) {
      const units=d.symbol.units.filter(u=>(u.unit===1||u.unit===0)&&(u.bodyStyle===1||u.bodyStyle===0));
      graphics(units.flatMap(u=>u.graphics),true);
      for(const p of units.flatMap(u=>u.pins)) {
        const a=p.rotation*Math.PI/180;
        points.push({x:p.x,y:-p.y},{x:p.x+Math.cos(a)*p.length,y:-p.y-Math.sin(a)*p.length});
        text(`${p.number} ${p.name}`,p.x,-p.y);
      }
    } else {
      points.push({x:-10,y:-8},{x:10,y:8});
      terminalNumbers(d).forEach((n,i)=>text(n,-12,-6+i*2));
    }
  }
  const finite=points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
  if(!finite.length) return {left:-10,top:-10,right:10,bottom:10};
  return finite.reduce((r,p)=>({left:Math.min(r.left,p.x),top:Math.min(r.top,p.y),right:Math.max(r.right,p.x),bottom:Math.max(r.bottom,p.y)}),{left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity});
}

export function fitLibraryPreview(bounds:PreviewBounds,width:number,height:number):PreviewView {
  const scale=Math.max(1e-9,Math.min(Math.max(1,width-48)/Math.max(1,bounds.right-bounds.left),Math.max(1,height-48)/Math.max(1,bounds.bottom-bounds.top)));
  return {scale,x:width/2-(bounds.left/2+bounds.right/2)*scale,y:height/2-(bounds.top/2+bounds.bottom/2)*scale};
}

export function previewPoint(view:PreviewView,p:KPoint):KPoint {return {x:(p.x-view.x)/view.scale,y:(p.y-view.y)/view.scale};}
