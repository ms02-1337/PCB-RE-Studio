import { $, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { browser } from "@wdio/globals";

async function expectFullHeight(selector: string) {
  const dimensions = await browser.execute((childSelector: string) => {
    const host = document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
    const child = host.querySelector<HTMLElement>(childSelector)!;
    const hostRect = host.getBoundingClientRect();
    const childRect = child.getBoundingClientRect();
    return { top: Math.abs(hostRect.top - childRect.top), bottom: Math.abs(hostRect.bottom - childRect.bottom), height: childRect.height };
  }, selector);
  expect(dimensions.top).toBeLessThanOrEqual(1);
  expect(dimensions.bottom).toBeLessThanOrEqual(1);
  expect(dimensions.height).toBeGreaterThan(180);
}
describe("Native workbench", () => {
  it("loads native metadata and operates commands", async () => {
    await expect($('[role="tabpanel"]:not([hidden]) h1')).toHaveText(
      "Projects",
    );
    await expect($("footer")).toHaveText(expect.stringContaining("0.1.0"));
    await expect($('[aria-label="Minimize"]')).toBeEnabled();
    await expect($('[aria-label="Activity bar"]')).toBeDisplayed();
    await expectFullHeight(".projects-panel");
    await $('[role="tab"][id="tab-2"]').click();
    await expect($('[role="tabpanel"]:not([hidden]) h1')).toHaveText(
      "Visual editor",
    );
    await expect($('[aria-label="Activity bar"]')).not.toBeDisplayed();
    await expect($('[aria-label="Primary sidebar"]')).not.toBeDisplayed();
    await expect($('[aria-label="Inspector"]')).not.toExist();
    await $("button=Panel").click();
    await expect($('[aria-label="Bottom panel"]')).toBeDisplayed();
    await $('[aria-label="Command Palette"]').click();
    await $('[aria-label="Search commands"]').setValue("sidebar");
    await expect($("button=Toggle sidebar")).not.toExist();
    await $("button=Close").click();
    await $('.titlebar [aria-label="Settings"]').click();
    await expect($('[role="dialog"][aria-label="Autosave settings"]')).toBeDisplayed();
    await $("button=Cancel").click();
    await $('[role="tab"][id="tab-0"]').click();
    await expect($('[aria-label="Activity bar"]')).toBeDisplayed();
    await expectFullHeight(".projects-panel");
    await $('[role="tab"][id="tab-1"]').click();
    await expectFullHeight(".placement-panel");
    await expect($('[aria-label="Component properties"]')).toBeDisplayed();
    const canvas = await $(".canvas-wrap").getSize();
    expect(canvas.height).toBeGreaterThan(100);
    await $("button=Panel").click();
    await expectFullHeight(".placement-panel");
  });
});
