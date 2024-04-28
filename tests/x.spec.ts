import { test } from "@playwright/test";
import { Codegen } from "../codegen";

test("codegen", async ({ page }, testInfo) => {
  await page.goto("/");
  await Codegen.start(page, testInfo);
});
