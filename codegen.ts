import {
  ElementHandle,
  JSHandle,
  Page,
  PageScreenshotOptions,
  TestInfo,
  expect,
} from "@playwright/test";
import { EventEmitter } from "events";
import { ensureFileSync } from "fs-extra";
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import * as path from "node:path";

const EVENT_MODIFIER_KEYS = [
  "shiftKey",
  "ctrlKey",
  "altKey",
  "metaKey",
] as const;
type EventModifiers = Record<(typeof EVENT_MODIFIER_KEYS)[number], boolean>;

const EVENT_KEYS = ["type", "x", "y", "key"] as const;

const EVENTS = ["mousedown", "mousemove", "mouseup", "dblclick"] as const;
type EventType = (typeof EVENTS)[number];

type MouseEventData = {
  type: EventType;
  x: number;
  y: number;
  handle: string;
} & Partial<EventModifiers>;
// type KeyboardEventData = { key: string } & Partial<EventModifiers>;
type ScreenshotEventData = {
  type: "screenshot";
  handle: string;
  screenshot: Buffer;
  name?: string;
  options?: PageScreenshotOptions;
};
type StepEventData = { type: "step"; which: "start" | "end"; name?: string };
type EventData =
  | MouseEventData
  // | KeyboardEventData
  | ScreenshotEventData
  | StepEventData;

type R = {
  [K in EventType]: MouseEventData;
} & { screenshot: ScreenshotEventData; step: StepEventData };

const getCodegenKey = ({
  key,
  altKey,
  ctrlKey,
  metaKey,
  shiftKey,
}: Partial<EventModifiers & { key: string }>) => {
  return Object.entries({ altKey, ctrlKey, metaKey, shiftKey, key })
    .map(([key, value]) => {
      if (!value) {
        return "";
      }
      const [upper, ...rest] = key.replace("Key", "");
      return `${upper.toUpperCase()}${rest}`;
    })
    .filter((val) => !!val && val !== key)
    .join("+");
};

export class Codegen extends EventEmitter {
  readonly testInfo: TestInfo;
  protected events: EventData[] = [];
  private recording = false;
  private counter = 0;
  private readonly file: string;

  static async start(page: Page, testInfo: TestInfo) {
    const codegen = new Codegen(testInfo);
    await codegen.install(page);
    await page.evaluate(() => startRecording());
    await page.pause();
    return codegen;
  }

  constructor(testInfo: TestInfo) {
    super();
    this.testInfo = testInfo;

    this.file = path.resolve(testInfo.outputDir, "codegen.ts");
    ensureFileSync(this.file);
    appendFileSync(
      this.file,
      [
        `import { test, expect, Page } from "@playwright/test";`,
        "",
        "",
        "let page: Page; // here just for TS",
        "",
        "// you may need to replace the `selector` value",
        `const selector = 'canvas_top=#canvas';`,
        "",
        "",
      ].join("\n")
    );
    testInfo.attach("codegen.ts", {
      path: this.file,
    });

    ([...EVENTS, "step", "screenshot"] as const).forEach((eventType) =>
      this.on(eventType, (ev) => {
        this.events.push(ev);
        appendFileSync(this.file, this.parse(ev).concat("").join("\n"));
      })
    );
    this.on("screenshot", (ev) => this.attachScreenshot(ev));
  }

  on<K extends keyof R>(eventType: K, listener: (ev: R[K]) => any) {
    return super.on(eventType, listener);
  }

  async install(page: Page) {
    try {
      execSync(`code ${this.file}`);
    } catch (error) {}

    await page.exposeFunction(
      "resolveSelector",
      (handle: ElementHandle<Node>) => this.toSelector(handle)
    );

    await page.exposeFunction("consumeEvent", async (e: MouseEventData) => {
      this.emit(e.type, {
        ...e,
      } as MouseEventData);
    });

    await page.exposeBinding("startRecording", async ({ page }) => {
      this.recording = true;
      const disposer = await page.evaluateHandle(
        ([events, modifiers]) => {
          const consume = async (e: MouseEvent) =>
            consumeEvent({
              type: e.type,
              x: e.x,
              y: e.y,
              ...Object.fromEntries(
                modifiers.map((k) => [k, e[k]]).filter(([k, v]) => !!v)
              ),
              handle: await resolveSelector(e.target),
            });
          events.forEach((ev) => window.addEventListener(ev, consume));
          return () =>
            events.forEach((ev) => window.removeEventListener(ev, consume));
        },
        [EVENTS, EVENT_MODIFIER_KEYS] as const
      );
    });

    await page.exposeFunction("stopRecording", async () => {
      this.recording = false;
      // await disposer.evaluate((d) => d());
      // await disposer.dispose();
    });

    const assertRecording = () => {
      if (!this.recording) {
        throw new Error("Recoding is not in progress, call `startRecording()`");
      }
    };

    await page.exposeFunction("step", async (name?: string) => {
      assertRecording();
      this.emit("step", {
        type: "step",
        which: "start",
        name,
      } as StepEventData);
    });

    await page.exposeFunction("endStep", async () => {
      assertRecording();
      this.emit("step", { type: "step", which: "end" } as StepEventData);
    });

    await page.exposeBinding(
      "captureScreenshot",
      async ({ page }, options?: PageScreenshotOptions & { name?: string }) => {
        assertRecording();
        const handle = (
          await page.evaluateHandle(() => document.activeElement)
        ).asElement();
        const name = options?.name;
        delete options?.name;
        this.emit("screenshot", {
          type: "screenshot",
          handle: this.toSelector(handle),
          screenshot: await (handle || page).screenshot(options),
          name,
          options,
        } as ScreenshotEventData);
        await handle.dispose();
      }
    );
  }

  protected attachScreenshot({ name, screenshot }: ScreenshotEventData) {
    this.testInfo.attach(name || `codegen${this.counter++}.png`, {
      body: screenshot,
    });
    const { updateSnapshots } = this.testInfo.config;
    this.testInfo.config.updateSnapshots = "all";
    expect(screenshot).toMatchSnapshot({
      name,
    });
    this.testInfo.config.updateSnapshots = updateSnapshots;
  }

  toSelector(handle: ElementHandle | null) {
    return "selector";
  }

  parse(ev: EventData) {
    const data = this.events.slice();
    const index = data.length - 1;
    switch (ev.type) {
      // case "keydown": {
      //   {
      //     if (array[index + 1]?.[0] !== "keyup") {
      //       const key = getCodegenKey(ev as KeyboardEventData);
      //       return [`await page.keyboard.down('${key}')`];
      //     }
      //     return [];
      //   }
      // }
      // case "keyup": {
      //   {
      //     const key = getCodegenKey(ev as KeyboardEventData);
      //     if (array[index - 1]?.[0] === "keydown") {
      //       return [`await page.keyboard.press('${key}')`];
      //     }
      //     return [`await page.keyboard.up('${key}')`];
      //   }
      // }

      case "mouseup": {
        const { x, y, handle } = ev;
        if (data[index - 1]?.[0] === "mousedown") {
          return [
            `await page.click(${handle}, ${JSON.stringify({
              position: { x, y },
            })});`,
          ];
        }
        const downIndex = data.findLastIndex((ev) => ev.type === "mousedown");
        const down = data[index] as MouseEventData;
        const move = data
          .slice(downIndex + 1, index)
          .filter((ev) => ev.type === "mousemove") as MouseEventData[];
        return [
          `await page.hover(${down.handle}, ${JSON.stringify({
            position: { x: down.x, y: down.y },
          })});`,
          `await page.mouse.down();`,
          ...move
            .reduce(
              (ev, curr) => {
                const last = ev[ev.length - 1];
                return EVENT_MODIFIER_KEYS.every((k) => curr[k] === last[k])
                  ? ev.slice(0, -1).concat({ ...curr, steps: last.steps + 1 })
                  : ev.concat({ ...curr, steps: 0 });
              },
              [{ ...move[0], steps: 0 }]
            )
            .map(
              ({ x, y, steps }) =>
                `await page.mouse.move(${x}, ${y}, { steps: ${steps} });`
            ),
          `await page.mouse.up();`,
        ];
      }

      case "dblclick": {
        const { x, y } = ev;
        return [`await page.mouse.dblclick(${x}, ${y})`];
      }

      case "screenshot": {
        const { name, options, handle } = ev;
        return [
          `expect(await page.locator(${handle}).screenshot(${
            options ? JSON.stringify(options) : ""
          })).toMatchSnapshot(${name ? JSON.stringify({ name }) : ""});`,
        ];
      }

      case "step": {
        const { name, which } = ev;
        if (which === "start") {
          return [`await test.step('${name || "step"}', async () => {`];
        } else {
          return [`});`];
        }
      }

      default:
        return [];
    }
  }

  // attachCode() {

  //   // close last step
  //   const lastStep = data.findLast((ev) => ev.type === "step") as
  //   | StepEventData
  //   | undefined;
  // lastStep.which === "start" && data.push({ type: "step", which: "end" });
  //   this.testInfo.attach("recorded events", {
  //     body: JSON.stringify(data, null, 2),
  //   });
  //   const pathToFile = path.resolve(testInfo.outputDir, "codegen.ts");
  //   writeFileSync(pathToFile, codegen);
  //   testInfo.attach("codegen.ts", {
  //     path: pathToFile,
  //   });
  //   execSync(`prettier --write --ignore-path '' ${pathToFile}`);
  //   const body = readFileSync(pathToFile).toString();
  //   testInfo.attach("codegen", {
  //     body,
  //   });
  //   console.log(
  //     `\n\nCodegen of the test "${testInfo.title}" has completed successfully`,
  //     "Generated output is available in the test attachments\n\n",
  //     body
  //   );
  // }
}
