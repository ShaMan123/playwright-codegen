import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "fs";
import { Codegen } from "../codegen";

let codegen: Codegen;

// clear snapshots so we can test snapshot generation
test.beforeAll(async ({}, testInfo) => {
  codegen = new Codegen(testInfo);
  ["a.png", "b.png", "codegen-1.png"].forEach((name) => {
    const pathToFile = testInfo.snapshotPath(name);
    existsSync(pathToFile) && rmSync(pathToFile);
    expect(existsSync(pathToFile)).toBeFalsy();
  });
});
// test codegen
test.afterAll(async ({}, testInfo) => {
  await test.step("test output", async () => {
    expect(readFileSync(codegen.file)).toMatchSnapshot({
      name: "codegen.dat",
    });
    // const [events, codegen] = testInfo.attachments.slice(-2);
    // expect(events.body).toMatchSnapshot({ name: "recorded_events.dat" });
    // expect(codegen.body).toMatchSnapshot({ name: "codegen.dat" });
    ["a.png", "b.png", "codegen-1.png"].forEach((name) => {
      const pathToFile = testInfo.snapshotPath(name);
      expect(existsSync(pathToFile)).toBeTruthy();
    });
  });
});

test("codegen", async ({ page }, testInfo) => {
  await page.goto("/");
  await codegen.install(page);
  await page.goto("/");
  await test.step("generate test", async () => {
    await test.step("startRecording()", async () => {
      await page.evaluate(() => window.startRecording());
      await page.hover("#canvas", {
        position: { x: 443, y: 43 },
      });
      await page.mouse.down();
      await page.mouse.move(300, 206, { steps: 10 });
      await page.mouse.up();
    });

    await test.step(`step('1')`, async () => {
      await page.evaluate(() => window.step("1"));
      await page.hover("#canvas", {
        position: { x: 268, y: 203 },
      });
      await page.mouse.down();
      await page.mouse.move(144, 48, { steps: 10 });
      await page.mouse.up();
    });

    await test.step(`step(), endStep('2')`, async () => {
      await page.evaluate(() => window.step("2"));
      await page.hover("#canvas", {
        position: { x: 133, y: 72 },
      });
      await page.mouse.down();
      await page.mouse.move(135, 557, { steps: 10 });
      await page.mouse.up();
      await page.evaluate(() => window.endStep());
    });

    await page.hover("#canvas", {
      position: { x: 228, y: 294 },
    });
    await page.mouse.down();
    await page.mouse.move(475, 292, { steps: 10 });
    await page.mouse.up();

    await test.step(`step('screenshots')`, async () => {
      const timeout = 1000;
      await page.evaluate(() => window.step("screenshots"));
      await test.step(`captureScreenshot()`, async () => {
        await page.evaluate(() =>
          window.captureScreenshot({
            clip: { x: 0, y: 0, width: 500, height: 500 },
          })
        );
        await page.waitForTimeout(timeout);
      });
      await test.step(`captureScreenshot({ name: 'a.png' })`, async () => {
        await page.evaluate(() =>
          window.captureScreenshot({
            name: "a.png",
            clip: { x: 0, y: 0, width: 500, height: 500 },
          })
        );
        await page.waitForTimeout(timeout);
      });
      await test.step(`captureScreenshot({ name: 'b.png' })`, async () => {
        await page.evaluate(() =>
          window.captureScreenshot({
            name: "b.png",
            clip: { x: 0, y: 0, width: 500, height: 500 },
          })
        );
        await page.waitForTimeout(timeout);
      });
    });

    await test.step("modifier keys", async () => {
      await page.evaluate(() => window.step("modifier keys"));
      await page.hover("#canvas", {
        position: { x: 475, y: 555 },
      });
      await page.mouse.down();
      await page.keyboard.down("Shift");
      await page.mouse.move(805, 600, { steps: 10 });
      await page.keyboard.press("Alt");
      await page.mouse.move(700, 572, { steps: 10 });
      await page.keyboard.press("Control");
      await page.mouse.move(455, 515, { steps: 10 });
      await page.keyboard.up("Shift");
      await page.mouse.move(469, 417, { steps: 10 });
      await page.mouse.up();
    });

    await test.step("typing", async () => {
      await page.evaluate(() => window.step("typing"));
      await page.click("#canvas", {
        position: { x: 58, y: 292 },
      });
      await page.keyboard.press("1");
      await page.keyboard.press("2");
      await page.keyboard.press("3");
      await page.keyboard.down("Shift");
      await page.keyboard.press("!");
      await page.keyboard.press("@");
      await page.keyboard.press("#");
      await page.keyboard.up("Shift");
      await page.keyboard.down("Alt");
      await page.keyboard.press("1");
      await page.keyboard.press("2");
      await page.keyboard.press("3");
      await page.keyboard.up("Alt");
      await page.keyboard.down("Control");
      await page.keyboard.press("1");
      await page.keyboard.press("1");
      await page.keyboard.press("2");
      await page.keyboard.press("3");
      await page.keyboard.down("Alt");
      await page.keyboard.press("1");
      await page.keyboard.press("2");
      await page.keyboard.press("3");
      await page.keyboard.up("Alt");
      await page.keyboard.up("Control");
      await page.hover("#canvas", {
        position: { x: 219, y: 256 },
      });
      await page.mouse.down();
      await page.mouse.move(64, 250, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.press("Delete");
      await page.mouse.dblclick(113, 272);
      await page.keyboard.down("Meta");
      await page.keyboard.press("S");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Meta");
    });
  });
});
