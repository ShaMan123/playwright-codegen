import {
  ElementHandle,
  Page,
  PageScreenshotOptions,
  TestInfo,
  expect,
} from "@playwright/test";
import { EventEmitter } from "events";
import { readFileSync, writeFileSync } from "fs";
import { ensureFileSync } from "fs-extra";
import capitalize from "lodash.capitalize";
import debounce from "lodash.debounce";
import { execSync } from "node:child_process";
import * as path from "node:path";

const EVENT_MODIFIER_KEYS = [
  "shiftKey",
  "ctrlKey",
  "altKey",
  "metaKey",
] as const;
type EventModifiers = Record<(typeof EVENT_MODIFIER_KEYS)[number], boolean>;

const MOUSE_EVENTS = ["mousedown", "mousemove", "mouseup", "dblclick"] as const;
type MouseEventType = (typeof MOUSE_EVENTS)[number];
type BasicMouseEventData = {
  x: number;
  y: number;
  handle: string;
} & Partial<EventModifiers>;
type MouseEventData = {
  type: MouseEventType;
} & BasicMouseEventData;
type MouseMoveEventData = BasicMouseEventData & {
  type: "mousemove";
  steps?: number;
};
type ConsumedMouseEventData = (
  | {
      type: "mousedown" | "mouseup" | "dblclick";
    }
  | {
      type: "mousemove";
      steps?: number;
    }
  | { type: "click" }
) &
  BasicMouseEventData;

const KEYBOARD_EVENTS = ["keydown", "keyup"] as const;
type KeyboardEventType = (typeof KEYBOARD_EVENTS)[number];
type BasicKeyboardEventData = {
  key: string;
} & Partial<EventModifiers>;
type KeyboardEventData = BasicKeyboardEventData & {
  type: KeyboardEventType;
};
type ConsumedKeyboardEventData = BasicKeyboardEventData & {
  type: KeyboardEventType | "keypress";
};

type ScreenshotEventData = {
  type: "screenshot";
  handle: string;
  screenshot: Buffer;
  name?: string;
  options?: PageScreenshotOptions;
};

type StepEventData = { type: "step"; which: "start" | "end"; name?: string };

type EventMap = {
  [K in MouseEventType]: MouseEventData;
} & { [K in KeyboardEventType]: KeyboardEventData } & {
  screenshot: ScreenshotEventData;
  step: StepEventData;
};
type ConsumedEventData =
  | ConsumedMouseEventData
  | ConsumedKeyboardEventData
  | ScreenshotEventData
  | StepEventData;

const EVENTS_TO_CONSUME = [
  ...MOUSE_EVENTS,
  ...KEYBOARD_EVENTS,
  "step",
  "screenshot",
] as const;

const getCodegenKey = ({
  key,
  altKey,
  ctrlKey,
  metaKey,
  shiftKey,
}: Partial<EventModifiers> & { key: string }) => {
  return Object.entries({ altKey, ctrlKey, metaKey, shiftKey })
    .map(([key, value]) => (value ? capitalize(key.replace("Key", "")) : ""))
    .filter((val) => !!val && val !== key)
    .concat(key)
    .join("+");
};

declare global {
  interface Window {
    startRecording: () => Promise<void>;
    stopRecording: () => Promise<void>;
    step: (name?: string) => Promise<void>;
    endStep: () => Promise<void>;
    captureScreenshot: (
      options?: PageScreenshotOptions & { name?: string }
    ) => Promise<void>;
    emitCodegenEvent: (e: MouseEventData | KeyboardEventData) => Promise<void>;
    resolveSelector: (eventTarget: EventTarget) => Promise<string>;
  }
}

export class Codegen extends EventEmitter {
  readonly testInfo: TestInfo;
  private readonly file: string;
  protected events: ConsumedEventData[] = [];
  private recording = false;
  private down = false;
  private counter = 0;

  static async start(page: Page, testInfo: TestInfo) {
    const codegen = new Codegen(testInfo);
    try {
      execSync(`code ${codegen.file}`);
    } catch (error) {}
    await codegen.install(page);
    await page.evaluate(() => window.startRecording());
    await page.pause();
  }

  constructor(testInfo: TestInfo) {
    super();
    this.testInfo = testInfo;
    this.file = this.prepareFile(testInfo);
    this.attach();
  }

  protected prepareFile(testInfo: TestInfo) {
    const file = path.resolve(testInfo.outputDir, "codegen.ts");
    ensureFileSync(file);
    testInfo.attach("codegen.ts", {
      path: file,
    });

    return file;
  }

  toSelector(handle: ElementHandle | null) {
    return "selector";
  }

  async install(page: Page) {
    await page.exposeFunction(
      "resolveSelector",
      (handle: ElementHandle<Node>) => this.toSelector(handle)
    );

    await page.exposeFunction(
      "emitCodegenEvent",
      async (e: MouseEventData | KeyboardEventData) => {
        this.recording && this.emit(e.type, e);
      }
    );

    const disposer = await page.evaluateHandle(
      ([mouseEvents, keyboardEvents, modifiers]) => {
        const consumeMouseEvent = async (e: MouseEvent) =>
          window.emitCodegenEvent({
            type: e.type,
            x: e.x,
            y: e.y,
            ...Object.fromEntries(
              modifiers.map((k) => [k, e[k]]).filter(([k, v]) => !!v)
            ),
            handle: await window.resolveSelector(e.target),
          });
        const consumeKeyboardEvent = async (e: KeyboardEvent) =>
          window.emitCodegenEvent({
            type: e.type,
            key: e.key,
            ...Object.fromEntries(
              modifiers.map((k) => [k, e[k]]).filter(([k, v]) => !!v)
            ),
            handle: await window.resolveSelector(e.target),
          });

        mouseEvents.forEach((ev) =>
          window.addEventListener(ev, consumeMouseEvent)
        );
        keyboardEvents.forEach((ev) =>
          window.addEventListener(ev, consumeKeyboardEvent)
        );

        return () => {
          mouseEvents.forEach((ev) =>
            window.removeEventListener(ev, consumeMouseEvent)
          );
          keyboardEvents.forEach((ev) =>
            window.removeEventListener(ev, consumeKeyboardEvent)
          );
        };
      },
      [MOUSE_EVENTS, KEYBOARD_EVENTS, EVENT_MODIFIER_KEYS] as const
    );
    // await disposer.evaluate((d) => d());
    // await disposer.dispose();

    await page.exposeFunction("startRecording", () => {
      this.recording = true;
    });

    await page.exposeFunction("stopRecording", () => {
      this.recording = false;
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

  protected attach() {
    const write = debounce(() => this.write(), 250);
    const exec = (ev: EventMap[keyof EventMap]) => this.consume(ev) && write();
    EVENTS_TO_CONSUME.forEach((eventType) => this.on(eventType, exec));
    this.on("screenshot", (ev) => this.attachScreenshot(ev));
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

  on<K extends keyof EventMap>(
    eventType: K,
    listener: (ev: EventMap[K]) => any
  ) {
    return super.on(eventType, listener);
  }

  consume(ev: EventMap[keyof EventMap]) {
    const last = this.events[this.events.length - 1]?.type;

    if (ev.type === "mousedown") {
      this.down = true;
    } else if (ev.type === "mouseup") {
      this.down = false;
    } else if (ev.type === "mousemove" && !this.down) {
      return false;
    }

    if (ev.type === "mousemove" && last === "mousemove") {
      const { steps = 0 } = this.events.pop() as MouseMoveEventData;
      this.events.push({ ...ev, type: "mousemove", steps: steps + 1 });
    } else if (ev.type === "mouseup" && last === "mousedown") {
      this.events.pop();
      this.events.push({ ...ev, type: "click" });
    } else if (ev.type === "keyup" && last === "keydown") {
      this.events.pop();
      this.events.push({ ...ev, type: "keypress" });
    } else {
      this.events.push(ev);
    }

    return true;
  }

  parse() {
    const data = this.events.slice();

    // close last step
    const lastStep = data.findLast((ev) => ev.type === "step") as
      | StepEventData
      | undefined;
    lastStep?.which === "start" && data.push({ type: "step", which: "end" });

    return data.flatMap((ev) => {
      switch (ev.type) {
        case "keydown": {
          return [`await page.keyboard.down('${getCodegenKey(ev)}');`];
        }

        case "keyup": {
          return [`await page.keyboard.up('${getCodegenKey(ev)}');`];
        }

        case "keypress": {
          return [`await page.keyboard.press('${getCodegenKey(ev)}');`];
        }

        case "mousedown": {
          const { x, y, handle } = ev as MouseEventData;
          return [
            `await page.hover(${handle}, ${JSON.stringify({
              position: { x, y },
            })});`,
            `await page.mouse.down();`,
          ];
        }

        case "mousemove": {
          const { x, y, steps = 0 } = ev;
          return [`await page.mouse.move(${x}, ${y}, { steps: ${steps} });`];
        }

        case "mouseup": {
          return [`await page.mouse.up();`];
        }

        case "click": {
          const { x, y, handle } = ev;
          return [
            `await page.click(${handle}, ${JSON.stringify({
              position: { x, y },
            })});`,
          ];
        }

        case "dblclick": {
          const { x, y } = ev;
          return [`await page.mouse.dblclick(${x}, ${y});`];
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
    });
  }

  write() {
    writeFileSync(
      this.file,
      [
        `import { test, expect } from "@playwright/test";`,
        "",
        "",
        "test('codegen output', async ({ page }, testInfo) => {",
        "",
        "// you may need to replace the `selector` value",
        `const selector = '#canvas';`,
        "",
        "",
        ...this.parse(),
        "});",
      ].join("\n")
    );

    try {
      execSync(`prettier --write --ignore-path '' ${this.file}`);
    } catch (error) {}
  }

  attachOutput() {
    this.testInfo.attach("recorded events", {
      body: JSON.stringify(this.events, null, 2),
    });
    this.testInfo.attach("codegen", {
      body: readFileSync(this.file).toString(),
    });
    console.log(
      `\n\nCodegen of the test "${this.testInfo.title}" has completed successfully`,
      "Generated output is available in the test attachments\n\n"
    );
  }
}
