import type {
  ElementHandle,
  Page,
  PageScreenshotOptions,
  TestInfo,
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

const MOUSE_EVENTS = [
  "mousedown",
  "mousemove",
  "mouseup",
  "dblclick",
  "wheel",
] as const;
type BasicMouseEventData = {
  x: number;
  y: number;
  handle: string;
} & Partial<EventModifiers>;
type MouseEventData = (
  | {
      type: "mousedown" | "mousemove" | "mouseup" | "dblclick";
    }
  | { type: "wheel"; deltaX: number; deltaY: number }
) &
  BasicMouseEventData;
type ConsumedMouseEventData = (
  | {
      type: "mousedown" | "mouseup" | "dblclick";
    }
  | {
      type: "mousemove";
      steps?: number;
    }
  | { type: "click" }
  | { type: "wheel"; deltaX: number; deltaY: number }
) &
  BasicMouseEventData;

const KEYBOARD_EVENTS = ["keydown", "keyup"] as const;
type BasicKeyboardEventData = {
  key: string;
} & Partial<EventModifiers>;
type KeyboardEventData = BasicKeyboardEventData & {
  type: "keydown" | "keyup";
};
type ConsumedKeyboardEventData = BasicKeyboardEventData & {
  type: "keydown" | "keyup" | "keypress";
};

type ScreenshotEventData = {
  type: "screenshot";
  handle: string;
  screenshot: Buffer;
  name: string;
  options?: PageScreenshotOptions;
};

type StepEventData = { type: "step"; which: "start" | "end"; name?: string };

type CommentEventData = { type: "comment"; value: string };

type NavigationEventData = { type: "navigation"; url: string };

type EventMap = {
  [K in MouseEventData["type"]]: MouseEventData;
} & { [K in KeyboardEventData["type"]]: KeyboardEventData } & {
  screenshot: ScreenshotEventData;
  step: StepEventData;
  comment: CommentEventData;
  navigation: NavigationEventData;
};
type ConsumedEventData =
  | ConsumedMouseEventData
  | ConsumedKeyboardEventData
  | ScreenshotEventData
  | StepEventData
  | CommentEventData
  | NavigationEventData;

const EVENTS_TO_CONSUME = [
  ...MOUSE_EVENTS,
  ...KEYBOARD_EVENTS,
  "screenshot",
  "step",
  "comment",
  "navigation",
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

type BBox = { x: number; y: number; width: number; height: number };

interface CodegenBrowserAPI {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  step: (name?: string) => Promise<void>;
  endStep: () => Promise<void>;
  captureScreenshot: (
    options?: PageScreenshotOptions & { name?: string }
  ) => Promise<void>;
  comment: (value: string) => Promise<void>;
}

declare global {
  interface Window extends CodegenBrowserAPI {
    codegen: CodegenBrowserAPI & { help: VoidFunction };

    emitCodegenEvent: (e: MouseEventData | KeyboardEventData) => Promise<void>;
    resolveSelector: (eventTarget: EventTarget) => Promise<string>;
    isCapturingScreenshotArea: () => boolean;
    captureScreenshotArea: (bbox: BBox) => void;
  }
}

/**
 * @example
 *
 * test("My codegen test", async ({ page }, testInfo) => {
 *   ...
 *   // launch a TS file that is updated by codegen as well as playwright's native codegen
 *   await Codegen.start(page, testInfo);
 * });
 */
export class Codegen extends EventEmitter {
  readonly testInfo: TestInfo;
  readonly file: string;
  protected events: ConsumedEventData[] = [];
  private recording = false;
  private down = false;
  private steps: string[] = [];
  private counter = 0;
  private captureScreenshotArea?: (bbox: BBox) => void;

  /**
   * adds {@link CodegenMethods} to the window and starts recording
   */
  static async start(page: Page, testInfo: TestInfo) {
    const codegen = new Codegen(testInfo);
    try {
      execSync(`code ${codegen.file}`);
    } catch (error) {}
    await codegen.install(page);
    codegen.recording = true;
    await page.pause();
  }

  constructor(testInfo: TestInfo, fileName = "codegen.ts") {
    super();
    this.testInfo = testInfo;
    this.file = this.prepareFile(testInfo, fileName);
    this.attach();
  }

  protected prepareFile(testInfo: TestInfo, fileName: string) {
    const file = path.resolve(testInfo.outputDir, fileName);
    ensureFileSync(file);
    testInfo.attach(fileName, {
      path: file,
    });

    return file;
  }

  /**
   * @todo https://github.com/microsoft/playwright/blob/1f63cbff08a11f6fad671824adfd4a0f283da29a/packages/playwright-core/src/server/injected/selectorGenerator.ts#L73
   */
  toSelector(handle: ElementHandle<Node>) {
    return "selector";
  }

  /**
   * adds {@link PrivateCodegenMethods}, {@link CodegenMethods} to the window and attaches event listeners
   */
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

    page.on("framenavigated", async (frame) => {
      this.emit("navigation", {
        type: "navigation",
        url: frame.url(),
      } as NavigationEventData);
    });

    this.installWindowEventHandlers(page);
    page.on("load", () => this.installWindowEventHandlers(page));

    /**
     * {@link CodegenBrowserAPI.startRecording}
     */
    await page.exposeFunction("startRecording", () => {
      this.recording = true;
    });

    /**
     * {@link CodegenBrowserAPI.stopRecording}
     */
    await page.exposeFunction("stopRecording", () => {
      this.recording = false;
    });

    const assertRecording = () => {
      if (!this.recording) {
        throw new Error("Recoding is not in progress, call `startRecording()`");
      }
    };

    /**
     * {@link CodegenBrowserAPI.step}
     */
    await page.exposeFunction("step", async (name?: string) => {
      assertRecording();
      this.emit("step", {
        type: "step",
        which: "start",
        name,
      } as StepEventData);
      await page.evaluate(
        (value) => console.log(value),
        this.steps.join(" > ")
      );
    });

    /**
     * {@link CodegenBrowserAPI.endStep}
     */
    await page.exposeFunction("endStep", async () => {
      assertRecording();
      this.emit("step", { type: "step", which: "end" } as StepEventData);
      await page.evaluate(
        (value) => console.log(value),
        this.steps.join(" > ")
      );
    });

    await page.exposeFunction(
      "isCapturingScreenshotArea",
      () => !!this.captureScreenshotArea
    );
    await page.exposeFunction(
      "captureScreenshotArea",
      (bbox: { x: number; y: number; width: number; height: number }) =>
        this.captureScreenshotArea?.(bbox)
    );

    /**
     * {@link CodegenBrowserAPI.captureScreenshot}
     */
    await page.exposeBinding(
      "captureScreenshot",
      async (
        { page },
        name = `${this.testInfo.title}-${++this.counter}.png`,
        captureScreenshotArea?: boolean,
        options: PageScreenshotOptions = {}
      ) => {
        assertRecording();
        if (captureScreenshotArea) {
          // Track area selection
          await page.evaluateHandle(() => {
            const el = window.canvas.getSelectionElement();
            // Block canvas interactions
            el.style.pointerEvents = "none";

            let downX = 0;
            let downY = 0;
            window.addEventListener(
              "mousedown",
              (e: MouseEvent) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                const { offsetX: x, offsetY: y } = e;
                downX = x;
                downY = y;
              },
              { once: true }
            );
            window.addEventListener(
              "mouseup",
              (e: MouseEvent) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                const { offsetX: x, offsetY: y } = e;
                const left = Math.min(downX, x);
                const top = Math.min(downY, y);
                const right = Math.max(downX, x);
                const bottom = Math.max(downY, y);
                window.captureScreenshotArea({
                  x: left,
                  y: top,
                  width: right - left,
                  height: bottom - top,
                });

                // Restore canvas interactions
                delete el.style.pointerEvents;

                console.log("Successfully captured screenshot area");
              },
              { once: true }
            );

            console.log("Waiting for mouse down and up sequence");
          });
          options.clip = await new Promise<{
            x: number;
            y: number;
            width: number;
            height: number;
          }>(async (resolve) => {
            this.captureScreenshotArea = resolve;
          });
          delete this.captureScreenshotArea;
        }
        const handle = (
          await page.evaluateHandle(() => document.activeElement)
        ).asElement()!;
        this.emit("screenshot", {
          type: "screenshot",
          handle: await this.toSelector(handle),
          screenshot: await (
            !options.clip && handle ? handle : page
          ).screenshot(options),
          name,
          options,
        } as ScreenshotEventData);
        await handle.dispose();
      }
    );

    /**
     * {@link CodegenBrowserAPI.comment}
     */
    await page.exposeFunction("comment", async (value: string) => {
      assertRecording();
      this.emit("comment", { type: "comment", value } as CommentEventData);
    });

    /**
     * {@link CodegenBrowserAPI.comment}
     */
    await page.evaluateHandle(() => {
      window.codegen = {
        startRecording: window.startRecording,
        stopRecording: window.stopRecording,
        step: window.step,
        endStep: window.endStep,
        captureScreenshot: window.captureScreenshot,
        comment: window.comment,
        help: () => {
          console.log(
            [
              "Canvas Codegen Help",
              "Consider detaching devtools to avoid affecting the test",
              "",
              "Commands:",
              ...[
                "startRecording()",
                "stopRecording()",
                "",
                "step('stepName')",
                "endStep()",
                "",
                "captureScreenshot('name.png')",
                "captureScreenshot('name.png', /** capture screenshot area */ true)",
                "captureScreenshot(/** auto generate name */ undefined, true)",
                "captureScreenshot('name.png', false, options)",
                "",
                "comment('Add a comment to the test file at cursor position')",
              ].map((v) => `  ${v}`),
            ].join("\n")
          );
        },
      };
      window.codegen.help();
    });
  }

  protected async installWindowEventHandlers(page: Page) {
    const disposer = await page.evaluateHandle(
      ([mouseEvents, keyboardEvents, modifiers]) => {
        const consumeMouseEvent = async (e: MouseEvent | WheelEvent) =>
          !window.isCapturingScreenshotArea() &&
          window.emitCodegenEvent({
            type: e.type,
            x: e.x,
            y: e.y,
            ...(e instanceof WheelEvent
              ? { deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ }
              : {}),
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

    return async () => {
      await disposer.evaluate((d) => d());
      await disposer.dispose();
    };
  }

  protected attach() {
    const write = debounce(() => this.write(), 250);
    const exec = (ev: EventMap[keyof EventMap]) => this.consume(ev) && write();
    EVENTS_TO_CONSUME.forEach((eventType) => this.on(eventType, exec));
    this.on("screenshot", ({ name, screenshot }) => {
      this.testInfo.attach(name, {
        body: screenshot,
      });
      const snapshotPath = this.testInfo.snapshotPath(name);
      ensureFileSync(snapshotPath);
      writeFileSync(snapshotPath, screenshot);
    });
  }

  on<K extends keyof EventMap>(
    eventType: K,
    listener: (ev: EventMap[K]) => any
  ) {
    return super.on(eventType, listener);
  }

  consume(ev: EventMap[keyof EventMap]) {
    const last = this.events[this.events.length - 1]?.type;
    const beforeLast = this.events[this.events.length - 2]?.type;

    if (ev.type === "mousedown") {
      this.down = true;
    } else if (ev.type === "mouseup") {
      this.down = false;
    } else if (ev.type === "mousemove" && !this.down) {
      return false;
    }

    if (ev.type === "step" && ev.which === "start") {
      this.steps.push(ev.name || "step");
    } else if (ev.type === "step" && ev.which === "end" && !this.steps.pop()) {
      return false;
    }

    if (ev.type === "mousemove" && last === "mousemove") {
      const { steps = 0 } = this.events.pop() as { steps?: number };
      this.events.push({ ...ev, type: "mousemove", steps: steps + 1 });
    } else if (ev.type === "mouseup" && last === "mousedown") {
      this.events.pop();
      this.events.push({ ...ev, type: "click" });
    } else if (
      ev.type === "keyup" &&
      last === "keydown" &&
      getCodegenKey(ev) ===
        getCodegenKey(
          this.events[this.events.length - 1] as ConsumedMouseEventData & {
            type: "keydown";
          }
        )
    ) {
      this.events.pop();
      this.events.push({ ...ev, type: "keypress" });
    } else if (
      ev.type === "dblclick" &&
      last === "click" &&
      beforeLast === "click"
    ) {
      this.events.pop();
      this.events.pop();
      this.events.push(ev);
    } else if (ev.type === "wheel" && last === "wheel") {
      const { x, y, deltaX, deltaY } = this.events[
        this.events.length - 1
      ] as ConsumedMouseEventData & {
        type: "wheel";
      };
      if (x === ev.x && y === ev.y) {
        this.events.pop();
        this.events.push({
          ...ev,
          deltaX: deltaX + ev.deltaX,
          deltaY: deltaY + ev.deltaY,
        });
      } else {
        this.events.push(ev);
      }
    } else {
      this.events.push(ev);
    }

    return true;
  }

  parse() {
    const data = this.events.concat(
      // close open steps
      new Array(this.steps.length).fill({ type: "step", which: "end" })
    );

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
          const { x, y } = ev;
          return [
            // `await page.hover(${ev.handle}, ${JSON.stringify({
            //   position: { x, y },
            // })});`,
            `await page.mouse.move(${x}, ${y});`,
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
          const { x, y } = ev;
          return [`await page.mouse.click(${x}, ${y});`];
        }

        case "dblclick": {
          const { x, y } = ev;
          return [`await page.mouse.dblclick(${x}, ${y});`];
        }

        case "wheel": {
          const { x, y, deltaX, deltaY } = ev;
          return [
            `await page.mouse.move(${x}, ${y});`,
            `await page.mouse.wheel(${deltaX}, ${deltaY});`,
          ];
        }

        case "screenshot": {
          const { name, options, handle } = ev;
          return [
            `expect(${
              options?.clip ? "page" : `await page.locator(${handle})`
            }).toHaveScreenshot('${name}', ${
              options ? JSON.stringify(options) : ""
            });`,
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

        case "comment": {
          return [`// ${ev.value}`];
        }

        case "navigation": {
          return [`await page.goto('${ev.url}');`];
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
        "// This file is readonly and gets written frequently",
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
