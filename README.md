# Archived

See my [playwright fork](https://github.com/ShaMan123/playwright)

# Playwright Codegen

A simple codegen plugin for playwright.

Playwright's native codegen isn't flexible enough for all use cases, especially for canvas based apps.

Hopefully playwright will come up with something better and make this repo obsolete.

Until then enjoy.

Contributions are more than welcome.

Playwright tickets:

- [Feature request](https://github.com/microsoft/playwright/issues/29970)
- [Feature tracker](https://github.com/microsoft/playwright/issues/28474)

## Installation

```bash
npm i --save-dev playwright-codegen
```

## Usage

```typescript
import { Codegen } from "playwright-codegen";

test("My codegen test", async ({ page }, testInfo) => {
  ...
  await Codegen.start(page, testInfo); // launches a TS file that is updated by codegen as well as playwright's native codegen
});
```

Then in devtools you can use the following:

```typescript
interface CodegenMethods {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  step: (name?: string) => Promise<void>;
  endStep: () => Promise<void>;
  captureScreenshot: (
    options?: PageScreenshotOptions & { name?: string }
  ) => Promise<void>;
  comment: (value: string) => Promise<void>;
}
```
