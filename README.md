### Usage

```typescript

test("My codegen test", async ({ page }, testInfo) => {
  await Codegen.start(page, testInfo); // launches a TS file that is updated by codegen
});

```
