import { expect,it } from "vitest";
import { librarySplit } from "./librarySplit";
it("constrains ratio and both pixel minima across desktop and short layouts",()=>{for(const height of [0,200,320,400,1000])for(const ratio of [-1,0.2,0.3,0.65,2]){const v=librarySplit(height,ratio);expect(v.size).toBeGreaterThanOrEqual(120);expect(v.height-v.size).toBeGreaterThanOrEqual(200);expect(v.size/v.height).toBeGreaterThanOrEqual(0.2);expect(v.size/v.height).toBeLessThanOrEqual(0.65);}});
it("reclamps when available space shrinks and restores preferred ratio when it expands",()=>{expect(librarySplit(1000,0.65).size).toBe(650);expect(librarySplit(340,0.65).size).toBe(140);expect(librarySplit(1000,0.65).size).toBe(650);});
